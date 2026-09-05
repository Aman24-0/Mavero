import type { PlayerSource } from '$lib/shared/player';
import type { ProviderPlaybackCapabilities } from './capabilities';

/**
 * Normalized playback events that flow from a ProviderAdapter to the
 * PlaybackManager. Future provider-specific adapters (VidSrc, VidLink,
 * CineSrc, VidY, VidAPI.qzz.io, Viduki, etc. — see the Phase 0 capability
 * matrix) translate their provider-specific postMessage payloads into this
 * common shape.
 *
 * The Phase 1 direct adapter dispatches these from the underlying
 * HTMLVideoElement events. The Phase 1 generic embed adapter dispatches
 * only `load` and `provider-error` — embeds are treated as a black box
 * until a provider-specific adapter is registered (Phase 3).
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

/**
 * Phase 1 generic adapter contract.
 *
 * The contract is intentionally MINIMAL — only what Phase 1 needs to
 * establish the lifecycle boundary and event-normalization seam. Phase 3
 * will EXTEND this interface (add `play`, `pause`, `seek`, `getCurrentTime`,
 * `getDuration`, `applyStartPosition` etc.) when the first provider-specific
 * adapter (CineSrc, the only provider with VERIFIED bidirectional commands
 * per the Phase 0 matrix) is implemented.
 *
 * Phase 1 rules:
 *   - `canHandle(source)` is a pure predicate. Adapters MUST NOT mutate state.
 *   - `load(context)` is async; it MAY register listeners (postMessage,
 *     video element events, timers). It MUST resolve once the adapter is
 *     ready to emit events (NOT once playback starts).
 *   - `destroy()` MUST remove every listener and clear every timer
 *     registered in `load()`. No late event may fire after `destroy()`
 *     returns.
 *   - `onEvent(handler)` registers a single handler and returns an
 *     unsubscribe function. The handler will be invoked synchronously by
 *     the adapter on every playback event.
 *   - `getCapabilities()` is a pure getter — it returns the VERIFIED
 *     capability set for this adapter, derived from official provider docs.
 *     UNKNOWN capabilities default to `false`.
 *
 * Direct (HTML5 `<video>`) and generic embed (iframe) implementations live
 * alongside the manager as `DirectPlayerAdapter` and `EmbedPlayerAdapter`.
 * They are registered as the default adapter set in `adapter-registry.ts`.
 * Phase 3 will add provider-specific adapters that take priority when
 * `canHandle(source)` returns true.
 *
 * IMPORTANT: this contract does NOT yet expose play/pause/seek commands.
 * Those will be added in Phase 3 when the first provider-specific adapter
 * (CineSrc) is implemented, because CineSrc is the only provider with
 * VERIFIED bidirectional commands per the Phase 0 matrix.
 */
export interface PlayerProviderAdapter {
  /** Pure predicate: does this adapter handle the resolved source? */
  canHandle(source: PlayerSource): boolean;

  /**
   * Initialize the adapter for a resolved source. May register listeners,
   * start timers, or open postMessage channels. MUST resolve once the
   * adapter is ready to emit events (not once playback begins).
   *
   * The PlaybackManager guarantees `load()` is called at most once per
   * adapter session and is always followed by `destroy()` before the
   * session is replaced.
   */
  load(context: AdapterLoadContext): Promise<void> | void;

  /**
   * Tear down the adapter session. MUST remove every listener and clear
   * every timer registered in `load()`. After `destroy()` returns, the
   * adapter MUST NOT invoke the event handler.
   *
   * This is the only place where adapter-side cleanup happens. The
   * PlaybackManager calls it on every source switch, episode change,
   * and route unmount.
   */
  destroy?(): Promise<void> | void;

  /**
   * Register a single event handler. Returns an unsubscribe function.
   * The handler is invoked synchronously for every normalized PlayerEvent.
   */
  onEvent?(handler: PlayerEventHandler): () => void;

  /**
   * Pure getter for the VERIFIED capability set of this adapter.
   * UNKNOWN capabilities default to `false`. Phase 3 populates these
   * per-provider from the Phase 0 capability matrix.
   */
  getCapabilities(): ProviderPlaybackCapabilities;
}

export type PlayerEventHandler = (event: PlayerEvent) => void;

export type AdapterLoadContext = {
  /** The resolved source the adapter should handle. */
  source: PlayerSource;
  /**
   * The HTMLVideoElement bound by PlayerViewport when the source is direct,
   * or `undefined` for embed sources. Phase 3 may extend this with an
   * `iframe` ref when provider-specific embed adapters are added.
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
