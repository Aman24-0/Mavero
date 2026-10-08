/**
 * Live TV player overlay state (LT-17, Issue 1).
 *
 * Single source of truth for WHICH native player overlay (loading /
 * connecting / tap-to-play / buffering / empty) may render on the
 * LiveTvPlayer surface. The component's template keeps the branch ORDER
 * (error → connecting → loading → tap-to-play → buffering → empty) and
 * asks this function whether each individual branch is allowed to show.
 *
 * THE INVARIANT (production Android QA, LT-17 brief):
 *   While the official embed fallback is mounted (`embedActive`), the
 *   iframe is the SOLE visible playback surface — NO native overlay of
 *   any kind may ever render over it. This is a STATE-LOGIC guarantee
 *   (every kind is false by construction when embedActive is true), not
 *   a stacking-order trick: nothing is "covered", it simply never
 *   renders. Before LT-17 the empty-state branch keyed off
 *   `!sessionEngaged`, which is exactly the state the fallback leaves
 *   behind (engine destroyed) — that is how "Select a channel to start
 *   watching." appeared over a playing embed.
 *
 * SSR-safe: a pure function, no browser access, importable under Node.
 */

import type { LiveTvPlaybackState } from './player';

/** The native overlay kinds the player surface can show (mutually
 *  exclusive through the template's ordered else-if chain). */
export type LiveTvOverlayKind =
  | 'error'
  | 'connecting'
  | 'loading'
  | 'tap-to-play'
  | 'buffering'
  | 'empty';

/** Inputs — all already-derived component state (no engine access). */
export type LiveTvOverlayState = {
  /** LT-15 embed fallback mounted (embedChannelId !== null). */
  embedActive: boolean;
  /** Safe-table failure message (already null while the embed is active). */
  sessionError: string | null;
  /** A channel's playback data is being resolved right now. */
  resolving: boolean;
  /** An engine instance exists for the session. */
  enginePresent: boolean;
  /** The engine's normalized state. */
  engineState: LiveTvPlaybackState;
  /** Autoplay was blocked (stream loaded; NOT a failure). */
  autoplayBlocked: boolean;
};

/**
 * Whether one overlay kind may render. `embedActive` is checked FIRST
 * and suppresses every native kind — the embed's own "Switching to
 * alternate player…" hint lives inside the embed block and is not a
 * native overlay.
 */
export function isLiveTvOverlayShown(
  kind: LiveTvOverlayKind,
  state: LiveTvOverlayState
): boolean {
  if (state.embedActive) return false;
  switch (kind) {
    case 'error':
      return state.sessionError !== null;
    case 'connecting':
      return state.resolving;
    case 'loading':
      return state.engineState === 'loading';
    case 'tap-to-play':
      return state.autoplayBlocked;
    case 'buffering':
      return state.engineState === 'buffering';
    case 'empty':
      // "Genuinely NO active channel/player session" (LT-17 invariant):
      // nothing is resolving (a resolving channel IS a selected session
      // starting), nothing has failed (the safe-message error UI owns
      // that state), and no engine session ever started or survives.
      // loaded/playing/paused/buffering/error engine states are engaged
      // sessions and can never show the empty message either.
      return (
        !state.resolving &&
        state.sessionError === null &&
        (!state.enginePresent ||
          state.engineState === 'idle' ||
          state.engineState === 'destroyed')
      );
  }
}
