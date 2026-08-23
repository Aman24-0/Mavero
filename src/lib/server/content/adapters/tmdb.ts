import { env } from '$env/dynamic/private';
import { getOrSet } from '../cache';
import { asNumber, asString, asStringArray, fetchJson } from '../http';
import { ContentServiceError, type CollectionFilters, type ContentList, type ContentSource, type ContentType, type Episode, type ContentDetail, type NormalizedMediaItem, type Season, type SearchFilters } from '../types';
import { ottProviders } from '$lib/shared/ott';

type TmdbList<T> = { page?: number; total_pages?: number; total_results?: number; results?: T[] };
type TmdbMovie = {
  id: number;
  title?: string;
  original_title?: string;
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
};
type TmdbTv = {
  id: number;
  name?: string;
  original_name?: string;
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
};
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

function image(path: string | null | undefined, size: 'w342' | 'w500' | 'w780' = 'w500') {
  return path ? `${IMAGE_URL}/${size}${path}` : '';
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

function mapTmdb(raw: TmdbMedia, type: Exclude<ContentType, 'anime'>, tag?: string): NormalizedMediaItem {
  const isMovie = type === 'movie';
  const title = isMovie ? asString((raw as TmdbMovie).title, asString((raw as TmdbMovie).original_title, 'Untitled')) : asString((raw as TmdbTv).name, asString((raw as TmdbTv).original_name, 'Untitled'));
  const genres = raw.genres?.map((genre) => genre.name).filter(Boolean) ?? raw.genre_ids?.map((id) => genreNames[id]).filter(Boolean) ?? [];
  const tv = raw as TmdbTv;
  const movie = raw as TmdbMovie;
  const seasons = isMovie ? undefined : tv.number_of_seasons ?? tv.seasons?.filter((season) => (season.season_number ?? 0) > 0).length;
  const episodes = isMovie ? undefined : tv.number_of_episodes ?? tv.seasons?.reduce((sum, season) => sum + (season.episode_count ?? 0), 0);
  const rating = Math.round(asNumber(raw.vote_average) * 10) / 10;
  return {
    id: `${type}-${raw.id}`,
    title,
    year: dateYear(isMovie ? movie.release_date : tv.first_air_date),
    type,
    maturity: '13+',
    runtime: isMovie ? runtime(movie.runtime) : seasons ? `${seasons} season${seasons === 1 ? '' : 's'}` : 'Series',
    rating,
    popularity: asNumber(raw.popularity),
    voteCount: asNumber(raw.vote_count),
    genres: genres.length ? genres.slice(0, 4) : ['Drama'],
    description: asString(raw.overview, 'No synopsis is available yet.'),
    poster: image(raw.poster_path, 'w500'),
    backdrop: image(raw.backdrop_path, 'w780'),
    accent: '#9b87f5',
    status: isMovie ? undefined : asString(tv.status),
    episodes,
    seasons,
    tags: tag ? [tag] : undefined,
    source: tmdbSource(String(raw.id)),
    externalIds: { tmdb: String(raw.id), imdb: isMovie ? movie.imdb_id ?? undefined : tv.external_ids?.imdb_id ?? undefined },
    trailerKey: raw.videos?.results?.find((video) => video.site === 'YouTube' && video.type === 'Trailer')?.key
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

async function tmdbRequest<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
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
    const items = (result.results ?? []).filter((item) => item.poster_path).map((item) => mapTmdb(item, type, 'Trending'));
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
      ...(filters.sort === 'Top rated' ? { 'vote_count.gte': 250 } : {})
    };
    const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, params);
    const items = (result.results ?? []).filter((item) => item.poster_path).map((item) => mapTmdb(item, type));
    return { items, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getTmdbPopular(type: Exclude<ContentType, 'anime'>, page = 1): Promise<ContentList> {
  const key = `tmdb:popular:${type}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/movie/popular' : '/tv/popular';
    const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, { page });
    const items = (result.results ?? []).filter((item) => item.poster_path).map((item) => mapTmdb(item, type, 'Popular'));
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
    let rawItems = (result.results ?? []).filter((item) => item.poster_path);
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
    const raw = await tmdbRequest<TmdbMedia>(path, { append_to_response: 'videos,external_ids,recommendations' });
    const item = mapTmdb(raw, type);
    const recommendations = (raw.recommendations?.results ?? []).filter((candidate) => candidate.poster_path).slice(0, 6).map((candidate) => mapTmdb(candidate, type, 'Recommended'));
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

export const tmdbInternals = { mapTmdb, image, runtime, genreNames };
