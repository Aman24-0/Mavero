import type { PlayerSource } from '$lib/shared/player';
import type { ProviderPlaybackCapabilities } from './capabilities';

/**
 * Normalized playback events that flow from a ProviderAdapter to the
 * PlaybackManager. Provider-specific adapters (VidSrc, VidLink, CineSrc,
 * VidY, VidAPI.qzz.io, Viduki, etc. — see the Phase 0 capability matrix)
 * translate their provider-specific postMessage payloads into this common
 * shape.
 *
 * The direct adapter dispatches these from the underlying HTMLVideoElement
 * events (forwarded by PlayerShell via `dispatchViewportEvent()`). Provider-
 * specific embed adapters dispatch these from their postMessage listeners.
 *
 * IMPORTANT: this union is the ONLY shape the PlaybackManager accepts from
 * adapters. Provider-specific JSON shapes are translated at the adapter
 * boundary, never inside the manager.
 */
export type PlayerEvent =
  | { type: 'load' }
  | { type: 'ready'; duration?: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'buffering'; value: boolean }
  | { type: 'timeupdate'; currentTime: number; duration?: number }
  | { type: 'duration'; duration: number }
  | { type: 'seeking' }
  | { type: 'seeked'; currentTime: number }
  | { type: 'ended' }
  | { type: 'error'; message?: string; code?: string }
  | { type: 'provider-error'; message: string; code?: string };

export type PlayerEventHandler = (event: PlayerEvent) => void;

export type AdapterLoadContext = {
  /** The resolved source the adapter should handle. */
  source: PlayerSource;
  /**
   * The HTMLVideoElement bound by PlayerViewport when the source is direct,
   * or `undefined` for embed sources.
   */
  videoElement?: HTMLVideoElement;
  /**
   * The start position (seconds) to seek to on `ready`. Adapters that
   * support `startAt` (per `getCapabilities().startAt`) should honor this;
   * adapters that do not support `startAt` should ignore it. The
   * PlaybackManager still tracks `pendingSeek` and applies it via the
   * direct adapter's video element binding for direct sources.
   */
  startPosition?: number;
};

/**
 * Phase 3: result of a command sent to an adapter. Commands are async
 * because provider adapters may need to post a message and await a
 * response (e.g. CineSrc's `cinesrc:response` for getters).
 *
 * - `ok: true` — the command was accepted by the adapter. For getters,
 *   `value` contains the result.
 * - `ok: false, reason: 'unsupported'` — the adapter does not support
 *   this command (capability check failed). The caller should NOT fake
 *   local state.
 * - `ok: false, reason: 'not-ready'` — the adapter is not yet loaded
 *   or has been destroyed.
 * - `ok: false, reason: 'provider-error'` — the command was sent but
 *   the provider returned an error or timed out.
 */
export type CommandResult<T = void> =
  | { ok: true; value?: T }
  | { ok: false; reason: 'unsupported' | 'not-ready' | 'provider-error'; message?: string };

/**
 * Player provider adapter contract.
 *
 * Phase 1 established the minimal lifecycle boundary (canHandle, load,
 * destroy, onEvent, getCapabilities). Phase 3 extends it with optional
 * command methods (play, pause, seek, getCurrentTime, getDuration,
 * setVolume) for adapters that support them.
 *
 * Rules:
 *   - `canHandle(source)` is a pure predicate. Adapters MUST NOT mutate state.
 *   - `load(context)` is async; it MAY register listeners (postMessage,
 *     video element events, timers). It MUST resolve once the adapter is
 *     ready to emit events (NOT once playback starts).
 *   - `destroy()` MUST remove every listener and clear every timer
 *     registered in `load()`. No late event may fire after `destroy()`
 *     returns.
 *   - `onEvent(handler)` registers a single handler and returns an
 *     unsubscribe function.
 *   - `getCapabilities()` is a pure getter — it returns the VERIFIED
 *     capability set for this adapter. UNKNOWN capabilities default to
 *     `false`.
 *
 * Phase 3 command rules:
 *   - Command methods are OPTIONAL. Adapters that do not support a command
 *     SHOULD NOT implement it (or should return `{ ok: false, reason:
 *     'unsupported' }`).
 *   - The PlaybackManager checks `getCapabilities()` before calling a
 *     command method. If the capability is `false`, the manager returns
 *     `{ ok: false, reason: 'unsupported' }` without calling the adapter.
 *   - Commands MUST NOT throw for normal unsupported operations — return
 *     a `CommandResult` instead.
 *   - Only CineSrc has VERIFIED bidirectional commands (play/pause/seek/
 *     setVolume/setMuted/setPlaybackRate/getCurrentTime/getDuration/
 *     getPaused via JSON-RPC). All other provider adapters are one-way
 *     event emitters — they report events but do not accept commands.
 */
export interface PlayerProviderAdapter {
  /** Pure predicate: does this adapter handle the resolved source? */
  canHandle(source: PlayerSource): boolean;

  /**
   * Initialize the adapter for a resolved source. May register listeners,
   * start timers, or open postMessage channels. MUST resolve once the
   * adapter is ready to emit events (not once playback begins).
   */
  load(context: AdapterLoadContext): Promise<void> | void;

  /**
   * Tear down the adapter session. MUST remove every listener and clear
   * every timer registered in `load()`. After `destroy()` returns, the
   * adapter MUST NOT invoke the event handler.
   */
  destroy?(): Promise<void> | void;

  /**
   * Register a single event handler. Returns an unsubscribe function.
   */
  onEvent?(handler: PlayerEventHandler): () => void;

  /**
   * Pure getter for the VERIFIED capability set of this adapter.
   */
  getCapabilities(): ProviderPlaybackCapabilities;

  // ----- Phase 3: optional command methods -----

  /** Command the provider to play. Only if capabilities.play === true. */
  play?(): Promise<CommandResult>;

  /** Command the provider to pause. Only if capabilities.pause === true. */
  pause?(): Promise<CommandResult>;

  /**
   * Command the provider to seek to `seconds`. Only if
   * capabilities.seek === true.
   */
  seek?(seconds: number): Promise<CommandResult>;

  /**
   * Get the current playback position in seconds. Only if
   * capabilities.currentTime === true.
   */
  getCurrentTime?(): Promise<CommandResult<number>>;

  /**
   * Get the total duration in seconds. Only if
   * capabilities.duration === true.
   */
  getDuration?(): Promise<CommandResult<number>>;

  /**
   * Set the playback volume (0.0–1.0). Only if
   * capabilities.volume === true.
   */
  setVolume?(volume: number): Promise<CommandResult>;
}
