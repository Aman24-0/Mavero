// Upcoming releases server module.
//
// Sources:
//   - TMDB Discover Movie (primary_release_date.gte/lte) for upcoming movies
//   - TMDB Discover TV (air_date.gte/lte) for series with episodes airing in
//     the selected month, then TMDB TV season endpoint for the actual
//     Sxx/Exx episode metadata
//   - TMDB watch providers (flatrate only, IN region) for series OTT logos
//   - TMDB Discover TV (air_date.gte/lte + with_genres=16 +
//     with_original_language=ja) for anime episodes airing in the month —
//     anime is now sourced from TMDB TV (Animation genre + Japanese
//     original_language) and shares the same episode-fetch path as Series.
//
// Reliability:
//   - Each source is loaded independently. A failure in one source
//     does NOT crash the whole Upcoming page — partial results are
//     returned with a non-fatal error message in `errors`.
//   - ALL TMDB calls go through the shared adapter request path
//     (`tmdbRequest` in ./adapters/tmdb) so Upcoming gets the same
//     credential handling as the rest of the content layer — including
//     the 401/403 -> api_key fallback for deployments whose
//     TMDB_READ_ACCESS_TOKEN actually holds a v3 API key.
//   - A genuine upstream failure is NEVER reported as an empty month:
//     per-series lookup failures are counted, and if every candidate
//     series lookup fails the series source reports an error instead of
//     silently returning zero episodes.
//   - Results are cached with keys that include month/year/type/region
//     so a popular filter combo doesn't re-hit upstreams on every load.
//
// No fake data: episode numbers, dates, and providers come exclusively
// from upstream. If a field is missing it is omitted (undefined).

import { getOrSet } from './cache';
import { tmdbRequest, getTmdbIndiaProviders } from './adapters/tmdb';
import { ContentServiceError } from './types';
import { isAdultContent, getAdultProviderIds, ensureAdultProvidersResolved } from './adult-providers';
import { adultNetworkExclusionValue } from './adult-catalog';
import { movieRowVerdict } from './search-classify';
import type { UpcomingFilters, UpcomingItem, UpcomingProvider, UpcomingResult, UpcomingType } from './upcoming-types';

const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
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

// TMDB genre id 16 = Animation. Anime is identified as TMDB TV with
// genre 16 AND with_original_language='ja'.
const ANIME_GENRE_ID = 16;
const ANIME_ORIGINAL_LANGUAGE = 'ja';

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

// All TMDB requests use the shared adapter `tmdbRequest` (credential
// fallback + consistent error mapping). Only image URL building stays local.

function tmdbImage(path: string | null | undefined, size: 'w92' | 'w342' | 'w500' | 'w780' | 'original' = 'w500') {
  return path ? `${TMDB_IMAGE}/${size}${path}` : '';
}

// ---------- TMDB movies ----------

type TmdbMovieList = { results?: Array<{ id: number; title?: string; original_title?: string; poster_path?: string | null; backdrop_path?: string | null; release_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number; original_language?: string; adult?: boolean }> };

const genreNames: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
};

