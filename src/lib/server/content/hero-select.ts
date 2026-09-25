// ============================================================
// MAVERO — Discover Hero daily lineup selector (v2 — production fix).
//
// v1 (commit 89bb711) had two critical bugs that caused the actual
// running Hero to render as S/M/M/M/M/M instead of M/S/M/S/M/S:
//
//   1. The 30-day movie freshness gate was HARD, but TMDB's
//      /trending/movie/week rail surfaces popularity-driven content
//      that is often 60-90 days old (e.g., a July release trending
//      in September). The gate therefore rejected most candidates →
//      the movie pool was empty → the selector returned [].
//   2. When the selector returned [], DiscoverPage.svelte fell back
//      to the legacy createFeaturedItems path which had NO
//      freshness filter and NO M/S/M/S/M/S enforcement. selectFeatured
//      picked Reacher (high popularity, has backdrop) as the first
//      item, then 5 movies from trending → S/M/M/M/M/M.
//
// v2 fixes this by:
//
//   - Expanding the candidate pool (see getTmdbHeroMoviePool and
//     getTmdbHeroSeriesPool in tmdb.ts): now_playing + airing_today
//     + on_the_air are added in addition to trending. These give
//     genuinely fresh candidates that pass the 30-day gate.
//   - Replacing the 180-day series heuristic with a CURRENT-ACTIVITY
//     eligibility gate: a series is eligible only if it appears in
//     /tv/airing_today or /tv/on_the_air (TMDB id is in
//     `activeSeriesIds`) OR its first_air_date is within 30 days
//     (covers new series premieres). Reacher (2022, no current
//     activity) is correctly excluded.
//   - Implementing CONTROLLED DAILY ROTATION: instead of a hash
//     tiebreak that only rotates when scores are tied, we take the
//     top RELEVANCE_WINDOW_SIZE candidates per type and rotate the
//     slice start by `bucket % (window - slots + 1)` — different
//     buckets produce DIFFERENT lineups when the pool has depth
//     beyond the top N. Quality is preserved (we never go below the
//     relevance window).
//   - Returning a diagnostic counts object so the caller can log
//     when pools are thin.
//
// The selector is PURE: takes candidate pools + signals + bucket,
// returns up to 6 candidates in M/S/M/S/M/S order. No Svelte, no
// $env, no network — fully unit-testable from a tsx script.
// ============================================================

import type { NormalizedMediaItem } from './types';

const DAY_MS = 86_400_000;
export const HERO_BUCKET_MS = 86_400_000; // 24 hours
export const MOVIE_FRESH_WINDOW_DAYS = 30;
// Allow upcoming releases up to this many days in the FUTURE to count
// as fresh. TMDB's /movie/now_playing includes titles releasing in
// the next few days — they are "newly available" by the spec. We
// don't allow arbitrary far-future releases (a movie coming in 6
// months is not "fresh today").
export const MOVIE_FRESH_FUTURE_DAYS = 7;
// Series NEW-PREMIERE window — a series whose first_air_date is within
// this many days is eligible (covers a brand-new show that hasn't
// appeared in airing_today/on_the_air yet because the first episode
// aired recently). This is NOT a "currently airing" heuristic — the
// currently-airing signal is the activeSeriesIds set.
export const SERIES_PREMIERE_WINDOW_DAYS = 30;
export const HERO_LINEUP_SIZE = 6;
// Slots per type in a full 6-slot M/S/M/S/M/S lineup.
export const HERO_SLOTS_PER_TYPE = 3;
// The relevance window — we never pick candidates below the top N by
// score. Rotation happens within this window. With N=12 and 3 slots,
// we have 10 different daily offsets — enough for ~10 days of
// visible rotation when the pool has depth.
export const RELEVANCE_WINDOW_SIZE = 12;
// Minimum lineup length that MAY be cached for the long Hero TTL
// (24h). An empty lineup (length === 0) must NEVER be cached for
// 24h — that would freeze the Hero as "Featured title unavailable"
// for the entire rotation period. The caller uses this constant
// (or a stricter check) with getOrSetValidated to enforce the rule.
// A length of 1+ is cacheable: it's a real (if thin) lineup that
// reflects genuine candidate scarcity. The diagnostic log surfaces
// thin lineups so the underlying pool/source issue can be investigated.
export const MIN_LINEUP_TO_CACHE = 1;

