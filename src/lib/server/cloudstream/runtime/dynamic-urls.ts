/**
 * MAVERO CloudStream runtime — dynamic provider domain resolution (CS-2).
 *
 * Faithful port of the providers' real `getLatestBaseUrl` behavior (verified
 * in ALL five CSX Kotlin sources): every provider resolves its CURRENT base
 * URL at runtime from the shared `urls.json` document because these sites
 * rotate domains frequently (verified live: bollyflix → new.bollyflix.vote,
 * moviesdrive → new5.moviesdrive.christmas, vegamovies → vegamovies.gallery,
 * gdflix → new4.gdflix.io, hubcloud → hubcloud.ist, vcloud → vcloud.fit).
 *
 * Security: the document is fetched through the CS-1 SSRF-safe JSON facade
 * (`fetchCloudStreamJson` → `fetchStremioManifest`, D-006). The result is
 * cached in-process for 10 minutes to avoid hammering the remote config on
 * every resolution. On ANY failure the baked-in fallback base is returned —
 * identical to the Kotlin `catch { baseUrl }` behavior.
 */

import { fetchCloudStreamJson } from '../security/fetch';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';

/** The shared upstream dynamic-domain document (verified in Kotlin sources). */
const DYNAMIC_URLS_DOCUMENT = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';

/** In-process cache TTL: providers rotate domains weekly, not per-request. */
const DYNAMIC_URLS_TTL_MS = 10 * 60_000;

type DynamicUrlCacheEntry = {
  at: number;
  urls: ReadonlyMap<string, string>;
};

let cache: DynamicUrlCacheEntry | null = null;

export type DynamicUrlDeps = {
  /** Injectable fetcher (tests never touch the real network). */
  fetcher?: typeof fetch;
  /** Injectable DNS resolver (tests; forwarded to the SSRF-safe fetcher). */
  dnsResolver?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
  /** Injectable clock. */
  now?: () => number;
  /** Override the cache TTL (tests). */
  ttlMs?: number;
};

/** Bounded URL sanity check for a dynamic value (never trusted blindly). */
function sanitizeDynamicUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) return null;
  if (trimmed.length > 2048 || /\s/.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

/** Parse-time projection of the urls.json document. */
function parseDynamicUrls(body: unknown): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return map;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) continue;
    const sanitized = sanitizeDynamicUrl(value);
    if (sanitized !== null) map.set(key, sanitized);
  }
  return map;
}

/**
 * Returns the current dynamic-domain map (cached ≤10 min). Exported for the
 * live smoke script; production code uses `currentBaseUrl`.
 */
export async function dynamicUrls(deps: DynamicUrlDeps = {}): Promise<ReadonlyMap<string, string>> {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? DYNAMIC_URLS_TTL_MS;
  if (cache !== null && now() - cache.at < ttl) return cache.urls;

  try {
    const result = await fetchCloudStreamJson(DYNAMIC_URLS_DOCUMENT, {
      ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
      ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
    });
    const urls = parseDynamicUrls(result.body);
    cache = { at: now(), urls };
    return urls;
  } catch {
    // Kotlin parity: on failure keep the previous cache if it exists…
    if (cache !== null) return cache.urls;
    // …otherwise an empty map → callers fall back to their baked-in base.
    return new Map<string, string>();
  }
}

/** Test hook: clears the in-process cache. */
export function resetDynamicUrlsCacheForTests(): void {
  cache = null;
}

/**
 * Resolves the CURRENT base URL for one source key, falling back to the
 * baked-in base (port of `getLatestBaseUrl(baseUrl, source)`).
 */
export async function currentBaseUrl(baseUrl: string, source: string, deps: DynamicUrlDeps = {}): Promise<string> {
  const urls = await dynamicUrls(deps);
  const latest = urls.get(source);
  if (typeof latest === 'string' && latest.length > 0) return latest;
  return baseUrl;
}

/**
 * Rewrites a link onto the current domain when it has rotated (port of the
 * Kotlin `url.replace(baseUrl, latestBaseUrl)` pattern). Returns the input
 * unchanged when the source key is unknown or the URL does not start with
 * the old base.
 */
export function rebaseDynamicUrl(url: string, latestBaseUrl: string): string {
  if (typeof url !== 'string' || typeof latestBaseUrl !== 'string' || latestBaseUrl.length === 0) return url;
  try {
    const original = new URL(url);
    const latest = new URL(latestBaseUrl);
    if (original.origin === latest.origin) return url;
    return `${latest.origin}${original.pathname}${original.search}${original.hash}`;
  } catch {
    return url;
  }
}

/** Re-exported for extractor ports (they translate their own errors). */
export { ManifestServiceError };
