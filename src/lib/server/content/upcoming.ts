// Upcoming releases server module.
//
// Sources (Phase F — India release model):
//   - TMDB Discover Movie x2 for upcoming movies in INDIA:
//       · India THEATRICAL: region=IN + release_date month window +
//         with_release_type=2|3 (theatrical limited + theatrical)
//       · India DIGITAL/OTT: region=IN + release_date month window +
//         with_release_type=4
//     The two result sets are merged + deduped by canonical movie ID
//     (one card per movie, earliest India release date, releaseKinds
//     metadata) and walked beyond upstream page 1 while real results
//     remain, under a hard page-safety cap. primary_release_date is
//     deliberately NOT required together with release_date — that
//     dual-filter excluded movies whose primary (origin-country)
//     release fell outside the month even though their INDIA
//     theatrical/digital release was inside it (the old
//     "only ~10 titles / empty later months" regression).
//   - TMDB Discover TV (air_date.gte/lte) for series with episodes
//     airing in the selected month — REQUIRED to be India OTT oriented:
//     watch_region=IN + with_watch_monetization_types=flatrate
//     (subscription availability in India, server-side) + the generic
//     linear-TV genre exclusion (Soap/News/Talk) + the Upcoming-only
//     serial curation policy (upcoming-policy.ts). Buy/rent-only and
//     non-India providers are NOT accepted.
//   - TMDB TV season endpoint for the actual Sxx/Exx episode metadata,
//     resolved through MONTH-WINDOW season candidates
//     (selectUpcomingSeasonCandidates) instead of the unsafe
//     last_episode_to_air preference: for a future target month the
//     season airing new episodes is frequently a NEWER season than the
//     last-aired one. ALL real in-month episodes across the relevant
//     seasons are returned.
//   - TMDB watch providers (flatrate only, IN region) for series OTT logos
//   - TMDB Discover TV (air_date.gte/lte + with_genres=16 +
//     with_original_language=ja) for anime episodes airing in the month —
//     anime is sourced from TMDB TV (Animation genre + Japanese
//     original_language) and shares the season/episode-fetch path as
//     Series (with the anime curation exemption). No AniList/Yenime.
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
//   - Results are cached with keys that include month/year/type/region,
//     the adult-exclusion dimensions AND the policy/query version
//     constants from upcoming-policy.ts, so a policy or query-semantics
//     change re-keys instead of serving stale-era entries.
//
// No fake data: episode numbers, dates, and providers come exclusively
// from upstream. If a field is missing it is omitted (undefined).

import { getOrSet } from './cache';
import { tmdbRequest, getTmdbIndiaProviders } from './adapters/tmdb';
import { ContentServiceError } from './types';
import { isAdultContent, getAdultProviderIds, ensureAdultProvidersResolved } from './adult-providers';
import { adultNetworkExclusionValue } from './adult-catalog';
import { movieRowVerdict } from './search-classify';
import {
  UPCOMING_TV_WITHOUT_GENRES,
  UPCOMING_TV_SERIAL_POLICY_KEY,
  UPCOMING_TV_OTT_QUERY_KEY,
  UPCOMING_SEASON_MODEL_KEY,
  UPCOMING_MOVIE_RELEASE_MODEL_KEY,
  UPCOMING_MOVIE_RELEASE_TYPES,
  UPCOMING_MOVIE_MAX_UPSTREAM_PAGES,
  UPCOMING_TV_MAX_CANDIDATE_PAGES,
  UPCOMING_TV_MAX_CANDIDATES,
  UPCOMING_MAX_SEASON_INSPECTIONS,
  upcomingTvCurationVerdict,
  selectUpcomingSeasonCandidates,
  mergeMovieReleaseEvents
} from '../../shared/upcoming-policy';
import type { UpcomingFilters, UpcomingItem, UpcomingProvider, UpcomingReleaseKind, UpcomingResult, UpcomingType } from './upcoming-types';

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

type TmdbMovieList = { results?: Array<TmdbMovieRow>; total_pages?: number; total_results?: number; page?: number };

type TmdbMovieRow = { id: number; title?: string; original_title?: string; poster_path?: string | null; backdrop_path?: string | null; release_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number; original_language?: string; adult?: boolean };

const genreNames: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
};