async function loadUpcomingMovies(year: number, month: number, region: string): Promise<UpcomingItem[]> {
  const { gte, lte } = monthBounds(year, month);
  // Phase 6: the Upcoming module previously sent NO adult filters at all.
  // /discover/movie supports the TRANSITIONAL watch-provider exclusion
  // (documented Phase 3 movie-side mechanism — same as every other movie
  // rail) — now applied here with its region, plus include_adult=false.
  // The exclusion value is embedded in the cache key so provider-era and
  // no-provider result sets never share an entry.
  await ensureAdultProvidersResolved(() => getTmdbIndiaProviders());
  const adultIds = getAdultProviderIds();
  const providerExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  const key = `upcoming:movies:${year}:${month}:${region}:${providerExclusion ?? 'no-adult'}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    const result = await tmdbRequest<TmdbMovieList>('/discover/movie', {
      'primary_release_date.gte': gte,
      'primary_release_date.lte': lte,
      'release_date.gte': gte,
      'release_date.lte': lte,
      sort_by: 'popularity.desc',
      'vote_count.gte': 1,
      include_adult: false,
      // Pass the actual region so TMDB applies region-aware release-date
      // context (e.g. IN theatrical/availability dates). Without this,
      // the region only lives in the cache key and has no upstream effect.
      region,
      // Transitional movie-side adult exclusion (requires watch_region).
      ...(providerExclusion ? { 'without_watch_providers': providerExclusion, watch_region: region } : {}),
      page: 1
    });
    return result;
  });
  const movies = value.results ?? [];
  return movies
    .filter((m) => m.id && (m.title || m.original_title) && m.release_date)
    // Phase 6 defense-in-depth: classify every row through the ONE central
    // classifier (cheap flag path; anime exemption via genre 16 + ja) and
    // drop adult candidates. Normal rail: filtered regardless of Adult Mode
    // state.
    .filter((m) => movieRowVerdict({
      adult: m.adult,
      isAnime: m.genre_ids?.includes(16) === true && m.original_language === 'ja'
    }) !== 'adult')
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

type TmdbTvList = { results?: Array<{ id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; first_air_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number; original_language?: string }> };
type TmdbTvDetail = { id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; number_of_seasons?: number; last_episode_to_air?: { season_number?: number; episode_number?: number; air_date?: string }; seasons?: Array<{ season_number?: number; air_date?: string; episode_count?: number; poster_path?: string | null }>; networks?: Array<{ id?: number; name?: string | null }> };
type TmdbSeason = { season_number?: number; episodes?: Array<{ id: number; episode_number?: number; season_number?: number; name?: string; air_date?: string; still_path?: string | null; overview?: string }> };
type TmdbWatchProviders = { results?: Record<string, { flatrate?: Array<{ provider_id?: number; provider_name?: string; logo_path?: string | null }> }> };

async function getTvWatchProviders(seriesId: number, region: string): Promise<UpcomingProvider[]> {
  const key = `upcoming:providers:tv:${seriesId}:${region}`;
  const { value } = await getOrSet(key, providerPolicy, async () => {
    try {
      const result = await tmdbRequest<TmdbWatchProviders>(`/tv/${seriesId}/watch/providers`);
      // Only use the requested region's flatrate data. Do NOT fall back
      // to US or any other region — if the requested region (e.g. IN)
      // has no flatrate data, the provider row is hidden cleanly. The UI
      // does not label the provider region, so showing cross-region
      // providers would be misleading.
      const regionData = result.results?.[region];
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

async function getTvSeasonEpisodes(seriesId: number, seasonNumber: number): Promise<TmdbSeason> {
  const key = `upcoming:season:tv:${seriesId}:${seasonNumber}`;
  const { value } = await getOrSet(key, seasonPolicy, async () => {
    // Deliberately NOT caught here: a failed season lookup must propagate so
    // the caller can distinguish "no episodes this month" (real empty) from
    // "the episode data could not be loaded" (upstream failure). Failures are
    // not cached, so a transient error self-heals on the next request.
    return tmdbRequest<TmdbSeason>(`/tv/${seriesId}/season/${seasonNumber}`);
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

// Build one UpcomingItem per real TMDB episode airing in the selected
// month. A series with 3 episodes airing in the month produces 3 items,
// each with its actual season/episode/date/title. No metadata is
// fabricated — if TMDB doesn't provide a field, it is omitted.
//
// `itemType` controls the `type` field on the emitted UpcomingItem and
// the id prefix ('series-' or 'anime-'). Anime uses the same TMDB TV
// path as Series — the difference is that anime candidates are
// pre-filtered to genre 16 + original_language 'ja' in loadUpcomingAnime.
async function buildSeriesItems(raw: { id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; genre_ids?: number[]; original_language?: string }, year: number, month: number, region: string, itemType: 'series' | 'anime' = 'series'): Promise<UpcomingItem[]> {
  // Fetch series detail to find the most recent / current season.
  // NOT caught: a failed detail lookup propagates so loadUpcomingSeries can
  // distinguish "no episodes this month" from "upstream failure" (which
  // also makes classification uncertain -> the candidate is dropped —
  // fail-closed for this adult-sensitive path).
  const detail = await tmdbRequest<TmdbTvDetail>(`/tv/${raw.id}`);
  // Phase 6 — central Adult classification (defense-in-depth on top of the
  // without_networks query filter). The detail response carries networks[];
  // a VERIFIED adult network classifies the title as Adult even when TMDB's
  // generic adult flag is false. The anime exemption lives inside the ONE
  // central classifier (genre 16 + ja candidates keep their exemption — the
  // flag signal never classifies anime alone, but an adult NETWORK signal
  // still applies to any content). There is deliberately NO title blacklist
  // and NO genre heuristic here.
  const isAnimeCandidate = raw.genre_ids?.includes(16) === true && raw.original_language === 'ja';
  if (isAdultContent(undefined, undefined, undefined, isAnimeCandidate, detail.networks)) {
    return [];
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
  if (seasonToInspect === undefined) return [];

  const season = await getTvSeasonEpisodes(raw.id, seasonToInspect);
  if (!season?.episodes?.length) return [];

  // Find ALL episodes airing in the target month. Each becomes its own
  // UpcomingItem so the calendar shows every airing event.
  const { startMs, endMs } = monthBounds(year, month);
  const inMonthEpisodes = season.episodes
    .filter((ep) => {
      if (!ep.air_date) return false;
      const ms = Date.parse(ep.air_date);
      return ms >= startMs && ms <= endMs;
    })
    .sort((a, b) => (a.air_date ?? '').localeCompare(b.air_date ?? ''));
  if (!inMonthEpisodes.length) return [];

  // Fetch providers once for the series (same for all episodes).
  const providers = await getTvWatchProviders(raw.id, region);

  const title = detail.name || detail.original_name || raw.name || raw.original_name || 'Untitled';
  const poster = tmdbImage(detail.poster_path ?? raw.poster_path, 'w500');
  const backdrop = tmdbImage(detail.backdrop_path ?? raw.backdrop_path, 'w780') || undefined;
  const rating = detail.vote_average ? Math.round(detail.vote_average * 10) / 10 : undefined;
  const genres = raw.genre_ids?.map((id) => genreNames[id]).filter(Boolean).slice(0, 3);
  const providerSlice = providers.length ? providers.slice(0, 3) : undefined;

  // Emit one item per in-month episode. The id prefix differs for anime
  // (type='anime', id='anime-...') so the upcoming page can render the
  // Anime badge and route the click to the /anime/{tmdbId} detail page.
  return inMonthEpisodes.map((episode) => {
    const date = episode.air_date ?? '';
    return {
      id: `${itemType}-${raw.id}-s${seasonToInspect}e${episode.episode_number ?? 0}`,
      type: itemType,
      title,
      poster,
      backdrop,
      date,
      timestamp: Date.parse(date) || 0,
      season: seasonToInspect,
      episode: episode.episode_number ?? undefined,
      episodeTitle: episode.name || undefined,
      providers: providerSlice,
      year: Number(date.slice(0, 4)) || undefined,
      rating,
      genres,
      source: 'tmdb' as const
    } satisfies UpcomingItem;
  });
}

async function loadUpcomingSeries(year: number, month: number, region: string): Promise<UpcomingItem[]> {
  const { gte, lte } = monthBounds(year, month);
  // Phase 6: the Upcoming series source previously sent NO adult filters.
  // /discover/tv supports the canonical Phase 3 mechanism — exclude VERIFIED
  // adult TV NETWORKS via without_networks (values from the central registry
  // via adult-catalog.ts) — plus include_adult=false. The exclusion value is
  // embedded in the cache key (no network-era/no-filter result sharing).
  const networkExclusion = adultNetworkExclusionValue();
  const key = `upcoming:series:${year}:${month}:${region}:${networkExclusion ?? 'no-nets'}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    // Step 1: discover TV series with episodes airing in the month.
    const result = await tmdbRequest<TmdbTvList>('/discover/tv', {
      'air_date.gte': gte,
      'air_date.lte': lte,
      sort_by: 'popularity.desc',
      'vote_count.gte': 1,
      include_adult: false,
      ...(networkExclusion ? { without_networks: networkExclusion } : {}),
      page: 1
    });
    const candidates = (result.results ?? []).filter((s) => s.id && (s.name || s.original_name)).slice(0, 20);
    // Step 2: for each candidate, fetch detail + season + episodes to
    // find ALL episodes airing in the month (one UpcomingItem per
    // episode). Concurrency-limited to avoid N+1 request explosions.
    // Per-candidate failures are counted — if EVERY candidate lookup
    // fails, the source failed upstream and must surface as an error,
    // never as a silently empty month. Partial success still returns
    // the real episodes that did load.
    let failures = 0;
    const built = await mapWithConcurrency(candidates, async (c) => {
      try {
        return await buildSeriesItems(c, year, month, region);
      } catch {
        failures += 1;
        return [];
      }
    }, LOOKUP_CONCURRENCY);
    if (candidates.length > 0 && failures === candidates.length) {
      throw new ContentServiceError('The content provider returned an upstream error.', { code: 'UPSTREAM_ERROR', status: 502 });
    }
    // buildSeriesItems returns UpcomingItem[] per candidate — flatten.
    return built.flat();
  });
  return value.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- TMDB TV anime (genre 16 + original_language 'ja') ----------

