/**
 * Phase 7 — Scraper extraction engine: shared types & helpers.
 *
 * DESIGN CONTRACTS:
 *   * A scraper NEVER throws synchronously — it ALWAYS returns a Promise
 *     that RESOLVES with an `ExtractResult` on success or REJECTS with an
 *     `ExtractError` on failure. The SSE handler's `.catch()` turns a
 *     rejection into a `{"status":"failed"}` event without crashing the
 *     stream.
 *   * All network I/O is bounded (timeout + max-response-size) and
 *     cancellable via `AbortSignal` so a client disconnect stops work.
 *   * Spoofed headers (UA / Referer / Accept-Language) live in the shared
 *     `fetchEmbedPage` helper so every provider sends the same shape.
 *   * Failure categories are typed (NETWORK_ERROR, HTTP_ERROR,
 *     PARSER_ERROR, NO_STREAM, UNSUPPORTED, PLAYBACK_UNAVAILABLE) so the
 *     frontend can render honest, distinct UX states.
 *   * `dummyExtract()` is TEST-FIXTURE-ONLY — it is NOT registered in
 *     the production scraper registry (`index.ts`).
 */

// ============================================================
// Result + error model
// ============================================================

export type ExtractMediaType = 'hls' | 'mp4';

export type ExtractResult = {
  provider: string;
  url: string;
  /** Accurate media type — drives the Video.js source type. */
  type: ExtractMediaType;
  /** Optional descriptive title (display only). */
  title?: string;
};

/**
 * Typed failure categories. The frontend maps these to distinct,
 * honest user-facing states ("Extractor unavailable", "Connection
 * failed", "No playable stream", etc.) — never a raw stack trace.
 */
export type ExtractErrorCategory =
  | 'NETWORK_ERROR' // fetch rejected (DNS, timeout, TCP reset, abort)
  | 'HTTP_ERROR' // server replied non-2xx
  | 'PARSER_ERROR' // body fetched but no media URL could be extracted
  | 'NO_STREAM' // parser ran, no candidate found
  | 'UNSUPPORTED' // provider adapter not implemented for this path
  | 'PLAYBACK_UNAVAILABLE'; // URL extracted but type is not directly playable

export type ExtractError = {
  provider: string;
  /** Typed category — drives the frontend's failure UX. */
  category: ExtractErrorCategory;
  /** Safe, generic, user-facing message (no provider internals). */
  error: string;
};

export type ExtractParams = {
  tmdbId: string;
  mediaType: 'movie' | 'series';
  season?: number;
  episode?: number;
};

// ============================================================
// Bounded HTTP fetch helper
// ============================================================

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/** Hard cap on downloaded embed-page size (1 MiB — embed HTML is small). */
const MAX_EMBED_BYTES = 1024 * 1024;

/** Network timeout for any single embed fetch (15 s — generous, bounded). */
const EMBED_FETCH_TIMEOUT_MS = 15_000;

export type FetchEmbedOptions = {
  /** The URL of the embed page to fetch. */
  url: string;
  /** Optional Referer to spoof (defaults to the embed URL's origin). */
  referer?: string;
  /** Optional abort signal — cancels the in-flight fetch. */
  signal?: AbortSignal;
};

/**
 * Bounded `fetch` against a provider's embed URL using spoofed browser
 * headers so basic User-Agent / Referer / language checks pass.
 *
 * Resolves with the decoded UTF-8 response body, or rejects with an
 * `ExtractError`-shaped object (category + safe message) — never a
 * raw `Error`. The body is hard-capped at `MAX_EMBED_BYTES` to prevent
 * a malicious or buggy provider from streaming gigabytes into the
 * worker.
 */
