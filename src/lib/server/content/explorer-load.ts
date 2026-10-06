import { collection, discover, popular } from './service';
import { toMediaItem } from './presenter';
import { getOrSetValidated } from './cache';
import { getTmdbHeroMoviePool, getTmdbHeroSeriesPool, getTmdbAnimeMerged, type AnimeGenreConstraint } from './adapters/tmdb';
import { heroDailyBucket, selectSpotlightLineup, SPOTLIGHT_SIZE, type SpotlightResult } from './hero-select';
import { isDiscoverLanguageValue, type CollectionFilters, type ContentType, type ContentList, type DiscoverLanguage, type NormalizedMediaItem } from './types';
import { isExplorerGenre, isExplorerLanguage, isExplorerSort, explorerGenreId, EXPLORER_GENRES, type ExplorerSort } from '$lib/shared/explorer-taxonomy';
import { DESTINATION_ROUTES } from '$lib/shared/content-labels';
import type { MediaItem } from '$data/content';

// ============================================================
// MAVERO — Explorer pages (Movies / TV Shows / Anime redesign).
//
// One loadExplorerData(type, url) server loader powers the three
// Explorer routes; one explorerFeed(type, filters, page) serves the
// client-side progressive/infinite results via /api/explorer/feed.
// Both compose ONLY the existing cached TMDB paths (collection /
// discover / popular / hero pools / merged anime) — zero new backend
// fetching, zero duplicate page implementations, existing TTL/LRU
// caching reused.
//
// Page contract (URL):
//   ?genre=<name>   — validated against the per-type Explorer genre
//                     taxonomy (closed list; invalid values ignored).
//   ?language=<code> — validated against the per-type Explorer
//                     language list (closed; invalid values ignored).
//   ?sort=<value>   — Follow-up task 2 (§10): closed two-value union
//                     (popular | top-rated) — the Show-more target
//                     state for the Popular / Top Rated rails. The
//                     same route/query mechanism the legacy collection
//                     route carried, mapped onto existing services.
//   ?page=<1..20>   — feed page for the SSR seed of the filtered view.
//
//   Unfiltered (no genre/language/sort): spotlight + Popular + Top
//   Rated rails.
//   Filtered (genre and/or language and/or sort): spotlight + the
//   filtered feed page (SSR seed); the client tops up responsively
//   and continues infinitely.
// ============================================================

export type ExplorerFilters = { genre?: string; language?: DiscoverLanguage; sort?: ExplorerSort };

export type ExplorerSection = { key: 'popular' | 'top-rated'; title: string; items: MediaItem[]; showMoreHref: string };

export type ExplorerFeedResult = {
  items: MediaItem[];
  page: number;
  hasNextPage: boolean;
  totalPages: number | undefined;
  /** Set when the upstream catalog failed (vs. genuinely empty results). */
  error?: string;
};

// The feed serves pages 1..20 — the same serving window as the old
// collection contract (MAX_COLLECTION_PAGE). One source of truth.
const MAX_EXPLORER_FEED_PAGE = 20;

export function parseExplorerPage(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= MAX_EXPLORER_FEED_PAGE ? page : 1;
}

export function parseExplorerFilters(url: URL, type: ContentType): ExplorerFilters {
  const genreParam = url.searchParams.get('genre')?.trim();
  const languageParam = url.searchParams.get('language')?.trim();
  const sortParam = url.searchParams.get('sort')?.trim();
  return {
    genre: isExplorerGenre(type, genreParam) ? genreParam : undefined,
    language: isDiscoverLanguageValue(languageParam) && isExplorerLanguage(type, languageParam) ? languageParam : undefined,
    sort: isExplorerSort(sortParam) ? sortParam : undefined
  };
}

export function hasExplorerFilters(filters: ExplorerFilters): boolean {
  return Boolean(filters.genre || (filters.language && filters.language !== 'all') || filters.sort);
}

function explorerErrorMessage(type: ContentType): string {
  const label = type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series';
  return `${label} catalog is temporarily unavailable.`;
}

