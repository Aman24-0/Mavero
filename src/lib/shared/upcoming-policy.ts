// ============================================================
// UPCOMING — India release + OTT curation policy (Phase F).
//
// SCOPE (binding): this module applies ONLY to the /upcoming page
// pipeline (`upcoming.ts`). It is NOT applied to:
//   - Discover rails / Popular TV (popular-tv-policy.ts is scoped to
//     Popular TV and is deliberately NOT reused here — Upcoming owns
//     its own constants + verdict so the two policies can evolve
//     independently)
//   - Adult Discover (adult-catalog.ts + the Phase 7 contract)
//   - Search (search-classify.ts)
//   - Detail pages / resolver / playback
//   - Anime catalog architecture (anime keeps its TMDB-only
//     genre-16 + original-language-ja definition; the curation verdict
//     explicitly exempts anime, see below)
//
// WHY (problems being fixed):
//   1. (Phase F.3 REVISION — DISCOVERY is genre-free) The F.2 discovery
//      still carried a broad genre blacklist (`without_genres` for
//      Reality 10764, Soap 10766, Talk 10767). That was a candidate
//      STARVATION filter: many legitimate Indian OTT series are tagged
//      Drama + Soap by TMDB, so they were removed at the Discover layer
//      BEFORE any detail metadata, episode lookup or OTT eligibility
//      check could speak — which is exactly why Hindi/Tamil/Telugu/
//      Kannada future months stayed empty while English survived.
//      Discovery is now PURELY schedule + language (air_date month
//      window + optional with_original_language). The authoritative
//      Upcoming Series curation is the DETAIL-level verdict
//      (`upcomingTvCurationVerdict`): News/Talk dropped by detail
//      metadata, serial-scale released-episode counts dropped, and a
//      Soap-tagged legitimate OTT drama is KEPT when it has real
//      target-month episodes and India OTT eligibility. There is
//      deliberately NO title blacklist and NO broad genre blacklist.
//        a) DISCOVERY (cheap, broad): /discover/tv with ONLY the episode
//           schedule window (air_date.gte/lte) + language. NO
//           without_genres, NO watch_region, NO monetization filter.
//        b) ELIGIBILITY (expensive, precise, SEASON-level): per
//           surviving candidate — AFTER real target-month episodes are
//           confirmed — every relevant target season is checked through
//           GET /tv/{series_id}/season/{season_number}/watch/providers
//           (official TMDB endpoint; same results.{CC}.flatrate shape
//           as the series-level endpoint). The series is kept when at
//           least one relevant target season has a valid India flatrate
//           provider. Documented FALLBACK: only when a season endpoint
//           returned NO provider data at all (empty results — no data
//           for ANY region), the parent GET /tv/{id}/watch/providers
//           results.IN.flatrate may vouch for that season. A season
//           that HAS provider data without India flatrate (US-only,
//           buy/rent-only, IN present but empty flatrate) is affirmative
//           absence — it never qualifies and never falls back.
//           Provider lookup FAILURE -> failed candidate (never
//           fabricated as "no OTT"); all candidates failing surfaces a
//           real upstream error.
//   1b. SERIAL CURATION (detail level): a conservative serial-structure
//       policy — Indian daily/weekly serials are serials by
//       production model (hundreds of released episodes), the same
//       reliable signal measured for the Popular TV rail
//       (measured 2026-09-08: contaminating serials 198-957
//       released episodes vs must-keep OTT shows 10-32). A title
//       with MORE released episodes than the threshold is a serial
//       and is dropped from Upcoming Series. This is deterministic
//       metadata — there is deliberately NO title blacklist.
//      NOTE on TMDB `with_type`: TMDB does not expose a universal
//      "web series" flag and the numeric type enum is NOT reliable
//      enough to treat as a web-series filter (type 4 = Scripted can
//      include normal television drama). The detail-level string
//      `type` is only used to drop the obviously generic linear-TV
//      categories (News / Talk Show) as defense-in-depth; missing
//      type metadata keeps the candidate (fail-open curation).
//   2. Upcoming episode discovery preferred
//      `last_episode_to_air.season_number`, which is unsafe for a
//      FUTURE target month: the season airing new episodes in the
//      target month is frequently a NEWER season than the last-aired
//      one. `selectUpcomingSeasonCandidates` derives the seasons
//      relevant to the target month from the season air-date windows,
//      next_episode_to_air and last_episode_to_air instead.
//   3. (CineLog-proven REVISION — MOVIE DISCOVERY IS ONE DATE-RANGE
//      QUERY) The earlier F.3 candidate UNION (region-aware Source A +
//      primary-release-date Source B) and its mandatory per-movie
//      /movie/{id}/release_dates truth gate are both REMOVED. Discovery
//      now follows the model already proven in production by CineLog's
//      Upcoming implementation — ONE direct /discover/movie query with
//      region=IN + with_release_country=IN + release_date.gte/lte (the
//      selected month bounds) + include_adult=false +
//      sort_by=release_date.asc, and NO vote_count floor (upcoming
//      titles commonly have ZERO votes). A row returned by that query
//      HAS an India release inside the window and its `release_date` IS
//      the primary card date. `GET /movie/{id}/release_dates` is
//      DEMOTED to OPTIONAL enrichment (releaseKinds badges only): a
//      missing/failed/event-less response can never remove a
//      discover-qualified movie.
//   4. Upcoming event IDs are episode-unique
//      (`series-123-s58e294`), but the detail routes need the parent
//      TMDB ID. `upcomingDetailPath` extracts the canonical numeric ID
//      with a strict parser (no blind prefix-stripping) and fails safe
//      (null) on malformed IDs.
//
// ANIME EXEMPTION (binding): the curation verdict NEVER drops anime
// candidates (itemType 'anime'): anime series are long-running by
// design (a 500-episode anime is normal, not serial contamination),
// and the anime query keeps its own TMDB semantics (genre 16 +
// original_language ja, no India flatrate requirement — most airing
// Japanese anime have no India flatrate data and requiring it would
// empty the section).
//
// MOVIE DISCOVERY + ENRICHMENT MODEL (used by upcoming.ts, constants
// live here):
//   candidates come from ONE CineLog-proven /discover/movie date-range
//   query (region=IN + with_release_country=IN + release_date month
//   window + language + adult exclusions — NO with_release_type, NO
//   primary_release_date, NO vote_count floor), deduped by canonical
//   movie ID. The discover row's India release_date IS the primary card
//   date. /movie/{id}/release_dates is OPTIONAL ENRICHMENT: results.IN
//   events of types 2|3 (theatrical) and 4 (digital) inside the selected
//   month derive the releaseKinds badges — a missing/failed/event-less
//   enrichment leaves the badges off and the movie ON the page.
//   releaseKinds never remove or re-date a discovered movie.
//
// CACHE KEYS: the constants exported here are embedded in the
// upcoming.ts cache keys, so bumping a policy/query version re-keys
// instead of serving stale-era entries.
// ============================================================

