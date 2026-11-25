/**
 * VidStart (ThugTV media API) resolver adapter — round 41 (2026-11).
 *
 * FOURTH DirectStream server group (after Vidsrc, Vidstream/Rivestream and
 * VidPlay/ThugTV). Calls the ThugTV MEDIA host SERVER-SIDE ONLY — the API
 * URL is never exposed to the browser — and wraps the returned stream URL
 * through the Cloudflare Worker as ?e=<base64url(url)> so the real CDN URL
 * never appears in plain text client-side.
 *
 * API (server-side only, media.thugtv.st — NO Cloudflare challenge, plain
 * fetch works; still routed through the Worker so the browser only ever
 * talks to the Worker origin):
 *   movie: https://media.thugtv.st/api/stream/source/movie/<tmdbId>
 *   tv   : https://media.thugtv.st/api/stream/source/tv/<tmdbId>/<season>/<episode>
 *
 * Response: { status: "ready", catalogueUpdatedAt, source: { id, name,
 * label, type: "hls", format: "hls", url } } — `source.url` is a SINGLE HLS
 * MASTER playlist (…/direct-media.m3u8?ticket=…) that already carries the
 * quality variants (EXT-X-STREAM-INF) and the audio renditions
 * (EXT-X-MEDIA). The ticket is minted per request.
 *
 * EXACTLY ONE server entry is returned — NO `qualities` array and NO
 * `language` field. hls.js builds the Quality and Audio menus from the
 * manifest itself; supplying a `qualities` array here would collapse the
 * Quality menu to a single item (the exact bug this adapter avoids).
 *
 * This API returns NO subtitles — the field is omitted entirely.
 *
 * RELIABILITY — same conventions as thugtv.ts (rounds 39-40):
 *   1. BOUNDED retry loop — up to 2 attempts (backoff 500ms after
 *      attempt 1, a fresh 10s AbortController per attempt). Retried: a
 *      thrown fetch (network error / an abort that is NOT our own
 *      timeout), HTTP 403/408/425/429/500/502/503/504, and a 200 whose
 *      body says `status !== 'ready'`. NOT retried: 404 and any other
 *      4xx, our own timeout abort (a hung upstream must not hold the
 *      composite resolve for 2 × 10s), or a 200 whose body is not JSON
 *      (logged, then omitted).
 *   2. SHORT-LIVED SUCCESS CACHE — a payload that yields the one server
 *      entry is cached for 60s, so a follow-up resolve of the same title /
 *      episode skips the network entirely. The ticket is minted per call,
 *      so a 60s window is safe. Failures are never cached.
 */

import type { ProviderAdapter, AdapterResult, ResolverContext } from './types';
import { env as publicEnv } from '$env/dynamic/public';

export const VIDSTART_ADAPTER_ID = 'vidstart';

const VIDSTART_API = 'https://media.thugtv.st/api/stream/source';
const API_TIMEOUT_MS = 10_000;
/** Bounded retry — 2 attempts keep the worst-case failure cost low
 *  (one retry + 500ms backoff), same tuning as thugtv.ts round 40. */
const MAX_ATTEMPTS = 2;
/** Backoff BETWEEN attempts: 500ms after attempt 1. */
const RETRY_BACKOFF_MS = [500] as const;
/** Short-lived SUCCESS cache — only payloads that yield the one server
 *  entry are cached, for 60s: the ticket is minted per call, so a 60s
 *  window is safe (the cached master URL stays playable). Failures are
 *  NEVER cached. */
const CACHE_TTL_MS = 60_000;
/** Cache cap — on write, entries older than the TTL are evicted first,
 *  then the OLDEST entries are dropped so the Map never exceeds this. */
const CACHE_MAX_ENTRIES = 50;
const payloadCache = new Map<string, { at: number; payload: VidStartPayload }>();
/** Retriable statuses — the usual timeout / rate-limit / server classes.
 *  404 and other 4xx are NOT retried. */
const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

interface VidStartSource {
  id?: string;
  name?: string;
  label?: string;
  type?: string;
  format?: string;
  url?: string;
}

interface VidStartPayload {
  status?: string;
  catalogueUpdatedAt?: string;
  source?: VidStartSource;
  /** Defensive nested unwrap — same convention as thugtv.ts/rivestream.ts. */
  data?: { status?: string; catalogueUpdatedAt?: string; source?: VidStartSource };
}

/** Base64url-encode a UTF-8 string (for the ?e= Worker param).
 *  Matches the Worker's decodeBase64Url: base64 → replace + with -,
 *  / with _, strip = padding. Uses Node.js Buffer (server-side only).
 *  Local copy of the thugtv.ts helper — kept local on purpose. */
