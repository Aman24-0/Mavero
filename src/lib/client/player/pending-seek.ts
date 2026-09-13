/**
 * Pending-seek controller (Phase 9 — GOAL 6, reliable HLS seeking).
 *
 * The previous one-shot behavior applied the resume/switch seek on
 * `loadedmetadata` and then UNCONDITIONALLY discarded it:
 *
 *   if (pendingSeek > 0 && pendingSeek < duration) { video.currentTime = … }
 *   pendingSeek = 0;   // ← lost even when the seek was NOT applied
 *
 * For HLS VOD that is unreliable: `loadedmetadata` can fire before the
 * final duration / seekable range is ready (long VODs, event playlists,
 * native HLS on Safari where `seekable` grows as segments arrive). The
 * seek was then either dropped entirely (restart from 00:00) or clamped
 * to a stale range.
 *
 * THIS module is a small, PURE state machine — no DOM, no timers:
 *
 *   * The pending seek is retained until the media element actually has a
 *     usable range: a `seekable` range that covers the target (the
 *     authoritative HLS signal) or, for plain MP4, a finite positive
 *     duration that covers it.
 *   * Application is retried from the media lifecycle (`loadedmetadata`,
 *     `durationchange`, `loadeddata`, `canplay`, `progress`) — never from
 *     timers, so there are no excessive timers and no infinite loops.
 *   * Retries are BOUNDED twice over: an attempt counter and a wall-clock
 *     window from capture. An unreachable target (e.g. a live-edge stream)
 *     expires cleanly instead of retrying forever.
 *   * Every capture is stamped with a monotonic token. A capture is only
 *     applied while it is still the CURRENT one, so a stale pending seek
 *     from a previous source/stream can never land on a newly selected one
 *     (source switches re-capture; failed loads cannot leak old targets).
 *
 * The PlayerShell owns the DOM: it feeds `readyState`/`duration`/`seekable`
 * snapshots in and applies the returned target to `video.currentTime`.
 * Being pure makes the exact lifecycle unit-testable (Phase 9 suite).
 */

/**
 * Small epsilon subtracted from a seekable range end. A range that ends
 * exactly AT the target is not safely seekable there (end-of-range
 * rounding); requiring target < end − ε avoids the clamp-to-start bug at
 * range edges.
 */
export const PENDING_SEEK_RANGE_EPSILON = 0.25;

/** Maximum failed application attempts before the pending seek expires. */
export const PENDING_SEEK_MAX_ATTEMPTS = 60;

/** Wall-clock window (ms) after capture beyond which the seek expires. */
export const PENDING_SEEK_WINDOW_MS = 15_000;

/**
 * Structural snapshot of the media element state used for one application
 * attempt. `seekable` mirrors the standard TimeRanges shape so the REAL
 * element can be passed through unmodified and tests can pass plain arrays.
 */
export type PendingSeekMedia = {
  readyState: number;
  duration: number;
  seekable: { length: number; start(index: number): number; end(index: number): number };
};

export type PendingSeekState = {
  /** Pending target in seconds; 0 = no pending seek. */
  position: number;
  /** Monotonic capture token; 0 = no pending seek. */
  token: number;
  /** Monotonic token counter (each capture takes ++nextToken). */
  nextToken: number;
  /** Date.now() of the capture (window expiry). */
  capturedAt: number;
  /** Failed application attempts since capture. */
  attempts: number;
};

export function createPendingSeek(initialPosition = 0, now = 0): PendingSeekState {
  const state: PendingSeekState = { position: 0, token: 0, nextToken: 0, capturedAt: 0, attempts: 0 };
  if (Number.isFinite(initialPosition) && initialPosition > 0) capturePendingSeek(state, initialPosition, now);
  return state;
}

/**
 * Capture (or re-capture) the pending seek target. Used on initial load,
 * on source switches (preserve-position across sources) and on stream/
 * quality switches. Every capture invalidates any previous pending seek —
 * the new token supersedes it, which is exactly what makes a stale seek
 * from a previous source inapplicable.
 */
export function capturePendingSeek(state: PendingSeekState, position: number, now: number): void {
  if (!Number.isFinite(position) || position <= 0) {
    dropPendingSeek(state);
    return;
  }
  state.nextToken += 1;
  state.position = position;
  state.token = state.nextToken;
  state.capturedAt = now;
  state.attempts = 0;
}

/** Drop the pending seek entirely (no target is retained). */
export function dropPendingSeek(state: PendingSeekState): void {
  state.position = 0;
  state.token = 0;
  state.capturedAt = 0;
  state.attempts = 0;
}

/** True while a live (non-expired, non-exhausted) pending seek exists. */
export function hasPendingSeek(state: PendingSeekState, now: number): boolean {
  if (!state.token || state.position <= 0) return false;
  if (state.attempts >= PENDING_SEEK_MAX_ATTEMPTS) return false;
  return now - state.capturedAt <= PENDING_SEEK_WINDOW_MS;
}

/** True when the target lies within a usable range of the media snapshot. */
export function isSeekTargetApplicable(state: PendingSeekState, media: PendingSeekMedia): boolean {
  // HAVE_NOTHING — no metadata at all; nothing to reason about yet.
  if (!media || media.readyState <= 0) return false;
  const target = state.position;
  // 1) The authoritative HLS signal: a seekable range that covers the
  //    target. Works while `duration` is still Infinity/0 on long VODs.
  let hasRanges = false;
  for (let index = 0; index < media.seekable.length; index++) {
    hasRanges = true;
    if (target < media.seekable.end(index) - PENDING_SEEK_RANGE_EPSILON) return true;
  }
  if (hasRanges) return false;
  // 2) Plain MP4 fallback: a finite positive duration that covers the
  //    target (some engines report duration before seekable ranges).
  return Number.isFinite(media.duration) && media.duration > 0 && target < media.duration - PENDING_SEEK_RANGE_EPSILON;
}

/**
 * Attempt to apply the pending seek to the media snapshot. Returns the
 * applied target position when the seek should be written to
 * `video.currentTime` (and clears the pending state), `null` when the
 * media is not ready yet (the caller retries on the next lifecycle event;
 * each failed attempt bumps the bounded attempt counter and an expired
 * pending seek is dropped).
 */
export function applyPendingSeek(state: PendingSeekState, media: PendingSeekMedia, now: number): number | null {
  if (!hasPendingSeek(state, now)) {
    dropPendingSeek(state);
    return null;
  }
  if (!isSeekTargetApplicable(state, media)) {
    state.attempts += 1;
    if (state.attempts >= PENDING_SEEK_MAX_ATTEMPTS || now - state.capturedAt > PENDING_SEEK_WINDOW_MS) dropPendingSeek(state);
    return null;
  }
  const applied = state.position;
  dropPendingSeek(state);
  return applied;
}