// Recognized Indian TMDB original_language codes. Used ONLY for the
// controlled Indian boost — never for filtering.
const INDIAN_LANGUAGE_CODES = new Set([
  'hi', // Hindi
  'ta', // Tamil
  'te', // Telugu
  'ml', // Malayalam
  'kn', // Kannada
  'bn', // Bengali
  'mr', // Marathi
  'gu', // Gujarati
  'pa', // Punjabi
]);

/**
 * Minimal structural type the Hero selector consumes. Both
 * `NormalizedMediaItem` and `MediaItem` satisfy this shape.
 */
export type HeroCandidate = {
  id: string;
  type: 'movie' | 'series' | 'anime';
  releaseDate?: string;
  rating: number;
  popularity?: number;
  voteCount?: number;
  externalIds?: { tmdb?: string };
  originalLanguage?: string;
  backdrop?: string;
  backdropSmall?: string;
  backdropHero?: string;
  tags?: string[];
};

/**
 * Diagnostic counts returned alongside the lineup so the caller can
 * log when pools are thin. NOT exposed to the UI.
 *
 * The stage-by-stage counts let production diagnostics distinguish:
 *   - source failure (rawMovies === 0 → TMDB returned nothing)
 *   - adult classifier emptied the pool (rawMovies > 0, eligibleMovies === 0
 *     AND the drop happened before the selector ran — the adult
 *     classification is done by getTmdbHeroMoviePool / getTmdbHeroSeriesPool
 *     in tmdb.ts)
 *   - freshness gate removed everything (rawMovies > 0, but eligibleMovies
 *     === 0 AND postFreshness === 0)
 *   - backdrop gate removed everything (postFreshness > 0, but
 *     postBackdrop === 0 — happens when TMDB rows have null backdrop_path
 *     AND null poster_path, which is rare)
 *
 * The selector sees the AFTER-classifier items as its `raw` input, so
 * the raw → eligible delta is the freshness + backdrop + adult-tag
 * filtering done BY THE SELECTOR. The classifier filtering done by
 * the TMDB pool helpers is NOT visible here — log that separately
 * inside getTmdbHeroMoviePool / getTmdbHeroSeriesPool.
 */
export type HeroDiagnostics = {
  rawMovies: number;
  rawSeries: number;
  // Per-stage counts inside the selector (after the TMDB pool helpers
  // already applied the adult classifier). These let us identify which
  // selector-side gate removed candidates.
  postFreshnessMovies: number;
  postFreshnessSeries: number;
  postBackdropMovies: number;
  postBackdropSeries: number;
  eligibleMovies: number;
  eligibleSeries: number;
  finalMovies: number;
  finalSeries: number;
  lineupLength: number;
  bucket: number;
  /**
   * Whether the lineup came from a fresh cache hit (no recomputation).
   * Lets the caller detect "cache returned an already-cached empty
   * result" — when fromCache is true and lineupLength is 0, the cache
   * was poisoned by a previous request.
   */
  fromCache?: boolean;
  /**
   * Human-readable reason the lineup is short/empty, when applicable.
   * One of:
   *   - 'ok'                  — full 6-slot lineup
   *   - 'source-empty'        — raw pools were empty (TMDB failure)
   *   - 'freshness-rejected'   — all candidates failed the freshness gate
   *   - 'backdrop-rejected'    — all candidates failed the backdrop gate
   *   - 'pool-thin'            — enough eligible candidates but < 6 total
   *                              (e.g. 3 movies + 2 series = 5)
   */
  reason: 'ok' | 'source-empty' | 'freshness-rejected' | 'backdrop-rejected' | 'pool-thin';
};

/**
 * Result of selectHeroLineup — the canonical Hero lineup plus
 * diagnostics.
 */
export type HeroLineupResult<T extends HeroCandidate = HeroCandidate> = {
  lineup: T[];
  diagnostics: HeroDiagnostics;
};

// FNV-1a 32-bit hash. Stable across V8/Node/browser — required so
// SSR and client hydration produce the same lineup.
function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The current 24-hour bucket number. Same bucket → same lineup.
 * Different bucket → potentially different lineup (controlled
 * rotation via the relevance-window offset).
 */
export function heroDailyBucket(now: number = Date.now()): number {
  return Math.floor(now / HERO_BUCKET_MS);
}

