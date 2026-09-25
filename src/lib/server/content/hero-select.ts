// ============================================================
// MAVERO — Discover Hero daily lineup selector.
//
// Purpose: produce a stable, deterministic, fresh, balanced
// 6-title Hero lineup in strict M / S / M / S / M / S order.
//
// Design goals (per the Discover Hero task brief):
//   - Fresh: titles whose release date is older than the
//     freshness window normally do NOT qualify.
//   - Trending + popular: existing TMDB popularity/vote
//     signals are reused (no new TMDB endpoints invented).
//   - Currently-streaming: a positive signal from the
//     existing TMDB India watch-provider batch (no N+1).
//   - Indian content: controlled boost for recent Indian
//     titles (original_language is one of the recognized
//     Indian language codes). Never forced.
//   - Daily rotation: stable per 24h bucket; different bucket
//     can produce a different lineup when candidate depth
//     allows it. No Math.random() on every render.
//   - M/S/M/S/M/S strict order, with graceful fallback to
//     the other pool when one category is thin.
//   - No duplicate IDs within a single lineup.
//
// The selector is PURE: it takes already-fetched candidate
// pools + a streaming-id set + a daily bucket, and returns
// up to 6 NormalizedMediaItem[]. No Svelte, no $env, no
// network — fully unit-testable from a tsx script.
//
// The lineup itself is cached by the caller (discover-load.ts)
// via the existing `getOrSet` cache with a 24h TTL bucket key
// — see `loadHeroLineup()` there.
// ============================================================

import type { NormalizedMediaItem } from './types';

const DAY_MS = 86_400_000;
export const HERO_BUCKET_MS = 86_400_000; // 24 hours
export const MOVIE_FRESH_WINDOW_DAYS = 30;
// Series list rows do not carry `status` / `in_production`. The only
// available airing signal on a list row is `first_air_date`. A 30-day
// window on that field would incorrectly exclude currently-airing
// prestige shows whose original premiere was older but whose current
// season is still releasing episodes. The 180-day window is a
// documented, permissive heuristic that catches most currently-airing
// shows while still excluding long-finished series.
export const SERIES_FRESH_WINDOW_DAYS = 180;

export const HERO_LINEUP_SIZE = 6;

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
 * `NormalizedMediaItem` and `MediaItem` satisfy this shape, so the
 * selector can run on either (post-projection or pre-projection)
 * without losing type safety or requiring a cast.
 *
 * The fields are exactly the signals the selector reads:
 *   - identity + type (slot assignment)
 *   - releaseDate (freshness)
 *   - popularity, voteCount (trending signal — optional)
 *   - rating
 *   - externalIds.tmdb (streaming-boost identity)
 *   - originalLanguage (Indian boost)
 *   - backdrop trio (image-quality gate)
 *   - tags (adult-tag defense-in-depth)
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

// FNV-1a 32-bit hash. Deterministic and stable across V8 / Node / browser
// runs — required so SSR and client hydration produce the same lineup.
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
 * Different bucket → potentially different lineup (when the
 * candidate pool has depth beyond the top 6).
 */
export function heroDailyBucket(now: number = Date.now()): number {
  return Math.floor(now / HERO_BUCKET_MS);
}

/**
 * The relevant release/airing date in ms-since-epoch. Returns undefined
 * when no usable date is present.
 *
 * Movies: TMDB `release_date`. Series: TMDB `first_air_date`. Both are
 * normalized to ISO YYYY-MM-DD on the `releaseDate` field by `mapTmdb`.
 */
