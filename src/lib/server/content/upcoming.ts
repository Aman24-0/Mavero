// Upcoming releases server module.
//
// Sources:
//   - TMDB Discover Movie (primary_release_date.gte/lte) for upcoming movies
//   - TMDB Discover TV (air_date.gte/lte) for series with episodes airing in
//     the selected month, then TMDB TV season endpoint for the actual
//     Sxx/Exx episode metadata
//   - TMDB watch providers (flatrate only, IN region) for series OTT logos
//   - AniList AiringSchedule query for anime episodes airing in the month
//
// Reliability:
//   - Each source is loaded independently. A failure in one source
//     does NOT crash the whole Upcoming page — partial results are
//     returned with a non-fatal error message in `errors`.
//   - All upstream calls go through the existing `fetchJson` helper
//     which wraps fetch in try/catch + timeout + ContentServiceError.
//   - Results are cached with keys that include month/year/type/region
//     so a popular filter combo doesn't re-hit upstreams on every load.
//
// No fake data: episode numbers, dates, and providers come exclusively
// from upstream. If a field is missing it is omitted (undefined).

import { env } from '$env/dynamic/private';
import { getOrSet } from './cache';
import { fetchJson } from './http';
import { ContentServiceError } from './types';
import type { UpcomingFilters, UpcomingItem, UpcomingProvider, UpcomingResult, UpcomingType } from './upcoming-types';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
const ANILIST_API = env.ANILIST_API_URL || 'https://graphql.anilist.co';
const DEFAULT_REGION = 'IN';

// Cache: upcoming data is relatively slow to assemble (TMDB TV needs
// N season lookups). Use a 10-minute TTL with 30-minute stale-while-
// revalidate so a burst of filter changes doesn't hammer upstreams.
const upcomingPolicy = { ttlMs: 1000 * 60 * 10, staleWhileRevalidateMs: 1000 * 60 * 30 };
// Per-series season lookup cache (longer TTL — episode metadata rarely
// changes once aired).
const seasonPolicy = { ttlMs: 1000 * 60 * 30, staleWhileRevalidateMs: 1000 * 60 * 60 * 4 };
// Per-series provider lookup cache.
const providerPolicy = { ttlMs: 1000 * 60 * 30, staleWhileRevalidateMs: 1000 * 60 * 60 * 2 };

// Concurrency limit for season + provider lookups (matches existing
// Mavero OTT_LOOKUP_CONCURRENCY pattern).
const LOOKUP_CONCURRENCY = 4;

// ---------- filter parsing & validation ----------

export function parseUpcomingMonth(value: string | null | undefined): number {
  const now = new Date();
  if (!value) return now.getMonth() + 1;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  return now.getMonth() + 1;
}

export function parseUpcomingYear(value: string | null | undefined): number {
  const now = new Date();
  if (!value) return now.getFullYear();
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1900 && n <= 2100) return n;
  return now.getFullYear();
}

export function parseUpcomingType(value: string | null | undefined): 'all' | UpcomingType {
  if (value === 'movie' || value === 'series' || value === 'anime') return value;
  return 'all';
}

// Dynamic year options: current year, previous year, and next 3 years.
// Gives a useful surrounding range without hard-coding a specific year.
export function upcomingYearOptions(): number[] {
  const current = new Date().getFullYear();
  return [current - 1, current, current + 1, current + 2, current + 3];
}

// ---------- date helpers ----------

export function monthBounds(year: number, month: number): { gte: string; lte: string; startMs: number; endMs: number } {
  // month is 1-12. Build YYYY-MM-DD strings for the first and last day
  // of the month. Date.UTC handles day-0-of-next-month = last-day-of-
  // this-month correctly.
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // day 0 = last day of prev month
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    gte: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`,
    lte: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`,
    startMs: start.getTime(),
    endMs: end.getTime() + 24 * 60 * 60 * 1000 - 1
  };
}

// ---------- TMDB helpers (self-contained, does not modify adapter) ----------

function requireTmdbCredentials() {
  const token = env.TMDB_READ_ACCESS_TOKEN;
  const apiKey = env.TMDB_API_KEY;
  if (!token && !apiKey) {
    throw new ContentServiceError('TMDB credentials are not configured.', { code: 'CONFIG_MISSING', status: 503 });
  }
  return { token, apiKey };
}