// Anime airing schedule now comes from TMDB TV (Animation genre + Japanese
// original_language). The /discover/tv endpoint accepts air_date.gte/lte +
// with_genres=16 + with_original_language='ja' to filter server-side. The
// candidate series are then processed by the same buildSeriesItems path as
// Series — the only difference is the `itemType='anime'` flag, which
// controls the UpcomingItem.type field and the id prefix so the upcoming
// page can render the Anime badge and route clicks to /anime/{tmdbId}.
//
// IMPORTANT: this replaces the previous AniList AiringSchedule source.
// AniList is no longer used — anime is now TMDB content only.
export async function loadUpcomingAnime(year: number, month: number, region: string = DEFAULT_REGION): Promise<UpcomingItem[]> {
  const { gte, lte } = monthBounds(year, month);
  // Phase 6: include_adult=false (consistent with the anime rails) + the
  // canonical without_networks exclusion. The anime exemption is preserved:
  // the ONE central classifier never classifies an anime title adult from
  // the TMDB flag alone — but a VERIFIED adult-network signal still applies,
  // so excluding adult networks here cannot suppress legitimate anime.
  const networkExclusion = adultNetworkExclusionValue();
  const key = `upcoming:anime:${year}:${month}:${region}:${networkExclusion ?? 'no-nets'}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    // Step 1: discover anime TV series with episodes airing in the month.
    // TMDB filters server-side by Animation genre (16) + ja language.
    const result = await tmdbRequest<TmdbTvList>('/discover/tv', {
      'air_date.gte': gte,
      'air_date.lte': lte,
      with_genres: ANIME_GENRE_ID,
      with_original_language: ANIME_ORIGINAL_LANGUAGE,
      sort_by: 'popularity.desc',
      'vote_count.gte': 1,
      include_adult: false,
      ...(networkExclusion ? { without_networks: networkExclusion } : {}),
      page: 1
    });
    const candidates = (result.results ?? [])
      .filter((s) => s.id && (s.name || s.original_name))
      // Defense in depth: TMDB filters server-side, but ensure the
      // candidate actually looks like anime (genre 16 in genre_ids).
      .filter((s) => Array.isArray(s.genre_ids) ? s.genre_ids.includes(ANIME_GENRE_ID) : true)
      .slice(0, 20);
    // Step 2: for each candidate, fetch detail + season + episodes via
    // the shared buildSeriesItems path. itemType='anime' so the emitted
    // UpcomingItems have type='anime' and id='anime-{tmdbId}-s{S}e{E}'.
    let failures = 0;
    const built = await mapWithConcurrency(candidates, async (c) => {
      try {
        return await buildSeriesItems(c, year, month, region, 'anime');
      } catch {
        failures += 1;
        return [];
      }
    }, LOOKUP_CONCURRENCY);
    if (candidates.length > 0 && failures === candidates.length) {
      throw new ContentServiceError('The content provider returned an upstream error.', { code: 'UPSTREAM_ERROR', status: 502 });
    }
    return built.flat();
  });
  return value.sort((a, b) => a.timestamp - b.timestamp);
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
      loadUpcomingAnime(filters.year, filters.month, region)
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
  buildSeriesItems,
  DEFAULT_REGION,
  ANIME_GENRE_ID,
  ANIME_ORIGINAL_LANGUAGE
};
