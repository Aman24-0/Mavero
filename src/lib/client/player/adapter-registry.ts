import type { PlayerSource } from '$lib/shared/player';
import type { PlayerProviderAdapter } from './events';
import { DirectPlayerAdapter } from './direct-adapter';
import { EmbedPlayerAdapter } from './embed-adapter';

/**
 * Adapter registry — Phase 1.
 *
 * Holds the ordered list of `PlayerProviderAdapter` instances. The
 * PlaybackManager calls `pickAdapter(source)` to find the first adapter
 * whose `canHandle(source)` returns true.
 *
 * Phase 1 registers exactly two adapters in this order:
 *   1. `DirectPlayerAdapter` — handles `source.type === 'direct'`.
 *   2. `EmbedPlayerAdapter` — handles `source.type === 'embed'`.
 *
 * Phase 3 will insert provider-specific embed adapters (VidSrc, VidLink,
 * CineSrc, VidY, VidAPI.qzz.io, Viduki) AHEAD of the generic
 * `EmbedPlayerAdapter`. They will match by resolved source URL origin
 * (e.g. `https://cinesrc.st`, `https://vidlink.pro`).
 *
 * IMPORTANT: the registry is a plain array, not a service locator. There
 * is no DI container. The watch route constructs a single registry per
 * playback session and passes it to the PlaybackManager.
 */
export class PlayerAdapterRegistry {
  private adapters: PlayerProviderAdapter[] = [];

  constructor(adapters?: PlayerProviderAdapter[]) {
    if (adapters) this.adapters.push(...adapters);
  }

  register(adapter: PlayerProviderAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * Return the first adapter whose `canHandle(source)` returns true, or
   * `null` if none match. Order is registration order — Phase 3 will
   * register provider-specific adapters first so they take priority over
   * the generic embed adapter.
   */
  pickAdapter(source: PlayerSource): PlayerProviderAdapter | null {
    for (const adapter of this.adapters) {
      try {
        if (adapter.canHandle(source)) return adapter;
      } catch {
        // Adapters are untrusted extensions — a thrown predicate must not
        // crash the manager. Skip the failing adapter.
      }
    }
    return null;
  }

  /** Test helper: list all registered adapters. */
  list(): PlayerProviderAdapter[] {
    return [...this.adapters];
  }
}

/**
 * Build the default Phase 1 registry with the direct + generic embed
 * adapters. Phase 3 will add provider-specific adapters here.
 *
 * The registry is constructed PER PLAYBACK SESSION (per watch route mount)
 * so adapters do not share state across sessions.
 */
export function createDefaultAdapterRegistry(): PlayerAdapterRegistry {
  return new PlayerAdapterRegistry([new DirectPlayerAdapter(), new EmbedPlayerAdapter()]);
}