// ============================================================
// Spotlight — the 6-slide cinematic carousel lineup.
//
// Deterministic + daily-rotating (heroDailyBucket), cached ~24h via
// the versioned daily-bucket key with the same
// getOrSetValidated(empty-is-never-cached) discipline the Discover
// hero uses (v3 lesson — a transient TMDB failure must not freeze
// the spotlight for 24h).
//
// Candidate pools (all existing, all cached):
//   movie  — hero movie pool (now_playing etc.) + trending + popular
//   series — hero series pool (airing_today/on_the_air) + trending + popular
//   anime  — BOTH hero pools filtered to isAnime + trending + popular
// ============================================================

const SPOTLIGHT_CACHE_VERSION = 'v1';
const SPOTLIGHT_POLICY = { ttlMs: 1000 * 60 * 60 * 24, staleWhileRevalidateMs: 1000 * 60 * 60 * 6 };

function dedupeCandidates(items: NormalizedMediaItem[]): NormalizedMediaItem[] {
  const seen = new Set<string>();
  const out: NormalizedMediaItem[] = [];
  for (const item of items) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function toCandidates(list: { items: MediaItem[] }): NormalizedMediaItem[] {
  return list.items as unknown as NormalizedMediaItem[];
}

async function loadSpotlightCandidates(type: ContentType): Promise<{ items: NormalizedMediaItem[]; activeSeriesIds: Set<string> }> {
  const [moviePool, seriesPool, trending, popularRail] = await Promise.all([
    getTmdbHeroMoviePool().catch(() => ({ items: [] as NormalizedMediaItem[] })),
    getTmdbHeroSeriesPool().catch(() => ({ items: [] as NormalizedMediaItem[], activeSeriesIds: new Set<string>() })),
    discover(type, 1).catch(() => null),
    popular(type, 1).catch(() => null)
  ]);
  const activeSeriesIds = seriesPool.activeSeriesIds ?? new Set<string>();

  const trendingItems = trending && trending.source.provider !== 'fixtures' ? trending.items : [];
  const popularItems = popularRail && popularRail.source.provider !== 'fixtures' ? popularRail.items : [];

  if (type === 'movie') {
    return { items: dedupeCandidates([...moviePool.items, ...trendingItems, ...popularItems]), activeSeriesIds };
  }
  if (type === 'series') {
    return { items: dedupeCandidates([...seriesPool.items, ...trendingItems, ...popularItems]), activeSeriesIds };
  }
  // anime — the hero pools are movie/TV-wide; keep the anime-tagged rows
  // (both formats count: anime movies + anime series).
  const animeFromPools = [...moviePool.items, ...seriesPool.items].filter((item) => item.isAnime === true);
  return { items: dedupeCandidates([...animeFromPools, ...trendingItems, ...popularItems]), activeSeriesIds };
}

export async function loadExplorerSpotlight(type: ContentType): Promise<MediaItem[]> {
  const bucket = heroDailyBucket();
  const key = `tmdb:explorer-spotlight:${SPOTLIGHT_CACHE_VERSION}:${type}:${bucket}`;
  try {
    const { value } = await getOrSetValidated<SpotlightResult<NormalizedMediaItem>>(
      key,
      SPOTLIGHT_POLICY,
      (result) => result.spotlight.length >= 1,
      async () => {
        const { items, activeSeriesIds } = await loadSpotlightCandidates(type);
        return selectSpotlightLineup<NormalizedMediaItem>(items, activeSeriesIds, bucket);
      }
    );
    return value.spotlight.slice(0, SPOTLIGHT_SIZE).map(toMediaItem);
  } catch (error) {
    console.warn(`[Explorer] spotlight load failed for ${type} — returning empty lineup`, error);
    return [];
  }
}

// ============================================================
// Filtered feed — the Explorer's progressive result pages.
//
//   movie/series → the existing collection() path with the genre id
//                  resolved per-type and the language filter passed
//                  through (getTmdbCollection's language walk).
//                  Follow-up task 2 (§10): sort=top-rated routes to the
//                  EXISTING 'Top rated' collection ordering; sort=popular
//                  with no genre/language uses the EXISTING popular()
//                  service (the exact service that feeds the Popular
//                  rail — the Show-more continuation is the same data).
//   anime        → the existing merged anime path with the per-side
//                  genre constraint. Language: the merged path is
//                  'ja' by construction; 'all'/'ja' are equivalent
//                  and other codes cannot reach here (closed union).
//                  sort=top-rated maps to the merged 'top-rated' mode
//                  (the same mode the Top Rated anime rail uses).
// ============================================================

export async function explorerFeed(type: ContentType, filters: ExplorerFilters, page: number): Promise<ExplorerFeedResult> {
  const safePage = Math.max(1, Math.min(page, MAX_EXPLORER_FEED_PAGE));
  try {
    if (type === 'anime') {
      const genreDef = filters.genre ? EXPLORER_GENRES.anime.find((genre) => genre.name === filters.genre) : undefined;
      const constraint: AnimeGenreConstraint | undefined = genreDef
        ? { movieGenreId: genreDef.movieId, tvGenreId: genreDef.seriesId }
        : undefined;
      const result: ContentList = await getTmdbAnimeMerged(filters.sort === 'top-rated' ? 'top-rated' : 'popularity', safePage, constraint);
      if (result.source.provider === 'fixtures') {
        return { items: [], page: safePage, hasNextPage: false, totalPages: undefined, error: explorerErrorMessage(type) };
      }
      return {
        items: result.items.map(toMediaItem),
        page: result.page ?? safePage,
        hasNextPage: result.hasNextPage,
        totalPages: undefined
      };
    }
    // Popular Show-more continuation (no genre/language narrowing):
    // the exact popular() service that feeds the Popular rail — the
    // full collection state the "Show more →" CTA promises.
    if (filters.sort === 'popular' && !filters.genre && !(filters.language && filters.language !== 'all')) {
      const result = await popular(type, safePage);
      if (result.source.provider === 'fixtures') {
        return { items: [], page: safePage, hasNextPage: false, totalPages: undefined, error: explorerErrorMessage(type) };
      }
      return {
        items: result.items.map(toMediaItem),
        page: result.page ?? safePage,
        hasNextPage: result.hasNextPage,
        totalPages: undefined
      };
    }
    const genreId = filters.genre ? explorerGenreId(type, filters.genre) : undefined;
    const collectionFilters: CollectionFilters = {
      ...(genreId !== undefined ? { genre: String(genreId) } : {}),
      sort: filters.sort === 'top-rated' ? 'Top rated' : 'For you',
      ...(filters.language && filters.language !== 'all' ? { language: filters.language } : {})
    };
    const result = await collection(type, safePage, collectionFilters);
    if (result.source.provider === 'fixtures') {
      return { items: [], page: safePage, hasNextPage: false, totalPages: undefined, error: explorerErrorMessage(type) };
    }
    return {
      items: result.items.map(toMediaItem),
      page: result.page ?? safePage,
      hasNextPage: result.hasNextPage,
      totalPages: typeof result.totalPages === 'number' ? Math.min(Math.max(result.totalPages, safePage), MAX_EXPLORER_FEED_PAGE) : undefined
    };
  } catch {
    return { items: [], page: safePage, hasNextPage: false, totalPages: undefined, error: explorerErrorMessage(type) };
  }
}

// ============================================================
// Unfiltered sections — Popular + Top Rated, cross-section dedup.
//
// "Filter chips ke neeche ye section rahenge par kisi section me title
// repeat na ho": a title that already appears in an EARLIER section
// (or in the spotlight) is not repeated in a later section; a section
// left thin by dedup is topped up with eligible non-duplicate titles
// (trending rail — a distinct, already-cached source).
// ============================================================

const SECTION_TITLES: Record<ContentType, { popular: string; topRated: string }> = {
  movie: { popular: 'Popular movies', topRated: 'Top rated movies' },
  series: { popular: 'Popular TV shows', topRated: 'Top rated TV shows' },
  anime: { popular: 'Popular anime', topRated: 'Top rated anime' }
};

// Minimum items a section keeps before the trending top-up kicks in.
const MIN_SECTION_ITEMS = 10;

async function loadSectionRail(type: ContentType, kind: 'popular' | 'top-rated'): Promise<{ items: MediaItem[]; error?: string }> {
  try {
    if (kind === 'popular') {
      const result = await popular(type, 1);
      if (result.source.provider === 'fixtures') return { items: [], error: explorerErrorMessage(type) };
      return { items: result.items.map(toMediaItem) };
    }
    const result = await collection(type, 1, { sort: 'Top rated' });
    if (result.source.provider === 'fixtures') return { items: [], error: explorerErrorMessage(type) };
    return { items: result.items.map(toMediaItem) };
  } catch {
    return { items: [], error: explorerErrorMessage(type) };
  }
}

async function loadTrendingForTopUp(type: ContentType): Promise<MediaItem[]> {
  try {
    const result = await discover(type, 1);
    if (result.source.provider === 'fixtures') return [];
    return result.items.map(toMediaItem);
  } catch {
    return [];
  }
}

function itemKey(item: MediaItem): string {
  return `${item.type}:${item.id}`;
}

function excludeSeen(items: MediaItem[], seen: Set<string>): MediaItem[] {
  return items.filter((item) => !seen.has(itemKey(item)));
}

async function loadExplorerSections(type: ContentType): Promise<{ sections: ExplorerSection[]; errorMessage: string | undefined }> {
  const [popularRail, topRatedRail, trending] = await Promise.all([
    loadSectionRail(type, 'popular'),
    loadSectionRail(type, 'top-rated'),
    loadTrendingForTopUp(type)
  ]);

  const seen = new Set<string>();
  const sections: ExplorerSection[] = [];

  // Popular first (intentional ordering — the broadest entry rail).
  // Follow-up task 2 (§10): each section carries its canonical
  // Show-more target — the Explorer route's own ?sort= state over the
  // SAME service that feeds the rail (no new endpoint, the legacy
  // collection-route URL mechanism restored).
  const popularItems = excludeSeen(popularRail.items, seen);
  popularItems.forEach((item) => seen.add(itemKey(item)));
  if (popularItems.length > 0) {
    sections.push({ key: 'popular', title: SECTION_TITLES[type].popular, items: popularItems, showMoreHref: `${DESTINATION_ROUTES[type]}?sort=popular` });
  }

  // Top rated — deduped against Popular + spotlight-independent.
  let topRatedItems = excludeSeen(topRatedRail.items, seen);
  if (topRatedItems.length > 0 && topRatedItems.length < MIN_SECTION_ITEMS && trending.length > 0) {
    // Top-up with eligible non-duplicates (trending), preserving the
    // top-rated ordering ahead of the fill.
    const fill = excludeSeen(trending, new Set([...seen, ...topRatedItems.map(itemKey)]));
    topRatedItems = [...topRatedItems, ...fill].slice(0, MIN_SECTION_ITEMS);
  }
  topRatedItems.forEach((item) => seen.add(itemKey(item)));
  if (topRatedItems.length > 0) {
    sections.push({ key: 'top-rated', title: SECTION_TITLES[type].topRated, items: topRatedItems, showMoreHref: `${DESTINATION_ROUTES[type]}?sort=top-rated` });
  }

  const errorMessage = popularRail.error && topRatedRail.error ? `${popularRail.error} ${topRatedRail.error} Check the server catalog configuration and try again.` : undefined;
  return { sections, errorMessage };
}

// ============================================================
// The page loader.
// ============================================================

export async function loadExplorerData(type: ContentType, url: URL) {
  const page = parseExplorerPage(url.searchParams.get('page'));
  const filters = parseExplorerFilters(url, type);
  const filtered = hasExplorerFilters(filters);

  const spotlight = await loadExplorerSpotlight(type);

  if (filtered) {
    const feed = await explorerFeed(type, filters, page);
    return {
      type,
      spotlight,
      sections: [] as ExplorerSection[],
      filters,
      page: feed.page,
      hasNextPage: feed.hasNextPage,
      totalPages: feed.totalPages,
      filteredItems: feed.items,
      errorMessage: feed.error
    };
  }

  const { sections, errorMessage } = await loadExplorerSections(type);
  return {
    type,
    spotlight,
    sections,
    filters,
    page,
    hasNextPage: false,
    totalPages: undefined as number | undefined,
    filteredItems: [] as MediaItem[],
    errorMessage
  };
}