// Phase F — India movie release model.
//
// ONE movie card per canonical TMDB movie, discovered through TWO
// separate logical TMDB discover queries (kept explicit because TMDB
// documents release-type ordering behavior — '2|3|4' in one query is
// NOT treated as equivalent):
//   A) INDIA THEATRICAL  — with_release_type='2|3'
//   B) INDIA DIGITAL/OTT — with_release_type='4'
// Both queries:
//   - region=IN so release_date.gte/lte filter INDIAN release dates
//   - release_date month window ONLY — primary_release_date is
//     deliberately NOT required together with release_date (the old
//     dual-filter suppressed real India releases whose primary release
//     fell in another country/month)
//   - include_adult=false + the transitional adult watch-provider
//     exclusion (requires watch_region — kept from Phase 6)
//   - bounded upstream pagination: pages are walked while TMDB reports
//     more pages, capped by UPCOMING_MOVIE_MAX_UPSTREAM_PAGES so a
//     pathological query can never loop unbounded; total_pages is read
//     from the real upstream response, never fabricated.
//
// Upstream ordering is popularity (a documented, anchor-free sort);
// the merged result is ordered chronologically by the real India
// release date at merge time — the user-visible order stays
// deterministic and date-true even when page-walking truncates the
// long tail (most relevant titles survive the cap).
async function discoverIndiaMovieRows(kind: 'theatrical' | 'digital', year: number, month: number, region: string, providerExclusion: string | undefined): Promise<TmdbMovieRow[]> {
  const { gte, lte } = monthBounds(year, month);
  // Cache keys are per-kind (theatrical and digital result sets can
  // never collide) and embed every query dimension: kind, year, month,
  // region, adult exclusion and the release-model version.
  const key = `upcoming:movies:${kind}:${year}:${month}:${region}:${providerExclusion ?? 'no-adult'}:${UPCOMING_MOVIE_RELEASE_MODEL_KEY}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    const collected: TmdbMovieRow[] = [];
    const seen = new Set<number>();
    let page = 1;
    let totalPages = 1;
    while (page <= Math.min(totalPages, UPCOMING_MOVIE_MAX_UPSTREAM_PAGES)) {
      const result = await tmdbRequest<TmdbMovieList>('/discover/movie', {
        // Pass the actual region so TMDB applies region-aware
        // release-date context (India release dates + release types).
        region,
        'release_date.gte': gte,
        'release_date.lte': lte,
        with_release_type: UPCOMING_MOVIE_RELEASE_TYPES[kind],
        sort_by: 'popularity.desc',
        'vote_count.gte': 1,
        include_adult: false,
        // Transitional movie-side adult exclusion (requires watch_region).
        ...(providerExclusion ? { 'without_watch_providers': providerExclusion, watch_region: region } : {}),
        page
      });
      for (const row of result.results ?? []) {
        if (row.id && !seen.has(row.id)) {
          seen.add(row.id);
          collected.push(row);
        }
      }
      totalPages = result.total_pages ?? page;
      if ((result.page ?? page) >= totalPages) break;
      page += 1;
    }
    return collected;
  });
  return value;
}

async function loadUpcomingMovies(year: number, month: number, region: string): Promise<UpcomingItem[]> {
  // Phase 6: the Upcoming module previously sent NO adult filters at all.
  // /discover/movie supports the TRANSITIONAL watch-provider exclusion
  // (documented Phase 3 movie-side mechanism — same as every other movie
  // rail) — applied to BOTH release-kind queries with its region, plus
  // include_adult=false. The exclusion value is embedded in the cache
  // keys so provider-era and no-provider result sets never share an entry.
  await ensureAdultProvidersResolved(() => getTmdbIndiaProviders());
  const adultIds = getAdultProviderIds();
  const providerExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  const [theatricalRows, digitalRows] = await Promise.all([
    discoverIndiaMovieRows('theatrical', year, month, region, providerExclusion),
    discoverIndiaMovieRows('digital', year, month, region, providerExclusion)
  ]);
  // Merge + dedupe (one card per movie, earliest India release date,
  // canonical releaseKinds order) then map to UpcomingItems with the
  // releaseKinds metadata preserved for the UI.
  const events = mergeMovieReleaseEvents(
    theatricalRows.map((m) => ({ tmdbId: m.id, date: m.release_date ?? '' })),
    digitalRows.map((m) => ({ tmdbId: m.id, date: m.release_date ?? '' }))
  );
  const rowsById = new Map<number, TmdbMovieRow>();
  for (const row of [...theatricalRows, ...digitalRows]) if (row.id && !rowsById.has(row.id)) rowsById.set(row.id, row);
  return events
    .map((event): UpcomingItem | null => {
      const m = rowsById.get(event.tmdbId);
      // Same metadata contract as before Phase F: a row without a real
      // title or without a parseable India release date is not a card.
      if (!m || (!m.title && !m.original_title)) return null;
      const date = event.date;
      if (!date || !Number.isFinite(Date.parse(date))) return null;
      const releaseKinds: UpcomingReleaseKind[] = [...event.releaseKinds];
      return {
        id: `movie-${event.tmdbId}`,
        type: 'movie' as const,
        title: m.title || m.original_title || 'Untitled',
        poster: tmdbImage(m.poster_path, 'w500'),
        backdrop: tmdbImage(m.backdrop_path, 'w780') || undefined,
        date,
        timestamp: Date.parse(date) || 0,
        year: Number(date.slice(0, 4)) || undefined,
        rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : undefined,
        genres: m.genre_ids?.map((id) => genreNames[id]).filter(Boolean).slice(0, 3),
        releaseKinds,
        source: 'tmdb' as const
      } satisfies UpcomingItem;
    })
    .filter((item): item is UpcomingItem => item !== null)
    // Phase 6 defense-in-depth: classify every row through the ONE central
    // classifier (cheap flag path; anime exemption via genre 16 + ja) and
    // drop adult candidates. Normal rail: filtered regardless of Adult Mode
    // state.
    .filter((item) => {
      const m = rowsById.get(Number(item.id.slice('movie-'.length)));
      return movieRowVerdict({
        adult: m?.adult,
        isAnime: m?.genre_ids?.includes(16) === true && m?.original_language === 'ja'
      }) !== 'adult';
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- TMDB TV episodes ----------

type TmdbTvList = { results?: Array<{ id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; first_air_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number; original_language?: string }>; total_pages?: number; total_results?: number; page?: number };
type TmdbTvDetail = { id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; number_of_seasons?: number; number_of_episodes?: number; type?: string; last_episode_to_air?: { season_number?: number; episode_number?: number; air_date?: string }; next_episode_to_air?: { season_number?: number; episode_number?: number; air_date?: string }; seasons?: Array<{ season_number?: number; air_date?: string; episode_count?: number; poster_path?: string | null }>; networks?: Array<{ id?: number; name?: string | null }> };
type TmdbSeason = { season_number?: number; episodes?: TmdbSeasonEpisodeRow[] };
type TmdbSeasonEpisodeRow = { id: number; episode_number?: number; season_number?: number; name?: string; air_date?: string; still_path?: string | null; overview?: string };
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
// Phase F — month-window season resolution: instead of preferring
// last_episode_to_air.season_number (unsafe for a future target month —
// the season airing new episodes is frequently a NEWER season than the
// last-aired one), the seasons relevant to the target month are derived
// by the pure selectUpcomingSeasonCandidates policy (season air-date
// windows + next/last episode pointers + month boundaries) and ALL of
// them are inspected (capped) so every real in-month episode across the
// relevant seasons is returned.
//
// `itemType` controls the `type` field on the emitted UpcomingItem and
// the id prefix ('series-' or 'anime-'). Anime uses the same TMDB TV
// path as Series — the difference is that anime candidates are
// pre-filtered to genre 16 + original_language 'ja' in loadUpcomingAnime
// and are EXEMPT from the Upcoming Series curation policy (anime series
// are long-running by design; the serial rule is a Series-only curation
// signal, never an anime signal).
async function buildSeriesItems(raw: { id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; genre_ids?: number[]; original_language?: string }, year: number, month: number, region: string, itemType: 'series' | 'anime' = 'series'): Promise<UpcomingItem[]> {
  // Fetch series detail (season windows + episode pointers + networks +
  // the curation metadata). NOT caught: a failed detail lookup propagates
  // so loadUpcomingSeries can distinguish "no episodes this month" from
  // "upstream failure" (which also makes classification uncertain -> the
  // candidate is dropped — fail-closed for this adult-sensitive path).
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
  // Phase F — Upcoming Series OTT curation verdict (upcoming-policy.ts,
  // Upcoming-scoped; Popular TV's policy is deliberately NOT reused).
  // Metadata-based serial suppression: a scripted series with a
  // serial-scale released-episode count is a daily/weekly serial and is
  // dropped from Upcoming Series. Anime candidates are exempt. Missing
  // metadata keeps the candidate (curation fail-open — the ADULT
  // exclusion above stays unconditional and fail-closed).
  const curationVerdict = upcomingTvCurationVerdict({
    itemType,
    numberOfEpisodes: detail.number_of_episodes,
    tvType: detail.type
  });
  if (curationVerdict !== 'keep') return [];

  // Phase F — month-window season candidates (replaces the unsafe
  // last_episode_to_air preference). Deterministic, metadata-based, and
  // capped so a pathological detail payload cannot create unbounded
  // season lookups.
  const { startMs, endMs } = monthBounds(year, month);
  const seasonCandidates = selectUpcomingSeasonCandidates(
    // Normalize TMDB snake_case rows into the policy module's structural
    // input shape (the pure policy stays independent of TMDB field naming).
    (detail.seasons ?? []).map((s) => ({ seasonNumber: s.season_number, airDate: s.air_date })),
    detail.next_episode_to_air ? { seasonNumber: detail.next_episode_to_air.season_number, airDate: detail.next_episode_to_air.air_date } : undefined,
    detail.last_episode_to_air ? { seasonNumber: detail.last_episode_to_air.season_number, airDate: detail.last_episode_to_air.air_date } : undefined,
    startMs,
    endMs,
    UPCOMING_MAX_SEASON_INSPECTIONS
  );
  if (!seasonCandidates.length) return [];

  // Inspect the candidate seasons through the cached season endpoint.
  // A single failed season lookup must not discard episodes already
  // loaded from another candidate season, but if EVERY candidate season
  // fails the failure propagates so the caller can still distinguish
  // "real empty" from "upstream failure" (all-fail -> candidate counted
  // as failed by loadUpcomingSeries/loadUpcomingAnime).
  const seasonResults = await mapWithConcurrency(seasonCandidates, async (seasonNumber) => {
    try {
      return { seasonNumber, season: await getTvSeasonEpisodes(raw.id, seasonNumber) };
    } catch (err) {
      return { seasonNumber, error: err };
    }
  }, LOOKUP_CONCURRENCY);
  const loadedSeasons = seasonResults.filter((r): r is { seasonNumber: number; season: TmdbSeason } => r.season !== undefined);
  if (loadedSeasons.length === 0) {
    throw seasonResults[0]?.error ?? new ContentServiceError('The content provider returned an upstream error.', { code: 'UPSTREAM_ERROR', status: 502 });
  }

  // Collect ALL episodes airing in the target month across the inspected
  // seasons. Each becomes its own UpcomingItem so the calendar shows
  // every airing event. Episodes are deduped by season+episode identity
  // (a defensive guard against overlapping season payloads — identical
  // real events must not render twice).
  const seenEpisodes = new Set<string>();
  const inMonthEpisodes: Array<{ season: number; episode: TmdbSeasonEpisodeRow }> = [];
  for (const { seasonNumber, season } of loadedSeasons) {
    for (const ep of season?.episodes ?? []) {
      if (!ep.air_date) continue;
      const ms = Date.parse(ep.air_date);
      if (!(ms >= startMs && ms <= endMs)) continue;
      // Prefer the EPISODE's own season_number (real TMDB metadata);
      // fall back to the inspected season number from the endpoint path.
      const resolvedSeason = ep.season_number ?? seasonNumber;
      const identity = `s${resolvedSeason}e${ep.episode_number ?? 0}`;
      if (seenEpisodes.has(identity)) continue;
      seenEpisodes.add(identity);
      inMonthEpisodes.push({ season: resolvedSeason, episode: ep });
    }
  }
  inMonthEpisodes.sort((a, b) => (a.episode.air_date ?? '').localeCompare(b.episode.air_date ?? '') || a.season - b.season || (a.episode.episode_number ?? 0) - (b.episode.episode_number ?? 0));
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
  // The event ID keeps the season/episode suffix for card-key uniqueness;
  // detail navigation extracts the parent TMDB ID via
  // upcomingDetailPath ($lib/shared/upcoming-policy.ts).
  return inMonthEpisodes.map(({ season: resolvedSeason, episode }) => {
    const date = episode.air_date ?? '';
    return {
      id: `${itemType}-${raw.id}-s${resolvedSeason}e${episode.episode_number ?? 0}`,
      type: itemType,
      title,
      poster,
      backdrop,
      date,
      timestamp: Date.parse(date) || 0,
      season: resolvedSeason,
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
  // Phase F — India OTT-oriented Upcoming Series. The cache key embeds EVERY
  // dimension that materially changes the query/result shape: year, month,
  // region, adult-network exclusion, the India-OTT query version, the serial
  // curation policy version and the season-resolution model version — so a
  // policy or semantics bump re-keys instead of serving stale-era entries.
  const key = `upcoming:series:${year}:${month}:${region}:${networkExclusion ?? 'no-nets'}:${UPCOMING_TV_OTT_QUERY_KEY}:${UPCOMING_TV_SERIAL_POLICY_KEY}:${UPCOMING_SEASON_MODEL_KEY}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    // Step 1: discover TV series with episodes airing in the month —
    // India OTT availability is a SERVER-SIDE query constraint (not a
    // client-side filter): watch_region=IN + flatrate monetization only
    // (buy/rent-only and broadcast-only titles are never candidates),
    // plus the generic linear-TV genre exclusion (Soap/News/Talk).
    // Bounded pagination: walk upstream pages while TMDB reports more,
    // capped at UPCOMING_TV_MAX_CANDIDATE_PAGES and never past real
    // total_pages (never fabricated).
    const candidates: Array<{ id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; first_air_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number; original_language?: string }> = [];
    const seenCandidates = new Set<number>();
    let page = 1;
    let totalPages = 1;
    while (page <= Math.min(totalPages, UPCOMING_TV_MAX_CANDIDATE_PAGES)) {
      const result = await tmdbRequest<TmdbTvList>('/discover/tv', {
        'air_date.gte': gte,
        'air_date.lte': lte,
        watch_region: region,
        with_watch_monetization_types: 'flatrate',
        without_genres: UPCOMING_TV_WITHOUT_GENRES,
        sort_by: 'popularity.desc',
        'vote_count.gte': 1,
        include_adult: false,
        ...(networkExclusion ? { without_networks: networkExclusion } : {}),
        page
      });
      for (const s of result.results ?? []) {
        if (s.id && !seenCandidates.has(s.id)) {
          seenCandidates.add(s.id);
          candidates.push(s);
        }
      }
      totalPages = result.total_pages ?? page;
      if ((result.page ?? page) >= totalPages) break;
      page += 1;
    }
    // HARD cap on processed candidates (bounded N+1 — each candidate
    // costs a detail + season + provider lookup).
    const scopedCandidates = candidates.filter((s) => s.id && (s.name || s.original_name)).slice(0, UPCOMING_TV_MAX_CANDIDATES);
    // Step 2: for each candidate, fetch detail + season + episodes to
    // find ALL episodes airing in the month (one UpcomingItem per
    // episode). Concurrency-limited to avoid N+1 request explosions.
    // Per-candidate failures are counted — if EVERY candidate lookup
    // fails, the source failed upstream and must surface as an error,
    // never as a silently empty month. Partial success still returns
    // the real episodes that did load.
    let failures = 0;
    const built = await mapWithConcurrency(scopedCandidates, async (c) => {
      try {
        return await buildSeriesItems(c, year, month, region);
      } catch {
        failures += 1;
        return [];
      }
    }, LOOKUP_CONCURRENCY);
    if (scopedCandidates.length > 0 && failures === scopedCandidates.length) {
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
  //
  // Phase F: anime deliberately does NOT require India flatrate OTT
  // availability and is exempt from the Series serial curation policy —
  // anime keeps its own TMDB-only semantics (genre 16 + ja). The cache
  // key embeds the season-resolution model version because the shared
  // season/episode discovery path changed (re-key, never serve stale-era
  // item sets under new semantics).
  const networkExclusion = adultNetworkExclusionValue();
  const key = `upcoming:anime:${year}:${month}:${region}:${networkExclusion ?? 'no-nets'}:${UPCOMING_SEASON_MODEL_KEY}`;
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
  discoverIndiaMovieRows,
  DEFAULT_REGION,
  ANIME_GENRE_ID,
  ANIME_ORIGINAL_LANGUAGE
};