function releaseDateMs(item: HeroCandidate): number | undefined {
  const raw = item.releaseDate;
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * HARD eligibility gate for movies. A movie with release_date older
 * than 30 days is EXCLUDED from the Hero pool — popularity cannot
 * override this (popularity is a ranking signal AFTER eligibility).
 *
 * Future-dated movies (upcoming releases scheduled in the next 30
 * days) are eligible — they're "fresh" by the spec ("newly
 * available"). TMDB's now_playing / discover endpoints already
 * restrict to released-or-soon titles, so this is a permissive
 * forward-edge case.
 */
export function isMovieFreshForHero(item: HeroCandidate, now: number = Date.now()): boolean {
  const ms = releaseDateMs(item);
  if (ms === undefined) return false;
  const age = now - ms;
  // Allow upcoming releases up to MOVIE_FRESH_FUTURE_DAYS in the
  // future (TMDB /movie/now_playing includes them). Do NOT allow
  // arbitrary far-future releases — a movie scheduled in 6 months is
  // not "fresh today".
  return age >= -MOVIE_FRESH_FUTURE_DAYS * DAY_MS && age <= MOVIE_FRESH_WINDOW_DAYS * DAY_MS;
}

/**
 * HARD eligibility gate for series. Replaces the v1 180-day
 * heuristic (which incorrectly allowed Reacher 2022 because its
 * first_air_date was within 180 days of nothing — the math was
 * wrong AND the heuristic was wrong).
 *
 * A series is eligible if EITHER:
 *   1. It appears in the `activeSeriesIds` set — i.e. TMDB's
 *      /tv/airing_today or /tv/on_the_air returned it, proving
 *      current episode activity. This is the strongest possible
 *      "currently airing" signal without per-title detail lookups
 *      (TMDB list rows do NOT carry last_episode_to_air).
 *   2. Its first_air_date is within SERIES_PREMIERE_WINDOW_DAYS —
 *      covers a brand-new series that hasn't shown up in
 *      airing_today yet because the premiere was recent.
 *
 * Reacher (2022, no current activity, original premiere 4 years
 * ago) is correctly EXCLUDED.
 */
export function isSeriesFreshForHero(
  item: HeroCandidate,
  activeSeriesIds: Set<string>,
  now: number = Date.now()
): boolean {
  // Signal 1: current activity (strongest — no date math).
  const tmdbId = item.externalIds?.tmdb ?? item.id.replace(/^(movie|series|anime)-/, '');
  if (activeSeriesIds.size > 0 && activeSeriesIds.has(tmdbId)) return true;
  // Signal 2: recent series premiere.
  const ms = releaseDateMs(item);
  if (ms === undefined) return false;
  return now - ms <= SERIES_PREMIERE_WINDOW_DAYS * DAY_MS;
}

/**
 * Unified eligibility — picks the right gate by type.
 */
export function isFreshForHero(
  item: HeroCandidate,
  activeSeriesIds: Set<string>,
  now: number = Date.now()
): boolean {
  if (item.type === 'movie') return isMovieFreshForHero(item, now);
  // series, anime series, or anime-tagged series — all use the series gate.
  return isSeriesFreshForHero(item, activeSeriesIds, now);
}

/**
 * Image-quality gate: prefer candidates with a usable backdrop.
 * The Hero renders a 1280x720+ backdrop; a candidate with only a
 * poster fallback would look poor.
 */
export function hasHeroBackdrop(item: HeroCandidate): boolean {
  return Boolean((item.backdrop ?? '').trim() || (item.backdropHero ?? '').trim() || (item.backdropSmall ?? '').trim());
}

/**
 * Adult exclusion: defense-in-depth on the `tags` field.
 */
function isAdultTagged(item: HeroCandidate): boolean {
  return Boolean(item.tags?.includes('Adult'));
}

function boundedLog(value: number | undefined, divisor: number): number {
  if (!value || value <= 0) return 0;
  return Math.min(1, Math.log10(value + 1) / divisor);
}

/**
 * Composite score. Components:
 *   - Freshness (linear decay, 0.20 max) — decays over the 30-day
 *     window for movies; for series it's a flat 0.20 if active
 *     (since current activity is the strongest signal).
 *   - Trending/popularity (log10, 0.15 max)
 *   - Rating (0.10 max)
 *   - Currently-streaming India flatrate boost (0.18 max)
 *   - Indian-content boost (0.08 max)
 *   - Backdrop quality (0.05 max)
 *
 * Eligibility (freshness gate) is applied BEFORE scoring — the score
 * only ranks candidates that have already passed eligibility.
 */
export function scoreHeroCandidate(
  item: HeroCandidate,
  streamingIds: Set<string>,
  activeSeriesIds: Set<string>,
  now: number = Date.now()
): number {
  // Freshness decay (only meaningful for movies; series get a flat
  // bonus when active so the score reflects "currently airing" without
  // decaying their original premiere date).
  let freshness = 0;
  const ms = releaseDateMs(item);
  if (ms !== undefined) {
    const daysSince = Math.max(0, (now - ms) / DAY_MS);
    if (item.type === 'movie') {
      freshness = Math.max(0, 0.20 * (1 - daysSince / MOVIE_FRESH_WINDOW_DAYS));
    } else {
      // Series: full freshness bonus if currently active; otherwise
      // decay by the premiere window.
      const tmdbId = item.externalIds?.tmdb ?? item.id.replace(/^(movie|series|anime)-/, '');
      const isActive = activeSeriesIds.size > 0 && activeSeriesIds.has(tmdbId);
      freshness = isActive ? 0.20 : Math.max(0, 0.10 * (1 - daysSince / SERIES_PREMIERE_WINDOW_DAYS));
    }
  }

  const popularity = boundedLog(item.popularity, 3) * 0.15;
  const rating = Math.min(0.10, Math.max(0, item.rating / 10) * 0.10);
  const tmdbId = item.externalIds?.tmdb ?? item.id.replace(/^(movie|series|anime)-/, '');
  const streaming = streamingIds.size > 0 && streamingIds.has(tmdbId) ? 0.18 : 0;
  const isIndian = item.originalLanguage !== undefined && INDIAN_LANGUAGE_CODES.has(item.originalLanguage);
  const indian = isIndian ? 0.08 : 0;
  const backdrop = (item.backdrop ?? '').trim() || (item.backdropHero ?? '').trim() ? 0.05 : 0;
  return freshness + popularity + rating + streaming + indian + backdrop;
}

type ScoredCandidate = { item: HeroCandidate; score: number; rankKey: number };

type PoolStats = {
  raw: number;
  postFreshness: number;
  postBackdrop: number;
  eligible: number;
  pool: ScoredCandidate[];
};

/**
 * Build the scored + sorted eligible pool for one content type.
 * Eligibility filters (freshness, backdrop, adult, dedupe) are
 * applied HERE — the returned `pool` contains ONLY eligible
 * candidates sorted by score DESC, then deterministic FNV-1a hash
 * ASC. The `stats` object tracks per-stage counts so diagnostics
 * can identify which gate removed candidates.
 *
 * Stage order (all applied per item, in this order):
 *   1. raw count (input size)
 *   2. NOT adult-tagged (defense-in-depth on the `tags` field)
 *   3. has usable backdrop (hasHeroBackdrop)
 *   4. passes the freshness gate (isFreshForHero)
 *   5. deduped by `type:id`
 *
 * Note: the adult classifier at the TMDB pool helper level
 * (filterAdultFromListPage in tmdb.ts) runs BEFORE this selector —
 * so `raw` here is already post-classifier. To diagnose a
 * classifier-empty pool, log inside getTmdbHeroMoviePool /
 * getTmdbHeroSeriesPool.
 */
function buildEligiblePool<T extends HeroCandidate>(
  items: T[],
  streamingIds: Set<string>,
  activeSeriesIds: Set<string>,
  bucket: number,
  now: number
): PoolStats {
  const seen = new Set<string>();
  const out: ScoredCandidate[] = [];
  let postFreshness = 0;
  let postBackdrop = 0;
  for (const item of items) {
    if (isAdultTagged(item)) continue;
    if (hasHeroBackdrop(item)) postBackdrop += 1;
    else continue;
    if (isFreshForHero(item, activeSeriesIds, now)) postFreshness += 1;
    else continue;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      item,
      score: scoreHeroCandidate(item, streamingIds, activeSeriesIds, now),
      rankKey: stableHash(`${bucket}:${item.id}`)
    });
  }
  // Sort: score DESC (best first), then deterministic hash ASC.
  out.sort((a, b) => (b.score - a.score) || (a.rankKey - b.rankKey));
  return {
    raw: items.length,
    postFreshness,
    postBackdrop,
    eligible: out.length,
    pool: out
  };
}

