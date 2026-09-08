// Upcoming releases server module.
//
// Sources (Phase F.3 — root-cause fix for future-release starvation):
//   - TMDB Discover Movie as the CANDIDATE discovery mechanism for
//     upcoming movies (Phase F.3 UNION of two documented sources):
//       · Source A: region=IN + release_date month window (F.2 stream).
//       · Source B: primary_release_date month window, NO region param.
//     WHY A ALONE STILL STARVED (F.3 diagnosis): with `region`, TMDB
//     filters movies by their INDIA release dates, and for unreleased
//     titles the India regional release-date data is frequently not
//     indexed yet — a movie with no indexed IN release date can never
//     match a region-aware date window, so October 2026+ stayed empty
//     even though the official OpenAPI lists both query families.
//     Source B matches on the PRIMARY release date (the origin-country
//     date, which IS indexed at announcement time), so Indian films and
//     same-window worldwide releases become candidates without requiring
//     India regional metadata to exist yet. Both sources keep the
//     language filter, the adult exclusions and bounded pagination, and
//     their union is deduped by canonical movie ID. with_release_type is
//     deliberately NOT sent AT ALL.
//
//     IMPORTANT (kept from Phase F.1 — the FINAL TRUTH IS UNWEAKENED):
//     discover/movie is only a CANDIDATE mechanism. TMDB's region
//     handling can fall back to the primary release date when a
//     country-specific date is missing, so the row's `release_date` is
//     NOT trusted as the card date. For EVERY candidate movie the
//     pipeline fetches GET /movie/{id}/release_dates and treats country
//     `IN` + release types 2|3|4 as the FINAL India release truth:
//       · only movies with a real IN release event INSIDE the selected
//         month/year survive (stale/foreign dates — August on a
//         September page, a 2022 date, a 1999 date — can never render);
//       · the card date IS that real India event date (earliest valid);
//       · releaseKinds derive from the ACTUAL India events (a movie with
//         both an India theatrical and an India digital event in the
//         month renders exactly ONE card).
//   - TMDB watch providers (flatrate only, results.IN only) for movie
//     OTT logos when the movie's India releaseKinds include 'digital',
//     and for series OTT logos.
//   - TMDB Discover TV (air_date.gte/lte) for series with episodes
//     airing in the selected month — Phase F.3 MAKES DISCOVERY PURELY
//     SCHEDULE + LANGUAGE:
//       · DISCOVERY (candidate stage): air_date month window + optional
//         with_original_language ONLY. The F.2-era `without_genres`
//         blacklist (Reality 10764 / Soap 10766 / Talk 10767) is
//         REMOVED — it was a candidate STARVATION filter: legitimate
//         Indian OTT series are frequently tagged Drama + Soap by TMDB,
//         so they were deleted BEFORE any detail metadata, episode
//         lookup or OTT eligibility check could speak. That is exactly
//         why Hindi/Tamil/Telugu/Kannada future months stayed empty
//         while English survived. There is deliberately NO replacement
//         genre blacklist and NO title blacklist.
//       · ELIGIBILITY (final gate, SEASON-level, Phase F.3): after a
//         candidate's REAL target-month episodes are confirmed, every
//         relevant target season is checked through the official
//         GET /tv/{series_id}/season/{season_number}/watch/providers
//         endpoint (same results.{CC}.flatrate shape as the series
//         endpoint). The series is kept when at least one relevant
//         target season has a valid India flatrate provider. Documented
//         FALLBACK: only when a season endpoint returned NO provider
//         data at all (empty results — no data for ANY region), the
//         parent GET /tv/{id}/watch/providers results.IN.flatrate may
//         vouch for it. A season that HAS provider data without India
//         flatrate (US-only, buy/rent-only, IN present but empty) is
//         affirmative absence — it never qualifies and never falls
//         back. A provider LOOKUP FAILURE is treated as a failed
//         candidate — availability is never fabricated. Anime is
//         exempt: it never requires India flatrate availability.
//       · Detail-level curation (upcomingTvCurationVerdict) is the
//         AUTHORITATIVE Upcoming Series curation: News/Talk dropped by
//         detail metadata, serial-scale released-episode counts dropped
//         (>100 released episodes), Soap-tagged legitimate OTT dramas
//         KEPT. Reality shows are NOT blindly excluded — any future
//         category suppression must be justified by detail metadata and
//         product semantics, never by a broad candidate starvation
//         filter.
//     ANIME CANDIDATES (TMDB TV genre 16 + original_language ja —
//     Mavero's existing anime definition) are REJECTED from the Series
//     pipeline before any expensive processing: anime has its own
//     independent section.
//   - TMDB TV season endpoint for the actual Sxx/Exx episode metadata,
//     resolved through MONTH-WINDOW season candidates
//     (selectUpcomingSeasonCandidates) instead of the unsafe
//     last_episode_to_air preference: for a future target month the
//     season airing new episodes is frequently a NEWER season than the
//     last-aired one. ALL real in-month episodes across the relevant
//     seasons are returned.
//   - TMDB Discover TV (air_date.gte/lte + with_genres=16 +
//     with_original_language=ja) for anime episodes airing in the month —
//     anime is sourced from TMDB TV (Animation genre + Japanese
//     original_language) and shares the season/episode-fetch path as
//     Series (with the anime curation exemption). No AniList/Yenime.
//   - LANGUAGE FILTER (Phase F.1): every discover query accepts an
//     optional `with_original_language` constraint parsed from the URL.
//     THIS FILTER MEANS TMDB ORIGINAL LANGUAGE (the language the title
//     was produced in), NOT dubbed-audio availability. 'all' omits the
//     constraint. Anime is intrinsically original_language=ja: a non-ja
//     language filter returns an empty anime section (correctly, without
//     querying upstream).
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
  UPCOMING_TV_SERIAL_POLICY_KEY,
  UPCOMING_TV_DISCOVERY_KEY,
  UPCOMING_TV_ELIGIBILITY_KEY,
  UPCOMING_SEASON_MODEL_KEY,
  UPCOMING_MOVIE_RELEASE_TRUTH_KEY,
  UPCOMING_PROVIDER_MODEL_KEY,
  UPCOMING_MOVIE_MAX_UPSTREAM_PAGES,
  UPCOMING_MOVIE_MAX_CANDIDATES,
  UPCOMING_TV_MAX_CANDIDATE_PAGES,
  UPCOMING_TV_MAX_CANDIDATES,
  UPCOMING_MAX_SEASON_INSPECTIONS,
  UPCOMING_ANIME_GENRE_ID,
  UPCOMING_ANIME_ORIGINAL_LANGUAGE,
  upcomingTvCurationVerdict,
  selectUpcomingSeasonCandidates,
  parseUpcomingLanguage,
  isAnimeCandidate,
  isIndiaFlatrateEligible,
  seasonIndiaProviderOutcome,
  seasonProviderVerdict,
  dedupeProvidersById,
  extractIndiaMovieReleaseEvents,
  deriveMovieReleaseKinds,
  earliestIndiaReleaseDate,
  isDateInMonth,
  normalizeRegionFlatrateProviders
} from '../../shared/upcoming-policy';
import type { UpcomingFilters, UpcomingItem, UpcomingProvider, UpcomingReleaseKind, UpcomingResult, UpcomingType } from './upcoming-types';
import type { IndiaReleaseDatesPayload, SeasonWatchProvidersPayload } from '../../shared/upcoming-policy';

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
// Per-movie India release_dates cache (Phase F.1 — the FINAL release
// truth). The RAW response is month-independent (filtering happens per
// request), so one cached entry serves every month window for the movie.
const releaseDatesPolicy = { ttlMs: 1000 * 60 * 30, staleWhileRevalidateMs: 1000 * 60 * 60 * 4 };

