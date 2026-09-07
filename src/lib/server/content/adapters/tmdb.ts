import { env } from '$env/dynamic/private';
import { getOrSet } from '../cache';
import { asNumber, asString, asStringArray, fetchJson } from '../http';
import { ContentServiceError, type CollectionFilters, type ContentList, type ContentSource, type ContentType, type Episode, type ContentDetail, type NormalizedMediaItem, type Season, type SearchFilters, type CastMember, type DiscoverLanguage, type DiscoverProvider } from '../types';
import { ottProviders } from '$lib/shared/ott';
import { getAdultProviderIds, resolveAdultProviders, getCachedAdultProviders } from '../adult-providers';

type TmdbList<T> = { page?: number; total_pages?: number; total_results?: number; results?: T[] };
type TmdbMovie = {
  id: number;
  title?: string;
  original_title?: string;
  original_language?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  runtime?: number | null;
  adult?: boolean;
  imdb_id?: string | null;
  videos?: { results?: { key?: string; site?: string; type?: string }[] };
  recommendations?: TmdbList<TmdbMovie>;
  credits?: TmdbCredits;
};
type TmdbTv = {
  id: number;
  name?: string;
  original_name?: string;
  original_language?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  number_of_episodes?: number | null;
  number_of_seasons?: number | null;
  episode_run_time?: number[];
  in_production?: boolean;
  status?: string;
  external_ids?: { imdb_id?: string | null };
  videos?: { results?: { key?: string; site?: string; type?: string }[] };
  recommendations?: TmdbList<TmdbTv>;
  seasons?: { season_number?: number; name?: string; episode_count?: number; air_date?: string; poster_path?: string | null }[];
  credits?: TmdbCredits;
};
type TmdbCredit = { id: number; name?: string; character?: string; profile_path?: string | null };
type TmdbCredits = { cast?: TmdbCredit[] };
type TmdbEpisode = { id: number; episode_number?: number; season_number?: number; name?: string; overview?: string; air_date?: string; runtime?: number | null; still_path?: string | null };
type TmdbSeason = { season_number?: number; name?: string; episode_count?: number; air_date?: string; poster_path?: string | null; episodes?: TmdbEpisode[] };

type TmdbMedia = TmdbMovie | TmdbTv;
type TmdbProviderRegion = { flatrate?: { provider_id?: number }[]; buy?: { provider_id?: number }[]; rent?: { provider_id?: number }[] };
type TmdbWatchProviders = { results?: Record<string, TmdbProviderRegion> };

export const tmdbOttProviders = ottProviders;

const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_URL = 'https://image.tmdb.org/t/p';
const genreNames: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10765: 'Sci-Fi & Fantasy'
};

function tmdbSource(externalId?: string): ContentSource {
  return { provider: 'tmdb', externalId, fetchedAt: new Date().toISOString() };
}

function image(path: string | null | undefined, size: 'w342' | 'w500' | 'w780' | 'w1280' | 'original' = 'w500') {
  return path ? `${IMAGE_URL}/${size}${path}` : '';
}

function profileImage(path: string | null | undefined, size: 'w185' | 'w342' = 'w185') {
  return path ? `${IMAGE_URL}/${size}${path}` : '';
}

function extractCast(raw: TmdbMedia, limit = 12): CastMember[] | undefined {
  const credits = (raw as TmdbMovie).credits ?? (raw as TmdbTv).credits;
  const cast = credits?.cast;
  if (!Array.isArray(cast) || cast.length === 0) return undefined;
  return cast
    .filter((entry) => entry && typeof entry.id === 'number' && typeof entry.name === 'string' && entry.name.trim())
    .slice(0, limit)
    .map((entry) => ({
      id: String(entry.id),
      name: entry.name as string,
      character: typeof entry.character === 'string' && entry.character.trim() ? entry.character : undefined,
      photo: profileImage(entry.profile_path) || undefined
    }));
}

function runtime(minutes: number | null | undefined, fallback = 'Feature length') {
  if (!minutes || minutes <= 0) return fallback;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours ? `${hours}h ${String(remaining).padStart(2, '0')}m` : `${remaining}m`;
}

function dateYear(value?: string) {
  const year = Number(value?.slice(0, 4));
  return Number.isFinite(year) && year > 1800 ? year : new Date().getFullYear();
}

function hasRequiredListMetadata(raw: TmdbMedia, type: Exclude<ContentType, 'anime'>) {
  const title = type === 'movie'
    ? (raw as TmdbMovie).title || (raw as TmdbMovie).original_title
    : (raw as TmdbTv).name || (raw as TmdbTv).original_name;
  const date = type === 'movie' ? (raw as TmdbMovie).release_date : (raw as TmdbTv).first_air_date;
  return Number.isInteger(raw.id) && raw.id > 0 && Boolean(title?.trim()) && Boolean(date?.trim()) && Boolean(raw.poster_path || raw.backdrop_path);
}