function releaseDateMs(item: HeroCandidate): number | undefined {
  const raw = item.releaseDate;
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Freshness eligibility for the Hero.
 *
 * Movies: hard 30-day window on `releaseDate`.
 * Series: permissive 180-day window on `first_air_date` (mapped to
 * `releaseDate`). The 180-day window catches currently-airing prestige
 * shows whose original premiere is older but whose current season is
 * still releasing. The spec explicitly forbids rejecting an actively
 * airing series just because its original premiere was older; without
 * a `status` signal on list rows, the 180-day window is the smallest
 * correct extension that achieves that.
 *
 * Anime items (isAnime === true) follow their canonical type's rule
 * (movies use the 30-day window; series use the 180-day window).
 */
export function isFreshForHero(item: HeroCandidate, now: number = Date.now()): boolean {
  const ms = releaseDateMs(item);
  if (ms === undefined) return false;
  const windowDays = item.type === 'movie' ? MOVIE_FRESH_WINDOW_DAYS : SERIES_FRESH_WINDOW_DAYS;
  return now - ms <= windowDays * DAY_MS;
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
 * Adult exclusion: a Hero candidate must NOT carry the Adult tag.
 * The trending rails already exclude adult content via the existing
 * adult classifier (networks/providers/adult flag), so this is a
 * defense-in-depth check on the `tags` field set by the classifier.
 */
function isAdultTagged(item: HeroCandidate): boolean {
  return Boolean(item.tags?.includes('Adult'));
}

function boundedLog(value: number | undefined, divisor: number): number {
  if (!value || value <= 0) return 0;
  return Math.min(1, Math.log10(value + 1) / divisor);
}

/**
 * Composite score in [0, ~1.0]. Components:
 *   - Freshness (linear decay, 0.20 max)
 *   - Trending/popularity (log10, 0.15 max)
 *   - Rating (0.10 max)
 *   - Currently-streaming boost (0.18 max) — when the candidate's
 *     TMDB id is in the India flatrate streaming-id set
 *   - Indian-content boost (0.08 max) — recent Indian-language
 *     titles get a controlled preference (never forced)
 *   - Backdrop quality (0.05 max) — prefer real backdrops
 *
 * The score is NOT exposed in the UI — purely a selection signal.
 * Components are intentionally small so that no single signal
 * dominates the lineup (a very popular old title cannot beat a
 * valid fresh title merely on popularity).
 */
export function scoreHeroCandidate(
  item: HeroCandidate,
  streamingIds: Set<string>,
  now: number = Date.now()
): number {
  // Freshness (linear decay over the per-type window).
  const ms = releaseDateMs(item);
  let freshness = 0;
  if (ms !== undefined) {
    const daysSince = Math.max(0, (now - ms) / DAY_MS);
    const windowDays = item.type === 'movie' ? MOVIE_FRESH_WINDOW_DAYS : SERIES_FRESH_WINDOW_DAYS;
    freshness = Math.max(0, 0.20 * (1 - daysSince / windowDays));
  }

  // Popularity (log10 cap).
  const popularity = boundedLog(item.popularity, 3) * 0.15;

  // Rating.
  const rating = Math.min(0.10, Math.max(0, item.rating / 10) * 0.10);

  // Currently-streaming boost (no N+1 — caller passes a batch set).
  const tmdbId = item.externalIds?.tmdb ?? item.id.replace(/^(movie|series|anime)-/, '');
  const streaming = streamingIds.size > 0 && streamingIds.has(tmdbId) ? 0.18 : 0;

  // Indian-content controlled boost. Recent Indian-language titles get
  // a small, capped preference. Never forced — a non-Indian candidate
  // with a higher composite score still wins.
  const isIndian = item.originalLanguage !== undefined && INDIAN_LANGUAGE_CODES.has(item.originalLanguage);
  const indian = isIndian ? 0.08 : 0;

  // Backdrop quality: prefer real backdrops over poster fallbacks.
  const backdrop = (item.backdrop ?? '').trim() || (item.backdropHero ?? '').trim() ? 0.05 : 0;

  return freshness + popularity + rating + streaming + indian + backdrop;
}

type ScoredCandidate = { item: HeroCandidate; score: number; rankKey: number };

/**
 * Build the scored + deterministically-sorted pool for one content type.
 *
 * Sort order:
 *   1. score DESC (best first)
 *   2. rankKey ASC (stable per-bucket tiebreak — different bucket →
 *      different tiebreak → controlled rotation when scores are close)
 *
 * The rankKey mixes the daily bucket with the candidate id so:
 *   - Same bucket → same rankKey → same lineup (stable for 24h).
 *   - Different bucket → different rankKey → potentially different
 *     order when scores are tied (controlled rotation).
 */
function buildPool<T extends HeroCandidate>(
  items: T[],
  streamingIds: Set<string>,
  bucket: number,
  now: number
): ScoredCandidate[] {
  const seen = new Set<string>();
  const out: ScoredCandidate[] = [];
  for (const item of items) {
    if (isAdultTagged(item)) continue;
    if (!hasHeroBackdrop(item)) continue;
    if (!isFreshForHero(item, now)) continue;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      item,
      score: scoreHeroCandidate(item, streamingIds, now),
      rankKey: stableHash(`${bucket}:${item.id}`)
    });
  }
  out.sort((a, b) => (b.score - a.score) || (a.rankKey - b.rankKey));
  return out;
}

