import type { PlayerSource } from '$lib/shared/player';
import { DIRECT_PLAYBACK_CAPABILITIES, type ProviderPlaybackCapabilities } from './capabilities';
import type { AdapterLoadContext, PlayerEvent, PlayerEventHandler, PlayerProviderAdapter } from './events';

/**
 * Direct (HTML5 `<video>`) adapter — Phase 1.
 *
 * Wraps the existing `<video>` event flow. PlayerViewport already dispatches
 * `loadedmetadata`/`timeupdate`/`play`/`pause`/`waiting`/`playing`/`seeking`/
 * `seeked`/`ended`/`error` via Svelte's `createEventDispatcher`; PlayerShell
 * re-dispatches them to the manager by calling `adapter.emit()`.
 *
 * The adapter is intentionally a thin translator — it does NOT own the
 * `<video>` element (PlayerViewport still owns the bind:this ref via
 * `videoElement` prop) and it does NOT issue commands back to the video
 * element (PlayerShell still owns `videoElement.play()`/`pause()`/`seek()`
 * for Phase 1; Phase 3 will route commands through the adapter).
 *
 * Lifecycle:
 *   - `load(context)` wires the bound `videoElement` reference. The actual
 *     event listeners live in PlayerViewport's template (on:timeupdate etc.)
 *     and are forwarded by PlayerShell calling `adapter.emit(event)`.
 *   - `destroy()` clears the bound reference and the handler. The video
 *     element's own listeners are removed when PlayerViewport unmounts the
 *     `<video>` tag (Svelte handles that — `{#key iframeKey}` / source change
 *     remounts it).
 *
 * Phase 3 will extend this with `play`/`pause`/`seek` command methods when
 * the contract gains them.
 */
export class DirectPlayerAdapter implements PlayerProviderAdapter {
  private videoElement: HTMLVideoElement | undefined;
  private handler: PlayerEventHandler | undefined;
  private startPosition: number | undefined;
  private destroyed = false;

  canHandle(source: PlayerSource): boolean {
    return source.type === 'direct' && typeof source.url === 'string' && source.url.length > 0;
  }

  load(context: AdapterLoadContext): void {
    this.videoElement = context.videoElement;
    this.startPosition = context.startPosition;
    this.destroyed = false;
  }

  destroy(): void {
    this.destroyed = true;
    this.videoElement = undefined;
    this.handler = undefined;
    this.startPosition = undefined;
  }

  onEvent(handler: PlayerEventHandler): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  /**
   * Emit a normalized event to the registered handler. Called by PlayerShell
   * (or future adapter wiring) when the underlying `<video>` element fires
   * one of its DOM events. Late events after `destroy()` are dropped.
   */
  emit(event: PlayerEvent): void {
    if (this.destroyed) return;
    this.handler?.(event);
  }

  /**
   * Apply the start position to the bound video element. Called by PlayerShell
   * on `loadedmetadata` (where `videoElement.duration` becomes available)
   * to seek to `pendingSeek = initialProgress`. This preserves the existing
   * direct-source resume behaviour from Phase 0.
   *
   * Returns true if the seek was applied, false if the adapter was destroyed,
   * no video element is bound, or the position is out of range.
   */
  applyStartPosition(seconds: number, duration: number): boolean {
    if (this.destroyed || !this.videoElement) return false;
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    if (Number.isFinite(duration) && duration > 0 && seconds >= duration) return false;
    this.videoElement.currentTime = seconds;
    return true;
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return DIRECT_PLAYBACK_CAPABILITIES;
  }
}