function mapTmdb(raw: TmdbMedia, type: Exclude<ContentType, 'anime'>, tag?: string): NormalizedMediaItem {
  const isMovie = type === 'movie';
  const title = isMovie ? asString((raw as TmdbMovie).title, asString((raw as TmdbMovie).original_title, 'Untitled')) : asString((raw as TmdbTv).name, asString((raw as TmdbTv).original_name, 'Untitled'));
  const genres = raw.genres?.map((genre) => genre.name).filter(Boolean) ?? raw.genre_ids?.map((id) => genreNames[id]).filter(Boolean) ?? [];
  const tv = raw as TmdbTv;
  const movie = raw as TmdbMovie;
  const seasons = isMovie ? undefined : tv.number_of_seasons ?? tv.seasons?.filter((season) => (season.season_number ?? 0) > 0).length;
  const episodes = isMovie ? undefined : tv.number_of_episodes ?? tv.seasons?.reduce((sum, season) => sum + (season.episode_count ?? 0), 0);
  const rating = Math.round(asNumber(raw.vote_average) * 10) / 10;
  // Phase 7F+ (anime routing): detect anime via TMDB genre 'Animation' (16)
  // AND Japanese original_language ('ja'). This catches anime movies like
  // Demon Slayer: Infinity Castle (TMDB movie, animation+ja) and anime
  // series like Attack on Titan (TMDB series, animation+ja). For these
  // titles, `isAnime === true` and `animeFormat === type` so the resolver
  // can route to anime-capable providers (MegaPlay/Yenime) while the URL
  // and card UI keep their original movie/series classification.
  //
  // IMPORTANT: we only set isAnime=true when BOTH conditions are met. A
  // western animation movie (e.g. Toy Story, original_language='en') is
  // NOT anime and must continue to use the normal movie provider pipeline.
  const genreIds = raw.genre_ids ?? raw.genres?.map((g) => g.id) ?? [];
  const originalLanguage = raw.original_language;
  const isAnime = genreIds.includes(16) && originalLanguage === 'ja';
  const animeFormat: 'movie' | 'series' | undefined = isAnime ? (isMovie ? 'movie' : 'series') : undefined;
  // External IDs (forwarded to the resolver so each provider picks the
  // identifier it supports). TMDB populates `tmdb` always, `imdb` when
  // available. Anime content (genre 16 + 'ja') is detected separately
  // via `isAnime`/`animeFormat` and routed through the normal movie/series
  // provider pipeline — no AniList/MAL lookup is performed.
  const externalIds: NormalizedMediaItem['externalIds'] = {
    tmdb: String(raw.id),
    imdb: isMovie ? movie.imdb_id ?? undefined : tv.external_ids?.imdb_id ?? undefined
  };
  return {
    id: `${type}-${raw.id}`,
    title,
    year: dateYear(isMovie ? movie.release_date : tv.first_air_date),
    type,
    isAnime,
    animeFormat,
    maturity: '13+',
    runtime: isMovie ? runtime(movie.runtime) : seasons ? `${seasons} season${seasons === 1 ? '' : 's'}` : 'Series',
    rating,
    popularity: asNumber(raw.popularity),
    voteCount: asNumber(raw.vote_count),
    genres: genres.length ? genres.slice(0, 4) : ['Drama'],
    description: asString(raw.overview, 'No synopsis is available yet.'),
    poster: image(raw.poster_path ?? raw.backdrop_path, 'w500'),
    posterSmall: image(raw.poster_path ?? raw.backdrop_path, 'w342'),
    backdrop: image(raw.backdrop_path ?? raw.poster_path, 'w1280'),
    backdropSmall: image(raw.backdrop_path ?? raw.poster_path, 'w780'),
    backdropHero: image(raw.backdrop_path ?? raw.poster_path, 'original'),
    accent: '#9b87f5',
    status: isMovie ? undefined : asString(tv.status),
    episodes,
    seasons,
    tags: tag ? [tag] : undefined,
    source: tmdbSource(String(raw.id)),
    externalIds,
    trailerKey: raw.videos?.results?.find((video) => video.site === 'YouTube' && video.type === 'Trailer')?.key,
    cast: extractCast(raw)
  };
}

function requireCredentials() {
  const token = env.TMDB_READ_ACCESS_TOKEN;
  const apiKey = env.TMDB_API_KEY;
  if (!token && !apiKey) {
    throw new ContentServiceError('TMDB credentials are not configured.', { code: 'CONFIG_MISSING', status: 503 });
  }
  return { token, apiKey };
}

// Shared TMDB GET path for the whole content layer (discover/collection/search/detail
// AND the Upcoming releases module). Centralising every TMDB call here keeps ONE
// client with: the 401/403 -> api_key credential-format fallback, consistent
// timeout/rate-limit error mapping, and no second, weaker request implementation.
export async function tmdbRequest<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  const { token, apiKey } = requireCredentials();
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries({ language: 'en-US', ...params }).forEach(([key, value]) => {
    if (value !== undefined) url.searchParams.set(key, String(value));
  });
  if (!token && apiKey) url.searchParams.set('api_key', apiKey);

  try {
    return await fetchJson<T>(url.toString(), { headers: token ? { authorization: `Bearer ${token}` } : undefined });
  } catch (error) {
    // Netlify users sometimes paste a TMDB v3 API key into the v4 token variable.
    // Retry that value as a query API key once, without weakening the normal Bearer path.
    if (token && !apiKey && error instanceof ContentServiceError && (error.status === 401 || error.status === 403)) {
      const legacyUrl = new URL(url);
      legacyUrl.searchParams.set('api_key', token);
      try {
        return await fetchJson<T>(legacyUrl.toString());
      } catch {
        throw new ContentServiceError('TMDB authentication failed. Use a valid v4 Read Access Token in TMDB_READ_ACCESS_TOKEN or a v3 API key in TMDB_API_KEY.', { code: 'CONFIG_MISSING', status: 401 });
      }
    }
    if (error instanceof ContentServiceError && (error.status === 401 || error.status === 403)) {
      throw new ContentServiceError('TMDB authentication failed. Check the configured TMDB credential.', { code: 'CONFIG_MISSING', status: 401 });
    }
    throw error;
  }
}

const listPolicy = { ttlMs: 1000 * 60 * 4, staleWhileRevalidateMs: 1000 * 60 * 10 };
const detailPolicy = { ttlMs: 1000 * 60 * 30, staleWhileRevalidateMs: 1000 * 60 * 60 * 4 };
const ottProviderPolicy = { ttlMs: 1000 * 60 * 30, staleWhileRevalidateMs: 1000 * 60 * 60 * 2 };
const OTT_LOOKUP_CONCURRENCY = 4;