// NOTE (Phase F.3): the old UPCOMING_TV_WITHOUT_GENRES constant
// ('10764|10766|10767') is deliberately GONE. A broad genre blacklist at
// the Discover layer starved candidates — Indian OTT dramas tagged
// Drama+Soap never reached detail-level curation. Upcoming Series
// curation is detail-metadata-only (upcomingTvCurationVerdict below).

/**
 * A scripted series with MORE released episodes than this is treated as a
 * daily/weekly serial for Upcoming Series. Same measured margin as the
 * Popular TV policy (soaps 198-957 vs must-keep OTT 10-32) — 100 sits far
 * above every measured must-keep Indian OTT show and far below every
 * measured contaminating serial.
 */
export const UPCOMING_TV_DAILY_SERIAL_MAX_EPISODES = 100;

/** Cache-key dimension for the serial policy. Bump when the rule changes. */
export const UPCOMING_TV_SERIAL_POLICY_KEY = 'daily-serial-gt100';

/**
 * Cache-key dimension for the Upcoming Series CANDIDATE DISCOVERY query
 * shape. CineLog-proven model: air_date month window + language ONLY,
 * popularity-sorted, NO genre blacklist, NO watch-region/monetization
 * constraint, and NO vote_count floor (future titles commonly have zero
 * votes — a floor starves them before any detail metadata can speak).
 * Bumped from 'airdate-discovery-v3' so every pre-v4 cached candidate
 * set (which still carried the vote_count.gte=1 starvation floor) can
 * never be served under the new semantics.
 */