// Concurrency limit for season + provider lookups (matches existing
// Mavero OTT_LOOKUP_CONCURRENCY pattern).
const LOOKUP_CONCURRENCY = 4;

// TMDB genre id 16 = Animation. Anime is identified as TMDB TV with
// genre 16 AND with_original_language='ja' — Mavero's existing anime
// definition, shared with the pure policy module (isAnimeCandidate).
const ANIME_GENRE_ID = UPCOMING_ANIME_GENRE_ID;
const ANIME_ORIGINAL_LANGUAGE = UPCOMING_ANIME_ORIGINAL_LANGUAGE;

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

// Phase F.3 — India movie CANDIDATE discovery (DEDUPED UNION of two
// documented sources).
//
// Official TMDB OpenAPI (developer.themoviedb.org/openapi/tmdb-api.json)
// lists BOTH date-query families on /discover/movie: `region` +
// `release_date.gte/lte` AND `primary_release_date.gte/lte` (plus the
// OPTIONAL `with_release_type` refinement — never used here).
//
// WHY THE F.2 SINGLE REGION-AWARE STREAM STILL STARVED: with `region`,
// TMDB filters movies by their INDIA release dates. For unreleased
// titles the India regional release-date data is frequently not indexed
// yet — a movie with no indexed IN release date can never match a
// region-aware date window, so it never even reached the
// /movie/{id}/release_dates truth stage (October 2026+ returned nothing).
//
// The union covers both documented realities:
//   Source A (region-aware): region=IN + release_date month window —
//     matches movies whose India release data IS indexed.
//   Source B (primary): primary_release_date month window with NO region
//     parameter — matches on the movie's PRIMARY release date (the
//     origin-country date, indexed at announcement time) without
//     requiring India regional metadata to exist yet.
//
// Both sources share: optional with_original_language (TMDB ORIGINAL
// language only, omitted when 'all'), sort_by popularity, vote_count
// floor, include_adult=false, the transitional adult watch-provider
// exclusion (requires watch_region — kept from Phase 6, and watch_region
// does NOT change release-date semantics — that is `region`'s role), and
// bounded pagination (pages walked while TMDB reports more, until
// page >= real total_pages or the hard cap; total_pages is read from the
// real upstream response, never fabricated; rows are deduped by
// canonical movie ID across BOTH sources via the shared seen set).
//
// The discovered rows are CANDIDATES ONLY: their `release_date` is NOT
// trusted as the card date (TMDB region handling can fall back to the
// primary release date). Final India release truth (country IN, release
// types 2/3/4, selected month) comes from /movie/{id}/release_dates in
// loadUpcomingMovies.
type TmdbDiscoverMovieParams = Record<string, string | number | boolean | undefined>;

