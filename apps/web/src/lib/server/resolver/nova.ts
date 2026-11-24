/**
 * VidPlay (NovaHD) resolver adapter — round 37.
 *
 * Calls the NovaHD API SERVER-SIDE ONLY (the API URL is never exposed to the
 * browser). Each returned stream URL is wrapped through the Cloudflare Worker
 * as ?e=<base64url(url)> so the real CDN URL never appears in plain text
 * client-side.
 *
 * API (server-side only):
 *   movie : https://novahd.cc/api/sources?type=movie&tmdbId=<id>
 *   series: https://novahd.cc/api/sources?type=show&tmdbId=<id>&season=<n>&episode=<m>
 *
 * Headers (mandatory — without them the API returns a DECOY playlist):
 *   accept: 'application/json, text/plain, [all media types]'
 *   origin: 'https://novahd.cc'
 *   referer: 'https://novahd.cc/watch/movie/<id>'
 *            (series: 'https://novahd.cc/watch/tv/<id>' — if the decoy comes
 *             back on the movie referer, one retry with the tv referer)
 *   user-agent: desktop Chrome UA
 *
 * Rate limit: 30 requests / ~293 s → do NOT retry aggressively (max 1 retry).
 *
 * DECOY / FAILURE DETECTION (treat as "no sources", log it):
 *   - body contains 's.ts?v=42043f85'  → decoy
 *   - JSON has no `sources` array, or a non-JSON body
 *
 * CODEC FILTER (this is the whole point of this source):
 *   - Keep only entries with type === 'hls' (drop type 'dash' and any .mpd URL;
 *     log how many dropped).
 *   - For each candidate (cap 10, concurrency 4, 6 s timeout each) fetch the
 *     manifest TEXT through the Worker and keep it ONLY if it contains 'avc1';
 *     drop if it has hev1/hvc1 and no avc1.
 *   - Cache the filtered result in memory 5 minutes, keyed by
 *     `${tmdbId}:${mediaType}:${season??0}:${episode??0}`.
 *
 * LABELS + QUALITY (no language field exists in this API):
 *   - label = a language if the payload ever provides one, else the `provider`
 *     (e.g. "Falcon"), else `name`.
 *   - quality = parse `\d{3,4}p` from `name` or from the manifest RESOLUTION →
 *     qualities[] per label.
 *   - Emit one server entry per distinct label:
 *     { url: best, label, server: 'VidPlay', language: label, qualities }.
 */

import type { ProviderAdapter, AdapterResult, ResolverContext } from './types';
import { env as publicEnv } from '$env/dynamic/public';

export const NOVA_ADAPTER_ID = 'vidplay';

const NOVA_API = 'https://novahd.cc/api/sources';
const MAX_SOURCES = 28;
const MAX_CANDIDATES = 10;
const CONCURRENCY = 4;
const MANIFEST_TIMEOUT_MS = 6_000;
const API_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface NovaSource {
  name?: string;
  url?: string;
  type?: string; // 'hls' | 'dash' | ...
  provider?: string;
  language?: string;
}

interface NovaPayload {
  sources?: NovaSource[];
}

interface ServerEntry {
  url: string;
  label: string;
  server: string;
  language: string;
  qualities: Array<{ label: string; url: string }>;
}

