import type { PlayerSource } from '$lib/shared/player';
import type { PlayerProviderAdapter } from './events';
import { DirectPlayerAdapter } from './direct-adapter';
import { EmbedPlayerAdapter } from './embed-adapter';
import { VidSrcPlayerAdapter } from './providers/vidsrc-adapter';
import { VidLinkPlayerAdapter } from './providers/vidlink-adapter';
import { VidYPlayerAdapter } from './providers/vidy-adapter';
import { VidukiPlayerAdapter } from './providers/viduki-adapter';
import { CineSrcPlayerAdapter } from './providers/cinesrc-adapter';
import { VidApiQzzPlayerAdapter } from './providers/vidapi-qzz-adapter';
import { CinemaOSPlayerAdapter } from './providers/cinemaos-adapter';
import { VidPhantomPlayerAdapter } from './providers/vidphantom-adapter';
import { MegaPlayPlayerAdapter } from './providers/megaplay-adapter';

/**
 * Adapter registry — Phase 1 + Phase 3 + Phase 7F.
 *
 * Holds the ordered list of `PlayerProviderAdapter` instances. The
 * PlaybackManager calls `pickAdapter(source)` to find the first adapter
 * whose `canHandle(source)` returns true.
 *
 * Registration order:
 *   1. DirectPlayerAdapter — handles `source.type === 'direct'`.
 *   2. CineSrcPlayerAdapter — handles `https://cinesrc.st` (full bidirectional).
 *   3. VidSrcPlayerAdapter — handles `https://vidsrc.wiki`.
 *   4. VidLinkPlayerAdapter — handles `https://vidlink.pro`.
 *   5. VidYPlayerAdapter — handles `https://vidy.st` / `https://www.vidy.st`.
 *   6. VidukiPlayerAdapter — handles `https://www.viduki.net`.
 *   7. VidApiQzzPlayerAdapter — handles `https://vidapi.qzz.io`.
 *   8. CinemaOSPlayerAdapter — handles `https://cinemaos.tech` (skeleton).
 *   9. VidPhantomPlayerAdapter — handles `https://vidphantom.com` (skeleton).
 *  10. MegaPlayPlayerAdapter — handles `https://megaplay.buzz` (anime SUB/DUB).
 *  11. EmbedPlayerAdapter — generic fallback for all other embed sources.
 *
 * Provider-specific adapters are registered BEFORE the generic EmbedPlayerAdapter
 * so that `pickAdapter(source)` matches the provider-specific adapter first
 * (by URL origin). Sources whose URL origin does not match any provider-
 * specific adapter fall through to the generic EmbedPlayerAdapter (black-box
 * behavior — same as Phase 1).
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
   * `null` if none match. Order is registration order — provider-specific
   * adapters are registered first so they take priority over the generic
   * embed adapter.
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
 * Build the default Phase 3 + Phase 7F registry with the direct adapter,
 * all verified provider-specific embed adapters, and the generic embed
 * fallback.
 *
 * The registry is constructed PER PLAYBACK SESSION (per watch route mount)
 * so adapters do not share state across sessions.
 */
export function createDefaultAdapterRegistry(): PlayerAdapterRegistry {
  return new PlayerAdapterRegistry([
    new DirectPlayerAdapter(),
    // Provider-specific embed adapters (by URL origin, in priority order).
    // CineSrc first (full bidirectional — highest value).
    new CineSrcPlayerAdapter(),
    new VidSrcPlayerAdapter(),
    new VidLinkPlayerAdapter(),
    new VidYPlayerAdapter(),
    new VidukiPlayerAdapter(),
    new VidApiQzzPlayerAdapter(),
    // Skeleton adapters (exist but conservative — pending docs verification).
    new CinemaOSPlayerAdapter(),
    new VidPhantomPlayerAdapter(),
    // MegaPlay (anime-only SUB/DUB embed — Phase 7F).
    new MegaPlayPlayerAdapter(),
    // Generic fallback for all other embed sources (black-box).
    new EmbedPlayerAdapter(),
  ]);
}
