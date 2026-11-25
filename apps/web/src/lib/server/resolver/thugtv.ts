/**
 * VidPlay (ThugTV) resolver adapter — round 38.
 *
 * Calls the ThugTV API SERVER-SIDE ONLY (the API URL is never exposed to
 * the browser). Each returned stream URL is wrapped through the Cloudflare
 * Worker as ?e=<base64url(url)> so the real CDN URL never appears in plain
 * text client-side.
 *
 * API (server-side only):
 *   movie: https://api.thugtv.online/api/stream/movie/<tmdbId>
 *   tv   : https://api.thugtv.online/api/stream/tv/<tmdbId>/<season>/<episode>
 *
 * Response (FLAT): { sources: [...], pending: boolean }. A NESTED
 * `{ data: { sources } }` shape is also tolerated (same defensive unwrap
 * as rivestream.ts).
 *
 * RELIABILITY — intermittent upstream 403 (2026-11, verified from Worker
 * telemetry): api.thugtv.online INTERMITTENTLY returns HTTP 403 to the
 * Cloudflare Worker — movie/1291608 got 403 at 17:33:38Z and 17:34:00Z,
 * movie/969681 at 17:56:25Z, and the SAME URLs through the SAME deployed
 * Worker returned HTTP 200 minutes later (not a hard block, not
 * title-specific). A single 403 must not drop the whole VidPlay group, so
 * the resolve runs a BOUNDED retry loop: up to 3 attempts (backoff 500ms
 * after attempt 1, 1200ms after attempt 2, a fresh 10s AbortController
 * per attempt). Retried: a thrown fetch (network error / an abort that is
 * NOT our own timeout), HTTP 403/408/425/429/500/502/503/504, and
 * pending:true / empty sources. NOT retried: 404 and any other 4xx, our
 * own timeout abort (a hung upstream must not hold the composite resolve
 * for 3 × 10s), or a 200 whose body is not JSON (logged, then omitted).
 *
 * The payload carries ~12 sources, but EXACTLY ONE is a playable direct
 * stream: the "castle" entry (id 'server-direct-castle' on movies,
 * 'server-direct-castle-tv' on episodes) with qualityVariants[] +
 * audioStreams[] + subtitles[]. Every other entry is either type:"embed"
 * or a url:"" + resolvePath stub (MovieBox / Knight / vaplayer) that
 * cannot play as a direct stream — all dropped.
 *
 * SERVER LIST — URL-level dedupe with language priority:
 *   - every URL is normalised (trim + &amp; → &; the API HTML-escapes the
 *     query string and the escaped form breaks the CDN signature → 403).
 *   - a URL claimed by exactly ONE audio language is labelled with that
 *     language; a URL claimed by 0 or 2+ languages (an ambiguous
 *     multi-audio master) is labelled 'Citadel' (the castle server's own
 *     name), and same-labelled URLs merge into ONE row with several
 *     qualities.
 *   - HLS ONLY: .mpd (DASH) URLs are dropped — the VOD player is hls.js
 *     only. NO codec (avc1/hevc) probing: these are per-quality MEDIA
 *     playlists with no EXT-X-STREAM-INF/CODECS attribute, so there is
 *     nothing to inspect without downloading segments.
 *   - Subtitle URLs are returned RAW (not proxied) — same contract as the
 *     rivestream captions.
 */

import type { ProviderAdapter, AdapterResult, ResolverContext } from './types';
import { env as publicEnv } from '$env/dynamic/public';

export const THUGTV_ADAPTER_ID = 'thugtv';

const THUGTV_API = 'https://api.thugtv.online/api/stream';
const API_TIMEOUT_MS = 10_000;
/** Bounded retry — the upstream 403s intermittently (see header) and
 *  answers `pending: true` / empty sources on first hits. */
