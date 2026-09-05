import type { PlayerSource } from '$lib/shared/player';
import { DIRECT_PLAYBACK_CAPABILITIES, type ProviderPlaybackCapabilities } from './capabilities';
import type { AdapterLoadContext, CommandResult, PlayerEvent, PlayerEventHandler, PlayerProviderAdapter } from './events';

/**
 * Direct (HTML5 `<video>`) adapter — Phase 1 + Phase 3.
 *
 * Wraps the existing `<video>` event flow. PlayerViewport dispatches
 * `loadedmetadata`/`timeupdate`/`play`/`pause`/`waiting`/`playing`/`seeking`/
 * `seeked`/`ended`/`error` via Svelte's `createEventDispatcher`; PlayerShell
 * forwards them to the manager via `dispatchViewportEvent()`, which calls
 * `adapter.emit()`.
 *
 * Phase 3 extends this adapter with command methods (play, pause, seek,
 * getCurrentTime, getDuration, setVolume) that operate on the bound
 * HTMLVideoElement. The adapter does NOT own the `<video>` element —
 * PlayerViewport owns the `bind:this` ref — but it CAN issue commands
 * because the element reference is passed in `load(context)`.
 *
 * Lifecycle:
 *   - `load(context)` wires the bound `videoElement` reference.
 *   - `destroy()` clears the bound reference and the handler. The video
 *     element's own listeners are removed when PlayerViewport unmounts the
 *     `<video>` tag (Svelte handles that — `{#key iframeKey}` / source change
 *     remounts it).
 *   - Late events after `destroy()` are dropped by the `destroyed` flag.
 */
export class DirectPlayerAdapter implements PlayerProviderAdapter {
  protected videoElement: HTMLVideoElement | undefined;
  protected handler: PlayerEventHandler | undefined;
  protected startPosition: number | undefined;
  protected destroyed = false;

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
   * Emit a normalized event to the registered handler. Called by the
   * PlaybackManager's `dispatchViewportEvent()` when the underlying
   * `<video>` element fires one of its DOM events (forwarded by PlayerShell).
   * Late events after `destroy()` are dropped.
   */
  emit(event: PlayerEvent): void {
    if (this.destroyed) return;
    this.handler?.(event);
  }

  /**
   * Apply the start position to the bound video element. Called by PlayerShell
   * on `loadedmetadata` (where `videoElement.duration` becomes available)
   * to seek to `pendingSeek = initialProgress`.
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

  // ----- Phase 3: command methods -----

  async play(): Promise<CommandResult> {
    if (this.destroyed || !this.videoElement) return { ok: false, reason: 'not-ready' };
    try {
      await this.videoElement.play();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : 'Playback could not be started.' };
    }
  }

  async pause(): Promise<CommandResult> {
    if (this.destroyed || !this.videoElement) return { ok: false, reason: 'not-ready' };
    try {
      this.videoElement.pause();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : 'Pause failed.' };
    }
  }

  async seek(seconds: number): Promise<CommandResult> {
    if (this.destroyed || !this.videoElement) return { ok: false, reason: 'not-ready' };
    if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, reason: 'provider-error', message: 'Invalid seek position.' };
    try {
      this.videoElement.currentTime = seconds;
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : 'Seek failed.' };
    }
  }

  async getCurrentTime(): Promise<CommandResult<number>> {
    if (this.destroyed || !this.videoElement) return { ok: false, reason: 'not-ready' };
    return { ok: true, value: this.videoElement.currentTime };
  }

  async getDuration(): Promise<CommandResult<number>> {
    if (this.destroyed || !this.videoElement) return { ok: false, reason: 'not-ready' };
    const duration = this.videoElement.duration;
    if (!Number.isFinite(duration)) return { ok: false, reason: 'not-ready', message: 'Duration not yet available.' };
    return { ok: true, value: duration };
  }

  async setVolume(volume: number): Promise<CommandResult> {
    if (this.destroyed || !this.videoElement) return { ok: false, reason: 'not-ready' };
    const clamped = Math.min(1, Math.max(0, volume));
    try {
      this.videoElement.volume = clamped;
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : 'Volume change failed.' };
    }
  }
}
