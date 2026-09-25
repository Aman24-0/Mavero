import { collection, discover, popular, selectFeatured, trendingMoviesByLanguages } from './service';
import { toMediaItem } from './presenter';
import { getOrSet } from './cache';
import { getTmdbIndiaFlatrateIds } from './adapters/tmdb';
import { selectHeroLineup, heroDailyBucket } from './hero-select';
import type { CollectionFilters, CollectionSort, ContentType, ContentList } from './types';
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

// 24h TTL + 6h SWR — slightly longer than the standard list policy
// because the lineup is by design stable for one rotation period.
const HERO_LINEUP_POLICY = { ttlMs: 1000 * 60 * 60 * 24, staleWhileRevalidateMs: 1000 * 60 * 60 * 6 };

async function loadHeroLineup(
  trendingMovies: RailResult,
  trendingSeries: RailResult,
  trendingAnime: RailResult
): Promise<MediaItem[]> {
  const bucket = heroDailyBucket();
  const key = `tmdb:hero-lineup:${bucket}`;
  try {
    // The trending rails return MediaItem[] which now carries the
    // additive fields the Hero selector reads (popularity, voteCount,
    // originalLanguage, externalIds, tags, releaseDate). The structural
    // HeroCandidate type accepts MediaItem directly — no cast needed.
    // Anime items have canonical type 'movie' or 'series' (per the
    // getTmdbAnimeMerged contract), so they slot into Movie/Series
    // pools naturally — no separate anime pool needed.
    const moviePool: MediaItem[] = [
      ...trendingMovies.items,
      ...trendingAnime.items.filter((a) => a.type === 'movie')
    ];
    const seriesPool: MediaItem[] = [
      ...trendingSeries.items,
      ...trendingAnime.items.filter((a) => a.type === 'series')
    ];
    // The streaming-id set is fetched separately (it may be the empty
    // set on TMDB failure — the selector still continues with the
    // other signals). Fetched outside the lineup cache so its own
    // list TTL applies (independent of the lineup's 24h TTL).
    let streamingIds: Set<string>;
    try {
      streamingIds = await getTmdbIndiaFlatrateIds(2);
    } catch {
      streamingIds = new Set();
    }
    const { value } = await getOrSet(key, HERO_LINEUP_POLICY, async () => {
      return selectHeroLineup(moviePool, seriesPool, streamingIds, bucket);
    });
    // selectHeroLineup is generic in <T> so it returns the SAME type
    // as its input — MediaItem[] here. No projection needed.
    return value as MediaItem[];
  } catch {
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