async function tmdbRequest<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const { token, apiKey } = requireTmdbCredentials();
  const url = new URL(`${TMDB_BASE}${path}`);
  Object.entries({ language: 'en-US', ...params }).forEach(([key, value]) => {
    if (value !== undefined) url.searchParams.set(key, String(value));
  });
  if (!token && apiKey) url.searchParams.set('api_key', apiKey);
  return fetchJson<T>(url.toString(), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined
  });
}

function tmdbImage(path: string | null | undefined, size: 'w92' | 'w342' | 'w500' | 'w780' | 'original' = 'w500') {
  return path ? `${TMDB_IMAGE}/${size}${path}` : '';
}

// ---------- TMDB movies ----------

type TmdbMovieList = { results?: Array<{ id: number; title?: string; original_title?: string; poster_path?: string | null; backdrop_path?: string | null; release_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number }> };

const genreNames: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
};

async function loadUpcomingMovies(year: number, month: number, region: string): Promise<UpcomingItem[]> {
  const { gte, lte } = monthBounds(year, month);
  const key = `upcoming:movies:${year}:${month}:${region}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    const result = await tmdbRequest<TmdbMovieList>('/discover/movie', {
      'primary_release_date.gte': gte,
      'primary_release_date.lte': lte,
      'release_date.gte': gte,
      'release_date.lte': lte,
      sort_by: 'popularity.desc',
      'vote_count.gte': 1,
      page: 1
    });
    return result;
  });
  const movies = value.results ?? [];
  return movies
    .filter((m) => m.id && (m.title || m.original_title) && m.release_date)
    .map((m) => {
      const date = m.release_date ?? '';
      return {
        id: `movie-${m.id}`,
        type: 'movie' as const,
        title: m.title || m.original_title || 'Untitled',
        poster: tmdbImage(m.poster_path, 'w500'),
        backdrop: tmdbImage(m.backdrop_path, 'w780') || undefined,
        date,
        timestamp: Date.parse(date) || 0,
        year: Number(date.slice(0, 4)) || undefined,
        rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : undefined,
        genres: m.genre_ids?.map((id) => genreNames[id]).filter(Boolean).slice(0, 3),
        source: 'tmdb' as const
      } satisfies UpcomingItem;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- TMDB TV episodes ----------

type TmdbTvList = { results?: Array<{ id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; first_air_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number }> };
type TmdbTvDetail = { id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; number_of_seasons?: number; last_episode_to_air?: { season_number?: number; episode_number?: number; air_date?: string }; seasons?: Array<{ season_number?: number; air_date?: string; episode_count?: number; poster_path?: string | null }> };
type TmdbSeason = { season_number?: number; episodes?: Array<{ id: number; episode_number?: number; season_number?: number; name?: string; air_date?: string; still_path?: string | null; overview?: string }> };
type TmdbWatchProviders = { results?: Record<string, { flatrate?: Array<{ provider_id?: number; provider_name?: string; logo_path?: string | null }> }> };

async function getTvWatchProviders(seriesId: number, region: string): Promise<UpcomingProvider[]> {
  const key = `upcoming:providers:tv:${seriesId}:${region}`;
  const { value } = await getOrSet(key, providerPolicy, async () => {
    try {
      const result = await tmdbRequest<TmdbWatchProviders>(`/tv/${seriesId}/watch/providers`);
      const regionData = result.results?.[region] ?? result.results?.IN ?? result.results?.US;
      const flatrate = regionData?.flatrate ?? [];
      return flatrate
        .filter((p): p is { provider_id: number; provider_name: string; logo_path: string } => typeof p.provider_id === 'number' && typeof p.provider_name === 'string' && typeof p.logo_path === 'string')
        .map((p) => ({ id: p.provider_id, name: p.provider_name, logo: tmdbImage(p.logo_path, 'w92') }));
    } catch {
      return null; // transient failure — caller treats null as "no provider data"
    }
  });
  return value ?? [];
}

async function getTvSeasonEpisodes(seriesId: number, seasonNumber: number): Promise<TmdbSeason | null> {
  const key = `upcoming:season:tv:${seriesId}:${seasonNumber}`;
  const { value } = await getOrSet(key, seasonPolicy, async () => {
    try {
      return await tmdbRequest<TmdbSeason>(`/tv/${seriesId}/season/${seasonNumber}`);
    } catch {
      return null;
    }
  });
  return value;
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

async function buildSeriesItem(raw: { id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; genre_ids?: number[] }, year: number, month: number, region: string): Promise<UpcomingItem | null> {
  // Fetch series detail to find the most recent / current season.
  let detail: TmdbTvDetail;
  try {
    detail = await tmdbRequest<TmdbTvDetail>(`/tv/${raw.id}`);
  } catch {
    return null;
  }
  // Determine the season to inspect: prefer last_episode_to_air's season,
  // otherwise the latest season with a future air_date, otherwise the
  // highest season_number > 0.
  const lastSeason = detail.last_episode_to_air?.season_number;
  const seasons = (detail.seasons ?? []).filter((s) => typeof s.season_number === 'number' && s.season_number > 0);
  const candidateSeasons = seasons
    .map((s) => s.season_number as number)
    .sort((a, b) => a - b);
  let seasonToInspect: number | undefined = lastSeason ?? undefined;
  if (seasonToInspect === undefined && candidateSeasons.length) {
    // Pick the season whose air_date is closest to (but not after) the
    // target month — i.e. the season most likely to have episodes airing
    // in the target month.
    const { startMs } = monthBounds(year, month);
    const withDates = seasons
      .filter((s) => s.air_date)
      .map((s) => ({ number: s.season_number as number, ms: Date.parse(s.air_date as string) || 0 }))
      .sort((a, b) => Math.abs(a.ms - startMs) - Math.abs(b.ms - startMs));
    seasonToInspect = withDates[0]?.number ?? candidateSeasons[candidateSeasons.length - 1];
  }
  if (seasonToInspect === undefined) return null;

  const season = await getTvSeasonEpisodes(raw.id, seasonToInspect);
  if (!season?.episodes?.length) return null;

  // Find episodes airing in the target month.
  const { startMs, endMs } = monthBounds(year, month);
  const inMonthEpisodes = season.episodes.filter((ep) => {
    if (!ep.air_date) return false;
    const ms = Date.parse(ep.air_date);
    return ms >= startMs && ms <= endMs;
  });
  if (!inMonthEpisodes.length) return null;

  // Take the first upcoming episode (earliest air date in month).
  const episode = inMonthEpisodes.sort((a, b) => (a.air_date ?? '').localeCompare(b.air_date ?? ''))[0];
  const providers = await getTvWatchProviders(raw.id, region);

  const date = episode.air_date ?? '';
  return {
    id: `series-${raw.id}-s${seasonToInspect}e${episode.episode_number ?? 0}`,
    type: 'series',
    title: detail.name || detail.original_name || raw.name || raw.original_name || 'Untitled',
    poster: tmdbImage(detail.poster_path ?? raw.poster_path, 'w500'),
    backdrop: tmdbImage(detail.backdrop_path ?? raw.backdrop_path, 'w780') || undefined,
    date,
    timestamp: Date.parse(date) || 0,
    season: seasonToInspect,
    episode: episode.episode_number ?? undefined,
    episodeTitle: episode.name || undefined,
    providers: providers.length ? providers.slice(0, 3) : undefined,
    year: Number(date.slice(0, 4)) || undefined,
    rating: detail.vote_average ? Math.round(detail.vote_average * 10) / 10 : undefined,
    genres: raw.genre_ids?.map((id) => genreNames[id]).filter(Boolean).slice(0, 3),
    source: 'tmdb'
  };
}

async function loadUpcomingSeries(year: number, month: number, region: string): Promise<UpcomingItem[]> {
  const { gte, lte } = monthBounds(year, month);
  const key = `upcoming:series:${year}:${month}:${region}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    // Step 1: discover TV series with episodes airing in the month.
    const result = await tmdbRequest<TmdbTvList>('/discover/tv', {
      'air_date.gte': gte,
      'air_date.lte': lte,
      sort_by: 'popularity.desc',
      'vote_count.gte': 1,
      page: 1
    });
    const candidates = (result.results ?? []).filter((s) => s.id && (s.name || s.original_name)).slice(0, 20);
    // Step 2: for each candidate, fetch detail + season + episodes to
    // find the actual Sxx/Exx airing in the month. Concurrency-limited
    // to avoid N+1 request explosions.
    const built = await mapWithConcurrency(candidates, (c) => buildSeriesItem(c, year, month, region), LOOKUP_CONCURRENCY);
    return built.filter((item): item is UpcomingItem => item !== null);
  });
  return value.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- AniList anime ----------