export const UPCOMING_TV_DISCOVERY_KEY = 'airdate-discovery-v4';

/**
 * Cache-key dimension for the India OTT ELIGIBILITY model (Phase F.3):
 * SEASON-level gate — every relevant target season is checked through
 * /tv/{series_id}/season/{season_number}/watch/providers
 * (results.IN.flatrate), with the parent /tv/{id}/watch/providers
 * IN.flatrate as the documented fallback ONLY when a season endpoint
 * returned no provider data at all. Bumped from
 * 'in-flatrate-eligibility-v1' (series-level-only gate) so pre-F.3
 * eligibility-era result sets are never served.
 */
export const UPCOMING_TV_ELIGIBILITY_KEY = 'season-flatrate-eligibility-v2';

/**
 * Cache-key dimension for the month-window season resolution model.
 * Bump when the season/episode discovery semantics change so previously
 * cached series/anime item sets are never served under new semantics.
 */
export const UPCOMING_SEASON_MODEL_KEY = 'month-window-v1';

/**
 * Cache-key dimension for the India movie discovery + enrichment model.
 *
 * CineLog-proven model (v4): movie discovery is ONE direct date-range
 * query — /discover/movie with region=IN + with_release_country=IN +
 * release_date.gte/lte (the selected month bounds) + include_adult=false
 * + sort_by=release_date.asc. The discover row's India release_date IS
 * the primary Upcoming card date. `GET /movie/{id}/release_dates` is
 * DEMOTED to OPTIONAL enrichment (releaseKinds theatrical/digital badges
 * only): a missing or event-less release_dates response can no longer
 * remove a discover-qualified movie, so the F.3 mandatory truth gate and
 * the F.3 Source A/Source B candidate union are both GONE.
 *
 * Version 'in-release-discovery-v4' re-keys EVERY cache entry created
 * under the pre-v4 union model ('in-release-discovery-v3'), the pre-F.3
 * single region-aware stream ('v2') and the pre-F.2 per-kind discovery —
 * month candidate sets and per-movie release_dates payloads alike — so
 * old-era result sets can never be served under the new query semantics.
 */
export const UPCOMING_MOVIE_RELEASE_TRUTH_KEY = 'in-release-discovery-v4';

/**
 * Cache-key dimension for the India watch-provider model (flatrate only,
 * per-region). Phase F.3 adds SEASON-level provider lookups
 * (/tv/{id}/season/{n}/watch/providers) and provider dedupe, so the
 * model is bumped from 'tmdb-flatrate-v1' — series-parent and
 * season-provider cache entries from the old model are never reused.
 */
export const UPCOMING_PROVIDER_MODEL_KEY = 'tmdb-flatrate-v2';

// NOTE: TMDB release-type VALUES (1 Premiere, 2 Theatrical limited,
// 3 Theatrical, 4 Digital, 5 Physical, 6 TV) are used ONLY by
// `extractIndiaMovieReleaseEvents` below — the OPTIONAL release-kind
// enrichment — and deliberately NOT as a candidate-discovery filter
// (with_release_type is never sent to /discover/movie).

/** HARD cap on upstream /discover/movie pages walked (bounded pagination — the walk continues while TMDB reports more pages and never past the real total_pages or this cap). */
export const UPCOMING_MOVIE_MAX_UPSTREAM_PAGES = 10;

/**
 * HARD cap on upstream /discover/tv pages walked for series candidates
 * (bounded pagination). Phase F.3 raises this from 2: a production
 * upcoming calendar must walk the real upstream result set (now that the
 * incorrect genre exclusion no longer artificially shrinks it), while
 * real `total_pages` + this cap keep the query bounded.
 */
export const UPCOMING_TV_MAX_CANDIDATE_PAGES = 5;

/**
 * HARD cap on candidate TV series processed per month (bounded N+1).
 * Phase F.3 raises this from 40: with up to 5 pages x 20 rows and no
 * genre starvation, 80 candidates at concurrency 4 costs at most
 * detail (1) + seasons (<=3) + parent provider (1, fallback-only) +
 * season providers (<=3) calls per candidate that reaches the season
 * stage — candidates dropped by adult/curation metadata stop after the
 * single detail call. Season and provider lookups are cached
 * month-independently, so repeat visits are amortized.
 */