const MAX_ATTEMPTS = 3;
/** Backoff BETWEEN attempts: 500ms after attempt 1, 1200ms after attempt 2. */
const RETRY_BACKOFF_MS = [500, 1_200] as const;
/** Retriable statuses — the verified intermittent 403 plus the usual
 *  timeout / rate-limit / server classes. 404 and other 4xx are NOT retried. */
const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
/** Ambiguous multi-audio rows take the castle server's own name. */
const AMBIGUOUS_LABEL = 'Citadel';
const MAX_ROWS = 8;
const MAX_QUALITIES_PER_ROW = 6;

interface ThugTVVariant {
  label?: string;
  url?: string;
}

interface ThugTVAudioStream {
  lang?: string;
  label?: string;
  url?: string;
}

interface ThugTVSubtitle {
  lang?: string;
  label?: string;
  url?: string;
}

interface ThugTVSource {
  id?: string;
  name?: string;
  label?: string;
  url?: string;
  type?: string;
  quality?: string;
  resolvePath?: string;
  qualityVariants?: ThugTVVariant[];
  audioStreams?: ThugTVAudioStream[];
  subtitles?: ThugTVSubtitle[];
}

interface ThugTVPayload {
  sources?: ThugTVSource[];
  pending?: boolean;
  data?: { sources?: ThugTVSource[]; pending?: boolean };
}

interface ServerEntry {
  url: string;
  label: string;
  server: string;
  language?: string;
  qualities: Array<{ label: string; url: string }>;
}

/** Base64url-encode a UTF-8 string (for the ?e= Worker param).
 *  Matches the Worker's decodeBase64Url: base64 → replace + with -,
 *  / with _, strip = padding. Uses Node.js Buffer (server-side only).
 *  Local copy of the rivestream.ts helper — kept local on purpose. */
function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Wrap a CDN URL through the Worker proxy using the opaque ?e= param.
 *  Local copy of the rivestream.ts helper — kept local on purpose. */
function proxyUrl(rawUrl: string, workerProxyUrl: string): string {
  const encoded = encodeBase64Url(rawUrl);
  return `${workerProxyUrl}/?e=${encoded}`;
}

/** Normalise an API-provided URL: trim, and unescape &amp; → &. The API
 *  HTML-escapes the query string; leaving &amp; in place breaks the CDN
 *  signature and the media request returns 403. */
function normalizeUrl(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/&amp;/g, '&') : '';
}

/** Infer a resolution label from the URL path: ".../720/index_287.m3u8"
 *  → "720p", or ".../1280x720..." → "1280p". Returns null when the URL
 *  carries no resolution hint. */