export async function fetchEmbedPage(options: FetchEmbedOptions): Promise<string> {
  const url = options.url;
  const referer = options.referer ?? new URL(url).origin + '/';

  // Compose the abort signal: caller-supplied + a wall-clock timeout.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), EMBED_FETCH_TIMEOUT_MS);
  const composedSignal = options.signal
    ? composeAbortSignals(options.signal, timeoutController.signal)
    : timeoutController.signal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: composedSignal,
      redirect: 'follow',
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': DEFAULT_ACCEPT_LANGUAGE,
        'referer': referer,
        'sec-fetch-dest': 'iframe',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
      },
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = (error instanceof Error && error.name === 'AbortError') || composedSignal.aborted;
    const reason = error instanceof Error ? error.message : 'network error';
    throw {
      provider: '',
      category: aborted ? 'NETWORK_ERROR' : 'NETWORK_ERROR',
      error: aborted ? 'request cancelled' : `network: ${reason}`,
    } satisfies ExtractError;
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw {
      provider: '',
      category: 'HTTP_ERROR',
      error: `http ${response.status}`,
    } satisfies ExtractError;
  }

  // Bounded read — accumulate up to MAX_EMBED_BYTES then abort.
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > MAX_EMBED_BYTES) {
      throw { provider: '', category: 'PARSER_ERROR', error: 'response too large' } satisfies ExtractError;
    }
    return text;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let body = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_EMBED_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw { provider: '', category: 'PARSER_ERROR', error: 'response too large' } satisfies ExtractError;
      }
      body += decoder.decode(value, { stream: true });
    }
  }
  body += decoder.decode();
  return body;
}

/**
 * Composes multiple AbortSignals into one — aborts when ANY input
 * signal aborts. Uses the native `AbortSignal.any()` when available
 * (Node 20+), falls back to manual propagation otherwise.
 */
function composeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  // Modern Node 20+ has AbortSignal.any().
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(signals);
  // Fallback — compose manually.
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

// ============================================================
// Multi-stage media-URL parser (replaces the old findM3u8Url)
// ============================================================

export type ParsedMediaUrl = {
  url: string;
  type: ExtractMediaType;
};

/**
 * Multi-stage parser that locates the BEST candidate media URL in a
 * blob of provider HTML / packed JavaScript / JSON config.
 *
 * Stage order (most-specific → most-permissive):
 *   A. Absolute https/http URLs ending in `.m3u8` (preserves ?query).
 *   B. Absolute https/http URLs ending in `.mp4` (preserves ?query).
 *   C. Escaped JavaScript strings — `https:\/\/host\/path\/master.m3u8?...`
 *      (unescapes `\/` to `/` before validating).
 *   D. JSON-embedded values — extract string values from `<script>`
 *      blocks containing JSON, then look for URL-shaped values.
 *   E. Protocol-relative URLs — `//host/path/.m3u8` → `https://...`.
 *   F. Origin-relative URLs — `/path/.m3u8` → `${origin}/path/.m3u8`.
 *
 * Each candidate is validated via `new URL()` and must have http(s)
 * protocol + a non-empty path. Signed query parameters are PRESERVED.
 *
 * Returns `null` when no candidate is found (caller then rejects with
 * a typed `NO_STREAM` error). Does NOT select arbitrary `.m3u8` strings
 * from unrelated analytics/config data when stronger media evidence is
 * available (absolute URL match wins over escaped/JSON match).
 */