export const UPCOMING_TV_MAX_CANDIDATES = 80;

/**
 * HARD cap on deduped movie candidates entering the per-movie enrichment
 * N+1 (optional release_dates + watch/providers lookups). The single
 * CineLog discovery stream walks at most UPCOMING_MOVIE_MAX_UPSTREAM_PAGES
 * (10) pages x 20 rows = 200 rows, so this cap covers the complete walk
 * and never truncates in practice — it is the defensive bound that keeps
 * the per-candidate enrichment deterministically bounded even if the
 * page cap is ever raised. Candidates are deduped BEFORE this cap.
 */
export const UPCOMING_MOVIE_MAX_CANDIDATES = 200;

/** HARD cap on seasons inspected per series (bounded — target months normally resolve within 1-2 seasons). */
export const UPCOMING_MAX_SEASON_INSPECTIONS = 3;

/** Release channel of an India movie release event (decided ONLY by the per-movie release_dates truth, never by discovery). */
export type UpcomingMovieReleaseKind = 'theatrical' | 'digital';

/**
 * Is this total released-episode count the signature of a daily/weekly
 * serial? Pure and synchronous. `undefined`/non-finite (missing metadata)
 * is NOT a serial — the candidate stays (curation fail-open). Values
 * exactly AT the threshold stay too; only strictly greater counts are
 * serials.
 */
export function isDailySerialEpisodeCount(totalEpisodes: number | undefined | null): boolean {
  if (typeof totalEpisodes !== 'number' || !Number.isFinite(totalEpisodes)) return false;
  return totalEpisodes > UPCOMING_TV_DAILY_SERIAL_MAX_EPISODES;
}

/**
 * Conservative Upcoming Series curation verdict — pure and deterministic.
 *
 * - anime candidates are ALWAYS kept (binding exemption — see header)
 * - `tvType` is the TMDB detail string `type` field: only the obviously
 *   generic linear-TV categories (News, Talk Show) are dropped, as
 *   defense-in-depth on top of the query-level genre exclusion. Missing
 *   or unrecognized type values keep the candidate (fail-open curation —
 *   this is a curation filter, not a security boundary; the ADULT
 *   exclusion remains separate, unconditional and query-level).
 * - a released-episode count above the serial threshold is dropped as a
 *   serial by production model.
 */
export function upcomingTvCurationVerdict(input: {
  itemType: 'series' | 'anime';
  numberOfEpisodes?: number;
  tvType?: string;
}): 'keep' | 'drop-serial' | 'drop-generic' {
  if (input.itemType === 'anime') return 'keep';
  if (input.tvType === 'News' || input.tvType === 'Talk Show') return 'drop-generic';
  if (isDailySerialEpisodeCount(input.numberOfEpisodes)) return 'drop-serial';
  return 'keep';
}

export type UpcomingSeasonCandidateInput = {
  seasonNumber?: number;
  airDate?: string;
};

export type UpcomingEpisodePointer = {
  seasonNumber?: number;
  airDate?: string;
};

/**
 * Determine the seasons to inspect for a target month — the Phase F
 * replacement for "prefer last_episode_to_air.season_number".
 *
 * Deterministic candidate rules (all real TMDB metadata, nothing
 * fabricated):
 *   1. next_episode_to_air's season when its air date is on/before the
 *      month end (the season the show is actually moving into — covers
 *      the current month and future months).
 *   2. last_episode_to_air's season when its air date falls INSIDE the
 *      month (a current-month month window that already contains aired
 *      episodes of the run).
 *   3. every season whose own air_date falls inside the month (a NEW
 *      season premiering in the target month — the exact case the old
 *      last-aired preference missed).
 *   4. the season active at month start: the latest season with an
 *      air_date <= month start (a mid-run season whose weekly episodes
 *      continue into the month).
 *   5. fallback: when NO rule produced a season (e.g. the series has no
 *      air-date metadata at all) inspect the highest numbered season.
 *
 * The result is deduped, ascending, and capped at `maxSeasons` so a
 * pathological detail payload cannot create unbounded season lookups.
 */
