import { error, isHttpError } from '@sveltejs/kit';
import { getDetail, getSeriesSeason } from '$lib/server/content/service';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType, type Episode } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import { logger } from '$lib/server/http/log';
import type { PageServerLoad } from './$types';

// Phase 2-E (audit PERF-005) — Watch page server load parallelization.
//
// Previous flow (sequential):
//   1. getDetail(type, id)             [TMDB roundtrip]
//   2. canAccessAdultContent(...)      [conditional, per-request]
//   3. getSeriesSeason(id, season)     [conditional, TMDB roundtrip]
//   4. getPublicStreamingConfig(supabase) [DB read]
//
// The only TRUE dependency is: detail must resolve before the adult
// classification gate (because we need item.tags). The season fetch
// depends on params.type (always known) and item.isAnime (rare movie
// branch). The streaming config is completely independent of detail.
//
// (Phase 1 of the Vidara + Abyss hosting implementation removed the
//  former server-gated addon-resolution availability check — the entire
//  virtual MAVERO Player source branch was retired. The Stremio addon
//  DOWNLOADER surface remains available through the Download sheet /
//  external player / download flow, which does not require a watch-page
//  server-load computation.)
//
// Parallelized flow:
//   - Kick off detail + streamingConfig in parallel.
//   - Wait for detail first.
//   - Apply the adult gate.
//   - AFTER the gate clears, kick off the season fetch (title-specific
//     episode data — never speculatively before the gate, so unauthorized
//     adult requests don't trigger unnecessary episode fetches).
//   - Await the remaining promises.
//
// Behavior preserved:
//   - Adult Mode gate is still server-authoritative, per-request,
//     non-disclosing 404.
//   - Adult gate runs BEFORE any title-specific episode data is fetched
//     (preserves the Phase 6 security contract — unauthorized requests
//     never trigger episode metadata fetches).
//   - Streaming config degrades to a safe empty default on failure.
//   - Episode fetch is still optional — failure is silently absorbed
//     (the player falls back to item.seasonsData episodes).
//   - No duplicate queries: the season fetch runs at most once.

type StreamingConfigFallback = {
  version: 1;
  updatedAt: string;
  providers: never[];
  sources: never[];
  categories: never[];
  sourceCategories: never[];
  defaults: Record<string, never>;
  defaultsOrder: Record<string, never[]>;
};
const EMPTY_STREAMING_CONFIG: StreamingConfigFallback = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  providers: [],
  sources: [],
  categories: [],
  sourceCategories: [],
  defaults: {},
  defaultsOrder: {}
};