export function findMediaUrl(body: string, origin: string): ParsedMediaUrl | null {
  // Stage A: absolute https/http m3u8 (highest confidence — direct URL).
  const absoluteM3u8 = matchAbsoluteUrl(body, '.m3u8');
  if (absoluteM3u8) return { url: absoluteM3u8, type: 'hls' };

  // Stage B: absolute https/http mp4.
  const absoluteMp4 = matchAbsoluteUrl(body, '.mp4');
  if (absoluteMp4) return { url: absoluteMp4, type: 'mp4' };

  // Stage C: escaped JavaScript strings — unescape `\/` to `/` then
  // re-run the absolute-URL matcher on the unescaped body.
  const unescaped = body.replace(/\\\//g, '/');
  if (unescaped !== body) {
    const escapedM3u8 = matchAbsoluteUrl(unescaped, '.m3u8');
    if (escapedM3u8) return { url: escapedM3u8, type: 'hls' };
    const escapedMp4 = matchAbsoluteUrl(unescaped, '.mp4');
    if (escapedMp4) return { url: escapedMp4, type: 'mp4' };
  }

  // Stage D: JSON-embedded values — extract string values from
  // <script> JSON blocks and look for URL-shaped values.
  const jsonUrls = extractJsonStringUrls(body);
  for (const candidate of jsonUrls) {
    if (candidate.endsWith('.m3u8') || candidate.includes('.m3u8?')) {
      const validated = validateAbsolute(candidate);
      if (validated) return { url: validated, type: 'hls' };
    }
    if (candidate.endsWith('.mp4') || candidate.includes('.mp4?')) {
      const validated = validateAbsolute(candidate);
      if (validated) return { url: validated, type: 'mp4' };
    }
  }

  // Stage E: protocol-relative URLs — `//host/path/.m3u8`.
  const protoRel = matchProtocolRelative(body, '.m3u8');
  if (protoRel) return { url: protoRel, type: 'hls' };
  const protoRelMp4 = matchProtocolRelative(body, '.mp4');
  if (protoRelMp4) return { url: protoRelMp4, type: 'mp4' };

  // Stage F: origin-relative URLs — `/path/.m3u8` → `${origin}/path/.m3u8`.
  const originRel = matchOriginRelative(body, origin, '.m3u8');
  if (originRel) return { url: originRel, type: 'hls' };
  const originRelMp4 = matchOriginRelative(body, origin, '.mp4');
  if (originRelMp4) return { url: originRelMp4, type: 'mp4' };

  return null;
}

/** Matches absolute https/http URLs ending in the given extension (with optional ?query). */
function matchAbsoluteUrl(body: string, ext: string): string | null {
  const pattern = new RegExp(`https?:\\/\\/[^\\s"'\\\`<>)]+\\${ext}(?:\\?[^\\s"'\\\`<>)]*)?`, 'i');
  const match = pattern.exec(body);
  if (!match || !match[0]) return null;
  return validateAbsolute(match[0]);
}

/** Matches protocol-relative URLs (`//host/path/.ext`). */
function matchProtocolRelative(body: string, ext: string): string | null {
  // Look for `//host/path/.ext` preceded by a non-URL boundary (quote, =, (, space).
  const pattern = new RegExp(`(?:["'(=\\s]|^)(\\/\\/[\\w.-]+(?:\\.[\\w.-]+)+(?:\\/[^\\s"'\\\`<>)]*)?\\${ext}(?:\\?[^\\s"'\\\`<>)]*)?)`, 'i');
  const match = pattern.exec(body);
  if (!match || !match[1]) return null;
  const url = `https:${match[1]}`;
  return validateAbsolute(url);
}

/** Matches origin-relative URLs (`/path/.ext`) and resolves against `origin`. */
function matchOriginRelative(body: string, origin: string, ext: string): string | null {
  const pattern = new RegExp(`(?:["'(=\\s]|^)(\\/(?:[^\\s"'\\\`<>)]*\\${ext})(?:\\?[^\\s"'\\\`<>)]*)?)`, 'i');
  const match = pattern.exec(body);
  if (!match || !match[1]) return null;
  const base = origin.replace(/\/+$/, '');
  const url = `${base}${match[1].startsWith('/') ? match[1] : `/${match[1]}`}`;
  return validateAbsolute(url);
}

/** Extracts string-valued URLs from `<script>` JSON blocks. */
function extractJsonStringUrls(body: string): string[] {
  const urls: string[] = [];
  // Find all <script>...</script> blocks.
  const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptPattern.exec(body)) !== null) {
    const scriptContent = scriptMatch[1] ?? '';
    if (!scriptContent) continue;
    // Extract quoted string values that look like URLs.
    const stringPattern = /["'`]([^"'`\s<>]+https?:\/\/[^"'`\s<>]+)["'`]/g;
    let stringMatch: RegExpExecArray | null;
    while ((stringMatch = stringPattern.exec(scriptContent)) !== null) {
      if (stringMatch[1]) urls.push(stringMatch[1]);
    }
    // Also try parsing the script content as JSON and walk for URL values.
    try {
      const parsed = JSON.parse(scriptContent.trim());
      walkJsonForUrls(parsed, urls);
    } catch {
      // Not JSON — the regex pass above already covered it.
    }
  }
  return urls;
}

