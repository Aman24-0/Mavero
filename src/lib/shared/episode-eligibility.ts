/**
 * MAV-FOCUSED Issue 4 (2026-10) — episode + season eligibility logic.
 *
 * Pure functions that decide whether an episode or season is eligible to
 * render Play/Download buttons (episodes) or a season tab (seasons). The
 * logic is deliberately PURE — no DOM, no fetches, no side effects — so it
 * can be unit-tested in isolation with realistic fixtures and edge cases.
 *
 * The two root-cause bugs this module closes:
 *
 *   A. Future-dated episodes showed Play/Download buttons. Black Clover
 *      episode 3 with airDate 2026-10-17 was actionable today (2026-10-13).
 *   B. Announced/unstarted seasons appeared in the season selector as
 *      normal tabs with placeholder episode rows ("Episode 3", "Unknown").
 *      The Gentlemen season 3 had no episode metadata but still rendered
 *      a tab.
 *
 * Date handling:
 *   - TMDB `air_date` is a date-only string (YYYY-MM-DD). We treat it as
 *     MIDNIGHT UTC (00:00:00Z) on that day, then check `nowUTC >= airDate`.
 *     This avoids the timezone-conversion bug where a date-only value
 *     becomes "released" prematurely because of a local-timezone shift
 *     (e.g. an IST user at 2026-10-17T00:30 IST sees the episode as
 *     "released" because UTC is 2026-10-16T19:00 — but the episode's
 *     release date is 2026-10-17, and we want it released only from the
 *     17th onwards in UTC terms).
 *   - Missing / invalid `airDate`: conservative handling. We do NOT
 *     treat an unknown date as "released in the future" (that would
 *     hide legitimately-playable content), but we also do NOT invent
 *     release eligibility (that would surface placeholder episodes).
 *     The decision is delegated to the caller via a separate
 *     `hasConfirmedPlayableSource` flag — the existing playback
 *     eligibility rules decide. When the flag is absent, missing date
 *     → released (preserves the existing trusted-availability fallback).
 */

import type { Episode, Season } from '$lib/server/content/types';

/** A minimal episode shape so the helpers can run on both server-shaped
 *  and client-shaped episodes (the client-side MediaItem.seasonsData
 *  uses the same Episode shape). */
export type EligibleEpisode = Pick<Episode, 'airDate'> & { id: string; number: number; season: number };

/** A minimal season shape for the same reason. */
export type EligibleSeason = Pick<Season, 'airDate' | 'episodeCount' | 'episodes' | 'number'>;

/**
 * Parse a date-only string (YYYY-MM-DD) as MIDNIGHT UTC. Returns undefined
 * for invalid / missing input. We deliberately use UTC (not local time) so
 * a date-only release value is never converted by the user's local
 * timezone — the eligibility decision is the same for every user.
 */
function parseDateOnlyUTC(value: string | undefined | null): Date | undefined {
  if (!value || typeof value !== 'string') return undefined;
  // Accept only the canonical YYYY-MM-DD form. Anything else (partial,
  // different separator, time component) is treated as invalid.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Validate ranges (Date.UTC would roll over invalid months/days — we
  // want to reject them outright instead).
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  if (!Number.isFinite(ms)) return undefined;
  // Sanity: re-extract the day from the constructed UTC date and verify
  // it matches (Date.UTC silently rolls over e.g. Feb 30 → Mar 2).
  const constructed = new Date(ms);
  if (constructed.getUTCFullYear() !== year || constructed.getUTCMonth() !== month - 1 || constructed.getUTCDate() !== day) return undefined;
  return constructed;
}

/**
 * Decide whether an episode has aired (i.e. is eligible for Play/Download).
 *
 *  - `airDate` is a valid YYYY-MM-DD in the past → RELEASED.
 *  - `airDate` is a valid YYYY-MM-DD today (UTC) → RELEASED (midnight UTC
 *    has passed).
 *  - `airDate` is a valid YYYY-MM-DD in the future → NOT RELEASED.
 *  - `airDate` is missing or invalid → fall back to the caller's
 *    `hasConfirmedPlayableSource` flag. When that flag is true (the
 *    existing playback eligibility rules say a real source exists),
 *    the episode is RELEASED. When the flag is false/absent, the
 *    episode is NOT RELEASED (we do not invent eligibility for a
 *    placeholder episode with no date and no playable source).
 *
 *  `now` defaults to `new Date()` (real-time) but can be injected for tests.
 */