export function selectUpcomingSeasonCandidates(
  seasons: UpcomingSeasonCandidateInput[],
  nextEpisode: UpcomingEpisodePointer | undefined,
  lastEpisode: UpcomingEpisodePointer | undefined,
  startMs: number,
  endMs: number,
  maxSeasons: number = UPCOMING_MAX_SEASON_INSPECTIONS
): number[] {
  const candidates = new Set<number>();
  const parse = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  };
  // Rule 1: the season the next episode belongs to when it lands on/before month end.
  const nextMs = parse(nextEpisode?.airDate);
  if (nextEpisode?.seasonNumber !== undefined && nextMs !== undefined && nextMs <= endMs) {
    candidates.add(nextEpisode.seasonNumber);
  }
  // Rule 2: last-aired season when the air date is inside the month itself.
  const lastMs = parse(lastEpisode?.airDate);
  if (lastEpisode?.seasonNumber !== undefined && lastMs !== undefined && lastMs >= startMs && lastMs <= endMs) {
    candidates.add(lastEpisode.seasonNumber);
  }
  // Rule 3: seasons premiering inside the month.
  let activeAtMonthStart: { number: number; ms: number } | undefined;
  for (const season of seasons) {
    if (typeof season.seasonNumber !== 'number' || season.seasonNumber <= 0) continue;
    const ms = parse(season.airDate);
    if (ms !== undefined && ms >= startMs && ms <= endMs) {
      candidates.add(season.seasonNumber);
    }
    // Track the latest season that has started on/before month start.
    if (ms !== undefined && ms <= startMs) {
      if (!activeAtMonthStart || season.seasonNumber > activeAtMonthStart.number || (season.seasonNumber === activeAtMonthStart.number && ms > activeAtMonthStart.ms)) {
        activeAtMonthStart = { number: season.seasonNumber, ms };
      }
    }
  }
  // Rule 4: the season active at month start (may continue into the month).
  if (activeAtMonthStart) candidates.add(activeAtMonthStart.number);
  // Rule 5 fallback: no air-date metadata produced anything at all.
  if (candidates.size === 0) {
    const highest = seasons
      .map((s) => s.seasonNumber)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a)[0];
    if (highest !== undefined) candidates.add(highest);
  }
  return [...candidates].sort((a, b) => a - b).slice(0, Math.max(1, maxSeasons));
}

/**
 * Extract the canonical detail route path from an Upcoming event ID.
 *
 * Event IDs are episode-unique (`series-123-s58e294`, `anime-456-s01e22`
 * — season/episode suffixes keep duplicate-keyed cards apart) but the
 * detail routes need the parent TMDB ID. Strict parse, no blind prefix
 * stripping:
 *      movie-789            -> /movie/789
 *      series-123-s58e294   -> /series/123
 *      anime-456-s01e22     -> /anime/456
 * Malformed IDs (wrong prefix, non-numeric ID, empty, junk suffixes)
 * return null — the caller fails safe instead of routing to a 404.
 */
