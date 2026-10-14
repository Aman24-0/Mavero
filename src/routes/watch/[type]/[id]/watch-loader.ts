/**
 * Deep-audit refactor — SHARED watch page loader (2026-10).
 *
 * The watch page is now served by TWO route shapes:
 *
 *   CANONICAL (path form):  /watch/tv-show/1396/5/6
 *     src/routes/watch/[type]/[id]/[season]/[episode]/+page.server.ts
 *
 *   BACKWARD-COMPATIBLE (query form):  /watch/tv-show/1396?season=5&episode=6
 *     src/routes/watch/[type]/[id]/+page.server.ts
 *
 * Both shapes run THIS loader. The `form` parameter only decides:
 *   1. Where season/episode are read from (path params vs query params).
 *   2. Which canonicalization redirects apply:
 *        - query form + BOTH season&episode present  → 308 to the path form
 *          (season/episode are REMOVED from the forwarded query; every other
 *          query param — e.g. `from`, `controls` — is preserved).
 *        - non-episodic type + season/episode query  → 308 to the base URL
 *          with season/episode stripped (a movie resolver request must never
 *          carry season/episode — it would be rejected as INVALID_REQUEST).
 *        - legacy internal type ('series'/'anime')   → 307 to the modern
 *          public route type (existing Phase 5 behavior).
 *        - legacy prefixed ID ('movie-278')          → 308 to the bare ID,
 *          preserving any path tail and the forwarded query.
 *
 * Redirect-loop safety: the path form never redirects to the query form,
 * the bare ID never matches isLegacyPrefixedId, and the stripped/forwarded
 * query no longer contains season/episode after the canonical redirect —
 * every redirect target lands on a terminal shape.
 *
 * Everything below the canonicalization block is byte-for-byte the
 * pre-refactor load: parallel detail + streaming config, server-authoritative
 * adult gate (fail-closed, non-disclosing 404), gate-ordered season fetch,
 * typed degradation logging, and the identical return shape.
 */

import { error, isHttpError, redirect } from '@sveltejs/kit';
import type { Cookies } from '@sveltejs/kit';
import { getDetail, getSeriesSeason } from '$lib/server/content/service';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType, type Episode } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import { logWatchLoadStageFailure } from '$lib/server/content/watch-load-diagnostics';
import { logger } from '$lib/server/http/log';
import {
  isPublicRouteType,
  internalContentType,
  isLegacyWatchType,
  modernizeWatchType,
  isLegacyPrefixedId,
  extractTmdbId,
  isEpisodicRouteType,
  canonicalWatchHref,
  type PublicRouteType,
} from '$lib/shared/routes';

type WatchLoadEvent = {
  params: Record<string, string | undefined>;
  locals: App.Locals;
  cookies: Cookies;
  url: URL;
};

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

