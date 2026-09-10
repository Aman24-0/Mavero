import type { NormalizedStremioManifest } from './manifest-normalize';

/**
 * MAVERO Stremio manifest service — small bounded TTL cache (Phase 2).
 *
 * The repository's generic cache (`content/cache.ts`) has no bounded-memory
 * cap and lives in the content module, so the manifest service ships this
 * tiny dedicated cache instead (Phase 2 spec §12 allows a small server-side
 * TTL cache when it fits the architecture; a large caching system does NOT
 * belong in Phase 2).
 *
 * Properties required by spec §12:
 *   * server-only: lives in `$lib/server/streaming/stremio/`, never bundled
 *     for the client (SvelteKit blocks `$lib/server` imports from client code)
 *   * bounded lifetime: every entry carries a TTL (default 5 minutes)
 *   * bounded memory: at most `maxEntries` entries (default 32), each
 *     holding the SMALL NORMALIZED manifest — never raw response bytes
 *   * keyed by normalized manifest URL
 *   * never bypasses SSRF validation: entries can only be created by the
 *     secure fetcher, which validated the destination before storing; a hit
 *     performs no network I/O at all
 *   * addon configuration is admin-only and this cache is only reachable
 *     from server code, so it never leaks across users
 */

export const MANIFEST_CACHE_DEFAULT_TTL_MS = 5 * 60_000;
export const MANIFEST_CACHE_MAX_ENTRIES = 32;

type CacheEntry = {
  manifest: NormalizedStremioManifest;
  finalUrl: string;
  expiresAt: number;
};

export type ManifestCache = {
  get(key: string, now?: number): CacheEntry | undefined;
  set(key: string, value: NormalizedStremioManifest, finalUrl: string, now?: number): void;
  clear(): void;
  size(): number;
};

export type ManifestCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
};

export function createManifestCache(options: ManifestCacheOptions = {}): ManifestCache {
  const ttlMs = options.ttlMs ?? MANIFEST_CACHE_DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? MANIFEST_CACHE_MAX_ENTRIES;
  const entries = new Map<string, CacheEntry>();

  return {
    get(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now) {
        entries.delete(key);
        return undefined;
      }
      // Refresh insertion order so repeated hits keep hot entries alive.
      entries.delete(key);
      entries.set(key, entry);
      return { ...entry, manifest: { ...entry.manifest } };
    },
    set(key, manifest, finalUrl, now = Date.now()) {
      entries.delete(key);
      entries.set(key, { manifest: { ...manifest }, finalUrl, expiresAt: now + ttlMs });
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

/** Normalized cache key: canonical URL serialization (host lowercased by URL). */
export function manifestCacheKey(rawUrl: string): string {
  return new URL(rawUrl.trim()).toString();
}

/** Module-level default instance for future metadata-display flows. */
export const defaultManifestCache = createManifestCache();