// Shared bounded page-walker for both candidate sources: accumulates
// unique canonical IDs into `seen`/`collected` so the union dedupes
// across sources AND pages, and never walks past the real total_pages
// or the hard page cap.
async function collectMovieDiscoverPages(baseParams: TmdbDiscoverMovieParams, collected: TmdbMovieRow[], seen: Set<number>): Promise<void> {
  let page = 1;
  let totalPages = 1;
  while (page <= Math.min(totalPages, UPCOMING_MOVIE_MAX_UPSTREAM_PAGES)) {
    const result = await tmdbRequest<TmdbMovieList>('/discover/movie', { ...baseParams, page });
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
}

async function discoverIndiaMovieCandidates(year: number, month: number, region: string, language: string, providerExclusion: string | undefined): Promise<TmdbMovieRow[]> {
  const { gte, lte } = monthBounds(year, month);
  // The cache key embeds every query dimension: year, month, region,
  // language filter, adult exclusion and the movie release-model version
  // (a model bump re-keys instead of serving stale-era rows — including
  // every entry created under the pre-F.3 single-stream discovery and
  // the pre-F.2 per-kind discovery).
  const key = `upcoming:movies:${year}:${month}:${region}:${language}:${providerExclusion ?? 'no-adult'}:${UPCOMING_MOVIE_RELEASE_TRUTH_KEY}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    const collected: TmdbMovieRow[] = [];
    const seen = new Set<number>();
    // Shared query dimensions across both sources. Language filter
    // (Phase F.1): TMDB ORIGINAL language only — omitted entirely when
    // the filter is 'all'. The transitional movie-side adult exclusion
    // requires watch_region (which does NOT affect release-date
    // semantics — that is `region`'s role).
    const shared: TmdbDiscoverMovieParams = {
      // Phase F.3: with_release_type is deliberately NOT sent — the
      // release TYPE is decided ONLY by /movie/{id}/release_dates.
      ...(language !== 'all' ? { with_original_language: language } : {}),
      sort_by: 'popularity.desc',
      'vote_count.gte': 1,
      include_adult: false,
      ...(providerExclusion ? { 'without_watch_providers': providerExclusion, watch_region: region } : {})
    };
    // Source A: region-aware India release-date window (the F.2 stream).
    await collectMovieDiscoverPages({
      ...shared,
      region,
      'release_date.gte': gte,
      'release_date.lte': lte
    }, collected, seen);
    // Source B: primary release-date window (NO region parameter).
    await collectMovieDiscoverPages({
      ...shared,
      'primary_release_date.gte': gte,
      'primary_release_date.lte': lte
    }, collected, seen);
    return collected;
  });
  return value;
}

// Phase F.1 — per-movie India release TRUTH + OTT providers.
//
// The RAW /movie/{id}/release_dates response is month-independent (the
// month-window filtering happens per request on the cached payload), so
// one cached entry serves every month for a movie. Failures propagate
// (nothing is cached) so a transient upstream error can never be
// mistaken for "no India release" — the caller counts failures and
// distinguishes a real empty month from an upstream outage.
async function getMovieIndiaReleaseDates(movieId: number): Promise<IndiaReleaseDatesPayload> {
  const key = `upcoming:movierd:${movieId}:${UPCOMING_MOVIE_RELEASE_TRUTH_KEY}`;
  const { value } = await getOrSet(key, releaseDatesPolicy, async () => {
    return tmdbRequest<IndiaReleaseDatesPayload>(`/movie/${movieId}/release_dates`);
  });
  return value;
}

// India OTT providers for a MOVIE (Phase F.1). Same binding rules as the
// series path: ONLY results.IN, ONLY flatrate — never buy/rent, never a
// US or cross-region fallback. A provider lookup failure must NOT remove
// the movie: the card renders with its OTT badge but without icons.
async function getMovieWatchProviders(movieId: number, region: string): Promise<UpcomingProvider[]> {
  const key = `upcoming:providers:movie:${movieId}:${region}:${UPCOMING_PROVIDER_MODEL_KEY}`;
  const { value } = await getOrSet(key, providerPolicy, async () => {
    try {
      const result = await tmdbRequest<TmdbWatchProviders>(`/movie/${movieId}/watch/providers`);
      // Only use the requested region's flatrate data. Do NOT fall back
      // to US or any other region — if the requested region (e.g. IN)
      // has no flatrate data, the provider row is hidden cleanly. The UI
      // does not label the provider region, so showing cross-region
      // providers would be misleading.
      return normalizeRegionFlatrateProviders(result.results, region, (path) => tmdbImage(path, 'w92'));
    } catch {
      return null; // transient failure — caller treats null as "no provider data"
    }
  });
  return value ?? [];
}

async function loadUpcomingMovies(year: number, month: number, region: string, language: string = 'all'): Promise<UpcomingItem[]> {
  // Phase 6: the Upcoming module previously sent NO adult filters at all.
  // /discover/movie supports the TRANSITIONAL watch-provider exclusion
  // (documented Phase 3 movie-side mechanism — same as every other movie
  // rail) — applied to the candidate stream with its region, plus
  // include_adult=false. The exclusion value is embedded in the cache
  // keys so provider-era and no-provider result sets never share an entry.
  await ensureAdultProvidersResolved(() => getTmdbIndiaProviders());
  const adultIds = getAdultProviderIds();
  const providerExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  // Phase F.3 — ONE broad candidate UNION (region-aware source A +
  // primary source B, no with_release_type, no per-kind duplication).
  // Rows are deduped by canonical movie ID inside the discovery (shared
  // seen set across both sources + bounded pagination) and re-deduped
  // defensively below.
  const candidateRows = await discoverIndiaMovieCandidates(year, month, region, language, providerExclusion);
  // Metadata lookup map (one entry per unique candidate — the same
  // dedupe guarantee, re-established defensively before the N+1 stage).
  const rowsById = new Map<number, TmdbMovieRow>();
  for (const row of candidateRows) if (row.id && !rowsById.has(row.id)) rowsById.set(row.id, row);
  // Phase F.3 — hard cap on the deduped union entering the truth N+1
  // (bounded N+1 invariant; popularity-desc ordering means the dropped
  // tail is the least popular).
  const candidates = [...rowsById.values()].slice(0, UPCOMING_MOVIE_MAX_CANDIDATES);
  const { startMs, endMs } = monthBounds(year, month);

  // Phase F.1 — FINAL INDIA RELEASE TRUTH (unchanged in F.2). For every
  // unique candidate fetch the REAL India release events through the
  // cached /movie/{id}/release_dates lookup, concurrency-limited like
  // every other bounded N+1 lookup here:
  //   - only IN-country events of release type 2|3 (theatrical) and 4
  //     (digital) count, and only when their actual India release date
  //     falls INSIDE the selected month/year;
  //   - a candidate with no qualifying India release is DROPPED (this is
  //     what kills stale dates like an August event on the September page
  //     or a 1999 date leaking through TMDB's region-date fallback);
  //   - the card date IS the earliest real India event date;
  //   - releaseKinds derive from the ACTUAL India events (a movie
  //     discovered as theatrical-only can still end up theatrical+digital
  //     if the truth data says both released in India this month);
  //   - movies with a digital event get their India flatrate OTT
  //     providers (Netflix / Prime Video / JioHotstar / ...) for the
  //     card icons.
  type ValidatedMovie = { tmdbId: number; date: string; releaseKinds: UpcomingReleaseKind[]; providers: UpcomingProvider[] };
  let truthFailures = 0;
  // `candidates` are the deduped TmdbMovieRow rows — one truth lookup per
  // unique canonical movie ID (row.id).
  const validated = await mapWithConcurrency(candidates, async (candidate): Promise<ValidatedMovie | null> => {
    try {
      const payload = await getMovieIndiaReleaseDates(candidate.id);
      const events = extractIndiaMovieReleaseEvents(payload, startMs, endMs);
      if (!events.length) return null; // no real India release of type 2/3/4 inside the month -> drop
      const releaseKinds = deriveMovieReleaseKinds(events);
      const date = earliestIndiaReleaseDate(events);
      if (!date || !releaseKinds.length) return null;
      // OTT provider icons ONLY for digital releases. A provider failure
      // must NOT remove the movie (caught inside the provider lookup).
      const providers = releaseKinds.includes('digital') ? await getMovieWatchProviders(candidate.id, region) : [];
      return { tmdbId: candidate.id, date, releaseKinds, providers };
    } catch {
      truthFailures += 1;
      return null;
    }
  }, LOOKUP_CONCURRENCY);
  // If EVERY candidate's release_dates lookup failed, the movie source is
  // effectively down — surface an error, never a silently empty month.
  if (candidates.length > 0 && truthFailures === candidates.length) {
    throw new ContentServiceError('The content provider returned an upstream error.', { code: 'UPSTREAM_ERROR', status: 502 });
  }
  return validated
    .filter((v): v is ValidatedMovie => v !== null)
    .map((v): UpcomingItem | null => {
      const m = rowsById.get(v.tmdbId);
      // Same metadata contract as before Phase F: a row without a real
      // title or without a parseable India release date is not a card.
      if (!m || (!m.title && !m.original_title)) return null;
      const date = v.date;
      if (!date || !Number.isFinite(Date.parse(date))) return null;
      return {
        id: `movie-${v.tmdbId}`,
        type: 'movie' as const,
        title: m.title || m.original_title || 'Untitled',
        poster: tmdbImage(m.poster_path, 'w500'),
        backdrop: tmdbImage(m.backdrop_path, 'w780') || undefined,
        date,
        timestamp: Date.parse(date) || 0,
        year: Number(date.slice(0, 4)) || undefined,
        rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : undefined,
        genres: m.genre_ids?.map((id) => genreNames[id]).filter(Boolean).slice(0, 3),
        providers: v.providers.length ? v.providers.slice(0, 3) : undefined,
        releaseKinds: [...v.releaseKinds],
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
        isAnime: isAnimeCandidate(m?.genre_ids, m?.original_language)
      }) !== 'adult';
    })
    // Phase F.1 final invariant: a month-filtered Upcoming page must
    // NEVER display a movie whose date is outside the selected month —
    // every surviving card's date belongs to the selected YYYY-MM.
    .filter((item) => isDateInMonth(item.date, year, month))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- TMDB TV episodes ----------

type TmdbTvList = { results?: Array<{ id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; first_air_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number; original_language?: string }>; total_pages?: number; total_results?: number; page?: number };
type TmdbTvDetail = { id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; number_of_seasons?: number; number_of_episodes?: number; type?: string; last_episode_to_air?: { season_number?: number; episode_number?: number; air_date?: string }; next_episode_to_air?: { season_number?: number; episode_number?: number; air_date?: string }; seasons?: Array<{ season_number?: number; air_date?: string; episode_count?: number; poster_path?: string | null }>; networks?: Array<{ id?: number; name?: string | null }> };
type TmdbSeason = { season_number?: number; episodes?: TmdbSeasonEpisodeRow[] };
type TmdbSeasonEpisodeRow = { id: number; episode_number?: number; season_number?: number; name?: string; air_date?: string; still_path?: string | null; overview?: string };
type TmdbWatchProviders = { results?: Record<string, { flatrate?: Array<{ provider_id?: number; provider_name?: string; logo_path?: string | null }> }> };

async function getTvWatchProviders(seriesId: number, region: string): Promise<UpcomingProvider[]> {
  const key = `upcoming:providers:tv:${seriesId}:${region}:${UPCOMING_PROVIDER_MODEL_KEY}`;
  const { value } = await getOrSet(key, providerPolicy, async () => {
    const result = await tmdbRequest<TmdbWatchProviders>(`/tv/${seriesId}/watch/providers`);
    // Only use the requested region's flatrate data. Do NOT fall back
    // to US or any other region — if the requested region (e.g. IN)
    // has no flatrate data, the normalized list is simply empty. The UI
    // does not label the provider region, so showing cross-region
    // providers would be misleading.
    //
    // Phase F.2: failures are deliberately NOT caught here. The raw
    // response is cached only on success; a failed lookup propagates
    // (uncached, self-healing) so the SERIES eligibility gate can
    // distinguish "TMDB answered: no India flatrate" (empty list ->
    // drop the series) from "the lookup itself failed" (failed
    // candidate — never fabricated as "no OTT").
    return normalizeRegionFlatrateProviders(result.results, region, (path) => tmdbImage(path, 'w92'));
  });
  return value;
}

// Phase F.3 — SEASON-LEVEL watch providers (official TMDB endpoint
// GET /tv/{series_id}/season/{season_number}/watch/providers; the
// official OpenAPI shows the same results.{CC}.flatrate response shape
// as the series-level endpoint). The cache key distinguishes the
// SEASON provider lookup from the series-parent one (separate path
// segment + series ID + season number + region + model version).
// Failures are deliberately NOT caught: a failed season-provider lookup
// must propagate so the eligibility gate can treat it as a FAILED
// candidate — availability is never fabricated, and an all-candidates
// outage surfaces as a real upstream error instead of a silent empty
// month.
async function getTvSeasonWatchProviders(seriesId: number, seasonNumber: number, region: string): Promise<SeasonWatchProvidersPayload> {
  const key = `upcoming:providers:tvseason:${seriesId}:${seasonNumber}:${region}:${UPCOMING_PROVIDER_MODEL_KEY}`;
  const { value } = await getOrSet(key, providerPolicy, async () => {
    return tmdbRequest<SeasonWatchProvidersPayload>(`/tv/${seriesId}/season/${seasonNumber}/watch/providers`);
  });
  return value;
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
  // Phase F.1 — SERIES MUST NOT MIX ANIME. Mavero's anime definition is
  // TMDB TV genre 16 (Animation) + original_language 'ja'; a candidate
  // matching that identity is REJECTED from the Series pipeline before
  // ANY expensive work (detail/season/provider lookups). Non-Japanese
  // animation (genre 16 + another original language) is NOT anime in
  // Mavero and stays in Series. Anime keeps its own independent pipeline
  // (loadUpcomingAnime) — no AniList/Yenime reintroduction.
  if (itemType === 'series' && isAnimeCandidate(raw.genre_ids, raw.original_language)) {
    return [];
  }
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
  const rawIsAnime = isAnimeCandidate(raw.genre_ids, raw.original_language);
  if (isAdultContent(undefined, undefined, undefined, rawIsAnime, detail.networks)) {
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

  // Providers are fetched ONCE per series, and ONLY after the candidate
  // has real target-month episodes (Phase F.2 performance rule — the
  // eligibility lookup is the most expensive per-candidate call).
  //
  // Phase F.3 — SEASON-LEVEL INDIA OTT ELIGIBILITY (series only).
  // Upcoming Series is web/OTT series available on Indian subscription
  // platforms, so eligibility is evaluated at the SEASON level through
  // the official /tv/{id}/season/{n}/watch/providers endpoint for every
  // relevant target season that was just inspected for episodes:
  //   - a season WITH its own results.IN.flatrate provider qualifies the
  //     series; icons are the provider_id-deduped union of the
  //     qualifying seasons' own providers;
  //   - a season endpoint that returned NO provider data at all (empty
  //     results — no data for ANY region) may be vouched for by the
  //     parent /tv/{id}/watch/providers results.IN.flatrate (documented
  //     fallback; parent icons used; parent lookup is LAZY — only paid
  //     when a season actually needs it);
  //   - a season that HAS provider data without India flatrate
  //     (US-only, buy/rent-only, IN present but empty flatrate) is
  //     affirmative absence — it never qualifies and never falls back;
  //   - a season-provider LOOKUP FAILURE propagates -> failed candidate
  //     (never fabricated as "no OTT"; all candidates failing surfaces
  //     a real upstream error);
  //   - US/other-region or buy/rent-only data never passes (the
  //     normalizer reads results.IN.flatrate only).
  // ANIME is exempt: the anime pipeline never requires India flatrate
  // availability — a failed lookup just means no icons on the cards.
  let providers: UpcomingProvider[];
  if (itemType === 'series') {
    const seasonOutcomes = await mapWithConcurrency(loadedSeasons, async (loaded) => {
      // NOT caught: a failed season-provider lookup propagates as a
      // failed candidate (availability is never fabricated).
      const payload = await getTvSeasonWatchProviders(raw.id, loaded.seasonNumber, region);
      return seasonIndiaProviderOutcome(payload, loaded.seasonNumber, region, (path) => tmdbImage(path, 'w92'));
    }, LOOKUP_CONCURRENCY);
    const verdict = seasonProviderVerdict(seasonOutcomes);
    if (verdict.outcome === 'qualified') {
      providers = verdict.providers;
    } else if (verdict.outcome === 'needs-parent') {
      // Documented fallback: the season endpoint(s) had NO provider data
      // at all — the parent series-level IN.flatrate may vouch. NOT
      // caught: a parent lookup failure is a failed candidate.
      const parent = await getTvWatchProviders(raw.id, region);
      providers = isIndiaFlatrateEligible(parent) ? dedupeProvidersById(parent) : [];
    } else {
      providers = [];
    }
    if (!isIndiaFlatrateEligible(providers)) return [];
  } else {
    // Anime: best-effort parent icons only — no eligibility gate
    // (anime never requires India flatrate availability).
    try {
      providers = await getTvWatchProviders(raw.id, region);
    } catch {
      providers = [];
    }
  }

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

async function loadUpcomingSeries(year: number, month: number, region: string, language: string = 'all'): Promise<UpcomingItem[]> {
  const { gte, lte } = monthBounds(year, month);
  // Phase 6: the Upcoming series source previously sent NO adult filters.
  // /discover/tv supports the canonical Phase 3 mechanism — exclude VERIFIED
  // adult TV NETWORKS via without_networks (values from the central registry
  // via adult-catalog.ts) — plus include_adult=false. The exclusion value is
  // embedded in the cache key (no network-era/no-filter result sharing).
  const networkExclusion = adultNetworkExclusionValue();
  // Phase F.2 — the cache key embeds EVERY dimension that materially
  // changes the query/result shape: year, month, region (used by the
  // eligibility provider lookups), LANGUAGE filter, adult-network
  // exclusion, the candidate DISCOVERY query version (bumped from the
  // old flatrate-at-discovery semantics), the India-OTT ELIGIBILITY
  // model version, the serial curation policy version and the
  // season-resolution model version — so a policy or semantics bump
  // re-keys instead of serving stale-era entries.
  const key = `upcoming:series:${year}:${month}:${region}:${language}:${networkExclusion ?? 'no-nets'}:${UPCOMING_TV_DISCOVERY_KEY}:${UPCOMING_TV_ELIGIBILITY_KEY}:${UPCOMING_TV_SERIAL_POLICY_KEY}:${UPCOMING_SEASON_MODEL_KEY}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    // Step 1: DISCOVER candidate series with episodes airing in the
    // month (Phase F.3 — DISCOVERY IS PURELY SCHEDULE + LANGUAGE):
    // air_date.gte/lte month window +, when selected, the TMDB
    // original-language constraint. NOTHING ELSE filters candidates
    // here.
    //
    // The F.2-era `without_genres` blacklist (Reality 10764 / Soap
    // 10766 / Talk 10767) is REMOVED: it was a candidate STARVATION
    // filter — legitimate Indian OTT series are frequently tagged
    // Drama + Soap by TMDB, so they were deleted BEFORE any detail
    // metadata, episode lookup or OTT eligibility check could speak
    // (exactly why Hindi/Tamil/Telugu/Kannada future months stayed
    // empty while English survived). The AUTHORITATIVE Upcoming Series
    // curation is the detail-level verdict (upcomingTvCurationVerdict
    // in buildSeriesItems: News/Talk by detail type, serial-scale
    // episode counts) plus the SEASON-level India-OTT eligibility gate.
    // There is deliberately NO replacement genre blacklist and NO title
    // blacklist.
    //
    // watch_region / with_watch_monetization_types remain deliberately
    // ABSENT at the candidate stage: TMDB's Discover layer often lacks
    // India OTT monetization data for unaired foreign-language seasons.
    // INDIA OTT ELIGIBILITY is verified per-season in buildSeriesItems
    // through /tv/{id}/season/{n}/watch/providers (with the documented
    // parent fallback) AFTER real target-month episodes are confirmed.
    // Bounded pagination: walk upstream pages while TMDB reports more,
    // capped at UPCOMING_TV_MAX_CANDIDATE_PAGES (5) and never past real
    // total_pages (never fabricated).
    const candidates: Array<{ id: number; name?: string; original_name?: string; poster_path?: string | null; backdrop_path?: string | null; first_air_date?: string; vote_average?: number; genre_ids?: number[]; popularity?: number; original_language?: string }> = [];
    const seenCandidates = new Set<number>();
    let page = 1;
    let totalPages = 1;
    while (page <= Math.min(totalPages, UPCOMING_TV_MAX_CANDIDATE_PAGES)) {
      const result = await tmdbRequest<TmdbTvList>('/discover/tv', {
        'air_date.gte': gte,
        'air_date.lte': lte,
        // Phase F.3: NO without_genres, NO watch_region, NO
        // with_watch_monetization_types — discovery is schedule +
        // language only. The anime exclusion below stays independent
        // of the language filter.
        ...(language !== 'all' ? { with_original_language: language } : {}),
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
    // costs a detail + season + provider lookup). ANIME CANDIDATES
    // (genre 16 + ja) are rejected BEFORE the cap so anime never
    // consumes Series slots and never reaches expensive processing.
    const scopedCandidates = candidates
      .filter((s) => s.id && (s.name || s.original_name))
      .filter((s) => !isAnimeCandidate(s.genre_ids, s.original_language))
      .slice(0, UPCOMING_TV_MAX_CANDIDATES);
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
export async function loadUpcomingAnime(year: number, month: number, region: string = DEFAULT_REGION, language: string = 'all'): Promise<UpcomingItem[]> {
  // Phase F.1 — anime language semantics: anime is intrinsically
  // original_language='ja' (Mavero's TMDB-only anime definition). When a
  // language OTHER than ja is selected, no anime can match — return an
  // EMPTY section deterministically (correct result, no upstream query,
  // no error). language='all' and language='ja' both query normally.
  if (language !== 'all' && language !== ANIME_ORIGINAL_LANGUAGE) return [];
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
  // item sets under new semantics) and the language filter dimension
  // (Phase F.1) so language-era result sets never share entries.
  const networkExclusion = adultNetworkExclusionValue();
  const key = `upcoming:anime:${year}:${month}:${region}:${language}:${networkExclusion ?? 'no-nets'}:${UPCOMING_SEASON_MODEL_KEY}`;
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
  // Phase F.1 — language filter. 'all' (or a missing/legacy field) means
  // no language constraint; anything else must already be a canonical
  // code from UPCOMING_LANGUAGE_OPTIONS (parsed strictly server-side).
  const language = parseUpcomingLanguage(filters.language ?? 'all');
  const errors: string[] = [];
  const items: UpcomingItem[] = [];

  const wantMovies = filters.type === 'all' || filters.type === 'movie';
  const wantSeries = filters.type === 'all' || filters.type === 'series';
  const wantAnime = filters.type === 'all' || filters.type === 'anime';

  const tasks: Array<Promise<void>> = [];

  if (wantMovies) {
    tasks.push(
      loadUpcomingMovies(filters.year, filters.month, region, language)
        .then((m) => { items.push(...m); })
        .catch((err) => { errors.push(`Movies: ${safeMessage(err)}`); })
    );
  }
  if (wantSeries) {
    tasks.push(
      loadUpcomingSeries(filters.year, filters.month, region, language)
        .then((s) => { items.push(...s); })
        .catch((err) => { errors.push(`Series: ${safeMessage(err)}`); })
    );
  }
  if (wantAnime) {
    tasks.push(
      loadUpcomingAnime(filters.year, filters.month, region, language)
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
  getTvSeasonWatchProviders,
  getMovieIndiaReleaseDates,
  getMovieWatchProviders,
  buildSeriesItems,
  discoverIndiaMovieCandidates,
  DEFAULT_REGION,
  ANIME_GENRE_ID,
  ANIME_ORIGINAL_LANGUAGE
};
