/**
 * VidFlix (stream.hls.lol mbox API) resolver adapter — round 42 (2026-11).
 *
 * FIFTH DirectStream server group (after Vidsrc, Vidstream/Rivestream,
 * VidPlay/ThugTV and VidStart/ThugTV media). Calls the mbox API
 * SERVER-SIDE ONLY through the Cloudflare Worker as ?e=<base64url(url)> —
 * the API URL is never exposed to the browser, and the per-track MPD URLs
 * are wrapped through the SAME Worker so the browser only ever talks to
 * the Worker origin.
 *
 * API (server-side only, stream.hls.lol):
 *   movie: https://stream.hls.lol/mbox?tmdbId=<id>&type=movie
 *   tv   : https://stream.hls.lol/mbox?tmdbId=<id>&type=tv&season=<s>&episode=<e>
 *
 * Response: { expiresAt, server, subtitles: [{url, lang, label}],
 *             tracks: [{ id, url, kind: "dash", quality, lang, mode }] }
 *
 * DESIGN (round 42):
 *   * Each `tracks[]` entry is a SEPARATE DASH (.mpd) manifest carrying its
 *     own audio. ONE ROW PER TRACK is exposed inside the VidFlix tab of the
 *     server sheet; the row label is the track's audio language
 *     (lang || mode || quality). Rows are deduped by that label (keep the
 *     first) and capped at 8. server = 'VidFlix', protocol = 'dash'.
 *   * The Quality menu ALWAYS comes from the MPD's real levels — NO
 *     `qualities` array is ever set (the VOD DASH engine (round 42) reads
 *     getVariantTracks() from the manifest). The .mpd tracks are NEVER
 *     dropped here.
 *   * Subtitles are .srt (not VTT). Each {url, lang, label} is mapped to
 *     the SAME-ORIGIN converting proxy /api/content/subtitles/vtt/proxy
 *     (strict cacdn.hakunaymatata.com host allowlist, SRT→VTT conversion,
 *     bounded fetch — see that route). Capped at 40 tracks.
 *   * No NEW audio-selector UI: VidStart's single-URL-multi-audio behaviour
 *     is untouched; for VidFlix the language choice IS the row choice.
 *
 * RELIABILITY — same conventions as thugtv.ts/vidstart.ts (rounds 39-41):
 *   1. BOUNDED retry loop — up to 2 attempts (backoff 500ms after
 *      attempt 1, a fresh 10s AbortController per attempt). Retried: a
 *      thrown fetch (network error / an abort that is NOT our own
 *      timeout), HTTP 403/408/425/429/500/502/503/504. NOT retried: 404
 *      and any other 4xx, our own timeout abort (a hung upstream must not
 *      hold the composite resolve for 2 × 10s), or a 200 whose body is
 *      not JSON (logged, then omitted). A 200 whose tracks array is empty
 *      is NOT retried — the title simply has no VidFlix tracks.
 *   2. SHORT-LIVED SUCCESS CACHE — a payload that yields at least one row
 *      is cached for 60s (the upstream mints per-request URLs with an
 *      expiresAt, so a 60s window is safe). Failures are never cached.
 */

import type { ProviderAdapter, AdapterResult, ResolverContext } from './types';
import { env as publicEnv } from '$env/dynamic/public';

export const VIDFLIX_ADAPTER_ID = 'vidflix';

const VIDFLIX_API = 'https://stream.hls.lol/mbox';
const API_TIMEOUT_MS = 10_000;
/** Bounded retry — 2 attempts keep the worst-case failure cost low
 *  (one retry + 500ms backoff), same tuning as thugtv.ts/vidstart.ts. */
const MAX_ATTEMPTS = 2;
/** Backoff BETWEEN attempts: 500ms after attempt 1. */
const RETRY_BACKOFF_MS = [500] as const;
/** Short-lived SUCCESS cache — only payloads that yield at least one row
 *  are cached, for 60s: the upstream mints per-request MPD URLs with an
 *  expiresAt, so a 60s window is safe (the cached URLs stay playable).
 *  Failures are NEVER cached. */
const CACHE_TTL_MS = 60_000;
/** Cache cap — on write, entries older than the TTL are evicted first,
 *  then the OLDEST entries are dropped so the Map never exceeds this. */
const CACHE_MAX_ENTRIES = 50;
/** Server rows cap (one row per audio language). */
const MAX_ROWS = 8;
/** Subtitle tracks cap. */
const MAX_SUBTITLES = 40;
const payloadCache = new Map<string, { at: number; payload: VidFlixPayload }>();
/** Retriable statuses — the usual timeout / rate-limit / server classes.
 *  404 and other 4xx are NOT retried. */
