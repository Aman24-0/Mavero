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

/**
 * Cache-key dimension for the India movie release-truth model (Phase F.1).
 *
 * Phase F trusted the /discover/movie row's `release_date` as the card
 * date, but TMDB's region handling can fall back to the primary (origin)
 * release date when a country-specific date is missing — which let
 * stale/foreign dates (e.g. an August date or a 1999 date) render on the
 * September 2026 page. Phase F.1 makes
 * `GET /movie/{id}/release_dates` -> country `IN` -> release types 2|3|4
 * the FINAL India release truth; this version constant re-keys every
 * pre-truth cached entry so stale-date result sets can never be served.
 */
export const UPCOMING_MOVIE_RELEASE_TRUTH_KEY = 'in-release-dates-v1';

/** Cache-key dimension for the India watch-provider model (flatrate only, per-region). */
export const UPCOMING_PROVIDER_MODEL_KEY = 'tmdb-flatrate-v1';

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

// ============================================================
// PHASE F.1 — language filter, anime identity, India release
// truth, provider normalization. All pure and synchronous; this
// module stays import-free (client-safe, directly unit-testable).
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
 *     month window — a movie whose actual India release is outside the
 *     selected month/year is dropped by the caller (this kills the
 *     August-2026 / January-2022 / January-1999 class of stale card).
 *   - Dates normalize to the YYYY-MM-DD part of TMDB's ISO datetime.
 *
 * Pure: the caller decides what an empty result means (drop the movie).
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
 * The earliest VALID India release event date — the card date. Invalid
 * dates never win; undefined when no valid event exists.
 */
export function earliestIndiaReleaseDate(events: IndiaMovieReleaseEvent[]): string | undefined {
  let best: string | undefined;
  for (const event of events) {
    if (!event.date || !Number.isFinite(Date.parse(event.date))) continue;
    if (best === undefined || Date.parse(event.date) < Date.parse(best)) best = event.date;
  }
  return best;
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
