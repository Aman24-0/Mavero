import { env } from '$env/dynamic/private';
import { getOrSet } from '../cache';
import { asNumber, asString, asStringArray, fetchJson } from '../http';
import { ContentServiceError, type CollectionFilters, type ContentList, type ContentSource, type ContentType, type Episode, type ContentDetail, type NormalizedMediaItem, type Season, type SearchFilters, type CastMember, type DiscoverLanguage, type DiscoverProvider, POPULAR_TV_WITHOUT_GENRES } from '../types';
import { ottProviders } from '$lib/shared/ott';
import { getAdultProviderIds, resolveAdultProviders, getCachedAdultProviders, isAdultContent, ensureAdultProvidersResolved } from '../adult-providers';
import { adultNetworkExclusionValue, withAdultNetworksParams, getVerifiedAdultNetworkIdForKey } from '../adult-catalog';
import {
  ADULT_DISCOVER_PAGE_SIZE,
  ADULT_DISCOVER_MAX_UPSTREAM_PAGES,
  ADULT_DISCOVER_CLASSIFY_CONCURRENCY,
  ADULT_DISCOVER_PROVIDER_ALL,
  buildAdultDiscoverCacheKey,
  emptyAdultDiscoverResult,
  adultDiscoverSortBy,
  classifyAdultDiscoverRow,
  collectConfirmedAdultPage,
  isAdultDiscoverProvider,
  type AdultDiscoverFilters,
  type AdultDiscoverCandidateRow,
  type AdultDiscoverDetailVerdictLoader
} from '../adult-discover';
import { mapWithConcurrency } from '../concurrency';
import { INDIAN_POPULAR_TV_SOAP_POLICY_KEY, INDIAN_POPULAR_TV_NO_SOAP_POLICY_KEY, INDIAN_POPULAR_TV_SOAP_CHECK_CONCURRENCY, isDailySoapEpisodeCount } from '../popular-tv-policy';
import { movieRowVerdict, detailVerdict, collectSafeSearchPage, searchFilterMode, buildSearchCacheKey, type CandidateVerdict, type UpstreamSearchPage } from '../search-classify';
import { filterSafeRailItems, type RailCandidateRow, type DetailVerdictLoader } from '../list-classify';

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
type TmdbNetwork = { id?: number; name?: string | null; logo_path?: string | null; origin_country?: string[] };
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
  /**
   * TV networks (production/broadcast). Present in the /tv/{id} detail
   * response; list endpoints do not return it. Consumed by the adult
   * classifier via the VERIFIED adult network registry (adult-networks.ts).
   */
  networks?: TmdbNetwork[];
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

/**
 * Extract the TV networks of a TMDB TV detail response as the minimal
 * classifier-facing shape ({ id, name }). Returns undefined for movies, for
 * list-shaped results (no networks field), and when nothing usable remains
 * after dropping malformed entries — the classifier treats absent metadata
 * as "no network signal", and future authorization paths apply fail-closed
 * semantics on FAILED fetches (see isAdultContent contract).
 */
