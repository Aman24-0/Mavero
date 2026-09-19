import { error } from '@sveltejs/kit';
import { getDetail, getSeriesSeason } from '$lib/server/content/service';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType, type Episode } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { hasStreamEligibleAddons } from '$lib/server/streaming/stremio/mavero-player-source';
import { mediaWorkerBaseUrl } from '$lib/server/streaming/stremio/session-env';
import { dev } from '$app/environment';
import type { PageServerLoad } from './$types';

// Phase 2-E (audit PERF-005) — Watch page server load parallelization.
//
// Previous flow (sequential):
//   1. getDetail(type, id)             [TMDB roundtrip]
//   2. canAccessAdultContent(...)      [conditional, per-request]
//   3. getSeriesSeason(id, season)     [conditional, TMDB roundtrip]
//   4. getPublicStreamingConfig(supabase) [DB read]
//   5. hasStreamEligibleAddons(admin)  [DB read]
//
// The only TRUE dependency is: detail must resolve before the adult
// classification gate (because we need item.tags). The season fetch
// depends on params.type (always known) and item.isAnime (rare movie
// branch). The streaming config and addon eligibility are completely
// independent of detail.
//
// Parallelized flow:
//   - Kick off detail, streamingConfig, addonEligibility in parallel.
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
//   - maveroPlayerAvailable degrades to false on failure.
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
};
const EMPTY_STREAMING_CONFIG: StreamingConfigFallback = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  providers: [],
  sources: [],
  categories: [],
  sourceCategories: [],
  defaults: {}
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
  // The streaming config + addon eligibility are NOT title-specific, so
  // they CAN run in parallel with detail (no adult-gate dependency).

  // Kick off the INDEPENDENT work in parallel. Detail must resolve first
  // (the adult gate depends on item.tags), but the other two are
  // fully independent and can run concurrently with detail.
  const detailPromise = getDetail(params.type, params.id).catch(() => {
    // Fail-closed: an unresolvable title (including a failed classification
    // fetch) is a 404 — never an unclassified watch page.
    throw error(404, 'Title not found');
  });
  const streamingConfigPromise = getPublicStreamingConfig(locals.supabase)
    .catch(() => EMPTY_STREAMING_CONFIG);
  const maveroPlayerAvailablePromise = hasStreamEligibleAddons(createSupabaseAdminClient())
    .catch(() => false);

  // Await detail first — the adult gate depends on item.tags.
  const item = await detailPromise;

  // Adult Mode gate — server-authoritative, per-request, non-disclosing.
  if (detailVerdict(item.tags) === 'adult') {
    // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
    const user = locals.user;
    const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
    if (!canAccess) {
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
    // Await all independent work in parallel. The streaming config + addon
    // eligibility ran concurrently with detail + the adult gate; the season
    // fetch started after the gate cleared. We collect all results here.
    const [streamingConfig, maveroPlayerAvailable, seasonEpisodes] = await Promise.all([
      streamingConfigPromise,
      maveroPlayerAvailablePromise,
      seasonPromise
    ]);

    const fallbackEpisodes = item.seasonsData?.flatMap((season) => season.episodes ?? []) ?? [];
    const episodes = (isSeriesLike && seasonEpisodes && seasonEpisodes.length > 0)
      ? seasonEpisodes
      : fallbackEpisodes;

    // Phase 7 — wire the production media-worker URL into the page data
    // so ScraperViewport can connect to the real worker instead of
    // falling back to localhost. Resolution rules:
    //   1. `MAVERO_MEDIA_WORKER_URL` env var (https only — the
    //      `mediaWorkerBaseUrl()` helper rejects http and non-URL values).
    //   2. In dev only, fall back to `http://127.0.0.1:3000` so a
    //      developer can run the worker locally without configuration.
    //   3. In production, NO implicit fallback — `mediaWorkerUrl` is
    //      `null` and the ScraperViewport renders a typed
    //      "Extractor unavailable" state instead of silently dialing
    //      localhost. This is the "no silent production localhost"
    //      guarantee.
    const configuredWorkerUrl = mediaWorkerBaseUrl();
    const mediaWorkerUrl: string | null = configuredWorkerUrl
      ?? (dev ? 'http://127.0.0.1:3000' : null);

    return { item: toMediaItem(item), streamingConfig, episodes, maveroPlayerAvailable, mediaWorkerUrl };
  } catch {
    throw error(404, 'Title not found');
  }
};
