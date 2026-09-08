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
//   1. Upcoming Series surfaced Indian daily-soap / linear-TV serials
//      because the TV discover query had NO India OTT availability
//      constraint and NO generic linear-TV category exclusion. The fix
//      is layered:
//        a) QUERY LEVEL (server-side, in upcoming.ts): require
//           `watch_region=IN` + `with_watch_monetization_types=flatrate`
//           so only titles with India OTT (subscription) availability
//           are candidates, plus `without_genres` for Soap (10764),
//           News (10766) and Talk (10767).
//        b) DETAIL LEVEL (this module): a conservative serial-structure
//           policy — Indian daily/weekly serials are serials by
//           production model (hundreds of released episodes), the same
//           reliable signal measured for the Popular TV rail
//           (measured 2026-09-08: contaminating serials 198-957
//           released episodes vs must-keep OTT shows 10-32). A title
//           with MORE released episodes than the threshold is a serial
//           and is dropped from Upcoming Series. This is deterministic
//           metadata — there is deliberately NO title blacklist.
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
//   3. Upcoming event IDs are episode-unique
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
// MOVIE RELEASE MODEL (used by upcoming.ts, constants live here):
//   India theatrical (TMDB release types 2|3) and India digital/OTT
//   (release type 4) are discovered by two separate /discover/movie
//   queries (region=IN + release_date month window + with_release_type)
//   and merged by `mergeMovieReleaseEvents` (dedupe by canonical movie
//   ID, earliest India release date preserved, normalized releaseKinds
//   field — duplicate cards are never rendered).
//
// CACHE KEYS: the constants exported here are embedded in the
// upcoming.ts cache keys, so bumping a policy/query version re-keys
// instead of serving stale-era entries.
// ============================================================

/** TV genres treated as generic linear-TV categories for Upcoming Series: Soap, News, Talk. */
export const UPCOMING_TV_WITHOUT_GENRES = '10764|10766|10767';

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

/** Cache-key dimension for the India-OTT query shape (flatrate + genre exclusion). */
export const UPCOMING_TV_OTT_QUERY_KEY = 'in-flatrate-v1';

/**
 * Cache-key dimension for the month-window season resolution model.
 * Bump when the season/episode discovery semantics change so previously
 * cached series/anime item sets are never served under new semantics.
 */
export const UPCOMING_SEASON_MODEL_KEY = 'month-window-v1';

/** Cache-key dimension for the India movie release-type model (theatrical 2|3 + digital 4). */
export const UPCOMING_MOVIE_RELEASE_MODEL_KEY = 'in-release-types-v1';

/** TMDB release-type values for the two India movie queries (official TMDB release types: 1 Premiere, 2 Theatrical (limited), 3 Theatrical, 4 Digital, 5 Physical, 6 TV). */
export const UPCOMING_MOVIE_RELEASE_TYPES = {
  theatrical: '2|3',
  digital: '4'
} as const;

/** HARD cap on upstream /discover/movie pages walked per release kind (bounded pagination — a pathological query cannot loop unbounded). */
export const UPCOMING_MOVIE_MAX_UPSTREAM_PAGES = 10;

/** HARD cap on upstream /discover/tv pages walked for series candidates (bounded pagination). */
export const UPCOMING_TV_MAX_CANDIDATE_PAGES = 2;

/** HARD cap on candidate TV series processed per month (bounded N+1: each candidate costs detail + season + provider lookups). */
export const UPCOMING_TV_MAX_CANDIDATES = 40;

/** HARD cap on seasons inspected per series (bounded — target months normally resolve within 1-2 seasons). */
export const UPCOMING_MAX_SEASON_INSPECTIONS = 3;

/** Release channel of an India movie release event. */
export type UpcomingMovieReleaseKind = 'theatrical' | 'digital';

/** One deduped movie release event after merging the theatrical + digital result sets. */
export type MovieReleaseEvent = {
  tmdbId: number;
  /** Earliest India release date (YYYY-MM-DD) across the qualifying release kinds. */
  date: string;
  /** Canonical kind order: theatrical before digital. */
  releaseKinds: UpcomingMovieReleaseKind[];
};

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

/**
 * Merge the India theatrical + digital discover result sets into deduped
 * release events. Pure and synchronous:
 *   - dedupe by canonical TMDB movie ID (a movie qualifying for BOTH
 *     theatrical and digital in the month renders ONE card, never two)
 *   - preserve the EARLIEST valid India release date of the two events
 *   - releaseKinds in canonical order (theatrical first)
 * The returned events are sorted by (date, tmdbId) ascending so the
 * caller gets a chronologically stable stream.
 */
export function mergeMovieReleaseEvents(
  theatrical: Array<{ tmdbId: number; date: string }>,
  digital: Array<{ tmdbId: number; date: string }>
): MovieReleaseEvent[] {
  const byId = new Map<number, MovieReleaseEvent>();
  const absorb = (tmdbId: number, date: string, kind: UpcomingMovieReleaseKind) => {
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return;
    const existing = byId.get(tmdbId);
    if (!existing) {
      byId.set(tmdbId, { tmdbId, date, releaseKinds: [kind] });
      return;
    }
    if (!existing.releaseKinds.includes(kind)) {
      existing.releaseKinds = kind === 'theatrical' ? ['theatrical', ...existing.releaseKinds] : [...existing.releaseKinds, 'digital'];
    }
    // Keep the earliest valid India release date. An invalid/missing date
    // never wins over a valid one.
    const existingMs = Date.parse(existing.date);
    const incomingMs = Date.parse(date);
    if (!Number.isFinite(existingMs) || (Number.isFinite(incomingMs) && incomingMs < existingMs)) {
      existing.date = date;
    }
  };
  for (const row of theatrical) absorb(row.tmdbId, row.date, 'theatrical');
  for (const row of digital) absorb(row.tmdbId, row.date, 'digital');
  return [...byId.values()].sort((a, b) => {
    const aMs = Date.parse(a.date);
    const bMs = Date.parse(b.date);
    const aKey = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
    const bKey = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
    return aKey - bKey || a.tmdbId - b.tmdbId;
  });
}