/**
 * CONTROLLED DAILY ROTATION.
 *
 * Given an eligible pool (sorted by score DESC) and a slot count,
 * return the `slotCount` candidates to use for this bucket. The
 * rotation happens WITHIN the top RELEVANCE_WINDOW_SIZE candidates
 * (we never pick below the relevance window — quality preserved).
 *
 * Same bucket → same offset → same lineup.
 * Different bucket → different offset (when window > slotCount) →
 * potentially different lineup.
 *
 * If the pool is smaller than slotCount, return what we have (the
 * caller handles a short lineup — never inserts stale content to
 * fill).
 */
function pickWithTypeRotation<T extends HeroCandidate>(
  pool: ScoredCandidate[],
  bucket: number,
  slotCount: number
): T[] {
  if (pool.length === 0) return [];
  if (pool.length <= slotCount) {
    // Not enough depth to rotate — return all eligible candidates.
    return pool.map(s => s.item as T);
  }
  // Take the top RELEVANCE_WINDOW_SIZE by score (already sorted).
  const windowSize = Math.min(RELEVANCE_WINDOW_SIZE, pool.length);
  const window = pool.slice(0, windowSize);
  if (window.length <= slotCount) {
    return window.map(s => s.item as T);
  }
  // Daily rotation: offset within [0, window.length - slotCount].
  // Different buckets produce different offsets → different lineups,
  // all from the top RELEVANCE_WINDOW_SIZE.
  const maxOffset = window.length - slotCount;
  const offset = bucket % (maxOffset + 1);
  return window.slice(offset, offset + slotCount).map(s => s.item as T);
}

