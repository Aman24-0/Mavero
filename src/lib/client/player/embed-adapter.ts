import type { PlayerSource } from '$lib/shared/player';
import { EMBED_PLAYBACK_CAPABILITIES, type ProviderPlaybackCapabilities } from './capabilities';
import type { AdapterLoadContext, PlayerEvent, PlayerEventHandler, PlayerProviderAdapter } from './events';

/**
 * Generic embed (iframe) adapter — Phase 1.
 *
 * Wraps the existing `<iframe>` event flow. Per the Phase 0 capability
 * matrix, generic embed playback is a black box to Mavero — Mavero cannot
 * observe currentTime, duration, play/pause, seek, or ended from the
 * provider's player because:
 *
 *   - The iframe is cross-origin and Mavero never accesses its DOM.
 *   - Mavero registers no postMessage listeners except the existing
 *     Viduki `viduki:all-servers-failed` listener (which lives in the
 *     watch route, not in this adapter — Phase 3 will move it into a
 *     Viduki-specific adapter).
 *   - 16 of the 22 providers in the Phase 0 matrix have UNKNOWN
 *     postMessage capabilities.
 *
 * The only events this adapter emits are:
 *   - `load` — when the iframe finishes loading (`on:load` in PlayerViewport).
 *   - `provider-error` — currently never emitted in Phase 1 (Phase 3 will
 *     add provider-specific postMessage listeners that can signal errors,
 *     e.g. CineSrc's `cinesrc:error` event).
 *
 * Capabilities reflect this black-box state: only `fullscreen` is `true`
 * (because the iframe's `allowfullscreen` attribute is set, allowing the
 * provider's own player to enter fullscreen). Every other capability is
 * `false` until a provider-specific adapter (Phase 3) overrides it.
 *
 * Phase 3 will register provider-specific embed adapters (VidSrc, VidLink,
 * CineSrc, VidY, VidAPI.qzz.io, Viduki) ahead of this generic adapter in
 * the registry; `canHandle()` will match by source URL origin.
 */
export class EmbedPlayerAdapter implements PlayerProviderAdapter {
  private handler: PlayerEventHandler | undefined;
  private destroyed = false;

  canHandle(source: PlayerSource): boolean {
    return source.type === 'embed' && typeof source.url === 'string' && source.url.length > 0;
  }

  load(_context: AdapterLoadContext): void {
    this.destroyed = false;
    // No postMessage listener is registered here. The Viduki V1→V2 fallback
    // listener remains in the watch route for Phase 1 to preserve existing
    // behaviour exactly; Phase 3 will move it into a VidukiPlayerAdapter.
  }

  destroy(): void {
    this.destroyed = true;
    this.handler = undefined;
  }

  onEvent(handler: PlayerEventHandler): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  /**
   * Emit a normalized event to the registered handler. Called by PlayerShell
   * when the iframe fires `on:load` (translated to `{ type: 'load' }`).
   * Late events after `destroy()` are dropped.
   */
  emit(event: PlayerEvent): void {
    if (this.destroyed) return;
    this.handler?.(event);
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return EMBED_PLAYBACK_CAPABILITIES;
  }
}