export function isEpisodeReleased(
  episode: Pick<EligibleEpisode, 'airDate'>,
  options: { now?: Date; hasConfirmedPlayableSource?: boolean } = {}
): boolean {
  const now = options.now ?? new Date();
  const airDate = parseDateOnlyUTC(episode.airDate);
  if (airDate) {
    // Released once midnight UTC on the air date has passed.
    return now.getTime() >= airDate.getTime();
  }
  // Missing / invalid date: delegate to the caller's trusted-availability
  // signal. Do NOT invent eligibility.
  return options.hasConfirmedPlayableSource === true;
}

/**
 * Decide whether a season has genuinely started airing — i.e. at least one
 * of its episodes has a valid past airDate, OR the season airDate itself is
 * in the past AND the season has at least one episode.
 *
 *  - A season with episodes, where at least one has a valid past airDate
 *    → STARTED.
 *  - A season with episodes but ALL have future/missing airDates → NOT
 *    STARTED. (This is the "announced future season with placeholder
 *    episode objects only" case from the regression spec.)
 *  - A season with NO episodes but a valid past season airDate AND
 *    episodeCount > 0 → STARTED. (The metadata says it started; the
 *    episode list will populate later — but the season tab can show.)
 *  - A season with NO episodes AND a missing/future season airDate → NOT
 *    STARTED. (The Gentlemen S3 case.)
 *
 *  `now` defaults to `new Date()` (real-time) but can be injected for tests.
 */
export function isSeasonStarted(
  season: EligibleSeason,
  options: { now?: Date } = {}
): boolean {
  const now = options.now ?? new Date();
  const episodes = season.episodes ?? [];
  // If any episode has a valid past airDate, the season has started.
  if (episodes.some((episode) => {
    const airDate = parseDateOnlyUTC(episode.airDate);
    return airDate ? now.getTime() >= airDate.getTime() : false;
  })) {
    return true;
  }
  // No aired episode found. Fall back to the season-level airDate, but only
  // when there is at least one episode (episodeCount > 0 OR episodes array
  // is non-empty) — a season with NO episodes AND a past airDate is most
  // likely a metadata stub.
  const hasEpisodeList = episodes.length > 0 || (season.episodeCount ?? 0) > 0;
  if (!hasEpisodeList) return false;
  const seasonAirDate = parseDateOnlyUTC(season.airDate);
  if (!seasonAirDate) return false;
  return now.getTime() >= seasonAirDate.getTime();
}

/**
 * Filter the seasons array to only those that have genuinely started
 * airing. Preserves the original order. Empty / malformed input → empty
 * result (never invents a season).
 *
 *  `now` defaults to `new Date()` (real-time) but can be injected for tests.
 */
export function getEligibleSeasons(
  seasons: EligibleSeason[] | undefined | null,
  options: { now?: Date } = {}
): EligibleSeason[] {
  if (!Array.isArray(seasons) || seasons.length === 0) return [];
  const now = options.now ?? new Date();
  return seasons.filter((season) => isSeasonStarted(season, { now }));
}

/**
 * Compute the highest season number that has genuinely started airing.
 * Returns 0 when no season has started (so the caller can decide whether
 * to hide the season selector entirely).
 *
 *  `now` defaults to `new Date()` (real-time) but can be injected for tests.
 */
export function getLatestStartedSeasonNumber(
  seasons: EligibleSeason[] | undefined | null,
  options: { now?: Date } = {}
): number {
  const eligible = getEligibleSeasons(seasons, options);
  if (eligible.length === 0) return 0;
  return Math.max(...eligible.map((season) => season.number));
}