type AniListAiringSchedule = {
  id: number;
  episode: number | null;
  airingAt: number | null; // unix seconds
  media?: {
    id: number;
    title?: { romaji?: string | null; english?: string | null; native?: string | null };
    coverImage?: { extraLarge?: string | null; large?: string | null; medium?: string | null; color?: string | null };
    bannerImage?: string | null;
    averageScore?: number | null;
    genres?: string[] | null;
    seasonYear?: number | null;
  } | null;
};
type AniListAiringResponse = { data?: { Page?: { airingSchedules?: AniListAiringSchedule[] } }; errors?: { message?: string }[] };

const animeAiringQuery = `query ($page: Int, $airingAt_greater: Int, $airingAt_lesser: Int) {
  Page(page: $page, perPage: 50) {
    airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME) {
      id
      episode
      airingAt
      media {
        id
        title { romaji english native }
        coverImage { extraLarge large medium color }
        bannerImage
        averageScore
        genres
        seasonYear
      }
    }
  }
}`;

export async function loadUpcomingAnime(year: number, month: number): Promise<UpcomingItem[]> {
  const { startMs, endMs } = monthBounds(year, month);
  const key = `upcoming:anime:${year}:${month}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    const response = await fetchJson<AniListAiringResponse>(ANILIST_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: animeAiringQuery,
        variables: {
          page: 1,
          airingAt_greater: Math.floor(startMs / 1000),
          airingAt_lesser: Math.floor(endMs / 1000)
        }
      })
    });
    if (response.errors?.length) {
      throw new ContentServiceError('AniList returned a GraphQL error.', { code: 'UPSTREAM_ERROR', status: 502 });
    }
    const schedules = response.data?.Page?.airingSchedules ?? [];
    return schedules
      .filter((s) => s.media && (s.media.title?.english || s.media.title?.romaji || s.media.title?.native))
      .map((s) => {
        const media = s.media!;
        const title = media.title?.english || media.title?.romaji || media.title?.native || 'Untitled anime';
        const poster = media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || '';
        const ts = (s.airingAt ?? 0) * 1000;
        const d = new Date(ts);
        const pad = (n: number) => String(n).padStart(2, '0');
        const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
        return {
          id: `anime-${media.id}-ep${s.episode ?? 0}`,
          type: 'anime' as const,
          title,
          poster,
          backdrop: media.bannerImage || undefined,
          date,
          timestamp: ts,
          episode: s.episode ?? undefined,
          year: media.seasonYear || d.getUTCFullYear(),
          rating: media.averageScore ? Math.round((media.averageScore / 10) * 10) / 10 : undefined,
          genres: media.genres?.slice(0, 3),
          source: 'anilist' as const
        } satisfies UpcomingItem;
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  });
  return value;
}

// ---------- top-level orchestrator ----------

export async function loadUpcoming(filters: UpcomingFilters): Promise<UpcomingResult> {
  const region = DEFAULT_REGION;
  const errors: string[] = [];
  const items: UpcomingItem[] = [];

  const wantMovies = filters.type === 'all' || filters.type === 'movie';
  const wantSeries = filters.type === 'all' || filters.type === 'series';
  const wantAnime = filters.type === 'all' || filters.type === 'anime';

  const tasks: Array<Promise<void>> = [];

  if (wantMovies) {
    tasks.push(
      loadUpcomingMovies(filters.year, filters.month, region)
        .then((m) => { items.push(...m); })
        .catch((err) => { errors.push(`Movies: ${safeMessage(err)}`); })
    );
  }
  if (wantSeries) {
    tasks.push(
      loadUpcomingSeries(filters.year, filters.month, region)
        .then((s) => { items.push(...s); })
        .catch((err) => { errors.push(`Series: ${safeMessage(err)}`); })
    );
  }
  if (wantAnime) {
    tasks.push(
      loadUpcomingAnime(filters.year, filters.month)
        .then((a) => { items.push(...a); })
        .catch((err) => { errors.push(`Anime: ${safeMessage(err)}`); })
    );
  }

  await Promise.all(tasks);

  // Sort all items chronologically.
  items.sort((a, b) => a.timestamp - b.timestamp);

  return {
    items,
    filters,
    errors,
    errorMessage: items.length === 0 && errors.length > 0 ? 'Upcoming releases are temporarily unavailable. Please try again.' : undefined
  };
}

function safeMessage(err: unknown): string {
  if (err instanceof ContentServiceError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

// Exported for tests + diagnostics.
export const upcomingInternals = {
  parseUpcomingMonth,
  parseUpcomingYear,
  parseUpcomingType,
  upcomingYearOptions,
  monthBounds,
  loadUpcomingMovies,
  loadUpcomingSeries,
  loadUpcomingAnime,
  getTvWatchProviders,
  buildSeriesItem,
  DEFAULT_REGION
};