function inferQualityFromUrl(url: string): string | null {
  const match = url.match(/(?:\/)(\d{3,4})p?\//) ?? url.match(/(\d{3,4})x\d{3,4}/);
  return match ? `${match[1]}p` : null;
}

/** True when the URL's path is a DASH manifest — dropped, the VOD player
 *  is hls.js only. */
function isDashUrl(url: string): boolean {
  return url.split('?')[0]!.includes('.mpd');
}

export const thugtvAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: THUGTV_ADAPTER_ID,

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
      // api.thugtv.online, which Cloudflare blocks — fail closed and
      // surface the misconfiguration so it shows up in the Netlify log.
      console.warn('[thugtv] PUBLIC_STREAM_PROXY_URL missing');
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
      apiUrl = new URL(`${THUGTV_API}/movie/${rawId}`);
    } else if (season && episode) {
      apiUrl = new URL(`${THUGTV_API}/tv/${rawId}/${season}/${episode}`);
    } else {
      // TV without season/episode has nothing to resolve — omit the
      // VidPlay group (never block the other groups).
      console.warn('[thugtv] tv resolve without season/episode — skipping', rawId);
      return null;
    }
    console.info('[thugtv] API URL', apiUrl.toString());

    // Fetch through the Worker proxy — BOUNDED retry loop (see header).
    // api.thugtv.online intermittently answers 403 to the Worker, and
    // first hits can answer `pending: true` or an empty `sources` list;
    // both classes are retried with backoff. 404 and other 4xx are not.
    let payload: ThugTVPayload | null = null;
    let lastStatus = 0;
    let lastContentType = '';
    let lastBodyHead = '';
    let attemptsMade = 0;
    let succeeded = false;
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
          // identify a Cloudflare challenge page in the Netlify log.
          const text = await response.text();
          lastBodyHead = text.slice(0, 200);
          console.warn('[thugtv] attempt', attempt, 'HTTP', response.status, 'body', lastBodyHead);
          outcome = RETRYABLE_STATUSES.has(response.status) ? 'retry' : 'fatal';
        } else {
          const text = await response.text();
          lastBodyHead = text.slice(0, 200);
          try {
            payload = JSON.parse(text) as ThugTVPayload;
          } catch {
            // Never fail silently — surface enough of the body to identify
            // an HTML challenge page / contract change in the Netlify log.
            console.warn('[thugtv] non-JSON response — HTTP', lastStatus, 'type', lastContentType, 'body', JSON.stringify(lastBodyHead));
            return null;
          }
        }
      } catch (error) {
        if (timedOut && (error as { name?: string } | null | undefined)?.name === 'AbortError') {
          // Our OWN 10s timeout — NOT retried: a hung upstream must not
          // hold the composite resolve for MAX_ATTEMPTS × 10s.
          console.warn('[thugtv] attempt', attempt, 'timed out after', API_TIMEOUT_MS, 'ms —', error instanceof Error ? error.message : String(error));
          outcome = 'fatal';
        } else {
          // Network error / an abort that is not our timeout — retryable.
          console.warn('[thugtv] attempt', attempt, 'fetch failed —', error instanceof Error ? error.message : String(error));
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
      // still pending or delivered no sources (first-hit behaviour).
      const probe = payload?.data ?? payload;
      const gotSources = Array.isArray(probe?.sources) && (probe?.sources?.length ?? 0) > 0;
      const isPending = probe?.pending === true || payload?.pending === true;
      if (gotSources && !isPending) {
        if (attempt > 1) console.info('[thugtv] sources arrived on attempt', attempt);
        succeeded = true;
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt - 1]!));
      }
    }

    if (!succeeded) {
      // Bounded give-up — exactly one summary line, then omit the VidPlay
      // group (never block the other groups, never throw).
      console.warn('[thugtv] API resolve failed after', attemptsMade, 'attempts — HTTP', lastStatus);
      return null;
    }

    // The API has been observed returning both a NESTED
    // `{ data: { sources } }` and a FLAT `{ sources }`. Unwrap either shape.
    const body = payload?.data ?? payload;
    const sources = body?.sources ?? [];

    // TAKE EXACTLY ONE SERVER: the castle direct-HLS entry (movie payloads
    // use id 'server-direct-castle', episode payloads append '-tv'). Every
    // other entry is an embed or a url:"" + resolvePath stub — dropped.
    const castle = sources.find((s) => s && (s.id === 'server-direct-castle' || s.id === 'server-direct-castle-tv'));
    console.info('[thugtv] castle filter — kept', castle ? 1 : 0, 'dropped', castle ? sources.length - 1 : sources.length, 'of', sources.length, 'sources');

    const rows: ServerEntry[] = [];
    let subtitles: Array<{ url: string; language: string; label: string; origin: string }> = [];
    if (castle) {
      // a. qualityVariants[] as {label, url} (order preserved).
      const qualityVariants: Array<{ label: string; url: string }> = [];
      for (const v of castle.qualityVariants ?? []) {
        const url = normalizeUrl(v?.url);
        if (!url) continue;
        qualityVariants.push({ label: (v?.label ?? '').trim() || 'Auto', url });
      }
      // b. audioStreams[] as {lang, label, url} (order preserved).
      const audioStreams: Array<{ lang: string; label: string; url: string }> = [];
      for (const a of castle.audioStreams ?? []) {
        const url = normalizeUrl(a?.url);
        if (!url) continue;
        audioStreams.push({ lang: (a?.lang ?? '').trim(), label: (a?.label ?? '').trim() || (a?.lang ?? '').trim(), url });
      }
      // d. url → language labels (audioStreams; `label` falls back to `lang`).
      const languagesByUrl = new Map<string, string[]>();
      for (const a of audioStreams) {
        if (!a.label) continue;
        const list = languagesByUrl.get(a.url) ?? [];
        list.push(a.label);
        languagesByUrl.set(a.url, list);
      }
      // e. url → quality label (qualityVariants).
      const qualityByUrl = new Map<string, string>();
      for (const v of qualityVariants) {
        if (!qualityByUrl.has(v.url)) qualityByUrl.set(v.url, v.label);
      }
      // f. Walk the union of URLs, first-seen order (qualityVariants first,
      // then audioStreams). DASH (.mpd) URLs are dropped — the VOD player
      // is hls.js only. NO codec (avc1/hevc) probing is possible: these
      // are per-quality MEDIA playlists with no EXT-X-STREAM-INF/CODECS
      // attribute, so there is nothing to inspect without downloading
      // segments.
      const orderedUrls: string[] = [];
      const seenUrls = new Set<string>();
      for (const v of [...qualityVariants, ...audioStreams]) {
        if (seenUrls.has(v.url)) continue;
        seenUrls.add(v.url);
        if (isDashUrl(v.url)) continue;
        orderedUrls.push(v.url);
      }
      // g. Group by label → one row per label; qualities keep first-seen
      // order, identical URLs deduped inside a row.
      const rowsByLabel = new Map<string, Array<{ label: string; url: string }>>();
      for (const url of orderedUrls) {
        const languages = languagesByUrl.get(url) ?? [];
        const label = languages.length === 1 ? languages[0]! : AMBIGUOUS_LABEL;
        const qLabel = qualityByUrl.get(url) ?? inferQualityFromUrl(url) ?? castle.quality ?? 'Auto';
        let rowQualities = rowsByLabel.get(label);
        if (!rowQualities) {
          rowQualities = [];
          rowsByLabel.set(label, rowQualities);
        }
        if (!rowQualities.some((q) => q.url === url)) {
          rowQualities.push({ label: qLabel, url });
        }
      }
      // h. Cap at 8 rows / 6 qualities per row; EVERY url is proxied
      // through the Worker (row.url = the row's first quality).
      for (const [label, qualities] of rowsByLabel) {
        if (rows.length >= MAX_ROWS) break;
        const capped = qualities.slice(0, MAX_QUALITIES_PER_ROW);
        if (capped.length === 0) continue;
        rows.push({
          url: proxyUrl(capped[0]!.url, workerProxyUrl),
          label,
          server: 'VidPlay',
          language: label === AMBIGUOUS_LABEL ? undefined : label,
          qualities: capped.map((q) => ({ label: q.label, url: proxyUrl(q.url, workerProxyUrl) })),
        });
      }

      // Subtitles from the SAME castle entry. URLs stay RAW (not proxied) —
      // the same contract as the rivestream captions.
      subtitles = (castle.subtitles ?? [])
        .filter((s) => s && normalizeUrl(s.url))
        .map((s) => ({
          url: normalizeUrl(s.url),
          language: s.lang ?? s.label ?? 'Unknown',
          label: s.label ?? s.lang ?? 'Unknown',
          origin: 'vidplay',
        }));
    }

    console.info('[thugtv] sources', sources.length, 'castle', Boolean(castle), 'rows', rows.length, 'subs', subtitles.length);

    // No rows survived → omit the VidPlay group entirely (never block the
    // other groups).
    if (rows.length === 0) return null;

    return {
      type: 'direct',
      url: rows[0]!.url,
      protocol: 'hls',
      subtitles: subtitles.length > 0 ? subtitles : undefined,
      metadata: {
        adapterId: THUGTV_ADAPTER_ID,
        servers: rows,
      },
    };
  },
};