function extractTvNetworks(raw: TmdbTv): Array<{ id: number; name: string }> | undefined {
  if (!Array.isArray(raw.networks) || raw.networks.length === 0) return undefined;
  const mapped = raw.networks
    .filter((network) => network && Number.isInteger(network.id) && (network.id as number) > 0)
    .map((network) => ({ id: network.id as number, name: typeof network.name === 'string' ? network.name.trim() : '' }))
    .filter((network) => network.name.length > 0);
  return mapped.length > 0 ? mapped : undefined;
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
    networks: isMovie ? undefined : extractTvNetworks(tv),
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

// ============================================================
// Phase 6 — unsupported catalog path enforcement.
//
// The trending (/trending/{movie,tv}/week), legacy popular
// (/{movie,tv}/popular), theatre (/movie/now_playing) and detail
// recommendations (append_to_response) endpoints support NEITHER
// without_networks NOR without_watch_providers, and TV rows carry no
// networks[] metadata (verified Indian adult OTT originals are TMDB
// adult=false, so include_adult/flag checks alone CANNOT keep them out).
// Every candidate on these rails is therefore classified server-side
// through the ONE central classifier:
//   - movie rows: cheap flag verdict (movieRowVerdict → isAdultContent,
//     anime exemption included) — the Phase 4 movie-side contract;
//   - TV rows: the authoritative network signal requires the detail
//     response, so the (cached, in-flight-deduplicated) detail path is
//     used and its central classification verdict is read. Failures are
//     'uncertain' and fail CLOSED (excluded), never "not adult".
// Bounded concurrency (4) — never unbounded Promise.all, never sequential.
// These rails are NORMAL surfaces: they stay adult-free regardless of
// Adult Mode state (Adult Mode ON never injects adult titles into normal
// rails), so the filtering takes NO authorization input and its result is
// a global-safe content fact.
// ============================================================

/** Max simultaneous detail classifications for unsupported-rail candidates (matches Search). */
const RAIL_CLASSIFY_CONCURRENCY = 4;

/**
 * Detail-path verdict loader for TV rail candidates: reads the central
 * classification from the cached detail (getTmdbDetail classifies via
 * isAdultContent over networks[]/providers/adult/isAnime and is cached
 * 30 min, in-flight deduplicated). Never throws — any failure is reported
 * as 'uncertain' and handled fail-closed by the rail filter.
 */
const railDetailVerdictLoader: DetailVerdictLoader = async (tmdbId: string): Promise<CandidateVerdict> => {
  try {
    const detail = await getTmdbDetail('series', tmdbId);
    return detailVerdict(detail.tags);
  } catch {
    return 'uncertain';
  }
};

/**
 * Classify + filter one unsupported-rail page of candidate rows down to
 * its adult-free subset (shared by trending + legacy popular). Rows are
 * built AT MAP TIME so the movie rows keep the raw TMDB adult flag (the
 * cheap movie-side signal; normalized items do not carry it).
 * TMDB order is preserved; duplicates are collected once.
 */
async function filterAdultFromListPage(rows: RailCandidateRow<NormalizedMediaItem>[]): Promise<NormalizedMediaItem[]> {
  const result = await filterSafeRailItems(rows, {
    concurrency: RAIL_CLASSIFY_CONCURRENCY,
    loadDetailVerdict: railDetailVerdictLoader,
    tmdbIdOf: (item) => String(item.externalIds?.tmdb ?? item.id.replace(/^(movie|series)-/, '')),
    identityOf: (item) => `${item.type}:${item.id}`
  });
  return result.items;
}

// BUG 3 fix (Phase 3 architecture): generic catalog functions exclude adult
// content at the TMDB query level. TV queries exclude VERIFIED adult TV
// NETWORKS (`without_networks`, values from the central registry via
// adult-catalog.ts — the canonical adult identity). Movie queries keep the
// TRANSITIONAL watch-provider exclusion (`without_watch_providers`) because
// /discover/movie has no network filter in TMDB (documented in the worklog
// Phase 3 section — not a silent second architecture). The applied exclusion
// value is always embedded in the cache key so adult-excluded and
// adult-available result sets never leak between cache contexts.

/**
 * Ensure adult providers are resolved, then return the adult provider IDs
 * for exclusion. This is the safe entry point that all adult-sensitive
 * TMDB adapter functions should call before computing adultExclusion.
 * If the provider cache is fresh, this is a fast no-op.
 */
async function getResolvedAdultProviderIds(): Promise<number[]> {
  await ensureAdultProvidersResolved(() => getTmdbIndiaProviders());
  return getAdultProviderIds();
}

export async function getTmdbDiscover(type: Exclude<ContentType, 'anime'>, page = 1): Promise<ContentList> {
  // Phase 6: /trending/{movie,tv}/week supports NO network/provider filters
  // and TV rows carry no networks[] (verified adult OTT originals are TMDB
  // adult=false), so every candidate is classified server-side (movies via
  // the cheap flag path, TV via the cached detail path) and adult AND
  // uncertain candidates are excluded — ALWAYS, regardless of Adult Mode
  // state (normal rails stay adult-free). The old provider-gated post-filter
  // was a no-op (it passed `undefined` for the flag and TV rows have no
  // networks) and is replaced by this classification step.
  const key = `tmdb:discover:${type}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/trending/movie/week' : '/trending/tv/week';
    const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, { page });
    // Build candidate rows at map time so movie rows keep the raw adult flag.
    const rows: RailCandidateRow<NormalizedMediaItem>[] = (result.results ?? [])
      .filter((item) => hasRequiredListMetadata(item, type))
      .map((item) => ({
        item: mapTmdb(item, type, 'Trending'),
        mediaType: type,
        rawAdult: (item as TmdbMovie).adult
      }));
    const filteredItems = await filterAdultFromListPage(rows);
    return { items: filteredItems, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getTmdbCollection(type: Exclude<ContentType, 'anime'>, page = 1, filters: CollectionFilters = {}): Promise<ContentList> {
  const genreId = filters.genre ? Object.entries(genreNames).find(([, label]) => label.toLowerCase() === filters.genre?.toLowerCase())?.[0] ?? (/^\d+$/.test(filters.genre) ? filters.genre : undefined) : undefined;
  const year = filters.year && /^\d{4}$/.test(filters.year) ? Number(filters.year) : undefined;
  const sortBy = filters.sort === 'Top rated' ? 'vote_average.desc' : filters.sort === 'Newest' ? type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc' : 'popularity.desc';
  // Phase 3: TV excludes verified adult NETWORKS (canonical identity);
  // movies keep the transitional watch-provider exclusion because
  // /discover/movie has no network filter (worklog Phase 3).
  const networkExclusion = type === 'series' ? adultNetworkExclusionValue() : undefined;
  const adultIds = type === 'movie' ? await getResolvedAdultProviderIds() : [];
  const providerExclusion = type === 'movie' && adultIds.length > 0 ? adultIds.join('|') : undefined;
  const adultExclusion = networkExclusion ?? providerExclusion;
  const key = `tmdb:collection:${type}:${page}:${genreId ?? ''}:${year ?? ''}:${filters.sort ?? ''}:${adultExclusion ?? 'no-adult'}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/discover/movie' : '/discover/tv';
    const params: Record<string, string | number | boolean | undefined> = {
      page,
      include_adult: false,
      sort_by: sortBy,
      with_genres: genreId,
      ...(type === 'movie' ? { primary_release_year: year } : { first_air_date_year: year }),
      ...(filters.sort === 'Top rated' ? { 'vote_count.gte': 250 } : {}),
      ...(filters.sort === 'Newest' ? type === 'movie' ? { 'release_date.lte': new Date().toISOString().slice(0, 10) } : { 'first_air_date.lte': new Date().toISOString().slice(0, 10) } : {}),
      ...(networkExclusion ? { without_networks: networkExclusion } : {}),
      ...(providerExclusion ? { 'without_watch_providers': providerExclusion, watch_region: 'IN' } : {}),
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
  // Movie-only query — /discover/movie has NO network filter, so the
  // adult exclusion stays on the TRANSITIONAL watch-provider mechanism
  // (documented in the worklog Phase 3 endpoint matrix).
  const adultIds = await getResolvedAdultProviderIds();
  const adultExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  const key = `tmdb:lang-movies:movie:${normalized}:${page}:${adultExclusion ?? 'no-adult'}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const result = await tmdbRequest<TmdbList<TmdbMovie>>('/discover/movie', {
      page,
      include_adult: false,
      with_original_language: normalized,
      sort_by: 'popularity.desc',
      region: 'IN',
      ...(adultExclusion ? { 'without_watch_providers': adultExclusion, watch_region: 'IN' } : {}),
    });
    const items = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, 'movie')).map((item) => mapTmdb(item, 'movie', 'Trending'));
    return { items, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getTmdbPopular(type: Exclude<ContentType, 'anime'>, page = 1): Promise<ContentList> {
  // Phase 6: /{movie,tv}/popular supports NO network/provider filters and
  // TV rows carry no networks[] — same classification contract as trending
  // above (movies: flag path; TV: cached-detail path; adult AND uncertain
  // excluded unconditionally; the old provider-gated no-op filter replaced).
  const key = `tmdb:popular:${type}:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/movie/popular' : '/tv/popular';
    const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, { page });
    const rows: RailCandidateRow<NormalizedMediaItem>[] = (result.results ?? [])
      .filter((item) => hasRequiredListMetadata(item, type))
      .map((item) => ({
        item: mapTmdb(item, type, 'Popular'),
        mediaType: type,
        rawAdult: (item as TmdbMovie).adult
      }));
    const filteredItems = await filterAdultFromListPage(rows);
    return { items: filteredItems, page: result.page ?? page, hasNextPage: (result.page ?? page) < (result.total_pages ?? page), source: tmdbSource() };
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

function releaseDate(raw: TmdbMedia, type: Exclude<ContentType, 'anime'>) {
  return type === 'movie' ? (raw as TmdbMovie).release_date ?? '' : (raw as TmdbTv).first_air_date ?? '';
}

// ============================================================
// Phase 4 — Adult-aware search classification.
//
// TMDB /search supports NEITHER network NOR provider filters and TV
// search rows carry no networks[] metadata, so include_adult=false
// CANNOT keep adult-network titles (TMDB adult=false as a rule) out of
// unauthorized results. When adult access is OFF, every candidate is
// classified server-side through the ONE central classifier:
//   - movie rows: cheap metadata verdict (movieRowVerdict → isAdultContent)
//     — no detail request needed for the flag signal;
//   - TV rows: the authoritative network signal requires the detail
//     response, so the (cached, in-flight-deduplicated) detail path is
//     used and its central classification verdict is read. Failures are
//     'uncertain' and fail CLOSED (excluded), never "not adult".
// Bounded concurrency (4) — never unbounded Promise.all, never sequential.
// ============================================================

/** Max simultaneous detail classifications for search candidates (spec: 4–6). */
const SEARCH_CLASSIFY_CONCURRENCY = 4;
/** Hard cap on upstream pages walked per visible search page while filtering. */
const SEARCH_MAX_UPSTREAM_PAGES = 3;
/** Visible page size — TMDB's natural search page size (UI contract). */
const SEARCH_PAGE_SIZE = 20;

/** One search candidate as seen by the classifier: normalized row + the raw TMDB adult flag. */
type SearchCandidateRow = { item: NormalizedMediaItem; rawAdult: boolean | undefined };

/**
 * Classify one search candidate through the central classifier. MUST NOT
 * throw: any failure is reported as 'uncertain' and handled fail-closed
 * by the orchestrator (excluded for unauthorized search).
 */
async function classifySearchRow(row: SearchCandidateRow): Promise<CandidateVerdict> {
  const { item, rawAdult } = row;
  // Movies: search rows carry no networks and movie identity has no
  // network signal — the cheap metadata path via the central classifier
  // (TMDB adult flag + anime exemption) is the movie-side contract (Phase 4).
  if (item.type === 'movie') return movieRowVerdict({ adult: rawAdult, isAnime: item.isAnime });
  // TV: network identity is authoritative and list rows carry no
  // networks[] — read the central classification from the cached detail
  // (getTmdbDetail classifies via isAdultContent over networks[]/
  // providers/adult/isAnime and is cached 30 min, in-flight deduplicated).
  try {
    const detail = await getTmdbDetail('series', String(item.id));
    return detailVerdict(detail.tags);
  } catch {
    return 'uncertain';
  }
}

export async function searchTmdb(query: string, type: Exclude<ContentType, 'anime'>, page = 1, filters: SearchFilters = {}, canAccessAdult = false): Promise<ContentList> {
  const normalized = query.trim();
  // Phase 4 authorization-aware cache dimension: the adult-allowed and the
  // adult-excluded (classified + filtered) result sets are DIFFERENT cache
  // entries. An authorized response can never be served to an unauthorized
  // context or vice versa. Classification itself is cached per CONTENT (the
  // detail cache) with no authorization dimension — see search-classify.ts.
  // Phase 6: the key is built by the PURE buildSearchCacheKey (structural,
  // behaviorally-tested isolation — the authorization decision is part of
  // the key, not a convention).
  const key = buildSearchCacheKey({ type, query: normalized, page, ott: filters.ott, genre: filters.genre, sort: filters.sort, canAccessAdult });
  const { value, stale } = await getOrSet(key, { ttlMs: 1000 * 60 * 2, staleWhileRevalidateMs: 1000 * 60 * 5 }, async () => {
    const path = type === 'movie' ? '/search/movie' : '/search/tv';
    // NOTE: /search supports NO network/provider filter params — server-side
    // classification below is the only adult filter that exists here.
    // include_adult=false stays (pre-existing upstream cheap filter).
    const fetchUpstreamPage = async (upstreamPage: number): Promise<UpstreamSearchPage<SearchCandidateRow>> => {
      const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, { query: normalized, page: upstreamPage, include_adult: false });
      let rawItems = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, type));
      if (filters.genre) rawItems = rawItems.filter((item) => item.genre_ids?.includes(Number(filters.genre)));
      if (filters.ott) {
        const matches = await mapWithConcurrency(rawItems, (item) => matchesOtt(type, item.id, filters.ott as string), OTT_LOOKUP_CONCURRENCY);
        rawItems = rawItems.filter((_, index) => matches[index]);
      }
      if (filters.sort) rawItems.sort((left, right) => releaseDate(left, type).localeCompare(releaseDate(right, type)) * (filters.sort === 'release-desc' ? -1 : 1));
      // Normalize to the output shape, keeping the raw adult flag for the
      // cheap movie-row verdict (normalized rows do not carry the flag).
      const items = rawItems.map((item) => ({ item: mapTmdb(item, type), rawAdult: (item as TmdbMovie).adult }));
      return { items, totalPages: result.total_pages ?? upstreamPage };
    };

    if (searchFilterMode(canAccessAdult) === 'authorized-passthrough') {
      // Adult Mode ON / authorized: adult results MAY appear — the exact
      // pre-Phase-4 behavior (single upstream page, no classification N+1).
      // Authorization was evaluated server-side (service/route layer).
      const result = await fetchUpstreamPage(page);
      return { items: result.items.map((row) => row.item), page, hasNextPage: page < result.totalPages, source: tmdbSource() };
    }

    // Adult Mode OFF / unauthorized: classify every candidate (TV via the
    // cached detail path, movies via the cheap metadata path), exclude
    // adult AND uncertain (fail-closed), and continue upstream pages while
    // the visible page is underfilled — capped at SEARCH_MAX_UPSTREAM_PAGES
    // and never past TMDB total_pages.
    const outcome = await collectSafeSearchPage<SearchCandidateRow>({
      startPage: page,
      pageSize: SEARCH_PAGE_SIZE,
      maxUpstreamPages: SEARCH_MAX_UPSTREAM_PAGES,
      excludeUncertain: true,
      concurrency: SEARCH_CLASSIFY_CONCURRENCY,
      fetchUpstreamPage,
      classifyCandidate: classifySearchRow,
      identityOf: (row) => `${row.item.type}:${row.item.id}`
    });
    const items = outcome.items.map((row) => row.item);
    // Keep the sort dimension meaningful across continued pages (year is
    // the mapped-item field; within one upstream page the upstream
    // release-date order is already applied).
    if (filters.sort) items.sort((left, right) => (left.year - right.year) * (filters.sort === 'release-desc' ? -1 : 1));
    return { items, page, hasNextPage: !outcome.upstreamExhausted, source: tmdbSource() };
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
    const raw = await tmdbRequest<TmdbMedia>(path, { append_to_response: 'videos,external_ids,recommendations,credits,watch/providers' });
    const item = mapTmdb(raw, type);
    // BUG 1 fix: Central adult classification for detail lookups.
    // The detail response now includes watch/providers data (via
    // append_to_response), so we can check if the title is available
    // on any known adult provider in India — without a separate N+1
    // API call. The watch/providers data is cached with the detail.
    const watchProviders = (raw as TmdbMovie & { 'watch/providers'?: TmdbWatchProviders })['watch/providers'];
    const indiaProviders = watchProviders?.results?.IN;
    const providerIds = indiaProviders
      ? [...(indiaProviders.flatrate ?? []), ...(indiaProviders.buy ?? []), ...(indiaProviders.rent ?? [])]
          .map((p) => p.provider_id)
          .filter((id): id is number => typeof id === 'number')
      : undefined;
    const tmdbAdult = (raw as TmdbMovie).adult;
    // TV detail responses carry networks[] — the authoritative adult-network
    // identity signal (verified adult network registry, adult-networks.ts).
    // Wired into the central classifier alongside the transitional
    // watch-provider signal so a verified adult network classifies the title
    // as Adult even when TMDB's generic adult flag is false.
    const networks = type === 'series' ? extractTvNetworks(raw as TmdbTv) : undefined;
    if (isAdultContent(item.tags, providerIds, tmdbAdult, item.isAnime, networks)) {
      item.tags = [...(item.tags ?? []), 'Adult'];
    }
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
    const items = collected.slice(0, DISCOVER_PAGE_SIZE);
    // Phase 6: /movie/now_playing supports NO adult filters — classify the
    // final page through the central classifier (cheap flag path for movie
    // rows; anime exemption included) and drop adult candidates. Normal rail:
    // filtered regardless of Adult Mode state. TMDB order preserved.
    const candidateRows: RailCandidateRow<NormalizedMediaItem>[] = items.map((item) => ({
      item: mapTmdb(item, 'movie', 'In theatres'),
      mediaType: 'movie' as const,
      rawAdult: item.adult
    }));
    const safeItems = await filterAdultFromListPage(candidateRows);
    const hasNextPage = collected.length > DISCOVER_PAGE_SIZE || upstreamHasNext;
    return { items: safeItems, page, hasNextPage, source: tmdbSource() };
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
  // Phase 3: the TV half excludes verified adult NETWORKS (canonical);
  // the movie half keeps the transitional watch-provider exclusion
  // (/discover/movie has no network filter — worklog Phase 3).
  const networkExclusion = adultNetworkExclusionValue();
  const adultIds = await getResolvedAdultProviderIds();
  const providerExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  // Both halves share one cache entry, so the key embeds BOTH applied
  // exclusion values (no collision between provider-era and network-era
  // semantics, and the two dimensions change independently).
  const key = `tmdb:new-ott:${providerKey ?? 'all'}:${language}:${page}:${networkExclusion ?? 'no-nets'}:${providerExclusion ?? 'no-providers'}`;
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
      ...(providerExclusion ? { 'without_watch_providers': providerExclusion } : {}),
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
      ...(networkExclusion ? { without_networks: networkExclusion } : {}),
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
 * ADULT EXCLUSION (Phase 3 network migration):
 * The TV query excludes VERIFIED adult TV NETWORKS via
 * `without_networks` (values from the central registry via
 * adult-catalog.ts — the canonical adult identity). The movie query
 * keeps the transitional `without_watch_providers` exclusion because
 * /discover/movie has no network filter. Adult Mode ON never injects
 * adult titles into these rails — the exclusion is unconditional.
 *
 * GENERIC TV CATEGORY EXCLUSION (Phase 8):
 * The TV query ALSO excludes the generic TV genres Soap/News/Talk
 * (POPULAR_TV_WITHOUT_GENRES in types.ts) via `without_genres`. This is
 * an ADDITIONAL curation filter — it does NOT classify those genres as
 * Adult and never replaces the central classifier or the network
 * exclusion; it only stops generic linear-TV categories from dominating
 * the rail. It is UNCONDITIONAL: Adult Mode ON never removes it (the
 * normal Popular TV contract stays Adult-excluded and genre-clean in
 * both states). 10764/10766/10767 are TV genres — the movie half is
 * untouched.
 *
 * DAILY-SOAP STRUCTURAL EXCLUSION (post-release fix, popular-tv-policy.ts):
 * TMDB tags Indian daily soaps with ONLY Drama (18) — never the Soap
 * genre — so the Phase 8 genre exclusion cannot see them (measured:
 * Patiala Babes /tv/85879, Vantalakka /tv/235424, Pallakilo Pellikuturu
 * /tv/235330, Meenakshi Ponnunga /tv/276583, Bhoomige Bandha Bhagyantha
 * /tv/275535 are ALL Drama-only). Genre metadata alone is insufficient
 * (prestige Drama-only shows like Rocket Boys must stay), so the TV half
 * additionally applies the ISOLATED daily-soap policy: a candidate whose
 * CACHED DETAIL reports more than
 * INDIAN_POPULAR_TV_DAILY_SOAP_MAX_EPISODES released episodes is a
 * serial by production model and is dropped. Metadata-based (never a
 * title blacklist), deterministic, scoped to THIS rail only (not movies,
 * not Top Rated, not Search, not Adult Discover, not anime). A failed
 * detail lookup keeps the candidate (curation fail-open — the ADULT
 * exclusion above stays unconditional and query-level). For specific
 * languages the walk is deterministic from upstream page 1 so rail
 * pages tile the soap-free survivor stream without overlap; 'all'
 * keeps the single-page behavior. The applied policy is embedded in
 * the cache key (INDIAN_POPULAR_TV_SOAP_POLICY_KEY dimension).
 */
export async function getTmdbPopularByLanguage(type: Exclude<ContentType, 'anime'>, language: DiscoverLanguage, page = 1): Promise<ContentList> {
  // Phase 3: TV excludes verified adult NETWORKS; movies keep the
  // transitional watch-provider exclusion (no network filter for movies).
  const networkExclusion = type === 'series' ? adultNetworkExclusionValue() : undefined;
  const adultIds = type === 'movie' ? await getResolvedAdultProviderIds() : [];
  const providerExclusion = type === 'movie' && adultIds.length > 0 ? adultIds.join('|') : undefined;
  const adultExclusion = networkExclusion ?? providerExclusion;
  // Phase 8: the applied generic-genre exclusion is part of the cache key
  // (a constant dimension, like the adult-exclusion value above) so the key
  // always reflects the query shape that produced the response.
  const genreExclusion = type === 'series' ? POPULAR_TV_WITHOUT_GENRES : undefined;
  // Post-release fix: the applied daily-soap policy is a cache-key dimension
  // too (constant per media type) — a policy bump re-keys instead of serving
  // stale-era rails.
  const soapPolicyKey = type === 'series' ? INDIAN_POPULAR_TV_SOAP_POLICY_KEY : INDIAN_POPULAR_TV_NO_SOAP_POLICY_KEY;
  const key = `tmdb:popular-v2:${type}:${language}:${page}:${adultExclusion ?? 'no-adult'}:${genreExclusion ?? 'no-genre-exclusion'}:${soapPolicyKey}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const path = type === 'movie' ? '/discover/movie' : '/discover/tv';
    const langParam = language !== 'all' && language !== 'other' ? DISCOVER_LANGUAGE_PARAM[language] : undefined;
    // Daily-soap exclusion scope: TV candidates of the Popular TV rail only.
    // For specific languages the walk starts at upstream page 1 EVERY time so
    // rail page N = survivor rows [(N-1)*10, N*10) — disjoint, stable pages
    // even though serial-heavy upstream pages are being skipped. 'all' keeps
    // the existing single-upstream-page behavior (verified by discover_v2
    // tests) with the soap filter applied inside that page.
    const isSeries = type === 'series';
    const deterministicSoapWalk = isSeries && language !== 'all';
    const survivorTarget = deterministicSoapWalk ? page * DISCOVER_PAGE_SIZE : DISCOVER_PAGE_SIZE;
    const maxWalked = deterministicSoapWalk ? Math.min(MAX_OTHER_LANGUAGE_PAGES * page, 30) : MAX_OTHER_LANGUAGE_PAGES;
    const collected: TmdbMedia[] = [];
    let upstreamPage = deterministicSoapWalk ? 1 : page;
    let upstreamHasNext = true;
    let pagesWalked = 0;
    while (collected.length < survivorTarget && upstreamHasNext && pagesWalked < maxWalked) {
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
        // Phase 3: TV excludes adult networks (canonical); movies keep the
        // transitional provider exclusion. without_watch_providers requires
        // watch_region to be set.
        ...(networkExclusion ? { without_networks: networkExclusion } : {}),
        ...(providerExclusion ? { 'without_watch_providers': providerExclusion, watch_region: 'IN' } : {}),
        // Phase 8: exclude the generic TV categories (Soap/News/Talk) from
        // normal Popular TV — unconditionally, in addition to (never instead
        // of) the adult exclusion and the central classifier.
        ...(genreExclusion ? { without_genres: genreExclusion } : {}),
      });
      const raw = (result.results ?? []).filter((item) => hasRequiredListMetadata(item, type));
      const filtered = applyLanguageFilter(raw, language);
      // DAILY-SOAP STRUCTURAL EXCLUSION (Popular TV rail only — see the
      // function header and popular-tv-policy.ts). Each surviving candidate
      // is checked against its CACHED detail's released-episode count with
      // bounded concurrency. A failed detail lookup keeps the candidate
      // (curation fail-open); the adult exclusion above is unaffected.
      let pageCandidates = filtered;
      if (isSeries) {
        const soapVerdicts = await mapWithConcurrency(filtered, async (item): Promise<boolean> => {
          try {
            const detail = await getTmdbDetail('series', String(item.id));
            return isDailySoapEpisodeCount(detail.episodes);
          } catch {
            return false;
          }
        }, INDIAN_POPULAR_TV_SOAP_CHECK_CONCURRENCY);
        pageCandidates = filtered.filter((_, index) => !soapVerdicts[index]);
      }
      for (const item of pageCandidates) {
        if (!collected.some((existing) => existing.id === item.id)) collected.push(item);
      }
      upstreamHasNext = (result.page ?? upstreamPage) < (result.total_pages ?? upstreamPage);
      upstreamPage += 1;
      pagesWalked += 1;
      if (language === 'all') break;
    }
    const sliceStart = deterministicSoapWalk ? (page - 1) * DISCOVER_PAGE_SIZE : 0;
    const items = collected.slice(sliceStart, sliceStart + DISCOVER_PAGE_SIZE).map((item) => mapTmdb(item, type, 'Popular'));
    const hasNextPage = deterministicSoapWalk
      ? collected.length >= sliceStart + DISCOVER_PAGE_SIZE && upstreamHasNext
      : collected.length > DISCOVER_PAGE_SIZE || upstreamHasNext;
    return { items, page, hasNextPage, source: tmdbSource() };
  });
  return { ...value, source: { ...value.source, stale } };
}

/**
 * Section: top-rated-{movie,series} — TMDB vote_average.desc with a
 * sensible vote_count floor (200) so one-vote titles don't dominate.
 * Excludes adult content: TV via verified adult networks (Phase 3),
 * movies via the transitional watch-provider exclusion.
 */
export async function getTmdbTopRated(type: Exclude<ContentType, 'anime'>, language: DiscoverLanguage, page = 1): Promise<ContentList> {
  // Phase 3: TV excludes verified adult NETWORKS; movies keep the
  // transitional watch-provider exclusion (no network filter for movies).
  const networkExclusion = type === 'series' ? adultNetworkExclusionValue() : undefined;
  const adultIds = type === 'movie' ? await getResolvedAdultProviderIds() : [];
  const providerExclusion = type === 'movie' && adultIds.length > 0 ? adultIds.join('|') : undefined;
  const adultExclusion = networkExclusion ?? providerExclusion;
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
        ...(networkExclusion ? { without_networks: networkExclusion } : {}),
        ...(providerExclusion ? { 'without_watch_providers': providerExclusion, watch_region: 'IN' } : {}),
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
  const adultIds = await getResolvedAdultProviderIds();
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
        // Phase 6 BUG FIX: `without_watch_providers` is region-scoped by TMDB
        // and is IGNORED without `watch_region` — the pre-Phase-6 query sent
        // it without the region, so the transitional movie-side adult
        // exclusion silently never applied on the genre rails.
        ...(adultExclusion ? { 'without_watch_providers': adultExclusion, watch_region: 'IN' } : {}),
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
    // Phase 6: defense-in-depth on top of the (now region-corrected)
    // provider exclusion — classify the final page through the central
    // classifier (cheap flag path for movie rows; anime exemption included)
    // and drop adult candidates. Normal rail: filtered regardless of Adult
    // Mode state. TMDB order preserved.
    const candidateRows: RailCandidateRow<NormalizedMediaItem>[] = collected.slice(0, DISCOVER_PAGE_SIZE).map((item) => ({
      item: mapTmdb(item, 'movie'),
      mediaType: 'movie' as const,
      rawAdult: item.adult
    }));
    const items = await filterAdultFromListPage(candidateRows);
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
// PHASE 3 ARCHITECTURE — canonical adult identity = TMDB TV NETWORK.
//
// TV half: /discover/tv with `with_networks=<verified adult network ids>`
// (values from the central registry via adult-catalog.ts, pipe-joined
// "any of"). The watch-provider prerequisites (`watch_region=IN` +
// `with_watch_monetization_types=flatrate` + `with_watch_providers`) are
// GONE for TV — the rail discovers titles belonging to the configured
// adult networks even when TMDB has no JustWatch watch-provider entry
// for them. For a user-selected service the filter narrows to that
// service's VERIFIED network id (resolved by registry key); if the
// selected service has no verified network id, the TV half contributes
// nothing — we never fabricate network ids and never fall back to
// watch-provider identity for TV (worklog Phase 3).
//
// Movie half: TRANSITIONAL watch-provider query (`with_watch_providers`
// + `watch_region=IN` + flatrate) because /discover/movie has NO network
// filter in TMDB. Documented in the worklog Phase 3 endpoint matrix —
// not a silently-competing architecture. Removal: Phase 7 rail redesign
// or when TMDB grows a movie-side network/company equivalent.
//
// Merges movie + TV, dedupes by type+id, slices to 10 per page. No
// N+1 per-title calls — the filter is server-side.
// ============================================================

export async function getTmdbAdultShows(providerKey: string | undefined, page = 1): Promise<ContentList> {
  // ---- TV half: canonical adult NETWORK query (Phase 3). ----
  // Resolve the selected provider key to a VERIFIED network id (same key
  // convention in both registries). undefined = all verified networks.
  const selectedNetworkId = getVerifiedAdultNetworkIdForKey(providerKey);
  const networkInclusion = withAdultNetworksParams(selectedNetworkId);
  const hasTvQuery = 'with_networks' in networkInclusion;
  // ---- Movie half: TRANSITIONAL watch-provider query (see header). ----
  await getTmdbIndiaProviders();
  const adultProviders = getCachedAdultProviders();
  const providerId = providerKey
    ? adultProviders?.find((p) => p.key === providerKey)?.tmdbProviderId
    : undefined;
  const allAdultIds = adultProviders ? adultProviders.map((p) => p.tmdbProviderId).filter((id) => id > 0).join('|') : '';
  const watchProviders = providerId ?? (allAdultIds || undefined);
  const hasMovieQuery = Boolean(watchProviders);
  if (!hasTvQuery && !hasMovieQuery) {
    // Nothing verified to query in either ID space (no fabricated IDs).
    return { items: [], page, hasNextPage: false, source: tmdbSource() };
  }

  // Cache key embeds the network inclusion value so network-era entries
  // can never be served for provider-era semantics (or vice versa).
  const key = `tmdb:adult-shows:${providerKey ?? 'all'}:${page}:${networkInclusion.with_networks ?? 'no-networks'}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    // TV: network-based query — NO JustWatch region/monetization/provider
    // prerequisites. include_adult stays true (this IS the adult section).
    const tvParams: Record<string, string | number | boolean | undefined> = {
      page,
      include_adult: true,
      sort_by: 'first_air_date.desc',
      'first_air_date.lte': new Date().toISOString().slice(0, 10),
      ...networkInclusion,
    };
    // Movie: transitional provider-based query (unchanged semantics).
    const movieParams: Record<string, string | number | boolean | undefined> | undefined = watchProviders
      ? {
          page,
          include_adult: true,
          sort_by: 'release_date.desc',
          'release_date.lte': new Date().toISOString().slice(0, 10),
          watch_region: 'IN',
          with_watch_monetization_types: 'flatrate',
          with_watch_providers: watchProviders,
        }
      : undefined;
    const [movieResult, tvResult] = await Promise.all([
      movieParams
        ? tmdbRequest<TmdbList<TmdbMovie>>('/discover/movie', movieParams)
        : Promise.resolve({ results: [], page, total_pages: page } as TmdbList<TmdbMovie>),
      hasTvQuery
        ? tmdbRequest<TmdbList<TmdbTv>>('/discover/tv', tvParams)
        : Promise.resolve({ results: [], page, total_pages: page } as TmdbList<TmdbTv>),
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

// ============================================================
// Phase 7 — dedicated Adult Discover catalog (TMDB adapter).
//
// The backend source of the authorized Adult Discover surface. Per-type
// catalogs (series | movie) with language + sort + bounded pagination —
// NOT a merged rail. The source boundary is SERVER-CONTROLLED:
//
//   TV:    /discover/tv  + with_networks=<verified adult network ids>
//          (adult-catalog.ts -> adult-networks.ts; the client can neither
//          supply nor alter the network set). NO JustWatch prerequisites:
//          no watch_region / with_watch_monetization_types /
//          with_watch_providers — a verified adult network title belongs
//          in the Adult catalog even when TMDB adult=false and even when
//          JustWatch has no India entry for it.
//
//   Movie: /discover/movie has NO network filter in TMDB. The movie side
//          keeps the documented TRANSITIONAL watch-provider inclusion
//          (with_watch_providers=<resolved adult provider ids> +
//          watch_region=IN + flatrate) — the same movie-side architecture
//          the central classifier already considers valid (Signal 3).
//          Nothing is invented: an empty resolved provider set means the
//          movie catalog is EMPTY (safe TV-first under-fill).
//
// CLASSIFIER DEFENSE-IN-DEPTH: every candidate from either half is
// classified through the ONE central classifier (cached detail path,
// bounded concurrency) and ONLY confirmed-adult candidates are returned —
// 'safe' anomalies and 'uncertain' classifications fail CLOSED (see
// adult-discover.ts).
//
// CACHE ISOLATION: responses live in the dedicated `tmdb:adult-discover:*`
// namespace (buildAdultDiscoverCacheKey), structurally disjoint from every
// normal Discover/search namespace and from `tmdb:adult-shows:*`. NO
// authorization dimension: only authorized requests can reach this loader
// (the endpoint 404s and the service returns empty BEFORE any cache
// access), so there is no second cache context to isolate against — the
// same precedent as `tmdb:adult-shows:` (worklog section AA). The applied
// network/provider inclusion values ARE part of the key, so a registry
// change re-keys instead of serving stale-era entries.
//
// FALLBACK SAFETY: upstream failures PROPAGATE — no fixture data, no
// normal-catalog fallback, no silent empty-on-error swallowing here (the
// route renders an error; the Adult catalog never degrades into normal
// content).
// ============================================================

/**
 * Cached-detail verdict loader for Adult Discover candidates (both media
 * types): reads the central classification from the shared, in-flight-
 * deduplicated detail path. Throws on failure — classifyAdultDiscoverRow
 * maps any failure to 'uncertain' (fail-closed).
 */
const adultDiscoverDetailVerdictLoader: AdultDiscoverDetailVerdictLoader = async (mediaType, tmdbId) => {
  const detail = await getTmdbDetail(mediaType, tmdbId);
  return detailVerdict(detail.tags);
};

export async function getTmdbAdultDiscover(filters: AdultDiscoverFilters): Promise<ContentList> {
  const { type, language, sort, page } = filters;
  // ---- Closed-union provider filter (post-release fix). ----
  // `provider` arrives route-validated (isAdultDiscoverProvider) and is
  // mapped HERE to the verified registry id — the client never supplies
  // one. 'all'/absent keeps the full verified set; a verified key narrows
  // BOTH halves to that ONE service (Adult AND provider, never OR):
  //   TV:    with_networks=<that verified network id>
  //   Movie: with_watch_providers=<that service's resolved watch-provider
  //          id> — when the service has no resolved India watch-provider
  //          entry the movie half has NO verified source and stays EMPTY
  //          (fail-closed; never falls back to all providers).
  const selectedProviderKey = isAdultDiscoverProvider(filters.provider) && filters.provider !== ADULT_DISCOVER_PROVIDER_ALL ? filters.provider : undefined;
  const selectedNetworkId = selectedProviderKey ? getVerifiedAdultNetworkIdForKey(selectedProviderKey) : undefined;
  // ---- Server-controlled source boundary (no client input involved). ----
  const networkInclusion = type === 'series' ? withAdultNetworksParams(selectedNetworkId) : {};
  let providerInclusion: string | undefined;
  if (type === 'movie') {
    // Resolve the transitional movie-side source against the live TMDB
    // India provider list (5-min cache). An empty resolved set -> empty
    // catalog (never a fabricated or widened query).
    await getTmdbIndiaProviders();
    const resolvedAdultProviders = getCachedAdultProviders() ?? [];
    if (selectedProviderKey) {
      // Narrowed: only this service's resolved watch-provider id — or
      // nothing (a verified NETWORK without a JustWatch movie presence
      // yields an empty movie catalog, the documented safe under-fill).
      const match = resolvedAdultProviders.find((p) => p.key === selectedProviderKey && p.tmdbProviderId > 0);
      providerInclusion = match ? String(match.tmdbProviderId) : undefined;
    } else {
      const adultIds = getAdultProviderIds();
      providerInclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
    }
  }
  const hasSource = type === 'series' ? 'with_networks' in networkInclusion : Boolean(providerInclusion);
  if (!hasSource) {
    // Nothing verified to query in the relevant ID space — return the
    // empty non-disclosing result rather than fabricating filters. This
    // includes a provider selection with no verified id in the relevant
    // ID space (fail-closed: the selection never widens to 'all').
    return emptyAdultDiscoverResult(page);
  }
  const key = buildAdultDiscoverCacheKey({
    type,
    language,
    sort,
    page,
    networkInclusion: networkInclusion.with_networks,
    providerInclusion,
    provider: filters.provider ?? ADULT_DISCOVER_PROVIDER_ALL
  });
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const sortBy = adultDiscoverSortBy(sort, type);
    const langParam = language !== 'all' && language !== 'other' ? DISCOVER_LANGUAGE_PARAM[language] : undefined;
    const fetchUpstreamPage = async (upstreamPage: number): Promise<UpstreamSearchPage<AdultDiscoverCandidateRow<NormalizedMediaItem>>> => {
      const path = type === 'movie' ? '/discover/movie' : '/discover/tv';
      const params: Record<string, string | number | boolean | undefined> = {
        page: upstreamPage,
        // This IS the authorized Adult surface, so include_adult is true —
        // the classifier below still re-verifies every candidate.
        include_adult: true,
        sort_by: sortBy,
        // Mandatory Adult source constraint (server-controlled):
        ...(type === 'movie'
          ? { watch_region: 'IN', with_watch_monetization_types: 'flatrate', with_watch_providers: providerInclusion }
          : { ...networkInclusion }),
        // Language narrows the Adult catalog (Adult AND language — the
        // Adult constraint is never removed or OR-ed away).
        ...(langParam ? { with_original_language: langParam } : {}),
        // Sort refinements (matching the repo's rail conventions).
        ...(sort === 'newest'
          ? type === 'movie'
            ? { 'release_date.lte': new Date().toISOString().slice(0, 10) }
            : { 'first_air_date.lte': new Date().toISOString().slice(0, 10) }
          : {}),
        ...(sort === 'top-rated' ? { 'vote_count.gte': 5 } : {})
      };
      const result = await tmdbRequest<TmdbList<TmdbMedia>>(path, params);
      // Language post-filter (required for 'other'; a harmless double-check
      // for specific languages). Runs BEFORE classification so uncertain
      // classification work is never spent on rows the filter removes.
      const raw = applyLanguageFilter((result.results ?? []).filter((item) => hasRequiredListMetadata(item, type)), language);
      const rows = raw.map((item) => {
        const mapped = mapTmdb(item, type, 'Adult');
        return {
          item: mapped,
          mediaType: type,
          rawAdult: (item as TmdbMovie).adult,
          isAnime: mapped.isAnime
        };
      });
      return { items: rows, totalPages: result.total_pages ?? upstreamPage };
    };

    // Bounded page continuation + fail-closed classification defense
    // (collects ONLY classifier-confirmed adult candidates).
    const outcome = await collectConfirmedAdultPage<NormalizedMediaItem>({
      startPage: page,
      pageSize: ADULT_DISCOVER_PAGE_SIZE,
      maxUpstreamPages: ADULT_DISCOVER_MAX_UPSTREAM_PAGES,
      concurrency: ADULT_DISCOVER_CLASSIFY_CONCURRENCY,
      fetchUpstreamPage,
      classifyCandidate: (row) => classifyAdultDiscoverRow(row, adultDiscoverDetailVerdictLoader, (item) => String(item.externalIds?.tmdb ?? item.id.replace(/^(movie|series)-/, ''))),
      identityOf: (row) => `${row.item.type}:${row.item.id}`
    });
    return {
      items: outcome.items.map((row) => row.item),
      page,
      hasNextPage: !outcome.upstreamExhausted,
      source: tmdbSource()
    };
  });
  return { ...value, source: { ...value.source, stale } };
}