/** Build the forwarded query string with season/episode REMOVED. */
function forwardedQuery(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete('season');
  params.delete('episode');
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function loadWatchPage(event: WatchLoadEvent, form: 'query' | 'path') {
  const { params, url } = event;
  const rawType = params.type ?? '';
  const rawId = params.id ?? '';

  // ---------- Canonicalization redirects ----------
  // Legacy internal type ('series'/'anime') → modern public route type.
  // Preserved from Phase 5 (307 — the mapping existed before the path-form
  // contract; keeping 307 avoids pinning clients to a shape that may
  // evolve). The target keeps the same form the request arrived in.
  if (isLegacyWatchType(rawType)) {
    const modernType = modernizeWatchType(rawType);
    if (modernType) {
      const bareId = extractTmdbId(rawId) ?? rawId;
      if (form === 'path') {
        const season = params.season ?? '';
        const episode = params.episode ?? '';
        throw redirect(307, `/watch/${modernType}/${bareId}/${season}/${episode}${forwardedQuery(url)}`);
      }
      throw redirect(307, `/watch/${modernType}/${bareId}${url.search}`);
    }
  }

  // Legacy prefixed ID ('movie-278') → bare TMDB ID. 308 — same reason as
  // the detail routes. The path tail (if any) is preserved.
  if (isLegacyPrefixedId(rawId)) {
    const bareId = extractTmdbId(rawId) ?? rawId;
    if (form === 'path') {
      throw redirect(308, `/watch/${rawType}/${bareId}/${params.season ?? ''}/${params.episode ?? ''}${forwardedQuery(url)}`);
    }
    throw redirect(308, `/watch/${rawType}/${bareId}${url.search}`);
  }

  // Route-type validation (unchanged): the public route types plus the raw
  // internal types are accepted; anything else is a 404.
  if (!isPublicRouteType(rawType)) {
    if (!isContentType(rawType)) {
      throw error(404, 'Unsupported content type');
    }
  }

  const routeType: PublicRouteType | null = isPublicRouteType(rawType) ? rawType : null;
  const episodic = routeType ? isEpisodicRouteType(routeType) : rawType === 'series' || rawType === 'anime';

  if (form === 'path') {
    // STRICT path-form validation: the season/episode segments must be
    // positive integers — a malformed deep link is a 404, never a silent
    // fallback (the required "invalid or missing season/episode rejection"
    // contract for episodic content).
    const seasonNum = Number(params.season);
    const episodeNum = Number(params.episode);
    if (!episodic) {
      // A movie path tail is not a valid shape — the parent route is the
      // canonical form for movies.
      throw error(404, 'Unsupported watch URL');
    }
    if (!Number.isInteger(seasonNum) || seasonNum <= 0 || seasonNum > 999
      || !Number.isInteger(episodeNum) || episodeNum <= 0 || episodeNum > 9999) {
      throw error(404, 'Invalid season or episode');
    }
  } else {
    // Query-form canonicalization (no redirect loops — see module docs):
    //   1. Episodic + BOTH season&episode present → 308 to the path form.
    //      (Season-only / episode-only deep links keep their historical
    //      semantics — resume picks the target — so they are NOT
    //      redirected: forcing episode=1 would corrupt the resume target.)
    //   2. Non-episodic + any season/episode → 308 to the base URL with
    //      season/episode stripped: a movie resolve request carrying
    //      season/episode is rejected by the resolver (INVALID_REQUEST),
    //      so the canonical movie URL never carries them.
    const qSeason = url.searchParams.get('season');
    const qEpisode = url.searchParams.get('episode');
    const hasBoth = qSeason !== null && qEpisode !== null && qSeason !== '' && qEpisode !== '';
    const hasAny = qSeason !== null || qEpisode !== null;
    if (routeType && hasBoth && isEpisodicRouteType(routeType)) {
      throw redirect(308, `${canonicalWatchHref(routeType, rawId, Number(qSeason), Number(qEpisode))}${forwardedQuery(url)}`);
    }
    if (routeType && !isEpisodicRouteType(routeType) && hasAny) {
      throw redirect(308, `/watch/${routeType}/${rawId}${forwardedQuery(url)}`);
    }
  }

  // ---------- Internal type derivation (unchanged) ----------
  const internalType = isPublicRouteType(rawType)
    ? internalContentType(rawType)
    : rawType as 'movie' | 'series' | 'anime';

  // ---------- Season/episode resolution ----------
  // Path form: strict-validated positive integers (above).
  // Query form: historical permissive semantics (missing → undefined; the
  // season fetch defaults to 1). Episode stays undefined so the resume
  // target selection is unchanged for legacy deep links.
  const seasonNumber = form === 'path'
    ? Number(params.season)
    : Number(url.searchParams.get('season') || '') || 1;
  const episodeNumber = form === 'path'
    ? Number(params.episode)
    : (Number(url.searchParams.get('episode') || '') || undefined);

  // ---------- Phase 6 adult gate + parallel fetches (unchanged) ----------
  const detailPromise = getDetail(internalType, rawId).catch((detailError) => {
    logWatchLoadStageFailure(logger, 'watch:detail', detailError);
    throw error(404, 'Title not found');
  });
  const streamingConfigPromise = getPublicStreamingConfig(event.locals.supabase)
    .catch((configError) => {
      logWatchLoadStageFailure(logger, 'watch:streaming-config', configError);
      return EMPTY_STREAMING_CONFIG;
    });

  const item = await detailPromise;

  if (detailVerdict(item.tags) === 'adult') {
    const user = event.locals.user;
    try {
      const canAccess = await canAccessAdultContent(event.locals.supabase, user, event.cookies);
      if (!canAccess) {
        throw error(404, 'Title not found');
      }
    } catch (gateError) {
      if (isHttpError(gateError)) throw gateError;
      logger.error('watch adult authorization check failed (fail closed)', {
        errorType: gateError instanceof Error ? gateError.name : 'unknown'
      });
      throw error(404, 'Title not found');
    }
  }

  const isSeriesLike = internalType === 'series'
    || (item.isAnime === true && item.animeFormat !== 'movie')
    || internalType === 'anime';
  const seasonPromise: Promise<Episode[] | null> = isSeriesLike
    ? getSeriesSeason(rawId, seasonNumber)
        .then((season): Episode[] => (season.episodes as Episode[]) ?? [])
        .catch((seasonError) => {
          logWatchLoadStageFailure(logger, 'watch:season', seasonError);
          return null;
        })
    : Promise.resolve(null);

  try {
    const [streamingConfig, seasonEpisodes] = await Promise.all([
      streamingConfigPromise,
      seasonPromise
    ]);

    const fallbackEpisodes = item.seasonsData?.flatMap((season) => season.episodes ?? []) ?? [];
    const episodes = (isSeriesLike && seasonEpisodes && seasonEpisodes.length > 0)
      ? seasonEpisodes
      : fallbackEpisodes;

    // Return shape is UNCHANGED from the pre-refactor load ({ item,
    // streamingConfig, episodes }) — the client reads season/episode
    // reactively from `page.params` (present on both route forms after the
    // canonical redirect) and preserves the historical "both or neither"
    // playback-context rule (a series resolve request with season but no
    // episode is rejected by the resolver as INVALID_REQUEST).
    void episodeNumber;
    return { item: toMediaItem(item), streamingConfig, episodes };
  } catch (assemblyError) {
    logWatchLoadStageFailure(logger, 'watch:assembly', assemblyError);
    throw error(404, 'Title not found');
  }
}