/**
 * Compute the human-readable `reason` for a thin/empty lineup, from
 * the per-stage pool stats. Lets production logs distinguish:
 *   - 'source-empty'         — raw pools were empty (TMDB failure)
 *   - 'freshness-rejected'   — all candidates failed the freshness gate
 *   - 'backdrop-rejected'    — all candidates failed the backdrop gate
 *   - 'pool-thin'            — enough eligible candidates but < 6 total
 *   - 'ok'                   — full 6-slot lineup
 */
function diagnoseReason(
  movieStats: PoolStats,
  seriesStats: PoolStats,
  lineupLength: number
): HeroDiagnostics['reason'] {
  if (lineupLength >= HERO_LINEUP_SIZE) return 'ok';
  const rawTotal = movieStats.raw + seriesStats.raw;
  if (rawTotal === 0) return 'source-empty';
  // If we have eligible candidates but the lineup is still short,
  // it's because the eligible counts in one or both pools are below
  // HERO_SLOTS_PER_TYPE — call that 'pool-thin'.
  if (movieStats.eligible > 0 || seriesStats.eligible > 0) {
    // Eligible exists but lineup is short → at least one type is
    // below HERO_SLOTS_PER_TYPE.
    if (movieStats.eligible < HERO_SLOTS_PER_TYPE || seriesStats.eligible < HERO_SLOTS_PER_TYPE) {
      return 'pool-thin';
    }
    // Both pools have >= 3 eligible but lineup is short — shouldn't
    // happen, classify as pool-thin for safety.
    return 'pool-thin';
  }
  // No eligible candidates at all → either freshness or backdrop
  // rejected everything.
  // If postBackdrop > 0 but postFreshness === 0 → freshness gate.
  if (movieStats.postBackdrop > 0 || seriesStats.postBackdrop > 0) {
    if (movieStats.postFreshness === 0 && seriesStats.postFreshness === 0) {
      return 'freshness-rejected';
    }
  }
  // Otherwise backdrop rejected everything.
  return 'backdrop-rejected';
}