/** In-memory 5-minute cache keyed by `${tmdbId}:${mediaType}:${season??0}:${episode??0}`. */
interface CacheEntry {
  servers: ServerEntry[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/** Base64url-encode a UTF-8 string (for the ?e= Worker param). */
function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Wrap a URL through the Worker proxy using the opaque ?e= param. */
function proxyUrl(rawUrl: string, workerProxyUrl: string): string {
  const encoded = encodeBase64Url(rawUrl);
  return `${workerProxyUrl}/?e=${encoded}`;
}

/** Parse a resolution label like "720p" or "1080p" from a name string. */
function parseQualityLabel(name: string | undefined): string {
  if (!name) return 'Auto';
  const match = name.match(/(\d{3,4})p/i);
  return match ? `${match[1]}p` : 'Auto';
}

/** Determine the label for a source: language > provider > name. */
function sourceLabel(src: NovaSource): string {
  if (src.language && src.language.trim()) return src.language.trim();
  if (src.provider && src.provider.trim()) return src.provider.trim();
  if (src.name && src.name.trim()) return src.name.trim();
  return 'VidPlay';
}

/** Detect the NovaHD decoy playlist (the API returns this when headers are wrong). */
function isDecoy(text: string): boolean {
  return text.includes('s.ts?v=42043f85');
}

/**
 * Fetch a manifest through the Worker and check whether it contains 'avc1'.
 * Drops HEVC-only manifests (hev1/hvc1 without avc1). The whole point of this
 * source is serving avc1-only HLS to the hls.js VOD player (no DASH/HEVC).
 */
async function manifestHasAvc1(manifestUrl: string, workerProxyUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const proxied = proxyUrl(manifestUrl, workerProxyUrl);
    const response = await fetch(proxied, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.apple.mpegurl, application/x-mpegurl, text/plain, */*' },
    });
    if (!response.ok) return false;
    const text = await response.text();
    if (isDecoy(text)) return false;
    const hasAvc1 = text.includes('avc1');
    const hasHevc = text.includes('hev1') || text.includes('hvc1');
    return hasAvc1 || !hasHevc;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Run an async mapper over `items` with bounded concurrency. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await mapper(items[i]!);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Fetch the NovaHD API through the Worker. Returns the raw response text or
 * null on failure. The `referer` is one of '/watch/movie/<id>' or '/watch/tv/<id>'.
 */
async function fetchNovaApi(
  apiUrl: string,
  referer: string,
  workerProxyUrl: string
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const fetchUrl = proxyUrl(apiUrl, workerProxyUrl);
    const response = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://novahd.cc',
        referer,
        'user-agent': DESKTOP_UA,
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export const novaAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: NOVA_ADAPTER_ID,

  async resolve(context: ResolverContext): Promise<AdapterResult | null> {
    // IMPORTANT: Vite does NOT replace a dynamic `import.meta.env` OBJECT access
    // in the SSR bundle. Use `$env/dynamic/public` (same pattern as every other
    // adapter in this folder).
    const workerProxyUrl = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
    if (!workerProxyUrl) {
      console.warn('[vidplay] PUBLIC_STREAM_PROXY_URL missing — API call would be blocked');
      return null;
    }

    const rawId = context.content.id.replace(/^(movie|series|anime)-/, '');
    const mediaType = context.content.type;
    const season = context.request.season;
    const episode = context.request.episode;

    // Cache key — 5-minute in-memory cache to stay within the 30 req / 293 s
    // rate limit when the same episode is resolved repeatedly.
    const cacheKey = `${rawId}:${mediaType}:${season ?? 0}:${episode ?? 0}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.info('[vidplay] cache hit — servers:', cached.servers.length);
      if (cached.servers.length === 0) return null;
      return {
        type: 'direct',
        url: cached.servers[0]!.url,
        protocol: 'hls',
        metadata: { adapterId: NOVA_ADAPTER_ID, servers: cached.servers },
      };
    }

    // Build the API URL — server-side only.
    const apiUrl = new URL(NOVA_API);
    apiUrl.searchParams.set('type', mediaType === 'series' ? 'show' : 'movie');
    apiUrl.searchParams.set('tmdbId', rawId);
    if (mediaType === 'series' && season && episode) {
      apiUrl.searchParams.set('season', String(season));
      apiUrl.searchParams.set('episode', String(episode));
    }

    // The API requires a Referer that looks like the site's own watch page.
    // Movie referer first; if the decoy comes back, retry once with the TV
    // referer (max 1 retry — the rate limit is 30 req / ~293 s).
    const refererMovie = `https://novahd.cc/watch/movie/${rawId}`;
    const refererTv = `https://novahd.cc/watch/tv/${rawId}`;
    const primaryReferer = mediaType === 'series' ? refererTv : refererMovie;
    const fallbackReferer = mediaType === 'series' ? refererMovie : refererTv;

    let bodyText = await fetchNovaApi(apiUrl.toString(), primaryReferer, workerProxyUrl);
    if ((!bodyText || isDecoy(bodyText)) && bodyText !== null) {
      // Decoy on the primary referer — retry once with the fallback referer.
      console.warn('[vidplay] decoy on primary referer — retrying with fallback');
      bodyText = await fetchNovaApi(apiUrl.toString(), fallbackReferer, workerProxyUrl);
    }

    if (!bodyText) {
      console.warn('[vidplay] API returned no body');
      cache.set(cacheKey, { servers: [], expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }
    if (isDecoy(bodyText)) {
      console.warn('[vidplay] decoy or empty response — skipping');
      cache.set(cacheKey, { servers: [], expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }

    let payload: NovaPayload;
    try {
      payload = JSON.parse(bodyText) as NovaPayload;
    } catch {
      console.warn('[vidplay] non-JSON response — skipping');
      cache.set(cacheKey, { servers: [], expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }

    const rawSources = payload.sources ?? [];
    if (rawSources.length === 0) {
      console.warn('[vidplay] API returned no sources');
      cache.set(cacheKey, { servers: [], expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }

    // CODEC FILTER — keep only HLS entries (drop DASH / .mpd; the VOD player
    // is hls.js only). Log how many were dropped.
    const hlsCandidates = rawSources.filter((s) => {
      if (!s.url) return false;
      const type = (s.type ?? '').toLowerCase();
      if (type === 'dash') return false;
      if (s.url.includes('.mpd')) return false;
      return type === 'hls' || type === '' || s.url.includes('.m3u8');
    });
    const droppedCount = rawSources.length - hlsCandidates.length;
    if (droppedCount > 0) {
      console.info('[vidplay] dropped', droppedCount, 'non-HLS source(s)');
    }

    // Cap at MAX_CANDIDATES, then fetch each manifest through the Worker to
    // verify it contains 'avc1' (drop HEVC-only manifests).
    const candidates = hlsCandidates.slice(0, MAX_CANDIDATES);
    const avc1Flags = await mapWithConcurrency(candidates, CONCURRENCY, async (src) => ({
      src,
      hasAvc1: await manifestHasAvc1(src.url!, workerProxyUrl),
    }));
    const avc1Sources = avc1Flags.filter((r) => r.hasAvc1).map((r) => r.src);
    const hevcDropped = candidates.length - avc1Sources.length;
    if (hevcDropped > 0) {
      console.info('[vidplay] dropped', hevcDropped, 'HEVC-only manifest(s)');
    }

    // Group by label (language > provider > name): one server entry per label.
    const labelMap = new Map<string, { qualities: Array<{ label: string; url: string }> }>();
    for (const src of avc1Sources) {
      if (!src.url) continue;
      const label = sourceLabel(src);
      const qLabel = parseQualityLabel(src.name);
      const proxied = proxyUrl(src.url, workerProxyUrl);
      if (!labelMap.has(label)) {
        labelMap.set(label, { qualities: [] });
      }
      labelMap.get(label)!.qualities.push({ label: qLabel, url: proxied });
    }

    const servers: ServerEntry[] = [];
    for (const [label, group] of labelMap) {
      if (group.qualities.length === 0) continue;
      const best = group.qualities[0]!;
      servers.push({
        url: best.url,
        label,
        server: 'VidPlay',
        language: label,
        qualities: group.qualities,
      });
      if (servers.length >= MAX_SOURCES) break;
    }

    console.info('[vidplay] sources', rawSources.length,
      'hls', hlsCandidates.length, 'avc1', avc1Sources.length,
      'servers', servers.length);

    // Cache the result (including empty — avoids re-hitting the API within 5 min).
    cache.set(cacheKey, { servers, expiresAt: Date.now() + CACHE_TTL_MS });

    if (servers.length === 0) return null;

    return {
      type: 'direct',
      url: servers[0]!.url,
      protocol: 'hls',
      metadata: {
        adapterId: NOVA_ADAPTER_ID,
        servers,
      },
    };
  },
};