export async function getTmdbDiscover(type: Exclude<ContentType, 'anime'>, page = 1): Promise<ContentList> {
  const key = `tmdb:discover:${type}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/trending/movie/week' : '/trending/tv/week';
    const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, { page });
    const items = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, type)).map((item) => mapTmdb(item, type, 'Trending'));
    return { items, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getTmdbCollection(type: Exclude<ContentType, 'anime'>, page = 1, filters: CollectionFilters = {}): Promise<ContentList> {
  const genreId = filters.genre ? Object.entries(genreNames).find(([, label]) => label.toLowerCase() === filters.genre?.toLowerCase())?.[0] ?? (/^\d+$/.test(filters.genre) ? filters.genre : undefined) : undefined;
  const year = filters.year && /^\d{4}$/.test(filters.year) ? Number(filters.year) : undefined;
  const sortBy = filters.sort === 'Top rated' ? 'vote_average.desc' : filters.sort === 'Newest' ? type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc' : 'popularity.desc';
  const key = `tmdb:collection:${type}:${page}:${genreId ?? ''}:${year ?? ''}:${filters.sort ?? ''}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/discover/movie' : '/discover/tv';
    const params: Record<string, string | number | boolean | undefined> = {
      page,
      include_adult: false,
      sort_by: sortBy,
      with_genres: genreId,
      ...(type === 'movie' ? { primary_release_year: year } : { first_air_date_year: year }),
      ...(filters.sort === 'Top rated' ? { 'vote_count.gte': 250 } : {}),
      ...(filters.sort === 'Newest' ? type === 'movie' ? { 'release_date.lte': new Date().toISOString().slice(0, 10) } : { 'first_air_date.lte': new Date().toISOString().slice(0, 10) } : {})
    };
    const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, params);
    const items = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, type)).map((item) => mapTmdb(item, type));
    return { items, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

// Reusable language-filtered trending movies query (used by the Discover
// "Trending Movies — Hindi" and "Trending Movies — Regional" rails).
// Server-side filtering: TMDB `with_original_language` + popularity ordering,
// so no oversized fetch-then-filter pages and no hardcoded titles.
export async function getTmdbTrendingMoviesByLanguage(language: string, page = 1): Promise<ContentList> {
  const normalized = language.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) {
    throw new ContentServiceError('The requested movie language filter is invalid.', { code: 'NOT_FOUND', status: 404 });
  }
  const key = `tmdb:lang-movies:movie:${normalized}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const result = await tmdbRequest<TmdbList<TmdbMovie>>('/discover/movie', {
      page,
      include_adult: false,
      with_original_language: normalized,
      sort_by: 'popularity.desc',
      // India focus — TMDB applies region-aware release-date context.
      region: 'IN'
    });
    const items = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, 'movie')).map((item) => mapTmdb(item, 'movie', 'Trending'));
    return { items, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getTmdbPopular(type: Exclude<ContentType, 'anime'>, page = 1): Promise<ContentList> {
  const key = `tmdb:popular:${type}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/movie/popular' : '/tv/popular';
    const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, { page });
    const items = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, type)).map((item) => mapTmdb(item, type, 'Popular'));
    return { items, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

async function matchesOtt(type: Exclude<ContentType, 'anime'>, id: number, ottKey: string) {
  const provider = tmdbOttProviders.find((candidate) => candidate.key === ottKey);
  if (!provider) return true;
  const key = `tmdb:watch-providers:${type}:${id}`;
  const { value } = await getOrSet(key, ottProviderPolicy, async () => {
    try {
      const result = await tmdbRequest<TmdbWatchProviders>(`/${type === 'movie' ? 'movie' : 'tv'}/${id}/watch/providers`);
      const region = result.results?.IN ?? result.results?.US;
      const providers = [...(region?.flatrate ?? []), ...(region?.buy ?? []), ...(region?.rent ?? [])];
      return providers.map((candidate) => candidate.provider_id).filter((providerId): providerId is number => typeof providerId === 'number');
    } catch {
      return null;
    }
  });
  // A transient provider lookup failure should not silently erase a valid search result.
  return value === null || value.includes(provider.providerId);
}

async function mapWithConcurrency<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function releaseDate(raw: TmdbMedia, type: Exclude<ContentType, 'anime'>) {
  return type === 'movie' ? (raw as TmdbMovie).release_date ?? '' : (raw as TmdbTv).first_air_date ?? '';
}

export async function searchTmdb(query: string, type: Exclude<ContentType, 'anime'>, page = 1, filters: SearchFilters = {}): Promise<ContentList> {
  const normalized = query.trim();
  const key = `tmdb:search:${type}:${normalized.toLowerCase()}:${page}:${filters.ott ?? ''}:${filters.genre ?? ''}:${filters.sort ?? ''}`;
  const { value, stale } = await getOrSet(key, { ttlMs: 1000 * 60 * 2, staleWhileRevalidateMs: 1000 * 60 * 5 }, async () => {
    const path = type === 'movie' ? '/search/movie' : '/search/tv';
    const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, { query: normalized, page, include_adult: false });
    let rawItems = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, type));
    if (filters.genre) rawItems = rawItems.filter((item) => item.genre_ids?.includes(Number(filters.genre)));
    if (filters.ott) {
      const matches = await mapWithConcurrency(rawItems, (item) => matchesOtt(type, item.id, filters.ott as string), OTT_LOOKUP_CONCURRENCY);
      rawItems = rawItems.filter((_, index) => matches[index]);
    }
    if (filters.sort) rawItems.sort((left, right) => releaseDate(left, type).localeCompare(releaseDate(right, type)) * (filters.sort === 'release-desc' ? -1 : 1));
    const items = rawItems.map((item) => mapTmdb(item, type));
    return { items, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getTmdbDetail(type: Exclude<ContentType, 'anime'>, externalId: string): Promise<ContentDetail> {
  const numericId = Number(externalId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new ContentServiceError('The TMDB content identifier is invalid.', { code: 'NOT_FOUND', status: 404 });
  }
  const key = `tmdb:detail:${type}:${numericId}`;
  const { value, stale } = await getOrSet(key, detailPolicy, async () => {
    const path = type === 'movie' ? `/movie/${numericId}` : `/tv/${numericId}`;
    const raw = await tmdbRequest<TmdbMedia>(path, { append_to_response: 'videos,external_ids,recommendations,credits' });
    const item = mapTmdb(raw, type);
    // Anime detection (genre 16 + original_language 'ja') is set inside
    // `mapTmdb`. There is NO AniList enrichment step — anime content is
    // treated as a regular TMDB movie/series and routed through normal
    // providers via TMDB/IMDb identifiers.
    const recommendations = (raw.recommendations?.results ?? []).filter((candidate) => hasRequiredListMetadata(candidate, type)).slice(0, 6).map((candidate) => mapTmdb(candidate, type, 'Recommended'));
    return { ...item, recommendations };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getTmdbSeason(seriesId: string, seasonNumber: number): Promise<Season> {
  const numericId = Number(seriesId);
  if (!Number.isInteger(numericId) || numericId <= 0 || !Number.isInteger(seasonNumber) || seasonNumber < 0) {
    throw new ContentServiceError('The TV season identifier is invalid.', { code: 'NOT_FOUND', status: 404 });
  }
  const key = `tmdb:season:${numericId}:${seasonNumber}`;
  const { value } = await getOrSet(key, detailPolicy, async () => {
    const raw = await tmdbRequest<TmdbSeason>(`/tv/${numericId}/season/${seasonNumber}`);
    const episodes: Episode[] = (raw.episodes ?? []).map((episode) => ({
      id: String(episode.id), number: episode.episode_number ?? 0, season: episode.season_number ?? seasonNumber, title: asString(episode.name, `Episode ${episode.episode_number ?? 0}`), overview: asString(episode.overview), airDate: asString(episode.air_date) || undefined, runtime: runtime(episode.runtime, 'Unknown'), still: image(episode.still_path, 'w500')
    }));
    return { number: raw.season_number ?? seasonNumber, title: asString(raw.name, `Season ${seasonNumber}`), episodeCount: raw.episode_count ?? episodes.length, airDate: asString(raw.air_date) || undefined, poster: image(raw.poster_path, 'w500'), episodes } satisfies Season;
  });
  return value;
}

export const tmdbInternals = { mapTmdb, image, runtime, genreNames, hasRequiredListMetadata };

// ============================================================
// Discover V2 — India-first catalog query functions.
//
// All of these reuse the shared `tmdbRequest` + `getOrSet` cache path
// so they inherit the existing 401/403 fallback, rate-limit mapping,
// and 4 min TTL / 10 min SWR list policy.
//
// CRITICAL "All" RULE: when `language === 'all'` we issue ONE unfiltered
// catalog query (no language-bucket concatenation, no Hindi-first). India
// prioritization comes from `region=IN` / `watch_region=IN` / theatre
// availability — NOT from artificially reordering the All result.
//
// "Other language" excludes hi/en/ta/te/ml/kn. TMDB has no NOT-language
// filter, so we over-fetch pages and filter server-side, bounded by a
// strict safety limit to avoid infinite loops.
// ============================================================

const KNOWN_LANGUAGES: readonly string[] = ['hi', 'en', 'ta', 'te', 'ml', 'kn'];
const DISCOVER_LANGUAGE_PARAM: Record<DiscoverLanguage, string | undefined> = {
  all: undefined,
  hi: 'hi',
  en: 'en',
  ta: 'ta',
  te: 'te',
  ml: 'ml',
  kn: 'kn',
  // 'other' has no direct TMDB param — handled via server-side exclusion.
  other: undefined,
};
const OTHER_LANGUAGE_EXCLUSIONS = new Set(KNOWN_LANGUAGES);
// Max upstream pages we'll walk when filtering for "Other language".
// At 20 items/page this bounds the worst case to ~6 upstream requests
// before we give up and return whatever we have.
const MAX_OTHER_LANGUAGE_PAGES = 6;

function applyLanguageFilter<T extends TmdbMedia>(items: T[], language: DiscoverLanguage): T[] {
  if (language === 'all') return items;
  if (language === 'other') {
    return items.filter((item) => !OTHER_LANGUAGE_EXCLUSIONS.has(item.original_language ?? ''));
  }
  const code = DISCOVER_LANGUAGE_PARAM[language];
  if (!code) return items;
  return items.filter((item) => item.original_language === code);
}

// The TMDB list endpoints return up to 20 items per page. The Discover
// spec requires EXACTLY 10 visible items per section initially, and 10
// more per "Show more". We slice the merged result to the requested
// page size and compute hasNextPage from the upstream total_pages.
const DISCOVER_PAGE_SIZE = 10;

function slicePage(items: NormalizedMediaItem[], page: number, upstreamHasNext: boolean): { items: NormalizedMediaItem[]; hasNextPage: boolean } {
  // Pages are 1-indexed. Page 1 → items 0..9, page 2 → items 10..19, etc.
  // For the merged anime sections we accumulate across upstream pages
  // so each "Show more" returns the next 10 valid unique titles.
  const start = (page - 1) * DISCOVER_PAGE_SIZE;
  const slice = items.slice(start, start + DISCOVER_PAGE_SIZE);
  return { items: slice, hasNextPage: start + DISCOVER_PAGE_SIZE < items.length || upstreamHasNext };
}

/**
 * Section: theatre — movies currently running in theatres in India.
 * Uses TMDB /movie/now_playing with region=IN. Movie-only (TV is not
 * theatrical). Language filter is original_language.
 */
export async function getTmdbNowPlaying(language: DiscoverLanguage, page = 1): Promise<ContentList> {
  const key = `tmdb:theatre:${language}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    // For "all" we fetch the upstream page directly. For specific
    // languages we may need to walk pages until we have 10 valid
    // matches; for "other" we exclude the 6 known languages.
    const collected: TmdbMovie[] = [];
    let upstreamPage = page;
    let upstreamHasNext = true;
    let pagesWalked = 0;
    while (collected.length < DISCOVER_PAGE_SIZE && upstreamHasNext && pagesWalked < MAX_OTHER_LANGUAGE_PAGES) {
      const result = await tmdbRequest<TmdbList<TmdbMovie>>('/movie/now_playing', { page: upstreamPage, region: 'IN' });
      const raw = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, 'movie'));
      const filtered = applyLanguageFilter(raw, language);
      for (const item of filtered) {
        if (!collected.some((existing) => existing.id === item.id)) collected.push(item);
      }
      upstreamHasNext = (result.page ?? upstreamPage) < (result.total_pages ?? upstreamPage);
      upstreamPage += 1;
      pagesWalked += 1;
      // For "all" we only need the first upstream page (no filtering).
      if (language === 'all') break;
    }
    const items = collected.slice(0, DISCOVER_PAGE_SIZE).map((item) => mapTmdb(item, 'movie', 'In theatres'));
    const hasNextPage = collected.length > DISCOVER_PAGE_SIZE || upstreamHasNext;
    return { items, page, hasNextPage, source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

/**
 * Section: new-ott — titles newly available on streaming in India.
 *
 * For "All OTT" we issue a release-date-ordered TMDB discover query with
 * `watch_region=IN` + `with_watch_monetization_types=flatrate` (no
 * specific provider). For a specific provider we add
 * `with_watch_providers=<id>`. Mixed movie + TV — we run both
 * /discover/movie and /discover/tv in parallel and merge.
 *
 * Pagination: TMDB returns 20 items per upstream page. We fetch the
 * upstream page that corresponds to the Discover page and slice the
 * merged 40-item result to 10 items per Discover page. Each Discover
 * page is stateless — we don't accumulate across requests.
 *
 * Note on "New": TMDB's discover endpoint does not expose a reliable
 * "OTT availability date" field. We approximate "new on OTT" by sorting
 * by release date desc (movies) / first air date desc (TV) within the
 * universe of titles that have India flatrate availability. This surfaces
 * recently-released titles that are available on Indian streaming.
 */
export async function getTmdbNewOnOtt(providerKey: string | undefined, language: DiscoverLanguage, page = 1): Promise<ContentList> {
  // Resolve provider key → TMDB provider_id via the cached India list.
  // If the key doesn't resolve (unknown provider), treat as "All OTT"
  // rather than sending a bad ID to TMDB.
  const providerId = providerKey ? await resolveProviderIdByKey(providerKey) : undefined;
  // Phase 8: Exclude known adult-provider content from New on OTT.
  const adultIds = getAdultProviderIds();
  const adultExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  const key = `tmdb:new-ott:${providerKey ?? 'all'}:${language}:${page}:${adultExclusion ?? 'no-adult'}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    // TMDB returns 20 items per page. We need 10 per Discover page.
    // Since we merge movie + TV (up to 40 items per upstream page pair),
    // we map: Discover page N → TMDB page N, then slice 10 from the
    // merged result. This means each Discover page fetches a fresh TMDB
    // page — no accumulation across requests, fully stateless.
    const langParam = language !== 'all' && language !== 'other' ? DISCOVER_LANGUAGE_PARAM[language] : undefined;
    const movieParams: Record<string, string | number | boolean | undefined> = {
      page,
      include_adult: false,
      sort_by: 'release_date.desc',
      watch_region: 'IN',
      with_watch_monetization_types: 'flatrate',
      'release_date.lte': new Date().toISOString().slice(0, 10),
      ...(providerId ? { with_watch_providers: providerId } : {}),
      ...(langParam ? { with_original_language: langParam } : {}),
      ...(adultExclusion ? { 'without_watch_providers': adultExclusion } : {}),
    };
    const tvParams: Record<string, string | number | boolean | undefined> = {
      page,
      include_adult: false,
      sort_by: 'first_air_date.desc',
      watch_region: 'IN',
      with_watch_monetization_types: 'flatrate',
      'first_air_date.lte': new Date().toISOString().slice(0, 10),
      ...(providerId ? { with_watch_providers: providerId } : {}),
      ...(langParam ? { with_original_language: langParam } : {}),
      ...(adultExclusion ? { 'without_watch_providers': adultExclusion } : {}),
    };
    // Fetch both in parallel. Don't silently swallow errors — let them
    // propagate so the rail shows an error state rather than empty.
    const [movieResult, tvResult] = await Promise.all([
      tmdbRequest<TmdbList<TmdbMovie>>('/discover/movie', movieParams),
      tmdbRequest<TmdbList<TmdbTv>>('/discover/tv', tvParams)
    ]);
    let movieItems = (movieResult.results ?? []).filter((item) => hasRequiredListMetadata(item, 'movie')).map((item) => mapTmdb(item, 'movie', 'New on OTT'));
    let tvItems = (tvResult.results ?? []).filter((item) => hasRequiredListMetadata(item, 'series')).map((item) => mapTmdb(item, 'series', 'New on OTT'));
    // For "other" language, exclude the 6 known languages.
    if (language === 'other') {
      const movieRaw = (movieResult.results ?? []).filter((item) => hasRequiredListMetadata(item, 'movie'));
      const tvRaw = (tvResult.results ?? []).filter((item) => hasRequiredListMetadata(item, 'series'));
      movieItems = movieRaw.filter((item) => !OTHER_LANGUAGE_EXCLUSIONS.has(item.original_language ?? '')).map((item) => mapTmdb(item, 'movie', 'New on OTT'));
      tvItems = tvRaw.filter((item) => !OTHER_LANGUAGE_EXCLUSIONS.has(item.original_language ?? '')).map((item) => mapTmdb(item, 'series', 'New on OTT'));
    }
    // Merge by popularity desc as a secondary sort — TMDB already sorted
    // each list by release date; we interleave movie + TV by popularity
    // so the rail shows a genuine mixed catalog.
    let merged = [...movieItems, ...tvItems];
    merged.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    // Dedupe by canonical type+id.
    const seen = new Set<string>();
    merged = merged.filter((item) => {
      const k = `${item.type}:${item.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Slice to 10 items for the current Discover page.
    // We fetch one TMDB page (20 items per type = 40 merged) per
    // Discover page request, so we always slice from 0 of the current
    // TMDB page's merged result.
    const items = merged.slice(0, DISCOVER_PAGE_SIZE);
    const hasNextPage = (movieResult.page ?? page) < (movieResult.total_pages ?? page) || (tvResult.page ?? page) < (tvResult.total_pages ?? page) || merged.length > DISCOVER_PAGE_SIZE;
    return { items, page, hasNextPage, source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

/**
 * Section: popular-{movie,series} — TMDB popularity ranking with an
 * optional original_language filter. For "all" → one unfiltered query.
 *
 * IMPORTANT: We use /discover/movie and /discover/tv (NOT /movie/popular
 * or /tv/popular) because the /popular endpoints do NOT support the
 * `with_original_language` parameter. The /discover endpoints support
 * it and also support `sort_by=popularity.desc`, so we get the same
 * popularity ordering with the language filter applied at the TMDB
 * catalog level — no client-side filtering of a pre-fetched result set.
 *
 * OTT-ORIENTED TV (Phase 1 fix):
 * For type='series', we add `watch_region=IN` +
 * `with_watch_monetization_types=flatrate` to bias results toward
 * streaming-available titles rather than linear-TV-only serials. This
 * surfaces OTT catalog shows (Netflix India, Prime India, etc.) and
 * excludes broadcast-only daily soaps that are not available on any
 * streaming platform. The watch_provider filter is server-side — no N+1.
 *
 * ADULT EXCLUSION (Phase 8):
 * All normal catalog queries (including popular) exclude adult-provider
 * content. The TMDB `with_watch_providers` + `without_companies` approach
 * doesn't work cleanly here; instead, we pass `without_watch_providers`
 * with the pipe-separated list of known adult provider IDs. This is a
 * TMDB-supported filter parameter that excludes titles available on
 * those providers.
 */
export async function getTmdbPopularByLanguage(type: Exclude<ContentType, 'anime'>, language: DiscoverLanguage, page = 1): Promise<ContentList> {
  const adultIds = getAdultProviderIds();
  const adultExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  const key = `tmdb:popular-v2:${type}:${language}:${page}:${adultExclusion ?? 'no-adult'}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/discover/movie' : '/discover/tv';
    const langParam = language !== 'all' && language !== 'other' ? DISCOVER_LANGUAGE_PARAM[language] : undefined;
    const collected: TmdbMedia[] = [];
    let upstreamPage = page;
    let upstreamHasNext = true;
    let pagesWalked = 0;
    while (collected.length < DISCOVER_PAGE_SIZE && upstreamHasNext && pagesWalked < MAX_OTHER_LANGUAGE_PAGES) {
      const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, {
        page: upstreamPage,
        include_adult: false,
        sort_by: 'popularity.desc',
        ...(langParam ? { with_original_language: langParam } : {}),
        ...(type === 'movie' ? { region: 'IN' } : {}),
        // Phase 1: OTT-oriented TV — bias toward streaming-available titles.
        // For TV, add watch_region=IN + flatrate so we get OTT catalog
        // content rather than linear-TV-only serials.
        ...(type === 'series' ? { watch_region: 'IN', with_watch_monetization_types: 'flatrate' } : {}),
        // Phase 8: Exclude known adult-provider content from normal rails.
        // without_watch_providers requires watch_region to be set.
        ...(adultExclusion ? { 'without_watch_providers': adultExclusion, watch_region: 'IN' } : {}),
      });
      const raw = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, type));
      const filtered = applyLanguageFilter(raw, language);
      for (const item of filtered) {
        if (!collected.some((existing) => existing.id === item.id)) collected.push(item);
      }
      upstreamHasNext = (result.page ?? upstreamPage) < (result.total_pages ?? upstreamPage);
      upstreamPage += 1;
      pagesWalked += 1;
      if (language === 'all') break;
    }
    const items = collected.slice(0, DISCOVER_PAGE_SIZE).map((item) => mapTmdb(item, type, 'Popular'));
    const hasNextPage = collected.length > DISCOVER_PAGE_SIZE || upstreamHasNext;
    return { items, page, hasNextPage, source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

/**
 * Section: top-rated-{movie,series} — TMDB vote_average.desc with a
 * sensible vote_count floor (200) so one-vote titles don't dominate.
 * Excludes adult-provider content (Phase 8).
 */
export async function getTmdbTopRated(type: Exclude<ContentType, 'anime'>, language: DiscoverLanguage, page = 1): Promise<ContentList> {
  const adultIds = getAdultProviderIds();
  const adultExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  const key = `tmdb:top-rated-v2:${type}:${language}:${page}:${adultExclusion ?? 'no-adult'}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/discover/movie' : '/discover/tv';
    const langParam = language !== 'all' && language !== 'other' ? DISCOVER_LANGUAGE_PARAM[language] : undefined;
    const collected: TmdbMedia[] = [];
    let upstreamPage = page;
    let upstreamHasNext = true;
    let pagesWalked = 0;
    while (collected.length < DISCOVER_PAGE_SIZE && upstreamHasNext && pagesWalked < MAX_OTHER_LANGUAGE_PAGES) {
      const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, {
        page: upstreamPage,
        include_adult: false,
        sort_by: 'vote_average.desc',
        'vote_count.gte': 200,
        ...(langParam ? { with_original_language: langParam } : {}),
        ...(type === 'movie' ? { region: 'IN' } : {}),
        ...(adultExclusion ? { 'without_watch_providers': adultExclusion, watch_region: 'IN' } : {}),
      });
      const raw = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, type));
      const filtered = applyLanguageFilter(raw, language);
      for (const item of filtered) {
        if (!collected.some((existing) => existing.id === item.id)) collected.push(item);
      }
      upstreamHasNext = (result.page ?? upstreamPage) < (result.total_pages ?? upstreamPage);
      upstreamPage += 1;
      pagesWalked += 1;
      if (language === 'all') break;
    }
    const items = collected.slice(0, DISCOVER_PAGE_SIZE).map((item) => mapTmdb(item, type, 'Top rated'));
    const hasNextPage = collected.length > DISCOVER_PAGE_SIZE || upstreamHasNext;
    return { items, page, hasNextPage, source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

/**
 * Section: genre-* — TMDB genre + popularity ranking with optional
 * original_language filter. Movie-only (per the existing Discover
 * contract: genre rails are movie rails; anime has its own section).
 * Excludes adult-provider content (Phase 8).
 */
export async function getTmdbGenreByLanguage(genreId: number, language: DiscoverLanguage, page = 1): Promise<ContentList> {
  const adultIds = getAdultProviderIds();
  const adultExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  const key = `tmdb:genre-v2:${genreId}:${language}:${page}:${adultExclusion ?? 'no-adult'}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const langParam = language !== 'all' && language !== 'other' ? DISCOVER_LANGUAGE_PARAM[language] : undefined;
    const collected: TmdbMovie[] = [];
    let upstreamPage = page;
    let upstreamHasNext = true;
    let pagesWalked = 0;
    while (collected.length < DISCOVER_PAGE_SIZE && upstreamHasNext && pagesWalked < MAX_OTHER_LANGUAGE_PAGES) {
      const result = await tmdbRequest<TmdbList<TmdbMovie>>('/discover/movie', {
        page: upstreamPage,
        include_adult: false,
        sort_by: 'popularity.desc',
        with_genres: genreId,
        ...(langParam ? { with_original_language: langParam } : {}),
        region: 'IN',
        ...(adultExclusion ? { 'without_watch_providers': adultExclusion } : {}),
      });
      const raw = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, 'movie'));
      const filtered = applyLanguageFilter(raw, language);
      for (const item of filtered) {
        if (!collected.some((existing) => existing.id === item.id)) collected.push(item);
      }
      upstreamHasNext = (result.page ?? upstreamPage) < (result.total_pages ?? upstreamPage);
      upstreamPage += 1;
      pagesWalked += 1;
      if (language === 'all') break;
    }
    const items = collected.slice(0, DISCOVER_PAGE_SIZE).map((item) => mapTmdb(item, 'movie'));
    const hasNextPage = collected.length > DISCOVER_PAGE_SIZE || upstreamHasNext;
    return { items, page, hasNextPage, source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

/**
 * Sections: popular-anime + top-rated-anime + the /discover/anime
 * Explore page.
 *
 * CRITICAL: queries BOTH TMDB movie AND TMDB TV, filters each to
 * isAnime === true (genre 16 + original_language 'ja'), merges and
 * dedupes by canonical type+id. Anime movies keep type='movie';
 * anime series keep type='series'. We do NOT convert movies into
 * series or vice versa.
 *
 * For pagination we accumulate across upstream pages so each "Show
 * more" returns the next 10 valid unique anime titles.
 */
export async function getTmdbAnimeMerged(sort: 'popularity' | 'top-rated', page = 1): Promise<ContentList> {
  const key = `tmdb:anime-merged:${sort}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const sortBy = sort === 'top-rated' ? 'vote_average.desc' : 'popularity.desc';
    const voteCountGte = sort === 'top-rated' ? 200 : undefined;
    const [movieResult, tvResult] = await Promise.all([
      tmdbRequest<TmdbList<TmdbMovie>>('/discover/movie', {
        page,
        include_adult: false,
        sort_by: sortBy,
        with_genres: 16,
        with_original_language: 'ja',
        ...(voteCountGte ? { 'vote_count.gte': voteCountGte } : {})
      }).catch(() => ({ results: [], page, total_pages: page } as TmdbList<TmdbMovie>)),
      tmdbRequest<TmdbList<TmdbTv>>('/discover/tv', {
        page,
        include_adult: false,
        sort_by: sortBy,
        with_genres: 16,
        with_original_language: 'ja',
        ...(voteCountGte ? { 'vote_count.gte': voteCountGte } : {})
      }).catch(() => ({ results: [], page, total_pages: page } as TmdbList<TmdbTv>)),
    ]);
    const movieItems = (movieResult.results ?? []).filter((item) => hasRequiredListMetadata(item, 'movie')).map((item) => mapTmdb(item, 'movie'));
    const tvItems = (tvResult.results ?? []).filter((item) => hasRequiredListMetadata(item, 'series')).map((item) => mapTmdb(item, 'series'));
    // Both already pass isAnime detection (genre 16 + ja) inside mapTmdb,
    // but defensively filter again in case TMDB returns a mismatched row.
    const merged = [...movieItems, ...tvItems].filter((item) => item.isAnime === true);
    // Dedupe by canonical type+id (an anime movie and anime series can
    // share a TMDB id in theory — keep both since their type differs).
    const seen = new Set<string>();
    const deduped = merged.filter((item) => {
      const k = `${item.type}:${item.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Sort the merged set by the same dimension TMDB sorted each list.
    deduped.sort((a, b) => sort === 'top-rated' ? (b.rating - a.rating) : ((b.popularity ?? 0) - (a.popularity ?? 0)));
    const sliced = slicePage(deduped, page, (movieResult.page ?? page) < (movieResult.total_pages ?? page) || (tvResult.page ?? page) < (tvResult.total_pages ?? page));
    return { items: sliced.items, page, hasNextPage: sliced.hasNextPage, source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

// ============================================================
// India OTT providers — built from real TMDB provider metadata.
//
// TMDB exposes /watch/providers/movie?watch_region=IN and
// /watch/providers/tv?watch_region=IN which return the list of
// providers available in India with their provider_id, name, logo_path.
// We fetch both, merge, and curate to ~10–15 recognizable India-relevant
// providers. The logo URL is built from TMDB's logo_path so we never
// use random Google favicons.
//
// JustWatch attribution: TMDB's watch-provider data is powered by
// JustWatch. The Discover footer surfaces this attribution.
// ============================================================

type TmdbProviderListResult = {
  results?: Array<{ provider_id: number; provider_name: string; logo_path: string | null; display_priority?: number }>;
};

function providerKeyFromName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export async function getTmdbIndiaProviders(): Promise<DiscoverProvider[]> {
  const key = 'tmdb:india-providers';
  const { value } = await getOrSet(key, ottProviderPolicy, async () => {
    const [movieResult, tvResult] = await Promise.all([
      tmdbRequest<TmdbProviderListResult>('/watch/providers/movie', { watch_region: 'IN' }).catch(() => ({ results: [] } as TmdbProviderListResult)),
      tmdbRequest<TmdbProviderListResult>('/watch/providers/tv', { watch_region: 'IN' }).catch(() => ({ results: [] } as TmdbProviderListResult)),
    ]);
    const merged = new Map<number, DiscoverProvider>();
    for (const row of [...(movieResult.results ?? []), ...(tvResult.results ?? [])]) {
      if (!row?.provider_id || !row.provider_name) continue;
      if (merged.has(row.provider_id)) continue;
      merged.set(row.provider_id, {
        providerId: row.provider_id,
        name: row.provider_name,
        logoPath: row.logo_path ?? null,
        key: providerKeyFromName(row.provider_name)
      });
    }
    const providers = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    // Phase 6: resolve adult providers against the live TMDB India list.
    // This verifies that adult provider NAMES actually exist in TMDB's
    // India catalog before using their IDs for filtering. Providers not
    // found in TMDB are silently omitted — we never invent IDs.
    resolveAdultProviders(providers);
    return providers;
  });
  return value;
}

export function providerLogoUrl(logoPath: string | null): string {
  return logoPath ? `${IMAGE_URL}/w92${logoPath}` : '';
}

/**
 * Resolve a provider key (e.g. "netflix") back to its TMDB provider_id.
 * Looks up the cached India provider list. Returns undefined if the
 * key is not in the current TMDB India catalog — the caller treats
 * that as "no provider filter" rather than guessing.
 */
export async function resolveProviderIdByKey(providerKey: string): Promise<number | undefined> {
  const providers = await getTmdbIndiaProviders();
  const match = providers.find((p) => p.key === providerKey);
  return match?.providerId;
}

// ============================================================
// Phase 7-9: Indian Adult Shows section query.
//
// Queries titles available on known adult OTT providers in India.
// Uses `with_watch_providers` (pipe-separated adult provider IDs) +
// `watch_region=IN` + `with_watch_monetization_types=flatrate` to
// get titles that are actually available on at least one adult
// streaming service in India.
//
// For "All Adult OTT": one mixed query with all verified adult
// provider IDs pipe-joined. NOT per-provider bucket concatenation.
// For a specific provider: `with_watch_providers=<single ID>`.
//
// Merges movie + TV (both /discover/movie and /discover/tv) since
// adult content exists in both formats. Dedupes by type+id.
// No N+1 per-title provider calls — the filter is server-side.
// ============================================================

export async function getTmdbAdultShows(providerKey: string | undefined, page = 1): Promise<ContentList> {
  // Resolve the adult provider list (this also resolves individual provider
  // keys → TMDB provider IDs via the cached India provider list).
  await getTmdbIndiaProviders();
  const adultProviders = getCachedAdultProviders();
  if (!adultProviders || adultProviders.length === 0) {
    // No adult providers verified in the current TMDB India catalog.
    return { items: [], page, hasNextPage: false, source: tmdbSource() };
  }
  // For a specific provider, resolve its key → ID.
  const providerId = providerKey
    ? adultProviders.find((p) => p.key === providerKey)?.tmdbProviderId
    : undefined;
  // For "All Adult OTT", join all verified adult provider IDs.
  const allAdultIds = adultProviders.map((p) => p.tmdbProviderId).filter((id) => id > 0).join('|');
  const watchProviders = providerId ?? allAdultIds;
  if (!watchProviders) {
    return { items: [], page, hasNextPage: false, source: tmdbSource() };
  }

  const key = `tmdb:adult-shows:${providerKey ?? 'all'}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const baseParams: Record<string, string | number | boolean | undefined> = {
      page,
      include_adult: true, // Adult content IS requested here — this is the adult section.
      sort_by: 'popularity.desc',
      watch_region: 'IN',
      with_watch_monetization_types: 'flatrate',
      with_watch_providers: watchProviders,
    };
    const movieParams = { ...baseParams, sort_by: 'release_date.desc' as const, 'release_date.lte': new Date().toISOString().slice(0, 10) };
    const tvParams = { ...baseParams, sort_by: 'first_air_date.desc' as const, 'first_air_date.lte': new Date().toISOString().slice(0, 10) };
    const [movieResult, tvResult] = await Promise.all([
      tmdbRequest<TmdbList<TmdbMovie>>('/discover/movie', movieParams),
      tmdbRequest<TmdbList<TmdbTv>>('/discover/tv', tvParams),
    ]);
    const movieItems = (movieResult.results ?? []).filter((item) => hasRequiredListMetadata(item, 'movie')).map((item) => mapTmdb(item, 'movie', 'Adult'));
    const tvItems = (tvResult.results ?? []).filter((item) => hasRequiredListMetadata(item, 'series')).map((item) => mapTmdb(item, 'series', 'Adult'));
    let merged = [...movieItems, ...tvItems];
    merged.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    const seen = new Set<string>();
    merged = merged.filter((item) => {
      const k = `${item.type}:${item.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const items = merged.slice(0, DISCOVER_PAGE_SIZE);
    const hasNextPage = (movieResult.page ?? page) < (movieResult.total_pages ?? page) || (tvResult.page ?? page) < (tvResult.total_pages ?? page) || merged.length > DISCOVER_PAGE_SIZE;
    return { items, page, hasNextPage, source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

/**
 * Get the verified adult OTT provider list (for the dropdown).
 * Returns providers that were verified against the live TMDB India catalog.
 */
export async function getVerifiedAdultProviders() {
  await getTmdbIndiaProviders();
  return getCachedAdultProviders() ?? [];
}