function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Wrap a CDN URL through the Worker proxy using the opaque ?e= param.
 *  Local copy of the thugtv.ts helper — kept local on purpose. */
function proxyUrl(rawUrl: string, workerProxyUrl: string): string {
  const encoded = encodeBase64Url(rawUrl);
  return `${workerProxyUrl}/?e=${encoded}`;
}

/** Normalise an API-provided URL: trim, and unescape &amp; → & (same
 *  defensive normalisation as thugtv.ts — an escaped query string breaks
 *  CDN signatures). */
function normalizeUrl(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/&amp;/g, '&') : '';
}

/** True when the URL's path is a DASH manifest — dropped, the VOD player
 *  is hls.js only. */
function isDashUrl(url: string): boolean {
  return url.split('?')[0]!.includes('.mpd');
}

export const vidstartAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: VIDSTART_ADAPTER_ID,

  async resolve(context: ResolverContext): Promise<AdapterResult | null> {
    // IMPORTANT: Vite does NOT replace a dynamic `import.meta.env` OBJECT
    // access in the SSR bundle (only literal `import.meta.env.PUBLIC_FOO`
    // lookups are statically replaced). The `$env/dynamic/public` module
    // is the documented SvelteKit pattern for reading public env at
    // runtime and is what every other adapter in this folder uses
    // (see rivestream.ts — the import.meta.env bug already bit us once).
    const workerProxyUrl = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
    if (!workerProxyUrl) {
      // Without the Worker the API call would go straight from Netlify to
      // media.thugtv.st, breaking the CORS/origin contract — fail closed
      // and surface the misconfiguration so it shows up in the Netlify log.
      console.warn('[vidstart] PUBLIC_STREAM_PROXY_URL missing');
      return null;
    }

    // NormalizedMediaItem.id is the content ID (e.g. "movie-278" → strip prefix).
    const rawId = context.content.id.replace(/^(movie|series|anime)-/, '');
    const mediaType = context.content.type;
    const season = context.request.season;
    const episode = context.request.episode;

    // Build the API URL — server-side only.
    let apiUrl: URL;
    if (mediaType === 'movie') {
      apiUrl = new URL(`${VIDSTART_API}/movie/${rawId}`);
    } else if (season && episode) {
      apiUrl = new URL(`${VIDSTART_API}/tv/${rawId}/${season}/${episode}`);
    } else {
      // TV without season/episode has nothing to resolve — omit the
      // VidStart group (never block the other groups).
      console.warn('[vidstart] tv resolve without season/episode — skipping', rawId);
      return null;
    }
    console.info('[vidstart] API URL', apiUrl.toString());

    // Short-lived SUCCESS cache (60s TTL — see CACHE_TTL_MS): a fresh hit
    // skips the network ENTIRELY. Only the fetch is short-circuited — the
    // cached payload still flows through the SAME ready / https / .mpd
    // validation below, so the returned shape is unchanged. The entry is
    // NOT refreshed on a hit: the TTL runs from the NETWORK success,
    // keeping the served master URL well inside its ticket's lifetime.
    const cacheKey = `${mediaType}:${rawId}:${season ?? ''}:${episode ?? ''}`;
    const cached = payloadCache.get(cacheKey);

    // Fetch through the Worker proxy — BOUNDED retry loop (see header).
    // A 200 whose body says `status !== 'ready'` is retried (the upstream
    // prepares titles on demand); 404 and other 4xx are not.
    let payload: VidStartPayload | null = null;
    let lastStatus = 0;
    let lastContentType = '';
    let lastBodyHead = '';
    let attemptsMade = 0;
    let succeeded = false;
    let servedFromCache = false;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      console.info('[vidstart] cache hit', cacheKey);
      payload = cached.payload;
      succeeded = true;
      servedFromCache = true;
    } else {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attemptsMade = attempt;
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, API_TIMEOUT_MS);
        // How this attempt ended — decides retry vs give up.
        let outcome: 'ok' | 'retry' | 'fatal' = 'ok';
        try {
          const encoded = encodeBase64Url(apiUrl.toString());
          const fetchUrl = `${workerProxyUrl}/?e=${encoded}`;
          const response = await fetch(fetchUrl, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          });
          lastStatus = response.status;
          lastContentType = response.headers.get('content-type') ?? '';
          if (!response.ok) {
            // Read the body ONCE, truncated to 200 chars — enough to
            // identify an error page / contract change in the Netlify log.
            const text = await response.text();
            lastBodyHead = text.slice(0, 200);
            console.warn('[vidstart] attempt', attempt, 'HTTP', response.status, 'body', lastBodyHead);
            outcome = RETRYABLE_STATUSES.has(response.status) ? 'retry' : 'fatal';
          } else {
            const text = await response.text();
            lastBodyHead = text.slice(0, 200);
            try {
              payload = JSON.parse(text) as VidStartPayload;
            } catch {
              // Never fail silently — surface enough of the body to identify
              // an HTML error page / contract change in the Netlify log.
              console.warn('[vidstart] non-JSON response — HTTP', lastStatus, 'type', lastContentType, 'body', JSON.stringify(lastBodyHead));
              return null;
            }
          }
        } catch (error) {
          if (timedOut && (error as { name?: string } | null | undefined)?.name === 'AbortError') {
            // Our OWN 10s timeout — NOT retried: a hung upstream must not
            // hold the composite resolve for MAX_ATTEMPTS × 10s.
            console.warn('[vidstart] attempt', attempt, 'timed out after', API_TIMEOUT_MS, 'ms —', error instanceof Error ? error.message : String(error));
            outcome = 'fatal';
          } else {
            // Network error / an abort that is not our timeout — retryable.
            console.warn('[vidstart] attempt', attempt, 'fetch failed —', error instanceof Error ? error.message : String(error));
            outcome = 'retry';
          }
        } finally {
          clearTimeout(timeout);
        }
        if (outcome === 'fatal') break;
        if (outcome === 'retry') {
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt - 1]!));
          }
          continue;
        }
        // outcome === 'ok': a parsed JSON body. Retry while the upstream is
        // still preparing the title (status !== 'ready').
        const probe = payload?.data ?? payload;
        if (probe?.status === 'ready') {
          succeeded = true;
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt - 1]!));
        }
      }
    }

    if (!succeeded) {
      // Distinguish the two failure classes for the Netlify log: a parsed
      // 200 that never reached 'ready' falls through to the not-ready
      // check below (it carries the upstream's own status); anything else
      // is a network/HTTP failure — bounded give-up, exactly one summary
      // line, then omit the VidStart group (never block the other groups,
      // never throw).
      if (!(payload && lastStatus === 200)) {
        console.warn('[vidstart] API resolve failed after', attemptsMade, 'attempts — HTTP', lastStatus);
        return null;
      }
    }

    // The API has been observed returning both a NESTED `{ data: … }` and
    // a FLAT shape. Unwrap either shape, then require status === 'ready'.
    const body = payload?.data ?? payload;
    const status = body?.status;
    if (status !== 'ready') {
      console.warn('[vidstart] not ready — status', status ?? 'unknown');
      return null;
    }

    // Require a non-empty https source url (normalised: trim + &amp; → &).
    const sourceUrl = normalizeUrl(body?.source?.url);
    if (!sourceUrl || !sourceUrl.startsWith('https://')) {
      console.warn('[vidstart] ready but no https source url — dropping');
      return null;
    }
    // HLS ONLY: a .mpd (DASH) url is dropped — the VOD player is hls.js only.
    if (isDashUrl(sourceUrl)) {
      console.warn('[vidstart] dash (.mpd) source url — dropping');
      return null;
    }

    const sourceId = body?.source?.id;
    const label = body?.source?.name || body?.source?.label || 'VidStart';

    // Success → store in the short-lived cache. Failures never reach this
    // point (they return above), so they are never cached. Evict entries
    // older than the TTL, then enforce the cap by dropping the OLDEST
    // inserted entries (Map iteration order). A cache hit does NOT rewrite
    // the entry — `at` always marks the network success.
    if (!servedFromCache && payload) {
      const now = Date.now();
      for (const [staleKey, entry] of payloadCache) {
        if (now - entry.at >= CACHE_TTL_MS) payloadCache.delete(staleKey);
      }
      while (payloadCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = payloadCache.keys().next().value;
        if (oldestKey === undefined) break;
        payloadCache.delete(oldestKey);
      }
      payloadCache.set(cacheKey, { at: now, payload });
    }

    console.info('[vidstart] source', sourceId, 'label', label, 'status', status);

    // EXACTLY ONE server entry. DO NOT set `qualities` and DO NOT set
    // `language`: source.url is a SINGLE HLS master playlist that already
    // carries the quality variants (EXT-X-STREAM-INF) and audio renditions
    // (EXT-X-MEDIA) — hls.js builds the Quality and Audio menus from the
    // manifest. Supplying a `qualities` array here would collapse the
    // Quality menu to a single item — that is the bug to avoid.
    const entry = {
      url: proxyUrl(sourceUrl, workerProxyUrl),
      label,
      server: 'VidStart',
    };

    // This API returns NO subtitles — the field is omitted entirely.
    return {
      type: 'direct',
      url: entry.url,
      protocol: 'hls',
      metadata: {
        adapterId: VIDSTART_ADAPTER_ID,
        servers: [entry],
      },
    };
  },
};