export function upcomingDetailPath(eventId: string): string | null {
  if (typeof eventId !== 'string') return null;
  const match = /^(movie|series|anime)-(\d+)(?:-s\d+e\d+)?$/.exec(eventId);
  if (!match) return null;
  const [, type, numericId] = match;
  const id = Number(numericId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return `/${type}/${id}`;
}

// ============================================================
// PHASE F.1 — language filter, anime identity, India release
// truth, provider normalization. All pure and synchronous; this
// module stays import-free (client-safe, directly unit-testable).
//
// PHASE F.2 note: the old `mergeMovieReleaseEvents` (theatrical +
// digital two-stream candidate merge) was removed together with the
// release-type-restricted two-query discovery it served. Candidate
// movies now arrive from ONE deduped /discover/movie stream (dedupe
// by canonical TMDB ID happens in upcoming.ts); releaseKinds derive
// exclusively from the /movie/{id}/release_dates truth via
// `deriveMovieReleaseKinds` below.
// ============================================================

// ---------- language filter ----------

/**
 * Canonical Upcoming language filter options. THIS FILTER MEANS TMDB
 * `original_language` — the language a title was ORIGINALLY PRODUCED in.
 * It deliberately does NOT mean dubbed-audio availability (TMDB has no
 * reliable per-region dub metadata for discover filtering).
 */
export type UpcomingLanguageOption = { code: string; label: string };

export const UPCOMING_LANGUAGE_OPTIONS: UpcomingLanguageOption[] = [
  { code: 'all', label: 'All' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'kn', label: 'Kannada' },
  { code: 'bn', label: 'Bengali' },
  { code: 'mr', label: 'Marathi' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' }
];

/**
 * Strict language filter parsing. Valid codes (including 'all') pass
 * through unchanged; EVERYTHING else (missing, empty, unknown, wrong
 * case, injection attempts) fails SAFE to 'all'.
 */
export function parseUpcomingLanguage(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return 'all';
  return UPCOMING_LANGUAGE_OPTIONS.some((option) => option.code === value) ? value : 'all';
}

// ---------- anime identity (Series must never mix anime) ----------

/** TMDB genre id 16 = Animation — half of Mavero's anime definition. */
export const UPCOMING_ANIME_GENRE_ID = 16;

/** Japanese original language — the other half of Mavero's anime definition. */
export const UPCOMING_ANIME_ORIGINAL_LANGUAGE = 'ja';

/**
 * Mavero's EXISTING anime identity, unchanged: TMDB TV with genre 16
 * (Animation) AND original_language 'ja'. Non-Japanese animation
 * (genre 16 + any other original language) is NOT anime in Mavero —
 * it belongs to the Series pipeline.
 *
 * Used by the Upcoming Series pipeline to REJECT anime candidates
 * before any expensive detail/season/provider work, and by the adult
 * classifier exemption path.
 */
export function isAnimeCandidate(genreIds: number[] | undefined | null, originalLanguage: string | undefined | null): boolean {
  return Array.isArray(genreIds) && genreIds.includes(UPCOMING_ANIME_GENRE_ID) && originalLanguage === UPCOMING_ANIME_ORIGINAL_LANGUAGE;
}

// ---------- India movie release truth (Phase F.1) ----------

/** One real India release event for a movie, extracted from /movie/{id}/release_dates. */
export type IndiaMovieReleaseEvent = {
  /** Normalized India release date (YYYY-MM-DD). */
  date: string;
  kind: UpcomingMovieReleaseKind;
};

/** Structural shape of the TMDB /movie/{id}/release_dates response. */
export type IndiaReleaseDatesPayload = {
  results?: Array<{
    iso_3166_1?: string;
    release_dates?: Array<{ release_date?: string; type?: number }>;
  }>;
};

/**
 * Extract the REAL India release events (types 2 theatrical-limited,
 * 3 theatrical, 4 digital) whose ACTUAL India release date falls inside
 * the selected month window, from a /movie/{id}/release_dates payload.
 *
 * Binding rules (Phase F.1 movie release truth):
 *   - ONLY country code `IN` is read — every other country is ignored.
 *   - ONLY release types 2, 3 and 4 are accepted; types 1 (Premiere),
 *     5 (Physical) and 6 (TV) never create Upcoming movie events.
 *   - The event's own release_date (the India one) must fall inside the
 *     month window — events outside the window are ignored by the
 *     enrichment (they cannot badge a card for a month they do not
 *     belong to; the August-2026 / January-1999 stale-card class is
 *     additionally killed by the final isDateInMonth invariant on the
 *     card date itself).
 *   - Dates normalize to the YYYY-MM-DD part of TMDB's ISO datetime.
 *
 * Pure: the caller decides what an empty result means. Since the
 * CineLog-model revision an empty result means NO releaseKinds badges —
 * the discover-qualified movie itself stays on the page (this function
 * is enrichment, never a candidate gate).
 */
export function extractIndiaMovieReleaseEvents(payload: IndiaReleaseDatesPayload | null | undefined, startMs: number, endMs: number): IndiaMovieReleaseEvent[] {
  const country = (payload?.results ?? []).find((entry) => entry?.iso_3166_1 === 'IN');
  if (!country) return [];
  const events: IndiaMovieReleaseEvent[] = [];
  for (const rd of country.release_dates ?? []) {
    const type = rd?.type;
    if (type !== 2 && type !== 3 && type !== 4) continue;
    const raw = rd?.release_date;
    if (typeof raw !== 'string' || raw.length < 10) continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs) continue;
    events.push({ date: raw.slice(0, 10), kind: type === 4 ? 'digital' : 'theatrical' });
  }
  return events.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || (a.kind === 'theatrical' ? -1 : 1) - (b.kind === 'theatrical' ? -1 : 1));
}

