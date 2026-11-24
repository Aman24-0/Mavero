/**
 * Rivestream resolver adapter — "Vidstream" source (round 36).
 *
 * Calls the Rivestream scrapper API SERVER-SIDE ONLY (the API URL is never
 * exposed to the browser). Each returned stream URL is wrapped through the
 * Cloudflare Worker as ?e=<base64url(url)> so the real CDN URL never appears
 * in plain text client-side.
 *
 * Response (NESTED, the shape actually observed in production):
 *           { data: { sources: [{ quality, url, source, format }],
 *                     captions: [{ file, label, language, type: "vtt" }] } }
 *           A FLAT `{ sources, captions }` shape is also tolerated.
 *
 * Sources are grouped by language (parsed from the quality field after "|").
 * Each language group carries its qualities [{label:"720p",url},{label:"480p",url}].
 */

import type { ProviderAdapter, AdapterResult, ResolverContext } from './types';
import { env as publicEnv } from '$env/dynamic/public';

export const RIVESTREAM_ADAPTER_ID = 'rivestream';

const RIVESTREAM_API = 'https://scrapper.rivestream.app/api/provider';
const RIVESTREAM_PROVIDER = 'citadel';
const MAX_SOURCES = 28;

interface RivestreamSource {
  quality?: string;
  url?: string;
  source?: string;
  format?: string;
}

interface RivestreamCaption {
  file?: string;
  label?: string;
  language?: string;
  type?: string;
}

/**
 * The Rivestream scrapper API has been observed returning TWO response
 * shapes — the same endpoint sometimes returns a NESTED payload
 * `{ data: { sources, captions } }` and sometimes a FLAT payload
 * `{ sources, captions }`. The previous code only parsed the flat shape,
 * so whenever the API returned the nested shape both `sources` and
 * `captions` were `undefined`, the adapter hit the silent
 * `rawSources.length === 0` return, and the Vidstream group was always 0.
 *
 * `RivestreamPayload` types BOTH shapes; `body = payload.data ?? payload`
 * unwraps whichever one the API returned this time.
 */
interface RivestreamPayload {
  data?: { sources?: RivestreamSource[]; captions?: RivestreamCaption[] };
  sources?: RivestreamSource[];
  captions?: RivestreamCaption[];
}

interface ServerEntry {
  url: string;
  label: string;
  server: string;
  language: string;
  qualities: Array<{ label: string; url: string }>;
}

/** Base64url-encode a UTF-8 string (for the ?e= Worker param).
 *  Matches the Worker's decodeBase64Url: base64 → replace + with -,
 *  / with _, strip = padding. Uses Node.js Buffer (server-side only). */
function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Wrap a CDN URL through the Worker proxy using the opaque ?e= param. */
function proxyUrl(rawUrl: string, workerProxyUrl: string | undefined): string {
  if (!workerProxyUrl) return rawUrl; // dev fallback — no proxy
  const encoded = encodeBase64Url(rawUrl);
  const base = workerProxyUrl.endsWith('/') ? workerProxyUrl.slice(0, -1) : workerProxyUrl;
  return `${base}/?e=${encoded}`;
}

/** Parse the language from a quality string like "720p | Hindi" → "Hindi". */
function parseLanguage(quality: string | undefined): string {
  if (!quality) return 'Unknown';
  const parts = quality.split('|');
  if (parts.length >= 2) return parts.slice(1).join('|').trim();
  return 'Unknown';
}

/** Parse the resolution label from a quality string like "720p | Hindi" → "720p". */
function parseQualityLabel(quality: string | undefined): string {
  if (!quality) return 'Auto';
  const parts = quality.split('|');
  return parts[0].trim();
}