export const load: PageServerLoad = async ({ params, locals, cookies, url }) => {
  if (!isContentType(params.type)) throw error(404, 'Unsupported content type');

  // Phase 6 — direct watch enforcement (server-side, non-disclosing).
  //
  // The watch route is the highest-value adult bypass: it returns protected
  // metadata, episode data AND streaming configuration for any TMDB id.
  // Before ANY watch data is returned, the resolved title is classified by
  // the ONE central classifier (getDetail -> getTmdbDetail tags the detail
  // 'Adult' through isAdultContent over networks/providers/adult/isAnime)
  // and the CURRENT REQUEST's authorization is evaluated with the Phase 5
  // policy function (fresh per-request admin policy + verified preference —
  // never cached, never client-controlled).
  //
  // Adult + unauthorized -> the SAME non-disclosing 404 as any missing
  // title: no title, no Adult classification, no provider/network details,
  // no episode data, no streaming configuration, no resolver hints. The
  // client cannot distinguish "adult and forbidden" from "does not exist".

  const seasonNumber = Number(url.searchParams.get('season') || '') || 1;
  // SECURITY: the season fetch is TITLE-SPECIFIC episode data. We start it
  // AFTER the adult gate (below) — never speculatively before — so
  // unauthorized adult requests don't trigger unnecessary episode fetches.
  // The streaming config is NOT title-specific, so it CAN run in parallel
  // with detail (no adult-gate dependency).

  // Kick off the INDEPENDENT work in parallel. Detail must resolve first
  // (the adult gate depends on item.tags), but the streaming config is
  // fully independent and can run concurrently with detail.
  const detailPromise = getDetail(params.type, params.id).catch(() => {
    // Fail-closed: an unresolvable title (including a failed classification
    // fetch) is a 404 — never an unclassified watch page.
    throw error(404, 'Title not found');
  });
  const streamingConfigPromise = getPublicStreamingConfig(locals.supabase)
    .catch(() => EMPTY_STREAMING_CONFIG);

  // Await detail first — the adult gate depends on item.tags.
  const item = await detailPromise;

  // Adult Mode gate — server-authoritative, per-request, non-disclosing.
  if (detailVerdict(item.tags) === 'adult') {
    // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
    const user = locals.user;
    // MAVP-5 (RC-2): the policy/authorization read is the ONLY await in this
    // load that previously had no rejection guard. The Supabase
    // PostgrestBuilder promises inside getAdultAccessContext REJECT on
    // transient network failures (the `{ data, error }` destructure inside
    // that module normalizes Postgrest error SHAPES only, never rejections);
    // an escaped rejection surfaced as a generic SvelteKit 500 ("The signal
    // dropped.") on card-play and every other watch navigation. The gate is
    // now explicitly fail-CLOSED: when the authorization evaluation itself
    // fails we cannot verify access, so the request gets the SAME
    // non-disclosing 404 as any unauthorized adult title (the Phase 6
    // contract — "adult and forbidden" is indistinguishable from "does not
    // exist"). The failure is logged server-side (error class only — never
    // tokens, titles or user identifiers) so the transient infra failure
    // keeps actionable operator reporting instead of a generic 500. A
    // non-adult title never reaches this branch, so normal playback is
    // unaffected.
    try {
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) {
        throw error(404, 'Title not found');
      }
    } catch (gateError) {
      // SvelteKit HttpError (the intentional 404 above) must propagate as-is.
      if (isHttpError(gateError)) throw gateError;
      logger.error('watch adult authorization check failed (fail closed)', {
        errorType: gateError instanceof Error ? gateError.name : 'unknown'
      });
      throw error(404, 'Title not found');
    }
  }

  // After the adult gate cleared, fetch the season if the title is series-like.
  // For series/anime params.type, we know this upfront; for the rare
  // movie+anime-series case (item.isAnime && animeFormat !== 'movie'), we
  // only know after detail resolves.
  const isSeriesLike = params.type === 'series'
    || (item.isAnime === true && item.animeFormat !== 'movie')
    || params.type === 'anime';
  // Season fetch — optional, failure is silently absorbed (the player
  // falls back to item.seasonsData episodes). Result normalized to
  // `Episode[] | null` so the union type doesn't widen (the fixture path
  // returns a narrower episode shape than TMDB).
  const seasonPromise: Promise<Episode[] | null> = isSeriesLike
    ? getSeriesSeason(params.id, seasonNumber)
        .then((season): Episode[] => (season.episodes as Episode[]) ?? [])
        .catch(() => null)
    : Promise.resolve(null);

  try {
    // Await all independent work in parallel. The streaming config ran
    // concurrently with detail + the adult gate; the season fetch started
    // after the gate cleared. We collect all results here.
    const [streamingConfig, seasonEpisodes] = await Promise.all([
      streamingConfigPromise,
      seasonPromise
    ]);

    const fallbackEpisodes = item.seasonsData?.flatMap((season) => season.episodes ?? []) ?? [];
    const episodes = (isSeriesLike && seasonEpisodes && seasonEpisodes.length > 0)
      ? seasonEpisodes
      : fallbackEpisodes;

    return { item: toMediaItem(item), streamingConfig, episodes };
  } catch {
    throw error(404, 'Title not found');
  }
};