const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

interface VidFlixTrack {
  id?: string | number;
  url?: string;
  kind?: string;
  quality?: string;
  lang?: string;
  mode?: string;
}

interface VidFlixSubtitle {
  url?: string;
  lang?: string;
  label?: string;
}

interface VidFlixPayload {
  expiresAt?: string;
  server?: string;
  subtitles?: VidFlixSubtitle[];
  tracks?: VidFlixTrack[];
  /** Defensive nested unwrap — same convention as thugtv.ts/vidstart.ts. */
  data?: { expiresAt?: string; server?: string; subtitles?: VidFlixSubtitle[]; tracks?: VidFlixTrack[] };
}

/** Base64url-encode a UTF-8 string (for the ?e= Worker param and the
 *  subtitle proxy's ?u= param). Matches the Worker's decodeBase64Url:
 *  base64 → replace + with -, / with _, strip = padding. Uses Node.js
 *  Buffer (server-side only). Local copy of the vidstart.ts helper —
 *  kept local on purpose. */
function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Wrap a CDN URL through the Worker proxy using the opaque ?e= param.
 *  Local copy of the vidstart.ts helper — kept local on purpose. */
function proxyUrl(rawUrl: string, workerProxyUrl: string): string {
  const encoded = encodeBase64Url(rawUrl);
  return `${workerProxyUrl}/?e=${encoded}`;
}

/** Normalise an API-provided URL: trim, and unescape &amp; → & (same
 *  defensive normalisation as thugtv.ts/vidstart.ts — an escaped query
 *  string breaks CDN signatures). These tracks ARE .mpd — they are never
 *  dropped here. */
function normalizeUrl(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/&amp;/g, '&') : '';
}