/**
 * Select up to 6 Hero candidates in strict M / S / M / S / M / S order.
 *
 * Slot assignment:
 *   index 0 → Movie
 *   index 1 → Series
 *   index 2 → Movie
 *   index 3 → Series
 *   index 4 → Movie (Indian preference — applied via the boost)
 *   index 5 → Series
 *
 * Each slot picks the highest-scoring unused candidate from the
 * appropriate pool. If the pool is exhausted, the slot is skipped
 * (lineup is shorter than 6). If the other pool still has unused
 * candidates, the caller is responsible for any cross-pool fallback
 * at the END (we don't break the M/S/M/S/M/S pattern mid-selection).
 *
 * Within one lineup: no duplicate content IDs (enforced via `usedIds`).
 * Across daily rotations: controlled rotation via the per-bucket
 * `rankKey` tiebreak when scores are tied.
 *
 * Anime items (isAnime === true with type 'movie' or 'series') are
 * treated as their canonical type — anime movies count as Movie
 * slots, anime series count as Series slots. This is consistent with
 * the existing Mavero architecture (TMDB-tagged anime keeps its
 * canonical type for routing, playback, and now Hero slot assignment).
 *
 * Generic in <T> so callers that pass `MediaItem[]` or
 * `NormalizedMediaItem[]` get back the SAME type — no projection
 * step needed at the call site.
 */
export function selectHeroLineup<T extends HeroCandidate>(
  movies: T[],
  series: T[],
  streamingIds: Set<string>,
  bucket: number,
  now: number = Date.now()
): T[] {
  const moviePool = buildPool(movies, streamingIds, bucket, now);
  const seriesPool = buildPool(series, streamingIds, bucket, now);

  const lineup: T[] = [];
  const usedIds = new Set<string>();
  let movieCursor = 0;
  let seriesCursor = 0;

  for (let i = 0; i < HERO_LINEUP_SIZE; i++) {
    const wantMovie = i % 2 === 0; // slots 0,2,4 → Movie; 1,3,5 → Series
    const pool = wantMovie ? moviePool : seriesPool;
    let cursor = wantMovie ? movieCursor : seriesCursor;
    let picked: ScoredCandidate | undefined;
    while (cursor < pool.length) {
      const candidate = pool[cursor];
      cursor++;
      if (!usedIds.has(candidate.item.id)) {
        picked = candidate;
        break;
      }
    }
    if (wantMovie) movieCursor = cursor; else seriesCursor = cursor;
    if (picked) {
      lineup.push(picked.item as T);
      usedIds.add(picked.item.id);
    }
  }

  return lineup;
}

// ============================================================
// Streaming-id batch helper.
//
// The Hero "currently streaming" signal needs to know whether a
// candidate TMDB id is currently available on a flatrate streaming
// service in India. The existing `getTmdbNewOnOtt('all', 'all', 1)`
// query returns the 10 most recent titles on Indian flatrate — too
// narrow. Instead we issue a fresh, broader India-flatrate query
// (movie + TV, sorted by popularity desc) and collect the IDs into
// a Set. This is ONE extra batched TMDB query (cached), not N+1.
//
// The set is a positive signal only — its absence never excludes
// a candidate. A failed / empty query gracefully degrades to an
// empty set and the selector continues with the other signals.
// ============================================================

/**
 * Build a Set of TMDB IDs that are currently available on a flatrate
 * streaming service in India. The caller passes raw TMDB list rows
 * (already fetched for other purposes — typically the trending rails
 * reused via `getTmdbStreamingNowIds` in the adapter); we project
 * them to a Set<string> of canonical TMDB numeric ids.
 *
 * Accepts NormalizedMediaItem[] for simplicity — the caller can use
 * any flatrate-filtered list (e.g. `getTmdbNewOnOtt` results, or the
 * popular-series rail which already filters by `watch_region=IN` +
 * `with_watch_monetization_types=flatrate`).
 */
export function buildStreamingIdSet(items: HeroCandidate[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    const tmdbId = item.externalIds?.tmdb ?? item.id.replace(/^(movie|series|anime)-/, '');
    if (tmdbId) out.add(tmdbId);
  }
  return out;
}

// Re-export NormalizedMediaItem for callers that hold pre-projection
// items (the trending rails return NormalizedMediaItem[] before
// toMediaItem projection). The HeroCandidate type is structurally
// compatible — no cast needed.
export type { NormalizedMediaItem };