/**
 * Derive the release channels from ACTUAL India release events.
 * Canonical order: theatrical first, then digital.
 */
export function deriveMovieReleaseKinds(events: IndiaMovieReleaseEvent[]): UpcomingMovieReleaseKind[] {
  const hasTheatrical = events.some((e) => e.kind === 'theatrical');
  const hasDigital = events.some((e) => e.kind === 'digital');
  if (hasTheatrical && hasDigital) return ['theatrical', 'digital'];
  if (hasTheatrical) return ['theatrical'];
  if (hasDigital) return ['digital'];
  return [];
}

/**
 * Defensive month-membership guard for a YYYY-MM-DD date. Used as the
 * final invariant check on movie cards: item.date MUST belong to the
 * selected month/year or the card is dropped.
 */
export function isDateInMonth(date: string | undefined | null, year: number, month: number): boolean {
  if (typeof date !== 'string' || date.length === 0) return false;
  const ms = Date.parse(date);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month;
}

// ---------- watch-provider normalization (Phase F.1: movies too) ----------

/** Structural shape of one TMDB watch-provider row. */
export type FlatrateProviderRow = { provider_id?: number; provider_name?: string; logo_path?: string | null };

/** Normalized provider card shape (same for series and movies). */
export type NormalizedUpcomingProvider = { id: number; name: string; logo: string };

/**
 * Normalize ONE region's flatrate provider rows. Binding rules:
 *   - the caller selects the region entry from the watch/providers
 *     `results` record — ONLY that region is read; there is NO US or
 *     cross-region fallback anywhere;
 *   - ONLY flatrate rows are accepted (buy/rent are not OTT streaming);
 *   - malformed rows (missing id/name/logo) are skipped;
 *   - `logoUrl` builds the image URL from TMDB logo_path (injected so
 *     this pure module stays independent of image-size policy).
 */
export function normalizeRegionFlatrateProviders(
  results: Record<string, { flatrate?: FlatrateProviderRow[] }> | undefined,
  region: string,
  logoUrl: (path: string) => string
): NormalizedUpcomingProvider[] {
  const regionData = results?.[region];
  const flatrate = regionData?.flatrate ?? [];
  const out: NormalizedUpcomingProvider[] = [];
  for (const row of flatrate) {
    if (typeof row?.provider_id !== 'number' || typeof row?.provider_name !== 'string' || typeof row?.logo_path !== 'string') continue;
    out.push({ id: row.provider_id, name: row.provider_name, logo: logoUrl(row.logo_path) });
  }
  return out;
}

/**
 * India OTT ELIGIBILITY (Phase F.2) — the Upcoming SERIES gate.
 *
 * A candidate series qualifies for Upcoming Series ONLY when its
 * normalized India flatrate provider list contains at least one valid
 * provider (`/tv/{id}/watch/providers` -> results.IN.flatrate, already
 * normalized by `normalizeRegionFlatrateProviders`).
 *
 * Binding rules:
 *   - `null`/`undefined` input means the provider LOOKUP FAILED (a
 *     transient upstream error). It is NOT eligibility data — the
 *     upcoming.ts pipeline treats that case as a FAILED candidate
 *     explicitly; this helper returns false for it so the default is
 *     always the safe drop.
 *   - an empty array means TMDB answered and India has NO flatrate
 *     provider -> NOT eligible -> the series is dropped.
 *   - US/other-region-only or buy/rent-only availability never reaches
 *     this helper (the normalizer reads results.IN.flatrate only).
 *
 * ANIME is exempt by architecture: the anime pipeline never requires
 * India flatrate availability (most airing anime have no IN data).
 */
export function isIndiaFlatrateEligible(providers: NormalizedUpcomingProvider[] | null | undefined): boolean {
  return Array.isArray(providers) && providers.length > 0;
}

// ---------- season-level provider eligibility (Phase F.3) ----------

/**
 * Structural shape of the TMDB season-level watch/providers response
 * (GET /tv/{series_id}/season/{season_number}/watch/providers). The
 * official OpenAPI shows the SAME results.{CC}.{flatrate,...} shape as
 * the series-level endpoint, so one normalizer serves both.
 */
