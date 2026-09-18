import { error } from '@sveltejs/kit';
import { getDetail, getSeriesSeason } from '$lib/server/content/service';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType, type Episode } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { hasStreamEligibleAddons } from '$lib/server/streaming/stremio/mavero-player-source';
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
//   - For series/anime params.type, ALSO kick off the season fetch
//     in parallel (the common series-like case — no need to wait for
//     item.isAnime / item.animeFormat).
//   - Wait for detail first.
//   - Apply the adult gate.
//   - For the rare movie+anime-series case (params.type === 'movie' &&
//     item.isAnime && animeFormat !== 'movie'), fetch the season after
//     detail resolves (preserves the existing rare-path behavior).
//   - Await the remaining promises.
//
// Behavior preserved:
//   - Adult Mode gate is still server-authoritative, per-request,
//     non-disclosing 404.
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
  // Speculatively fetch the season when params.type is series/anime —
  // these are series-like REGARDLESS of item, so we know upfront we'll
  // need the season. The rare movie+anime-series case waits for detail.
  const seriesLikeByParams = params.type === 'series' || params.type === 'anime';

  // Kick off ALL independent work in parallel. Detail must resolve first
  // (the adult gate depends on item.tags), but the other three are
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
  // Season fetch — optional, failure is silently absorbed (the player
  // falls back to item.seasonsData episodes). Speculative only when
  // series-like-by-params (the common case). The result is normalized to
  // `Episode[] | null` so the union type doesn't widen (the fixture path
  // returns a narrower episode shape than TMDB).
  const speculativeSeasonPromise: Promise<Episode[] | null> = seriesLikeByParams
    ? getSeriesSeason(params.id, seasonNumber)
        .then((season): Episode[] => (season.episodes as Episode[]) ?? [])
        .catch(() => null)
    : Promise.resolve(null);

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

  // For the rare movie+anime-series case (params.type === 'movie' &&
  // item.isAnime && animeFormat !== 'movie'), we still need to fetch the
  // season now that we know it's needed.
  const isSeriesLike = params.type === 'series'
    || (item.isAnime === true && item.animeFormat !== 'movie')
    || params.type === 'anime';
  // If we didn't speculatively fetch the season but now need it, kick
  // it off here (rare path — preserves the existing behavior).
  const lateSeasonPromise: Promise<Episode[] | null> | null = (!seriesLikeByParams && isSeriesLike)
    ? getSeriesSeason(params.id, seasonNumber)
        .then((season): Episode[] => (season.episodes as Episode[]) ?? [])
        .catch(() => null)
    : null;

  try {
    // Await all independent work in parallel. These ran concurrently with
    // detail + the adult gate; we now collect their results.
    const [streamingConfig, maveroPlayerAvailable, speculativeSeason, lateSeason] = await Promise.all([
      streamingConfigPromise,
      maveroPlayerAvailablePromise,
      speculativeSeasonPromise,
      lateSeasonPromise ?? Promise.resolve(null)
    ]);

    const fallbackEpisodes = item.seasonsData?.flatMap((season) => season.episodes ?? []) ?? [];
    const seasonEpisodes = lateSeason ?? speculativeSeason;
    const episodes = (isSeriesLike && seasonEpisodes && seasonEpisodes.length > 0)
      ? seasonEpisodes
      : fallbackEpisodes;

    return { item: toMediaItem(item), streamingConfig, episodes, maveroPlayerAvailable };
  } catch {
    throw error(404, 'Title not found');
  }
};
