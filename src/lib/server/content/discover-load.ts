import { collection, discover, popular, selectFeatured, trendingMoviesByLanguages } from './service';
import { toMediaItem } from './presenter';
import { getOrSet, getOrSetValidated } from './cache';
import { getTmdbIndiaFlatrateIds, getTmdbHeroMoviePool, getTmdbHeroSeriesPool } from './adapters/tmdb';
import { selectHeroLineup, heroDailyBucket, isHeroLineupCacheable, type HeroCandidate, type HeroDiagnostics, type HeroLineupResult } from './hero-select';
import type { CollectionFilters, CollectionSort, ContentType, ContentList, NormalizedMediaItem } from './types';
import type { MediaItem } from '$data/content';

type RailResult = { items: MediaItem[]; error?: string };
type RailKind = 'trending' | 'popular';

async function loadRail(type: ContentType, kind: RailKind): Promise<RailResult> {
  try {
    const result: ContentList = kind === 'popular' ? await popular(type, 1) : await discover(type, 1);
    if (result.source.provider === 'fixtures') {
      return { items: [], error: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
    }
    return { items: result.items.map(toMediaItem) };
  } catch {
    return { items: [], error: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
  }
}

async function loadCollectionRail(type: ContentType, filters: CollectionFilters): Promise<RailResult> {
  try {
    const result = await collection(type, 1, filters);
    if (result.source.provider === 'fixtures') {
      return { items: [] };
    }
    return { items: result.items.map(toMediaItem) };
  } catch {
    return { items: [] };
  }
}

async function loadTopRated(type: ContentType): Promise<RailResult> {
  return loadCollectionRail(type, { sort: 'Top rated' });
}

async function loadNewest(type: ContentType): Promise<RailResult> {
  return loadCollectionRail(type, { sort: 'Newest' });
}

async function loadGenreCollection(type: ContentType, genre: string): Promise<RailResult> {
  return loadCollectionRail(type, { genre });
}

// Indian-language trending movies (movie only, TMDB original-language filter).
// - Hindi rail: one popularity-ordered TMDB query for original_language = 'hi'.
// - Regional rail: Indian regional languages OTHER than Hindi — 'hi' is
//   deliberately absent from this list, so the two rails never duplicate.
//   Each language is a separate bounded, cached TMDB query run in parallel
//   (TMDB cannot OR original languages in one query); results are merged,
//   deduplicated and popularity-ranked in the service layer.
const HINDI_MOVIE_LANGUAGES = ['hi'];
const REGIONAL_INDIAN_MOVIE_LANGUAGES = ['ta', 'te', 'ml', 'kn', 'bn', 'mr', 'gu', 'pa'];

async function loadTrendingMoviesByLanguages(languages: string[]): Promise<RailResult> {
  try {
    const result = await trendingMoviesByLanguages(languages, 1);
    if (result.source.provider === 'fixtures') return { items: [] };
    return { items: result.items.map(toMediaItem) };
  } catch {
    // A failed/empty language rail is simply hidden — no fixture or fake data.
    return { items: [] };
  }
}

const validCollectionSorts: CollectionSort[] = ['For you', 'Top rated', 'Newest'];

// The collection routes serve pages 1..20 — deeper pages are clamped back
// to 1 by parseCollectionPage. This constant is the single source of truth
// for that contract, so the pagination UI can disable "Next" exactly where
// the server stops serving pages (instead of wrapping page 21 → page 1).
export const MAX_COLLECTION_PAGE = 20;

function parseCollectionPage(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= MAX_COLLECTION_PAGE ? page : 1;
}

/**
 * Safe "Page X of Y" total: only reported when the upstream contract
 * actually provides one (TMDB discover returns total_pages; the anime
 * merged path does not), clamped to the server's 1..MAX_COLLECTION_PAGE
 * serving window and never below the current page.
 */
function clampTotalPages(value: unknown, page: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const total = Math.trunc(value);
  if (total < 1) return undefined;
  return Math.min(Math.max(total, page), MAX_COLLECTION_PAGE);
}

function parseCollectionFilters(url: URL): CollectionFilters {
  const genre = url.searchParams.get('genre')?.trim() || undefined;
  const yearValue = url.searchParams.get('year')?.trim() || undefined;
  const year = yearValue && /^\d{4}$/.test(yearValue) ? yearValue : undefined;
  const sortValue = url.searchParams.get('sort')?.trim();
  const sort = validCollectionSorts.includes(sortValue as CollectionSort) ? sortValue as CollectionSort : undefined;
  return { genre, year, sort };
}

export async function loadCollectionData(type: ContentType, url: URL) {
  const page = parseCollectionPage(url.searchParams.get('page'));
  const filters = parseCollectionFilters(url);
  try {
    const result = await collection(type, page, filters);
    if (result.source.provider === 'fixtures') {
      return { items: [], type, page: result.page, hasNextPage: false, totalPages: undefined as number | undefined, filters, errorMessage: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
    }
    return {
      items: result.items.map(toMediaItem),
      type,
      page: result.page,
      hasNextPage: result.hasNextPage,
      totalPages: clampTotalPages(result.totalPages, result.page ?? page),
      filters,
      errorMessage: undefined
    };
  } catch {
    return { items: [], type, page, hasNextPage: false, totalPages: undefined as number | undefined, filters, errorMessage: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
  }
}

type GenreCollection = { title: string; items: MediaItem[]; href: string };

// ============================================================
// Discover Hero daily lineup.
//
// The Hero lineup is computed server-side from the trending movie +
// series rails (already fetched above) plus the India flatrate
// streaming-id set (one batched, cached TMDB query pair). The result
// is cached for ~24h via the existing `getOrSet` cache with a daily
// bucket key — the same bucket produces the same lineup, the next
// bucket can produce a different lineup when candidate depth allows.
//
// The lineup is computed BEFORE the toMediaItem projection so the
// selector sees the full NormalizedMediaItem shape (popularity,
// voteCount, releaseDate, originalLanguage, externalIds, tags).
// ============================================================

// 24h TTL + 6h SWR — the lineup is by design stable for one rotation period.
const HERO_LINEUP_POLICY = { ttlMs: 1000 * 60 * 60 * 24, staleWhileRevalidateMs: 1000 * 60 * 60 * 6 };

// Cache version. Bumped to v3 to invalidate any poisoned v2 cache entries
// (the v2 cache key was `tmdb:hero-lineup:${bucket}` with NO version —
// an empty lineup cached by the v2 implementation can survive until the
// next UTC midnight boundary OR a manual cache clear). The versioned
// v3 key guarantees a fresh namespace; poisoned v2 entries become
// unreachable and expire naturally.
//
// Bump this when:
//   - the selector algorithm changes in a way that invalidates the
//     existing cached lineup shape;
//   - a production bug requires a forced cache flush.
const HERO_CACHE_VERSION = 'v3';

/**
 * Load the canonical Hero lineup — the SOLE source of Hero slides
 * for DiscoverPage. Contract:
 *
 *   - Up to 6 candidates in strict M/S/M/S/M/S order.
 *   - All candidates pass HARD eligibility gates (movies: 30-day
 *     release window with 7-day future allowance; series: current
 *     activity OR 30-day premiere).
 *   - NO legacy fallback, NO stale content, NO cross-pool fill.
 *   - Cached for ~24h via the versioned daily-bucket key.
 *
 * CRITICAL CACHE-POISONING FIX (v2 → v3):
 *   The v2 implementation used `getOrSet` directly on the selector
 *   result. `getOrSet`'s `refresh` writes the loader's return value
 *   UNCONDITIONALLY — so if `selectHeroLineup` returned `{lineup: []}`
 *   (due to a transient TMDB failure, cold detail-classifier cache,
 *   rate-limit, etc.) the empty result was cached for the full 24h
 *   HERO_LINEUP_POLICY TTL. Every subsequent request within the
 *   same daily bucket got `[]` back → "Featured title unavailable"
 *   for the entire rotation period.
 *
 *   v3 uses `getOrSetValidated` with `isHeroLineupCacheable` (lineup
 *   length >= 1) as the validity predicate. An empty result is
 *   RETURNED to the caller (so the current request sees it) but is
 *   NOT written to cache. The next request recomputes from scratch,
 *   allowing TMDB recovery to surface a valid lineup immediately
 *   instead of waiting 24h.
 *
 *   SWR is preserved: a stale valid cached lineup is served while a
 *   background refresh runs. If the refresh produces an invalid
 *   (empty) result, the existing valid stale entry is PRESERVED
 *   (not overwritten) — so a transient TMDB failure during refresh
 *   doesn't lose the previously-good lineup.
 *
 * Production diagnostics: when the lineup is shorter than 6, a
 * console.warn is emitted with the per-stage counts and the
 * `reason` field — letting ops distinguish source failure,
 * freshness-rejected, backdrop-rejected, and pool-thin cases.
 *
 * @param trendingMovies  Trending movie rail (legacy + extra depth).
 * @param trendingSeries  Trending series rail (legacy + extra depth).
 * @param trendingAnime   Trending anime rail (anime movies + series).
 */
async function loadHeroLineup(
  trendingMovies: RailResult,
  trendingSeries: RailResult,
  trendingAnime: RailResult
): Promise<MediaItem[]> {
  const bucket = heroDailyBucket();
  // Versioned key — guarantees a fresh namespace, immune to any
  // poisoned cache entries from earlier implementations.
  const key = `tmdb:hero-lineup:${HERO_CACHE_VERSION}:${bucket}`;
  try {
    // Fetch the expanded fresh pools + the streaming-id set + the
    // active-series id set in parallel (all cached via the existing
    // getOrSet path with the standard list TTL — these have SHORT
    // TTLs so a transient failure self-heals in minutes).
    const [moviePoolRes, seriesPoolRes, streamingIds] = await Promise.all([
      getTmdbHeroMoviePool().catch((error) => {
        console.warn('[Hero] getTmdbHeroMoviePool failed — using empty pool', error);
        return { items: [] as NormalizedMediaItem[] };
      }),
      getTmdbHeroSeriesPool().catch((error) => {
        console.warn('[Hero] getTmdbHeroSeriesPool failed — using empty pool', error);
        return { items: [] as NormalizedMediaItem[], activeSeriesIds: new Set<string>() };
      }),
      getTmdbIndiaFlatrateIds(2).catch((error) => {
        console.warn('[Hero] getTmdbIndiaFlatrateIds failed — using empty set', error);
        return new Set<string>();
      })
    ]);

    // Merge the expanded fresh pools with the trending rails so we
    // have both depth (trending) AND freshness (now_playing /
    // airing_today / on_the_air). Anime items contribute to their
    // canonical type's pool (anime movies → movie pool, anime series
    // → series pool) — same as the existing Mavero architecture.
    const animeItems = trendingAnime.items as unknown as NormalizedMediaItem[];
    const moviePool: NormalizedMediaItem[] = [
      ...moviePoolRes.items,
      ...trendingMovies.items as unknown as NormalizedMediaItem[],
      ...animeItems.filter((a) => a.type === 'movie')
    ];
    const seriesPool: NormalizedMediaItem[] = [
      ...seriesPoolRes.items,
      ...trendingSeries.items as unknown as NormalizedMediaItem[],
      ...animeItems.filter((a) => a.type === 'series')
    ];
    const activeSeriesIds = seriesPoolRes.activeSeriesIds ?? new Set<string>();

    // CRITICAL — use getOrSetValidated, NOT getOrSet. The validity
    // predicate (`isHeroLineupCacheable` = lineup.length >= 1)
    // guarantees an empty result is NEVER cached for the 24h Hero
    // TTL. A transient TMDB failure on the first request after
    // deploy can no longer freeze the Hero for 24h — the next
    // request recomputes.
    const { value, fromCache } = await getOrSetValidated<HeroLineupResult<NormalizedMediaItem>>(
      key,
      HERO_LINEUP_POLICY,
      (result) => isHeroLineupCacheable(result),
      async () => {
        const result = selectHeroLineup<NormalizedMediaItem>(
          moviePool,
          seriesPool,
          streamingIds,
          activeSeriesIds,
          bucket
        );
        // Server-side diagnostic log — covers BOTH thin (< 6) AND
        // empty (=== 0) lineups so production ops can identify the
        // root cause. Not exposed to the UI.
        const d = result.diagnostics;
        if (d.lineupLength < 6) {
          console.warn(
            `[Hero] thin/empty lineup — reason=${d.reason} fromCache=false ` +
            `bucket=${d.bucket} ` +
            `rawMovies=${d.rawMovies} postBackdropMovies=${d.postBackdropMovies} postFreshnessMovies=${d.postFreshnessMovies} eligibleMovies=${d.eligibleMovies} finalMovies=${d.finalMovies} ` +
            `rawSeries=${d.rawSeries} postBackdropSeries=${d.postBackdropSeries} postFreshnessSeries=${d.postFreshnessSeries} eligibleSeries=${d.eligibleSeries} finalSeries=${d.finalSeries} ` +
            `lineupLength=${d.lineupLength} ` +
            `activeSeriesIds=${activeSeriesIds.size} streamingIds=${streamingIds.size} ` +
            `moviePoolSourceItems=${moviePoolRes.items.length} seriesPoolSourceItems=${seriesPoolRes.items.length} ` +
            `trendingMovies=${trendingMovies.items.length} trendingSeries=${trendingSeries.items.length} trendingAnime=${trendingAnime.items.length}`
          );
        }
        return result;
      }
    );

    // If we served a stale-while-revalidate entry, the cache returned
    // a previously-computed result (which is valid by construction
    // because we never cache invalid). Log this for ops visibility
    // — it confirms the cache is healthy.
    if (fromCache && value.diagnostics.lineupLength < 6) {
      // Should not happen (we don't cache invalid), but log if it
      // does — indicates a bug in the validity predicate.
      console.warn(
        `[Hero] cache returned a thin lineup — reason=${value.diagnostics.reason} ` +
        `bucket=${value.diagnostics.bucket} lineupLength=${value.diagnostics.lineupLength} ` +
        `(this indicates the validity predicate is too permissive — investigate)`
      );
    }

    // Project the lineup to MediaItem[] for the page data.
    return value.lineup.map(toMediaItem);
  } catch (error) {
    console.warn('[Hero] loadHeroLineup failed — returning empty lineup', error);
    return [];
  }
}

export async function loadDiscoverData() {
  // Discover V2: the page is now data-driven — each content section
  // loads its own data client-side via /api/discover/rail. The server
  // load only needs to fetch enough for the hero gallery's featured
  // item (trending movie + series + anime). This keeps SSR fast and
  // avoids N parallel server-side TMDB calls.
  const [
    trendingMovies, trendingSeries, trendingAnime
  ] = await Promise.all([
    loadRail('movie', 'trending'),
    loadRail('series', 'trending'),
    loadRail('anime', 'trending')
  ]);

  const errors = [trendingMovies, trendingSeries, trendingAnime]
    .flatMap((rail) => rail.error ? [rail.error] : []);

  // Hero daily lineup — computed server-side from the trending rails +
  // the India flatrate streaming-id set, cached for ~24h via a daily
  // bucket key. Empty on failure (the DiscoverPage falls back to the
  // legacy createFeaturedItems path when heroItems is empty).
  const heroItems = await loadHeroLineup(trendingMovies, trendingSeries, trendingAnime);

  return {
    movies: trendingMovies.items,
    series: trendingSeries.items,
    anime: trendingAnime.items,
    // The following fields are kept for backward compatibility with
    // any code that still references them, but are now empty — the
    // new DiscoverSection components fetch their own data.
    popularSeries: [],
    popularAnime: [],
    trendingHindiMovies: [],
    trendingRegionalMovies: [],
    topRatedMovies: [],
    topRatedSeries: [],
    topRatedAnime: [],
    newMovies: [],
    genreCollections: [],
    featured: selectFeatured([...trendingMovies.items, ...trendingSeries.items, ...trendingAnime.items]),
    // New: server-selected Hero lineup in strict M/S/M/S/M/S order.
    // DiscoverPage.svelte prefers this over the legacy client-side
    // createFeaturedItems path. May be empty on failure — the
    // DiscoverPage handles the fallback.
    heroItems,
    errorMessage: errors.length ? `${[...new Set(errors)].join(' ')} Check the server catalog configuration and try again.` : undefined
  };
}