export type SeasonWatchProvidersPayload = {
  results?: Record<string, { flatrate?: FlatrateProviderRow[] }>;
};

/**
 * The India provider picture of ONE relevant target season, distilled
 * from a season watch/providers payload.
 *
 *   - `providers` = the season's own results.{region}.flatrate rows,
 *     normalized (empty when the season has none).
 *   - `providerDataAbsent` = the payload carried NO provider data for
 *     ANY region (missing/empty `results`). ONLY this state may fall
 *     back to the parent series-level providers: a season that HAS
 *     provider data without India flatrate (US-only, buy/rent-only, an
 *     IN entry with empty flatrate) is AFFIRMATIVE absence — it never
 *     qualifies and never falls back, so richer upstream data can never
 *     produce MORE availability than the data states.
 */
export type SeasonIndiaProviderOutcome = {
  seasonNumber: number;
  providers: NormalizedUpcomingProvider[];
  providerDataAbsent: boolean;
};

/**
 * Distill one season watch/providers payload into its India outcome.
 * `region` is the requested region (IN for the Upcoming product);
 * `logoUrl` is injected so this pure module stays independent of
 * image-size policy. A missing/failed payload is defensively treated as
 * "no provider data at all" — the caller separately treats LOOKUP
 * failures as failed candidates, so this only shapes successful answers.
 */
export function seasonIndiaProviderOutcome(
  payload: SeasonWatchProvidersPayload | null | undefined,
  seasonNumber: number,
  region: string,
  logoUrl: (path: string) => string
): SeasonIndiaProviderOutcome {
  const results = payload?.results;
  const providerDataAbsent = !results || Object.keys(results).length === 0;
  return {
    seasonNumber,
    providers: providerDataAbsent ? [] : normalizeRegionFlatrateProviders(results, region, logoUrl),
    providerDataAbsent
  };
}

/**
 * Deduplicate normalized providers by TMDB provider_id, keeping the
 * first occurrence (season provider results and parent fallback data
 * can overlap — identical providers must not render twice).
 */
export function dedupeProvidersById(providers: NormalizedUpcomingProvider[]): NormalizedUpcomingProvider[] {
  const seen = new Set<number>();
  const out: NormalizedUpcomingProvider[] = [];
  for (const provider of providers) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    out.push(provider);
  }
  return out;
}

/**
 * The Phase F.3 SEASON-LEVEL India OTT eligibility verdict for a series
 * whose real target-month episodes are already confirmed.
 *
 * Binding rule (documented product semantics):
 *   - ANY relevant target season with its own India flatrate provider
 *     qualifies the series; icons are the provider_id-deduped union of
 *     the qualifying seasons' own providers.
 *   - otherwise, when at least one season endpoint returned NO provider
 *     data at all (providerDataAbsent), the verdict is 'needs-parent':
 *     the caller may consult the parent /tv/{id}/watch/providers and
 *     qualifies the series through results.IN.flatrate (parent icons).
 *   - when every season carried provider data but NONE had India
 *     flatrate (US-only / buy-rent-only / IN-with-empty-flatrate), the
 *     verdict is 'ineligible' — affirmative absence, NO parent fallback.
 *
 * The parent lookup is deliberately LAZY (only 'needs-parent' triggers
 * it): a series whose seasons already speak for India never pays for a
 * parent call, and a parent outage can only affect candidates that
 * actually need the fallback.
 */
export type SeasonProviderVerdict =
  | { outcome: 'qualified'; providers: NormalizedUpcomingProvider[] }
  | { outcome: 'needs-parent' }
  | { outcome: 'ineligible' };

export function seasonProviderVerdict(seasons: SeasonIndiaProviderOutcome[]): SeasonProviderVerdict {
  if (seasons.length === 0) return { outcome: 'ineligible' };
  const ownQualified = seasons.filter((season) => season.providers.length > 0);
  if (ownQualified.length > 0) {
    return { outcome: 'qualified', providers: dedupeProvidersById(ownQualified.flatMap((season) => season.providers)) };
  }
  if (seasons.some((season) => season.providerDataAbsent)) return { outcome: 'needs-parent' };
  return { outcome: 'ineligible' };
}
