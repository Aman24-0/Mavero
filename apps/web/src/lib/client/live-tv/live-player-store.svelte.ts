// Live TV — global background player store (2026-10 round 5).
//
// A Svelte 5 reactive store that holds the LIVE TV playback session at the
// ROOT layout level so the player survives navigation away from /live-tv.
//
// ARCHITECTURE:
//   The /live-tv page creates the playback session (engine + video element +
//   channel metadata). When the user navigates away, the page hands its
//   session to this store. The root layout renders a floating mini-player
//   while the session is active AND the user is NOT on /live-tv. Returning
//   to /live-tv re-adopts the session (the page picks it back up).
//
// SECURITY: the store carries ONLY non-sensitive data — catalogue metadata
//   (channel id/name/category/logo), the HTMLVideoElement reference, and
//   the engine instance. NO signed URLs, NO resolver responses, NO tokens.
//   The engine owns the playback material; the store just holds the reference.
//
// LIFECYCLE:
//   1. /live-tv page creates session → calls setSession(channel, videoEl, engine)
//   2. User navigates away → the page's onDestroy does NOT destroy the engine;
//      the store keeps it alive. The root layout shows the mini-player.
//   3. User clicks the mini-player's Expand → navigates to /live-tv → the page
//      calls adoptSession() to take ownership back.
//   4. User clicks the mini-player's Close → calls clearSession() → the engine
//      is destroyed, the video element pauses + clears its src.

import type { LiveTvChannel } from './types';
import type { LiveTvPlaybackEngine } from './player';

export type LiveTvSession = {
  channel: LiveTvChannel;
  videoEl: HTMLVideoElement;
  engine: LiveTvPlaybackEngine | null;
};

let currentSession = $state<LiveTvSession | null>(null);

/** Whether a live TV session is active (the mini-player should render). */
export function hasLiveTvSession(): boolean {
  return currentSession !== null;
}

/** The current session (or null). Read by the root layout's mini-player. */
export function getLiveTvSession(): LiveTvSession | null {
  return currentSession;
}

/**
 * Store a live TV session so it survives navigation away from /live-tv.
 * Called by the /live-tv page when a channel starts playing. The page
 * retains ownership while it is mounted; the store is a fallback for when
 * the page unmounts.
 */
export function setLiveTvSession(channel: LiveTvChannel, videoEl: HTMLVideoElement, engine: LiveTvPlaybackEngine | null): void {
  currentSession = { channel, videoEl, engine };
}

/**
 * Update the engine reference on the existing session (the engine swaps on
 * channel switch / source switch, but the video element + channel persist).
 */
export function updateLiveTvSessionEngine(engine: LiveTvPlaybackEngine | null): void {
  if (currentSession) currentSession = { ...currentSession, engine };
}

/**
 * Update the channel metadata on the existing session (e.g. when the user
 * switches to a different channel while the mini-player is visible).
 */
export function updateLiveTvSessionChannel(channel: LiveTvChannel): void {
  if (currentSession) currentSession = { ...currentSession, channel };
}

/**
 * The /live-tv page calls this on mount to re-adopt a session that was left
 * running (the user navigated away and came back). The store transfers
 * ownership to the page; the mini-player hides.
 *
 * Returns the session (or null if none is active). The page wires the
 * video element + engine into its own state.
 */
export function adoptLiveTvSession(): LiveTvSession | null {
  const session = currentSession;
  // Don't clear the store yet — the page will call setLiveTvSession again
  // on the next channel selection. The store just stops rendering the
  // mini-player because the page is now mounted.
  return session;
}

/**
 * Clear the session entirely (the mini-player's Close button). Destroys the
 * engine, pauses + empties the video element, and drops the store reference.
 */
export function clearLiveTvSession(): void {
  const session = currentSession;
  if (!session) return;
  try {
    session.engine?.destroy();
  } catch { /* best-effort */ }
  try {
    session.videoEl.pause();
    session.videoEl.removeAttribute('src');
    session.videoEl.load();
  } catch { /* best-effort */ }
  currentSession = null;
}