/** Walks a parsed JSON tree collecting URL-shaped string values. */
function walkJsonForUrls(node: unknown, out: string[]): void {
  if (typeof node === 'string' && /https?:\/\//.test(node) && node.length < 2048) {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkJsonForUrls(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      walkJsonForUrls(value, out);
    }
  }
}

/** Validates an absolute URL — must be http(s) with a non-empty path. */
function validateAbsolute(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.pathname || parsed.pathname === '/') return null;
    // Preserve the full href (including signed ?query params).
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

// ============================================================
// Embed URL builder
// ============================================================

/**
 * Builds a provider embed URL from a path template and params.
 * Replaces the placeholders `$id`, `$season`, `$episode` in the template.
 */
export function buildEmbedUrl(baseUrl: string, params: ExtractParams): string {
  let out = baseUrl;
  out = out.replace(/\$id\b/g, encodeURIComponent(params.tmdbId));
  if (params.season !== undefined) {
    out = out.replace(/\$season\b/g, String(params.season));
  }
  if (params.episode !== undefined) {
    out = out.replace(/\$episode\b/g, String(params.episode));
  }
  // For series, swap the /movie/ segment to /tv/ if the template uses it.
  if (params.mediaType === 'series') {
    out = out.replace(/\/movie\//, '/tv/');
  }
  return out;
}

// ============================================================
// SSE request validation (spec §19)
// ============================================================

export type SseRequestValidation =
  | { ok: true; params: ExtractParams }
  | { ok: false; code: 'INVALID_TMDB' | 'INVALID_TYPE' | 'INVALID_SEASON' | 'INVALID_EPISODE'; message: string };

/**
 * Validates the SSE extraction request query parameters BEFORE any
 * scraper work is launched. Rejects obviously malformed requests so
 * the worker doesn't waste concurrency on garbage input.
 */
export function validateSseRequest(input: {
  tmdbId: string;
  mediaType: string;
  season?: string | null;
  episode?: string | null;
}): SseRequestValidation {
  const tmdbId = input.tmdbId.trim();
  if (!tmdbId || tmdbId.length > 64) {
    return { ok: false, code: 'INVALID_TMDB', message: 'tmdbId must be 1–64 chars' };
  }
  if (input.mediaType !== 'movie' && input.mediaType !== 'series') {
    return { ok: false, code: 'INVALID_TYPE', message: 'mediaType must be movie or series' };
  }
  let season: number | undefined;
  if (input.season !== undefined && input.season !== null && input.season !== '') {
    const n = Number(input.season);
    if (!Number.isSafeInteger(n) || n < 1) {
      return { ok: false, code: 'INVALID_SEASON', message: 'season must be a positive integer' };
    }
    season = n;
  }
  let episode: number | undefined;
  if (input.episode !== undefined && input.episode !== null && input.episode !== '') {
    const n = Number(input.episode);
    if (!Number.isSafeInteger(n) || n < 1) {
      return { ok: false, code: 'INVALID_EPISODE', message: 'episode must be a positive integer' };
    }
    episode = n;
  }
  return { ok: true, params: { tmdbId, mediaType: input.mediaType, season, episode } };
}

// ============================================================
// TEST-FIXTURE-ONLY dummy extractor
// ============================================================

/**
 * TEST FIXTURE ONLY — NOT registered in the production scraper
 * registry. Used by isolated extraction tests to exercise the SSE
 * pipeline shape without hitting real providers.
 *
 * In production, providers that do not have a real extractor return
 * a typed `UNSUPPORTED` error — they NEVER call this function.
 */
export function dummyExtract(
  providerName: string,
  mockUrl: string = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
): Promise<ExtractResult> {
  const delay = 2000 + Math.random() * 6000;
  const shouldSucceed = Math.random() > 0.2;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldSucceed) {
        resolve({ provider: providerName, url: mockUrl, type: 'hls' });
      } else {
        reject({ provider: providerName, category: 'NO_STREAM', error: 'no stream found' } satisfies ExtractError);
      }
    }, delay);
  });
}