export const rivestreamAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: RIVESTREAM_ADAPTER_ID,

  async resolve(context: ResolverContext): Promise<AdapterResult | null> {
    // IMPORTANT: Vite does NOT replace a dynamic `import.meta.env` OBJECT access
    // in the SSR bundle (only literal `import.meta.env.PUBLIC_FOO` lookups are
    // statically replaced). The previous `(import.meta as ...).env?.PUBLIC_STREAM_PROXY_URL`
    // pattern therefore always evaluated to `undefined` in the Netlify SSR
    // bundle, the API was fetched directly, Cloudflare blocked it, and the
    // Vidstream group silently disappeared. The `$env/dynamic/public` module
    // is the documented SvelteKit pattern for reading public env at runtime
    // and is what every other adapter in this folder uses.
    const workerProxyUrl = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
    if (!workerProxyUrl) {
      // Without the Worker the API call would go straight from Netlify to
      // scrapper.rivestream.app, which Cloudflare blocks — fail closed and
      // surface the misconfiguration so it shows up in the Netlify log.
      console.warn('[rivestream] PUBLIC_STREAM_PROXY_URL missing — API call would be blocked');
      return null;
    }

    // NormalizedMediaItem.id is the content ID (e.g. "movie-278" → strip prefix).
    const rawId = context.content.id.replace(/^(movie|series|anime)-/, '');
    const mediaType = context.content.type;
    const season = context.request.season;
    const episode = context.request.episode;

    // Build the API URL — server-side only.
    const apiUrl = new URL(RIVESTREAM_API);
    apiUrl.searchParams.set('provider', RIVESTREAM_PROVIDER);
    apiUrl.searchParams.set('id', rawId);
    if (mediaType === 'series' && season && episode) {
      apiUrl.searchParams.set('season', String(season));
      apiUrl.searchParams.set('episode', String(episode));
    }

    let payload: RivestreamPayload;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        // Route through the Worker proxy so the API call is not blocked
        // by Netlify's egress (same class of failure as vidsrc). The
        // Worker proxies the request and returns the JSON response.
        const encoded = encodeBase64Url(apiUrl.toString());
        const fetchUrl = `${workerProxyUrl}/?e=${encoded}`;
        const response = await fetch(fetchUrl, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          console.warn('[rivestream] API resolve failed — HTTP', response.status);
          return null;
        }
        payload = (await response.json()) as RivestreamPayload;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      // If the resolve fails / returns nothing → omit the Vidstream group
      // entirely (never block Vidsrc). Log the failure so it's visible.
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[rivestream] API resolve failed —', msg);
      return null;
    }

    // The API has been observed returning both a NESTED
    // `{ data: { sources, captions } }` and a FLAT `{ sources, captions }`.
    // Unwrap either shape; never fail silently on an empty result.
    const body = payload.data ?? payload;
    const rawSources = body.sources ?? [];
    const rawCaptions = body.captions ?? [];
    if (rawSources.length === 0) {
      console.warn('[rivestream] API returned no sources', {
        keys: Object.keys(payload ?? {}),
        bodyKeys: Object.keys(body ?? {}),
      });
      return null;
    }

    // Group by language: one entry per language.
    const langMap = new Map<string, { qualities: Array<{ label: string; url: string }> }>();
    for (const src of rawSources) {
      if (!src.url) continue;
      const lang = parseLanguage(src.quality);
      const qLabel = parseQualityLabel(src.quality);
      const proxied = proxyUrl(src.url, workerProxyUrl);
      if (!langMap.has(lang)) {
        langMap.set(lang, { qualities: [] });
      }
      langMap.get(lang)!.qualities.push({ label: qLabel, url: proxied });
    }

    // Build the server entries — one per language.
    const servers: ServerEntry[] = [];
    for (const [lang, group] of langMap) {
      if (group.qualities.length === 0) continue;
      // Best quality = first entry (API returns highest first).
      const best = group.qualities[0];
      servers.push({
        url: best.url,
        label: lang,
        server: 'Vidstream',
        language: lang,
        qualities: group.qualities,
      });
      if (servers.length >= MAX_SOURCES) break;
    }

    if (servers.length === 0) return null;

    // Map captions to SubtitleSource — tagged with origin: 'vidstream'
    // so the subtitle menu can group them under a "Vidstream" source.
    const subtitles = rawCaptions
      .filter((c) => c.file && c.type === 'vtt')
      .map((c) => ({
        url: c.file!,
        language: c.language ?? c.label ?? 'Unknown',
        label: c.label ?? c.language ?? 'Unknown',
        origin: 'vidstream',
      }));

    return {
      type: 'direct',
      url: servers[0].url,
      protocol: 'hls',
      subtitles: subtitles.length > 0 ? subtitles : undefined,
      metadata: {
        adapterId: RIVESTREAM_ADAPTER_ID,
        servers,
      },
    };
  },
};