export const vidflixAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: VIDFLIX_ADAPTER_ID,

  async resolve(context: ResolverContext): Promise<AdapterResult | null> {
    // IMPORTANT: Vite does NOT replace a dynamic `import.meta.env` OBJECT
    // access in the SSR bundle (only literal `import.meta.env.PUBLIC_FOO`
    // lookups are statically replaced). The `$env/dynamic/public` module
    // is the documented SvelteKit pattern for reading public env at
    // runtime and is what every other adapter in this folder uses.
    const workerProxyUrl = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
    if (!workerProxyUrl) {
      // Without the Worker the API call would go straight from Netlify to
      // stream.hls.lol and the browser could not fetch the MPDs (CORS) —
      // fail closed and surface the misconfiguration in the Netlify log.
      console.warn('[vidflix] PUBLIC_STREAM_PROXY_URL missing');
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
      apiUrl = new URL(`${VIDFLIX_API}?tmdbId=${rawId}&type=movie`);
    } else if (season && episode) {
      apiUrl = new URL(`${VIDFLIX_API}?tmdbId=${rawId}&type=tv&season=${season}&episode=${episode}`);
    } else {
      // TV without season/episode has nothing to resolve — omit the
      // VidFlix group (never block the other groups).
      console.warn('[vidflix] tv resolve without season/episode — skipping', rawId);
      return null;
    }
    console.info('[vidflix] API URL', apiUrl.toString());

    // Short-lived SUCCESS cache (60s TTL — see CACHE_TTL_MS): a fresh hit
    // skips the network ENTIRELY. Only the fetch is short-circuited — the
    // cached payload still flows through the SAME track/subtitle mapping
    // below, so the returned shape is unchanged. The entry is NOT
    // refreshed on a hit: the TTL runs from the NETWORK success, keeping
    // the served URLs well inside the upstream's expiresAt window.
    const cacheKey = `${mediaType}:${rawId}:${season ?? ''}:${episode ?? ''}`;
    const cached = payloadCache.get(cacheKey);

    // Fetch through the Worker proxy — BOUNDED retry loop (see header).
    let payload: VidFlixPayload | null = null;
    let lastStatus = 0;
    let lastContentType = '';
    let lastBodyHead = '';
    let attemptsMade = 0;
    let succeeded = false;
    let servedFromCache = false;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      console.info('[vidflix] cache hit', cacheKey);
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
            console.warn('[vidflix] attempt', attempt, 'HTTP', response.status, 'body', lastBodyHead);
            outcome = RETRYABLE_STATUSES.has(response.status) ? 'retry' : 'fatal';
          } else {
            const text = await response.text();
            lastBodyHead = text.slice(0, 200);
            try {
              payload = JSON.parse(text) as VidFlixPayload;
            } catch {
              // Never fail silently — surface enough of the body to identify
              // an HTML error page / contract change in the Netlify log.
              console.warn('[vidflix] non-JSON response — HTTP', lastStatus, 'type', lastContentType, 'body', JSON.stringify(lastBodyHead));
              return null;
            }
          }
        } catch (error) {
          if (timedOut && (error as { name?: string } | null | undefined)?.name === 'AbortError') {
            // Our OWN 10s timeout — NOT retried: a hung upstream must not
            // hold the composite resolve for MAX_ATTEMPTS × 10s.
            console.warn('[vidflix] attempt', attempt, 'timed out after', API_TIMEOUT_MS, 'ms —', error instanceof Error ? error.message : String(error));
            outcome = 'fatal';
          } else {
            // Network error / an abort that is not our timeout — retryable.
            console.warn('[vidflix] attempt', attempt, 'fetch failed —', error instanceof Error ? error.message : String(error));
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
        // outcome === 'ok': a parsed JSON body — done.
        succeeded = true;
        break;
      }
    }

    if (!succeeded) {
      // Bounded give-up, exactly one summary line, then omit the VidFlix
      // group (never block the other groups, never throw).
      console.warn('[vidflix] API resolve failed after', attemptsMade, 'attempts — HTTP', lastStatus);
      return null;
    }

    // The API has been observed returning both a NESTED `{ data: … }` and
    // a FLAT shape. Unwrap either shape.
    const body = payload?.data ?? payload;
    const tracks = Array.isArray(body?.tracks) ? body!.tracks! : [];

    // ONE ROW PER TRACK (deduped by the audio-language label, keep the
    // first), capped at MAX_ROWS. Each row carries its own MPD URL
    // (Worker-proxied), protocol 'dash' and NO qualities — the VOD DASH
    // engine reads the MPD's real levels for the Quality menu.
    const rows: Array<{
      url: string;
      label: string;
      server: string;
      protocol: 'dash';
      qualities: undefined; // the VOD DASH engine reads the MPD levels — never a hand-built list
    }> = [];
    const seenLabels = new Set<string>();
    let usableTracks = 0;
    for (const track of tracks) {
      if (rows.length >= MAX_ROWS) break;
      const trackUrl = normalizeUrl(track?.url);
      if (!trackUrl || !trackUrl.startsWith('https://')) continue; // never invented
      usableTracks += 1;
      const label = (typeof track?.lang === 'string' && track.lang.trim())
        || (typeof track?.mode === 'string' && track.mode.trim())
        || (typeof track?.quality === 'string' && track.quality.trim())
        || 'VidFlix';
      if (seenLabels.has(label)) continue; // one row per audio language
      seenLabels.add(label);
      rows.push({
        url: proxyUrl(trackUrl, workerProxyUrl),
        label,
        server: 'VidFlix',
        protocol: 'dash',
        qualities: undefined, // the VOD DASH engine reads the MPD levels — never a hand-built list
      });
    }

    // Empty tracks → omit the VidFlix group entirely (never block the
    // other groups).
    if (rows.length === 0) {
      console.warn('[vidflix] no usable tracks — dropping (tracks', tracks.length, ')');
      return null;
    }

    // Subtitles: .srt files → the SAME-ORIGIN converting proxy (strict
    // cacdn.hakunaymatata.com allowlist + SRT→VTT conversion + bounded
    // fetch — see /api/content/subtitles/vtt/proxy). Capped at 40.
    const subs: Array<{ url: string; language: string; label: string; origin: string }> = [];
    for (const subtitle of Array.isArray(body?.subtitles) ? body!.subtitles! : []) {
      if (subs.length >= MAX_SUBTITLES) break;
      const rawUrl = normalizeUrl(subtitle?.url);
      if (!rawUrl || !rawUrl.startsWith('https://')) continue; // never invented
      const display = (typeof subtitle?.label === 'string' && subtitle.label.trim())
        || (typeof subtitle?.lang === 'string' && subtitle.lang.trim())
        || 'Unknown';
      subs.push({
        url: `/api/content/subtitles/vtt/proxy?u=${encodeBase64Url(rawUrl)}`,
        language: display,
        label: display,
        origin: 'vidflix',
      });
    }

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

    console.info('[vidflix] tracks', usableTracks, 'rows', rows.length, 'subs', subs.length);

    return {
      type: 'direct',
      url: rows[0]!.url,
      protocol: 'dash',
      ...(subs.length > 0 ? { subtitles: subs } : {}),
      metadata: {
        adapterId: VIDFLIX_ADAPTER_ID,
        servers: rows,
      },
    };
  },
};
