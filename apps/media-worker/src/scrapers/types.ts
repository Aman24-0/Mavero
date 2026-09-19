/**
 * Phase 2 / Phase 5 — Scraper extraction engine: shared types & helpers.
 *
 * Phase 2 shipped a `dummyExtract()` helper that simulated a 2–8 second
 * network delay and resolved with a mock HLS URL. Phase 5 keeps the SAME
 * public types so the SSE endpoint in `server.ts` is untouched, but the
 * dummy helper is now used only by the `cineverse.ts` and `slast.ts`
 * scrapers — `vidsrc.ts` and `vidlink.ts` perform REAL HTTP extraction.
 *
 * DESIGN CONTRACTS (Phase 5):
 *   * A scraper NEVER throws synchronously — it ALWAYS returns a Promise
 *     that RESOLVES with an `ExtractResult` on success or REJECTS with an
 *     `ExtractError` on failure. The SSE handler's `.catch()` turns a
 *     rejection into a `{"status":"failed"}` event without crashing the
 *     stream (Phase 2 contract preserved).
 *   * All network I/O is bounded (timeout + max-response-size) to keep
 *     a single slow provider from stalling the SSE stream.
 *   * Spoofed headers (UA / Referer / Accept-Language) live in the
 *     shared `fetchEmbedPage` helper so every provider sends the same
 *     shape — providers only add their own `Referer` if needed.
 */

export type ExtractResult = {
  provider: string;
  url: string;
  type: 'hls' | 'mp4' | 'embed';
};

export type ExtractError = {
  provider: string;
  error: string;
};

export type ExtractParams = {
  tmdbId: string;
  mediaType: 'movie' | 'series';
  season?: number;
  episode?: number;
};

// ============================================================
// Phase 5 — Real extraction helpers (shared HTTP + regex utils)
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
};

/**
 * Phase 5 — Shared HTTP fetch helper used by every real scraper.
 *
 * Performs a bounded `fetch` against a provider's embed URL using
 * spoofed browser headers so basic User-Agent / Referer / language
 * checks pass. Resolves with the decoded UTF-8 response body, or
 * rejects with a descriptive error string.
 *
 * The body is hard-capped at `MAX_EMBED_BYTES` to prevent a malicious
 * or buggy provider from streaming gigabytes into the worker.
 */
export async function fetchEmbedPage(options: FetchEmbedOptions): Promise<string> {
  const url = options.url;
  const referer = options.referer ?? new URL(url).origin + '/';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
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
    const reason = error instanceof Error ? error.message : 'network error';
    throw new Error(`fetch failed: ${reason}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`http ${response.status}`);
  }

  // Bounded read — accumulate up to MAX_EMBED_BYTES then abort.
  const reader = response.body?.getReader();
  if (!reader) {
    // Fall back to .text() — still bounded by the server's response size.
    const text = await response.text();
    if (text.length > MAX_EMBED_BYTES) {
      throw new Error('response too large');
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
        throw new Error('response too large');
      }
      body += decoder.decode(value, { stream: true });
    }
  }
  body += decoder.decode();
  return body;
}

/**
 * Phase 5 — Extracts the first .m3u8 playlist URL from a blob of HTML
 * or packed JavaScript using a permissive regex. The matcher accepts:
 *
 *   * `https://host/path/playlist.m3u8` (absolute)
 *   * `//host/path/playlist.m3u8`     (protocol-relative)
 *   * `/path/playlist.m3u8`           (origin-relative — needs `origin`)
 *
 * Returns the FIRST match (providers normally only ship one master
 * playlist; if there are several, the first is the master). Returns
 * `null` when no m3u8 URL is present — the caller rejects with an
 * `ExtractError` in that case.
 */
export function findM3u8Url(body: string, origin: string): string | null {
  // Match any of: https://..., //host/path, or /path ending in .m3u8
  // (optionally followed by a query string).
  const pattern = /(?:https?:)?(?:\\?\/\\?\/)?[\w.-]+(?:\.[\w.-]+)+(?:\/[^\s"'`<>\\]*)?\.m3u8[^\s"'`<>\\]*/g;
  // The pattern above may be too greedy in some JS-packed bodies. Try
  // the most-specific absolute-URL pattern first.
  const absolute = /https?:\/\/[^\s"'`<>\\)]+\.m3u8(?:\?[^\s"'`<>\\)]*)?/i.exec(body);
  if (absolute && absolute[0]) {
    return normalizeM3u8Url(absolute[0], origin);
  }

  // Fall back to protocol-relative / origin-relative detection.
  const rel = /(?:["'(=]|^)(\/\/[^\s"'`<>\\)]+\.m3u8(?:\?[^\s"'`<>\\)]*)?)/.exec(body);
  if (rel && rel[1]) {
    return normalizeM3u8Url(rel[1], origin);
  }

  const path = /(?:["'(=]|^)(\/[^\s"'`<>\\)]+\.m3u8(?:\?[^\s"'`<>\\)]*)?)/.exec(body);
  if (path && path[1]) {
    return normalizeM3u8Url(path[1], origin);
  }

  void pattern; // (kept for documentation; not relied on by default path)
  return null;
}

/** Normalizes a matched URL to an absolute https URL. */
function normalizeM3u8Url(raw: string, origin: string): string {
  const cleaned = raw.replace(/\\(?!\/)/g, '').replace(/^["'(]+|["')]+$/g, '');
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (cleaned.startsWith('//')) return `https:${cleaned}`;
  // Origin-relative.
  const base = origin.replace(/\/+$/, '');
  return `${base}${cleaned.startsWith('/') ? cleaned : `/${cleaned}`}`;
}

/**
 * Phase 5 — Builds a provider embed URL from a path template and params.
 * Replaces the placeholders `$id`, `$season`, `$episode` in the template
 * (mirrors the spec example: `https://vidsrc.sh/embed/movie/$id`).
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
// Phase 2 — dummyExtract (kept for cineverse.ts + slast.ts)
// ============================================================

/**
 * Dummy extract helper — still used by the Phase 2 scrapers that have
 * not been promoted to real extraction in Phase 5. Returns a promise
 * that resolves after a randomized 2–8 second delay with a mock
 * ExtractResult, or rejects with an ExtractError (20% failure rate to
 * exercise both card states in the frontend).
 */
export function dummyExtract(
  providerName: string,
  mockUrl: string = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
): Promise<ExtractResult> {
  const delay = 2000 + Math.random() * 6000; // 2–8 seconds
  const shouldSucceed = Math.random() > 0.2; // 80% success rate

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldSucceed) {
        resolve({ provider: providerName, url: mockUrl, type: 'hls' });
      } else {
        reject({ provider: providerName, error: 'No stream found' });
      }
    }, delay);
  });
}
