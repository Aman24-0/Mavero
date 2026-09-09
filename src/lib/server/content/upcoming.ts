// Upcoming releases server module.
//
// Sources (CineLog-proven date-range discovery model):
//   - TMDB Discover Movie as the ONE direct India date-range discovery
//     query for upcoming movies (the architecture already proven in
//     production by CineLog's Upcoming implementation):
//       /discover/movie { region: 'IN', with_release_country: 'IN',
//         release_date.gte/lte = monthBounds(year, month),
//         include_adult: false, sort_by: 'release_date.asc' }
//     The selected Mavero Month + Year becomes FROM = YYYY-MM-01 and
//     TO = YYYY-MM-last-day, passed DIRECTLY into the query — no hidden
//     "next 30 days" behavior, no per-kind duplication, no candidate
//     union, no vote_count floor (upcoming titles commonly have ZERO
//     votes — a floor starves future months), no with_release_type.
//
//     IMPORTANT (CineLog lesson — DISCOVERY IS THE TRUTH):
//     with region + with_release_country=IN, a movie returned by this
//     query HAS an India release entry inside the window, and the row's
//     `release_date` IS that India release date — it is the primary
//     Upcoming card date. GET /movie/{id}/release_dates is therefore
//     DEMOTED to OPTIONAL ENRICHMENT: it contributes ONLY the
//     releaseKinds badges (IN types 2|3 -> theatrical, 4 -> digital) —
//       · a missing/failed release_dates response can NEVER remove a
//         movie that discover already qualified (no post-discovery
//         starvation gate — the card renders without kind badges);
//       · an empty enrichment result renders the same way;
//       · the final month invariant is still enforced on the CARD DATE
//         itself (isDateInMonth): a card can never display a date
//         outside the selected month/year.
//   - TMDB watch providers (flatrate only, results.IN only) for movie
//     OTT logos (no US/cross-region fallback; a provider lookup failure
//     hides the icons but never removes the movie) and for series OTT
//     logos.
//   - TMDB Discover TV (air_date.gte/lte) for series with episodes
//     airing in the selected month — DISCOVERY IS PURELY SCHEDULE +
//     LANGUAGE + POPULARITY (the CineLog TV model):
//       · DISCOVERY (candidate stage): air_date month window + optional
//         with_original_language ONLY, sorted popularity.desc. NO vote
//         count floor (future episodes commonly carry zero votes), no
//         genre blacklist (the removed without_genres Reality/Soap/Talk
//         filter was a candidate starvation mechanism — legitimate
//         Indian OTT series are frequently tagged Drama + Soap by TMDB),
//         NO watch_region / with_watch_monetization_types (TMDB's
//         Discover layer often lacks India OTT monetization data for
//         unaired seasons), no title blacklist. air_date.gte/lte (NOT
//         first_air_date) discovers BOTH brand-new premieres AND future
//         episodes of already-running series.
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

// CineLog-proven India movie DISCOVERY — ONE direct date-range query.
//
// The selected Mavero Month + Year becomes FROM = YYYY-MM-01 and
// TO = YYYY-MM-last-day (monthBounds), passed DIRECTLY into
// /discover/movie:
//   region=IN                 — the date window applies to INDIA release
//                               dates (TMDB regional semantics);
//   with_release_country=IN   — only movies that HAVE a release entry in
//                               India are returned (banned/unreleased-in-
//                               India titles never become candidates);
//   release_date.gte/lte      — the exact month bounds (no hidden
//                               "next 30 days" behavior);
//   include_adult=false       — Adult Mode exclusion at the source;
//   sort_by=release_date.asc  — earliest releases first (CineLog model);
//   with_original_language    — ONLY when a language is selected (TMDB
//                               ORIGINAL language, never dubbed audio);
//   without_watch_providers + watch_region — the transitional movie-side
//                               adult exclusion (kept from Phase 6; it
//                               requires watch_region, which does NOT
//                               change release-date semantics — that is
//                               `region`'s role).
//
// Deliberately NOT sent (starvation guards, learned the hard way):
//   - vote_count.gte: upcoming titles commonly have ZERO votes — a vote
//     floor filtered out 99% of future releases in CineLog's history;
//   - primary_release_date.*: the F.3 union is REMOVED — with_release_
//     country=IN already constrains discovery to India releases;
//   - with_release_type: the release TYPE is enrichment metadata
//     (releaseKinds), never a discovery filter.
//
// Bounded pagination: the walk continues while TMDB reports more pages
// (real total_pages from the upstream response, never fabricated) and
// never past UPCOMING_MOVIE_MAX_UPSTREAM_PAGES. Rows dedupe by canonical
// movie ID across pages.
//
// DISCOVERY IS THE TRUTH (CineLog model): every returned row IS an India
// release in the selected window, and its `release_date` is the primary
// card date. No mandatory post-discovery gate can starve it (release_dates
// is optional enrichment — see loadUpcomingMovies).
type TmdbDiscoverMovieParams = Record<string, string | number | boolean | undefined>;