/**
 * The canonical Hero lineup selector. Contract:
 *
 *   - Returns up to 6 candidates in STRICT M/S/M/S/M/S order.
 *   - When enough eligible candidates exist (>=3 movies AND >=3
 *     series), the lineup is exactly 6 in M/S/M/S/M/S order.
 *   - When one type is thin, the lineup is shorter (NO stale
 *     fallback, NO cross-pool fill — the contract forbids it).
 *   - All candidates pass HARD eligibility gates:
 *       movies: release_date within [now-30d, now+7d]
 *       series: in activeSeriesIds (airing_today/on_the_air) OR
 *               first_air_date within 30 days
 *     Popularity is a ranking signal AFTER eligibility, NOT a
 *     substitute.
 *   - Within one lineup: no duplicate content IDs.
 *   - Across daily buckets: controlled rotation within the
 *     RELEVANCE_WINDOW_SIZE — different buckets CAN produce
 *     different lineups when the pool has depth.
 *   - Same bucket → same lineup (deterministic).
 *   - NO Math.random() at runtime.
 *
 * Anime items (isAnime === true, type 'movie' or 'series') are
 * treated as their canonical type — anime movies count as Movie
 * slots, anime series count as Series slots.
 *
 * Generic in <T> so callers passing MediaItem[] or
 * NormalizedMediaItem[] get back the SAME type.
 */
export function selectHeroLineup<T extends HeroCandidate = HeroCandidate>(
  movies: T[],
  series: T[],
  streamingIds: Set<string>,
  activeSeriesIds: Set<string>,
  bucket: number,
  now: number = Date.now()
): HeroLineupResult<T> {
  const movieStats = buildEligiblePool(movies, streamingIds, activeSeriesIds, bucket, now);
  const seriesStats = buildEligiblePool(series, streamingIds, activeSeriesIds, bucket, now);

  // Controlled rotation — pick the slots-per-type candidates from
  // the top RELEVANCE_WINDOW_SIZE within each pool.
  const movieSlots = pickWithTypeRotation<T>(movieStats.pool, bucket, HERO_SLOTS_PER_TYPE);
  const seriesSlots = pickWithTypeRotation<T>(seriesStats.pool, bucket, HERO_SLOTS_PER_TYPE);

  // Interleave in strict M/S/M/S/M/S order. If one type has fewer
  // than HERO_SLOTS_PER_TYPE candidates, we just produce a shorter
  // lineup — the contract forbids cross-pool fallback.
  const lineup: T[] = [];
  for (let i = 0; i < HERO_SLOTS_PER_TYPE; i++) {
    if (i < movieSlots.length) lineup.push(movieSlots[i]);
    if (i < seriesSlots.length) lineup.push(seriesSlots[i]);
  }

  const reason = diagnoseReason(movieStats, seriesStats, lineup.length);

  const diagnostics: HeroDiagnostics = {
    rawMovies: movies.length,
    rawSeries: series.length,
    postFreshnessMovies: movieStats.postFreshness,
    postFreshnessSeries: seriesStats.postFreshness,
    postBackdropMovies: movieStats.postBackdrop,
    postBackdropSeries: seriesStats.postBackdrop,
    eligibleMovies: movieStats.eligible,
    eligibleSeries: seriesStats.eligible,
    finalMovies: lineup.filter(i => i.type === 'movie').length,
    finalSeries: lineup.filter(i => i.type === 'series').length,
    lineupLength: lineup.length,
    bucket,
    reason
  };

  return { lineup, diagnostics };
}

/**
 * Validity check for the long-lived Hero cache. The caller passes
 * this to getOrSetValidated to enforce: an empty lineup must NEVER
 * be cached for the 24h Hero TTL — the next request must recompute.
 *
 * A lineup of length >= 1 is considered valid (cacheable): it's a
 * real (if thin) lineup. The diagnostic `reason` field surfaces thin
 * pools via console.warn so the underlying issue can be investigated
 * without freezing the Hero as "Featured title unavailable" for 24h.
 */
export function isHeroLineupCacheable<T extends HeroCandidate>(result: HeroLineupResult<T>): boolean {
  return result.lineup.length >= MIN_LINEUP_TO_CACHE;
}

// ============================================================
// Streaming-id batch helper (kept for backward compat — the v1 API
// exposed this; v2 still uses it inside discover-load.ts).
// ============================================================
export function buildStreamingIdSet(items: HeroCandidate[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    const tmdbId = item.externalIds?.tmdb ?? item.id.replace(/^(movie|series|anime)-/, '');
    if (tmdbId) out.add(tmdbId);
  }
  return out;
}

export type { NormalizedMediaItem };