async function discoverIndiaMovieCandidates(year: number, month: number, region: string, language: string, providerExclusion: string | undefined): Promise<TmdbMovieRow[]> {
  const { gte, lte } = monthBounds(year, month);
  // The cache key embeds every query dimension: year, month, region,
  // language filter, adult exclusion and the movie discovery/enrichment
  // model version (a model bump re-keys instead of serving stale-era
  // rows — including every entry created under the pre-v4 F.3 source
  // union, the pre-F.3 single-stream discovery and the pre-F.2 per-kind
  // discovery).
  const key = `upcoming:movies:${year}:${month}:${region}:${language}:${providerExclusion ?? 'no-adult'}:${UPCOMING_MOVIE_RELEASE_TRUTH_KEY}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    const collected: TmdbMovieRow[] = [];
    const seen = new Set<number>();
    // ONE CineLog-shaped date-range query. Language filter (Phase F.1):
    // TMDB ORIGINAL language only — omitted entirely when the filter is
    // 'all'. The transitional movie-side adult exclusion requires
    // watch_region (which does NOT affect release-date semantics — that
    // is `region`'s role).
    const params: TmdbDiscoverMovieParams = {
      region,
      'release_date.gte': gte,
      'release_date.lte': lte,
      with_release_country: region,
      include_adult: false,
      sort_by: 'release_date.asc',
      ...(language !== 'all' ? { with_original_language: language } : {}),
      ...(providerExclusion ? { 'without_watch_providers': providerExclusion, watch_region: region } : {})
    };
    let page = 1;
    let totalPages = 1;
    while (page <= Math.min(totalPages, UPCOMING_MOVIE_MAX_UPSTREAM_PAGES)) {
      const result = await tmdbRequest<TmdbMovieList>('/discover/movie', { ...params, page });
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

// OPTIONAL per-movie release-kind ENRICHMENT (releaseKinds only).
//
// The RAW /movie/{id}/release_dates response is month-independent (the
// month-window filtering happens per request on the cached payload), so
// one cached entry serves every month for a movie. This lookup is NOT a
// candidate gate anymore (CineLog model): a missing/failed response
// merely means no releaseKinds badges — the movie itself stays because
// discovery already qualified it. Failures propagate from the lookup
// (nothing is cached) and are absorbed by the CALLER, which keeps the
// movie with unknown kinds.
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

async function loadUpcomingMovies(year: number, month: number, region: string, language: string = 'all', maxCandidates?: number): Promise<UpcomingItem[]> {
  // Phase 6: the Upcoming module previously sent NO adult filters at all.
  // /discover/movie supports the TRANSITIONAL watch-provider exclusion
  // (documented Phase 3 movie-side mechanism — same as every other movie
  // rail) — applied to the candidate stream with its region, plus
  // include_adult=false. The exclusion value is embedded in the cache
  // keys so provider-era and no-provider result sets never share an entry.
  await ensureAdultProvidersResolved(() => getTmdbIndiaProviders());
  const adultIds = getAdultProviderIds();
  const providerExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  // CineLog model — ONE direct India date-range discovery query (region
  // + with_release_country + release_date month window, release_date.asc
  // sort, NO vote_count floor, NO with_release_type, no candidate
  // union). Rows are deduped by canonical movie ID inside the discovery
  // and re-deduped defensively below.
  const candidateRows = await discoverIndiaMovieCandidates(year, month, region, language, providerExclusion);
  // Metadata lookup map (one entry per unique candidate — the same
  // dedupe guarantee, re-established defensively before the N+1 stage).
  const rowsById = new Map<number, TmdbMovieRow>();
  for (const row of candidateRows) if (row.id && !rowsById.has(row.id)) rowsById.set(row.id, row);
  // Hard cap on the deduped candidates entering the per-movie enrichment
  // N+1 (bounded N+1 invariant; see UPCOMING_MOVIE_MAX_CANDIDATES — the
  // cap covers the whole bounded page walk and never truncates it).
  // When maxCandidates is provided (pagination page 1), use the smaller
  // bound so page 1 does NOT process the full month.
  const candidateCap = maxCandidates !== undefined ? Math.min(maxCandidates, UPCOMING_MOVIE_MAX_CANDIDATES) : UPCOMING_MOVIE_MAX_CANDIDATES;
  const candidates = [...rowsById.values()].slice(0, candidateCap);
  const { startMs, endMs } = monthBounds(year, month);

  // CineLog model — DISCOVERY IS THE TRUTH for existence + date. Every
  // candidate row was returned by region=IN + with_release_country=IN +
  // release_date month window, so it HAS an India release inside the
  // selected month and its `release_date` IS the primary card date.
  // No mandatory post-discovery gate may starve it:
  //   - GET /movie/{id}/release_dates is OPTIONAL ENRICHMENT: it
  //     contributes ONLY the releaseKinds badges (IN events of type 2|3
  //     -> theatrical, 4 -> digital, inside the selected month). A
  //     missing/failed response — or one without any in-month IN type
  //     2/3/4 event — leaves the kinds UNKNOWN (no badges) and the
  //     movie STAYS. Availability is never fabricated either way.
  //   - OTT provider icons come from /movie/{id}/watch/providers
  //     (results.IN.flatrate ONLY, no US/cross-region fallback). The
  //     provider data is its own truth source — icons render whenever
  //     India flatrate availability exists, independent of the kind
  //     enrichment. A provider lookup failure hides the icons but never
  //     removes the movie (caught inside the provider lookup).
  type EnrichedMovie = { row: TmdbMovieRow; releaseKinds: UpcomingReleaseKind[]; providers: UpcomingProvider[] };
  const enriched = await mapWithConcurrency(candidates, async (candidate): Promise<EnrichedMovie> => {
    let releaseKinds: UpcomingReleaseKind[] = [];
    try {
      const payload = await getMovieIndiaReleaseDates(candidate.id);
      const events = extractIndiaMovieReleaseEvents(payload, startMs, endMs);
      releaseKinds = deriveMovieReleaseKinds(events);
    } catch {
      // Enrichment is optional: a failed release_dates lookup must NOT
      // remove a discover-qualified movie — kinds stay unknown.
      releaseKinds = [];
    }
    const providers = await getMovieWatchProviders(candidate.id, region);
    return { row: candidate, releaseKinds, providers };
  }, LOOKUP_CONCURRENCY);
  return enriched
    .map(({ row: m, releaseKinds, providers }): UpcomingItem | null => {
      // Metadata contract: a row without a real title or without a
      // parseable India release date is not a card.
      if (!m || (!m.title && !m.original_title)) return null;
      const date = m.release_date ?? '';
      if (!date || !Number.isFinite(Date.parse(date))) return null;
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
        providers: providers.length ? providers.slice(0, 3) : undefined,
        releaseKinds: releaseKinds.length ? [...releaseKinds] : undefined,
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
    // Final month invariant (kept from Phase F.1): a month-filtered
    // Upcoming page must NEVER display a movie whose date is outside the
    // selected month — every surviving card's date belongs to the
    // selected YYYY-MM. With with_release_country=IN + the release_date
    // window this holds by construction; the guard is the defensive
    // backstop (no post-filter starvation — discover results cannot be
    // dropped for lacking enrichment, only for an out-of-window date).
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

async function loadUpcomingSeries(year: number, month: number, region: string, language: string = 'all', maxCandidates?: number): Promise<UpcomingItem[]> {
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
  // old flatrate-at-discovery semantics AND from the vote-floored
  // pre-v4 discovery), the India-OTT ELIGIBILITY model version, the
  // serial curation policy version and the season-resolution model
  // version — so a policy or semantics bump re-keys instead of serving
  // stale-era entries.
  const key = `upcoming:series:${year}:${month}:${region}:${language}:${networkExclusion ?? 'no-nets'}:${UPCOMING_TV_DISCOVERY_KEY}:${UPCOMING_TV_ELIGIBILITY_KEY}:${UPCOMING_TV_SERIAL_POLICY_KEY}:${UPCOMING_SEASON_MODEL_KEY}:${maxCandidates ?? 'full'}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    // Step 1: DISCOVER candidate series with episodes airing in the
    // month (CineLog TV model — DISCOVERY IS PURELY SCHEDULE + LANGUAGE
    // + POPULARITY): air_date.gte/lte month window +, when selected, the
    // TMDB original-language constraint, sorted popularity.desc.
    // NOTHING ELSE filters candidates here. Deliberately NO vote_count
    // floor: future episodes commonly carry ZERO votes, and a vote floor
    // starves exactly the upcoming window this page exists to show.
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
        // CineLog TV model: NO without_genres, NO watch_region, NO
        // with_watch_monetization_types, NO vote_count floor —
        // discovery is schedule + language + popularity only. The
        // anime exclusion below stays independent of the language
        // filter.
        ...(language !== 'all' ? { with_original_language: language } : {}),
        sort_by: 'popularity.desc',
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
    // When maxCandidates is provided (pagination page 1), use the
    // smaller bound so page 1 does NOT process the full month.
    const candidateCap = maxCandidates !== undefined ? Math.min(maxCandidates, UPCOMING_TV_MAX_CANDIDATES) : UPCOMING_TV_MAX_CANDIDATES;
    const scopedCandidates = candidates
      .filter((s) => s.id && (s.name || s.original_name))
      .filter((s) => !isAnimeCandidate(s.genre_ids, s.original_language))
      .slice(0, candidateCap);
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
export async function loadUpcomingAnime(year: number, month: number, region: string = DEFAULT_REGION, language: string = 'all', maxCandidates?: number): Promise<UpcomingItem[]> {
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
  // key embeds the TV DISCOVERY query version (the anime discover query
  // is a /discover/tv query shape — a discovery-semantics bump must
  // re-key anime too) and the season-resolution model version because
  // the shared season/episode discovery path (re-key, never serve
  // stale-era item sets under new semantics) plus the language filter
  // dimension (Phase F.1) so language-era result sets never share
  // entries.
  const networkExclusion = adultNetworkExclusionValue();
  const key = `upcoming:anime:${year}:${month}:${region}:${language}:${networkExclusion ?? 'no-nets'}:${UPCOMING_TV_DISCOVERY_KEY}:${UPCOMING_SEASON_MODEL_KEY}:${maxCandidates ?? 'full'}`;
  const { value } = await getOrSet(key, upcomingPolicy, async () => {
    // Step 1: discover anime TV series with episodes airing in the month.
    // TMDB filters server-side by Animation genre (16) + ja language.
    // NO vote_count floor: future anime episodes commonly carry zero
    // votes (same CineLog lesson as every other Upcoming discovery).
    const result = await tmdbRequest<TmdbTvList>('/discover/tv', {
      'air_date.gte': gte,
      'air_date.lte': lte,
      with_genres: ANIME_GENRE_ID,
      with_original_language: ANIME_ORIGINAL_LANGUAGE,
      sort_by: 'popularity.desc',
      include_adult: false,
      ...(networkExclusion ? { without_networks: networkExclusion } : {}),
      page: 1
    });
    const animeCap = maxCandidates !== undefined ? Math.min(maxCandidates, 20) : 20;
    const candidates = (result.results ?? [])
      .filter((s) => s.id && (s.name || s.original_name))
      // Defense in depth: TMDB filters server-side, but ensure the
      // candidate actually looks like anime (genre 16 in genre_ids).
      .filter((s) => Array.isArray(s.genre_ids) ? s.genre_ids.includes(ANIME_GENRE_ID) : true)
      .slice(0, animeCap);
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

export const UPCOMING_PAGE_SIZE = 24;

// Bounded candidate batch size per source per page request.
// Each page request processes at most this many NEW candidates per
// source (starting from the cursor position). This is the real bound:
// page 1 processes BATCH candidates per source; page 2 processes the
// NEXT BATCH candidates per source (continuing from the cursor).
const SOURCE_CANDIDATE_BATCH = 30;

/**
 * Serializable source cursor state. Each source (movie/series/anime)
 * tracks how many candidates have been enriched so far. The cursor is
 * returned in the API response and passed back in the next request so
 * the server continues from the previous position without restarting.
 *
 * - movieCursor.candidateIndex: number of movie candidates already
 *   enriched (0 = start from the first candidate)
 * - seriesCursor.candidateIndex: number of series candidates already
 *   enriched
 * - animeCursor.candidateIndex: number of anime candidates already
 *   enriched
 * - exhausted: true when the source has no more candidates to process
 *
 * The cursor is serializable (plain object, JSON-safe) so it can be
 * passed via URL query params or API response JSON.
 */
export type SourceCursor = {
  candidateIndex: number;
  exhausted: boolean;
  /**
   * Pending events produced by the previous batch but not returned
   * (because they exceeded PAGE_SIZE). These are consumed BEFORE
   * processing new candidates on the next request, so no enriched
   * event is ever lost.
   */
  pending: UpcomingItem[];
};

export type UpcomingCursor = {
  movie: SourceCursor;
  series: SourceCursor;
  anime: SourceCursor;
};

export type UpcomingPageResult = {
  items: UpcomingItem[];
  filters: UpcomingFilters;
  errors: string[];
  errorMessage?: string;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  cursor: UpcomingCursor;
};

function emptyCursor(): UpcomingCursor {
  return {
    movie: { candidateIndex: 0, exhausted: false, pending: [] },
    series: { candidateIndex: 0, exhausted: false, pending: [] },
    anime: { candidateIndex: 0, exhausted: false, pending: [] }
  };
}

/**
 * Parse a cursor from a string (URL query param). Returns a fresh
 * empty cursor if the input is missing/invalid — page 1 always starts
 * from scratch.
 */
export function parseCursor(raw: string | null | undefined): UpcomingCursor {
  if (!raw) return emptyCursor();
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== 'object') return emptyCursor();
    const ensure = (s: any): SourceCursor => ({
      candidateIndex: typeof s?.candidateIndex === 'number' && s.candidateIndex >= 0 ? Math.floor(s.candidateIndex) : 0,
      exhausted: typeof s?.exhausted === 'boolean' ? s.exhausted : false,
      pending: Array.isArray(s?.pending) ? s.pending : []
    });
    return {
      movie: ensure(parsed.movie),
      series: ensure(parsed.series),
      anime: ensure(parsed.anime)
    };
  } catch {
    return emptyCursor();
  }
}

/**
 * Serialize a cursor to a URL-safe string.
 */
export function serializeCursor(cursor: UpcomingCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

// ---- Cursor-based source loaders ----
//
// These functions split the existing source pipeline into two phases:
//   1. Discovery (already cached) — returns the full candidate list
//   2. Enrichment (bounded per request for movies; full for series/anime)
//
// CHRONOLOGICAL ORDERING CONTRACT:
//   Movie discovery uses sort_by=release_date.asc, so movie candidates
//   ARE in chronological order. Batching movies is safe: batch N's
//   events are all ≤ batch N+1's events.
//
//   Series/anime discovery uses sort_by=popularity.desc, so candidates
//   are NOT chronological. A later candidate can produce an earlier-
//   dated event. Therefore series/anime MUST be fully enriched before
//   any events are emitted, to guarantee chronological correctness.
//   The per-item caches (detail/season/providers) make the full
//   enrichment fast on repeat requests.

async function loadMovieBatch(
  year: number, month: number, region: string, language: string,
  cursor: SourceCursor
): Promise<{ items: UpcomingItem[]; nextCursor: SourceCursor }> {
  await ensureAdultProvidersResolved(() => getTmdbIndiaProviders());
  const adultIds = getAdultProviderIds();
  const providerExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;
  const candidateRows = await discoverIndiaMovieCandidates(year, month, region, language, providerExclusion);
  const rowsById = new Map<number, TmdbMovieRow>();
  for (const row of candidateRows) if (row.id && !rowsById.has(row.id)) rowsById.set(row.id, row);
  const allCandidates = [...rowsById.values()].slice(0, UPCOMING_MOVIE_MAX_CANDIDATES);

  // Process only the next BATCH candidates starting from cursor position.
  // Movies are chronological (release_date.asc), so batching is safe.
  const startIdx = Math.min(cursor.candidateIndex, allCandidates.length);
  const batch = allCandidates.slice(startIdx, startIdx + SOURCE_CANDIDATE_BATCH);
  const { startMs, endMs } = monthBounds(year, month);

  type EnrichedMovie = { row: TmdbMovieRow; releaseKinds: UpcomingReleaseKind[]; providers: UpcomingProvider[] };
  const enriched = await mapWithConcurrency(batch, async (candidate): Promise<EnrichedMovie> => {
    let releaseKinds: UpcomingReleaseKind[] = [];
    try {
      const payload = await getMovieIndiaReleaseDates(candidate.id);
      const events = extractIndiaMovieReleaseEvents(payload, startMs, endMs);
      releaseKinds = deriveMovieReleaseKinds(events);
    } catch {
      releaseKinds = [];
    }
    const providers = await getMovieWatchProviders(candidate.id, region);
    return { row: candidate, releaseKinds, providers };
  }, LOOKUP_CONCURRENCY);

  const items = enriched
    .map(({ row: m, releaseKinds, providers }): UpcomingItem | null => {
      if (!m || (!m.title && !m.original_title)) return null;
      const date = m.release_date ?? '';
      if (!date || !Number.isFinite(Date.parse(date))) return null;
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
        providers: providers.length ? providers.slice(0, 3) : undefined,
        releaseKinds: releaseKinds.length ? [...releaseKinds] : undefined,
        source: 'tmdb' as const
      } satisfies UpcomingItem;
    })
    .filter((item): item is UpcomingItem => item !== null)
    .filter((item) => {
      const m = rowsById.get(Number(item.id.slice('movie-'.length)));
      return movieRowVerdict({ adult: m?.adult, isAnime: isAnimeCandidate(m?.genre_ids, m?.original_language) }) !== 'adult';
    })
    .filter((item) => isDateInMonth(item.date, year, month));

  const nextIdx = startIdx + batch.length;
  // Prepend any pending events from the previous request so they are
  // consumed before new candidates.
  const combinedItems = [...cursor.pending, ...items].sort((a, b) => a.timestamp - b.timestamp);
  return {
    items: combinedItems,
    nextCursor: { candidateIndex: nextIdx, exhausted: nextIdx >= allCandidates.length, pending: [] }
  };
}

/**
 * Load ALL movie events for the month (for type=all chronological merge).
 *
 * When type=all, movies must be fully enriched because series/anime
 * events (which are fully enriched) can have dates that interleave
 * with movie dates from a later batch. Batching movies in type=all
 * would cause chronological regressions across page boundaries.
 *
 * Uses the existing loadUpcomingMovies (which enriches all candidates).
 * The per-item caches make this fast on repeat requests.
 */
async function loadMovieFull(
  year: number, month: number, region: string, language: string,
  cursor: SourceCursor
): Promise<{ items: UpcomingItem[]; nextCursor: SourceCursor }> {
  if (cursor.exhausted && cursor.pending.length === 0) {
    return { items: [], nextCursor: cursor };
  }
  // If already exhausted (full enrichment was done on a previous call),
  // return ONLY the pending items — the full result was already
  // distributed as pending by loadUpcomingPage. Re-calling
  // loadUpcomingMovies would return the same items again, causing
  // duplicates.
  if (cursor.exhausted) {
    return {
      items: [...cursor.pending].sort((a, b) => a.timestamp - b.timestamp),
      nextCursor: { candidateIndex: 0, exhausted: true, pending: [] }
    };
  }
  // First call: full enrichment
  const fullItems = await loadUpcomingMovies(year, month, region, language);
  const combinedItems = [...cursor.pending, ...fullItems].sort((a, b) => a.timestamp - b.timestamp);
  return {
    items: combinedItems,
    nextCursor: { candidateIndex: 0, exhausted: true, pending: [] }
  };
}

/**
 * Load ALL series or anime events for the month.
 *
 * Series/anime discovery uses sort_by=popularity.desc, so candidates
 * are NOT in chronological order. A later candidate can produce an
 * earlier-dated event. Therefore ALL candidates must be enriched before
 * any events are emitted to guarantee chronological correctness.
 *
 * The enrichment is cached per-item (detail/season/providers — 30min
 * TTL), so repeat requests are fast. The source-level cache (10min TTL)
 * caches the full result.
 *
 * This function uses the existing loadUpcomingSeries/loadUpcomingAnime
 * (which already enrich all candidates) — it does NOT batch. The
 * cursor's candidateIndex is set to the full candidate count on first
 * call, and exhausted=true. Subsequent calls return from the cache
 * with no new enrichment work.
 */
async function loadSeriesOrAnimeFull(
  year: number, month: number, region: string, language: string,
  cursor: SourceCursor, isAnime: boolean
): Promise<{ items: UpcomingItem[]; nextCursor: SourceCursor }> {
  if (cursor.exhausted && cursor.pending.length === 0) {
    return { items: [], nextCursor: cursor };
  }
  // If already exhausted (full enrichment was done on a previous call),
  // return ONLY the pending items — the full result was already
  // distributed as pending by loadUpcomingPage.
  if (cursor.exhausted) {
    return {
      items: [...cursor.pending].sort((a, b) => a.timestamp - b.timestamp),
      nextCursor: { candidateIndex: 0, exhausted: true, pending: [] }
    };
  }
  // First call: full enrichment
  const fullItems = isAnime
    ? await loadUpcomingAnime(year, month, region, language)
    : await loadUpcomingSeries(year, month, region, language);
  const combinedItems = [...cursor.pending, ...fullItems].sort((a, b) => a.timestamp - b.timestamp);
  return {
    items: combinedItems,
    nextCursor: { candidateIndex: 0, exhausted: true, pending: [] }
  };
}

/**
 * Load one page of Upcoming items with REAL cursor-based pagination.
 *
 * CRITICAL: This function does NOT call loadUpcoming(). It calls the
 * cursor-based batch loaders (loadMovieBatch, loadSeriesBatch) which
 * process only SOURCE_CANDIDATE_BATCH candidates per source per request,
 * starting from the cursor position.
 *
 * The cursor is a serializable JSON object with independent
 * movie/series/anime source positions. Each API request passes the
 * cursor from the previous response so the server continues from
 * where it left off — never restarting from candidate 0.
 *
 * For type=all, all three sources are loaded in parallel, each
 * processing its next batch. The results are merged chronologically
 * and the first PAGE_SIZE items are returned. The cursor reflects
 * the actual progress of each source.
 *
 * If a source is exhausted (all candidates processed), its cursor
 * stays exhausted and no more work is done for that source.
 */
export async function loadUpcomingPage(
  filters: UpcomingFilters,
  page: number = 1,
  incomingCursor?: UpcomingCursor
): Promise<UpcomingPageResult> {
  const pageSize = UPCOMING_PAGE_SIZE;
  const region = DEFAULT_REGION;
  const language = parseUpcomingLanguage(filters.language ?? 'all');
  const errors: string[] = [];
  const cursor = incomingCursor ?? emptyCursor();

  const wantMovies = filters.type === 'all' || filters.type === 'movie';
  const wantSeries = filters.type === 'all' || filters.type === 'series';
  const wantAnime = filters.type === 'all' || filters.type === 'anime';

  // For single-type filters, only one source runs. For type=all,
  // all three run in parallel — each processes its own batch.
  // Each source returns ALL its events (pending from previous + newly
  // enriched). loadUpcomingPage merges them, slices PAGE_SIZE, and
  // stores the overflow back into per-source pending for next time.
  const tasks: Array<Promise<void>> = [];
  let movieItems: UpcomingItem[] = [];
  let seriesItems: UpcomingItem[] = [];
  let animeItems: UpcomingItem[] = [];
  // On failure, preserve the cursor position (do NOT mark exhausted).
  // The caller can retry from the same position.
  let movieCursor = cursor.movie;
  let seriesCursor = cursor.series;
  let animeCursor = cursor.anime;

  // CHRONOLOGICAL ORDERING CONTRACT:
  //   When type=all, ALL sources must be fully enriched because events
  //   from different sources can interleave chronologically. Batching
  //   any source in type=all would cause chronological regressions
  //   across page boundaries.
  //   When type=movie (single source), movies CAN be safely batched
  //   because movie discovery uses release_date.asc (chronological).
  //   Series/anime are ALWAYS fully enriched (popularity.desc discovery
  //   is not chronological).
  const isSingleType = filters.type !== 'all';

  if (wantMovies && (!cursor.movie.exhausted || cursor.movie.pending.length > 0)) {
    const movieLoader = isSingleType ? loadMovieBatch : loadMovieFull;
    tasks.push(
      movieLoader(filters.year, filters.month, region, language, cursor.movie)
        .then((r) => { movieItems = r.items; movieCursor = r.nextCursor; })
        .catch((err) => {
          errors.push(`Movies: ${safeMessage(err)}`);
          movieCursor = cursor.movie;
        })
    );
  }
  if (wantSeries && (!cursor.series.exhausted || cursor.series.pending.length > 0)) {
    tasks.push(
      loadSeriesOrAnimeFull(filters.year, filters.month, region, language, cursor.series, false)
        .then((r) => { seriesItems = r.items; seriesCursor = r.nextCursor; })
        .catch((err) => {
          errors.push(`Series: ${safeMessage(err)}`);
          seriesCursor = cursor.series;
        })
    );
  }
  if (wantAnime && (!cursor.anime.exhausted || cursor.anime.pending.length > 0)) {
    // Anime language semantics: anime is intrinsically ja. A non-ja
    // language filter returns empty deterministically.
    if (language !== 'all' && language !== ANIME_ORIGINAL_LANGUAGE) {
      animeCursor = { ...cursor.anime, exhausted: true };
    } else {
      tasks.push(
        loadSeriesOrAnimeFull(filters.year, filters.month, region, language, cursor.anime, true)
          .then((r) => { animeItems = r.items; animeCursor = r.nextCursor; })
          .catch((err) => {
            errors.push(`Anime: ${safeMessage(err)}`);
            animeCursor = cursor.anime;
          })
      );
    }
  }

  await Promise.all(tasks);

  // Merge all source items chronologically.
  const allItems = [...movieItems, ...seriesItems, ...animeItems];
  allItems.sort((a, b) => a.timestamp - b.timestamp);

  // Deduplicate by event ID.
  const seen = new Set<string>();
  const deduped = allItems.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  // Return the first PAGE_SIZE items. Store the overflow as pending
  // events in the cursor so they are returned on the next request
  // BEFORE processing new candidates. This prevents losing enriched
  // events that exceeded PAGE_SIZE.
  const pageItems = deduped.slice(0, pageSize);
  const overflow = deduped.slice(pageSize);

  // Distribute overflow back to source cursors as pending. Since the
  // merge was chronological, we assign each overflow item to its
  // source's pending list so the next request consumes them first.
  const moviePending: UpcomingItem[] = [];
  const seriesPending: UpcomingItem[] = [];
  const animePending: UpcomingItem[] = [];
  for (const item of overflow) {
    if (item.type === 'movie') moviePending.push(item);
    else if (item.type === 'anime') animePending.push(item);
    else seriesPending.push(item);
  }

  const nextMovieCursor: SourceCursor = { ...movieCursor, pending: moviePending };
  const nextSeriesCursor: SourceCursor = { ...seriesCursor, pending: seriesPending };
  const nextAnimeCursor: SourceCursor = { ...animeCursor, pending: animePending };

  // FIX 1: hasNextPage must only depend on ACTIVE sources for the
  // current filter type. An unused source's non-exhausted cursor must
  // NOT keep hasNextPage=true forever.
  const movieActive = wantMovies;
  const seriesActive = wantSeries;
  const animeActive = wantAnime;
  const hasNextPage =
    (movieActive && (nextMovieCursor.pending.length > 0 || !nextMovieCursor.exhausted)) ||
    (seriesActive && (nextSeriesCursor.pending.length > 0 || !nextSeriesCursor.exhausted)) ||
    (animeActive && (nextAnimeCursor.pending.length > 0 || !nextAnimeCursor.exhausted));

  return {
    items: pageItems,
    filters,
    errors,
    errorMessage: deduped.length === 0 && errors.length > 0 ? 'Upcoming releases are temporarily unavailable. Please try again.' : undefined,
    page,
    pageSize,
    hasNextPage,
    cursor: {
      movie: nextMovieCursor,
      series: nextSeriesCursor,
      anime: nextAnimeCursor
    }
  };
}

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
  loadUpcomingPage,
  loadUpcoming,
  loadMovieBatch,
  loadSeriesOrAnimeFull,
  parseCursor,
  serializeCursor,
  UPCOMING_PAGE_SIZE,
  SOURCE_CANDIDATE_BATCH,
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
