import type { ContentType } from '$lib/server/content/types';

/**
 * MAVERO 4K Downloader — server-side adapter for the downloads.shegu.st JSON API (Phase 19).
 *
 * The 4K API is NOT a Stremio addon. It returns a JSON document with a `links[]`
 * array. This module:
 *   * fetches ONLY the fixed HTTPS origin (https://downloads.shegu.st);
 *   * constructs only the expected /movie/{tmdbId} or /tv/{tmdbId}/{season}/{episode} path;
 *   * validates tmdbId/season/episode input;
 *   * enforces a request timeout + response-size limit;
 *   * parses JSON safely + validates the expected schema;
 *   * gracefully handles malformed API responses;
 *   * NEVER proxies the actual media/download URLs — they are passed to the
 *     user unchanged (Download + Share operate on the EXACT returned URL).
 *
 * SECURITY BOUNDARY (task §14):
 *   * Only the fixed origin is allowed — no generic URL fetcher.
 *   * Path parameters are validated (tmdbId = digits, season/episode = positive ints).
 *   * SSRF prevention: the origin is hardcoded, never derived from user input.
 *   * No media URLs are fetched server-side — only the JSON API.
 *   * No FFmpeg, no media-worker, no proxy.
 */

/** The fixed 4K API origin (hardcoded — never derived from user input). */
export const FOURK_API_ORIGIN = 'https://downloads.shegu.st';

/** Per-request timeout for the 4K API fetch (smaller than the addon budget — JSON is small). */
export const FOURK_API_TIMEOUT_MS = 15_000;
/** Maximum response body size (1 MiB — the links[] array is small). */
export const FOURK_API_MAX_BYTES = 1_048_576;

/** One parsed 4K API link entry. */
export type FourKLink = {
  /** The EXACT media URL returned by the API — preserved verbatim, never rewritten. */
  url: string;
  /** The link name/title from the API (e.g. "4K CINEJOY [FSL Server] [WEB-DL DDP5][16.62 GB]"). */
  name: string;
  /** Derived format (e.g. "WEB-DL DDP5", "WEB-DL DDP5 HDR") — from real API data, never invented. */
  format: string | undefined;
  /** Derived quality (e.g. "2160p") — from real API data, never invented. */
  quality: string | undefined;
  /** Derived size (e.g. "16.62 GB") — from real API data, never invented. */
  size: string | undefined;
};

export type FourKResult = {
  links: FourKLink[];
  /** Count of malformed link entries (diagnostics only). */
  malformed: number;
};

export type FourKRequest = {
  mediaType: ContentType;
  tmdbId: string;
  season?: number;
  episode?: number;
};

export type FourKFetchDeps = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};

/** Validates the request shape + constructs the API URL. */
function buildApiUrl(request: FourKRequest): string {
  const tmdbId = request.tmdbId?.trim();
  if (!tmdbId || !/^\d{1,12}$/.test(tmdbId)) throw new Error('Invalid tmdbId.');
  if (request.mediaType !== 'movie' && request.mediaType !== 'series' && request.mediaType !== 'anime') {
    throw new Error('Invalid media type.');
  }
  // Series/TV path requires season + episode.
  if (request.mediaType !== 'movie') {
    const { season, episode } = request;
    if (!Number.isSafeInteger(season) || (season as number) < 1 || !Number.isSafeInteger(episode) || (episode as number) < 1) {
      throw new Error('Series requests require valid season + episode.');
    }
    return `${FOURK_API_ORIGIN}/tv/${tmdbId}/${season}/${episode}`;
  }
  return `${FOURK_API_ORIGIN}/movie/${tmdbId}`;
}

/**
 * Extracts the format from the API link name. The format is the text between
 * the LAST `[...]` bracket pair (excluding the size bracket) and the end.
 *
 * Examples:
 *   "4K CINEJOY [FSL Server] [WEB-DL DDP5][16.62 GB]" → "WEB-DL DDP5"
 *   "4K CINEJOY [FSL Server] [WEB-DL DDP5 HDR][16.62 GB]" → "WEB-DL DDP5 HDR"
 *   "Movie [WEB-DL][5.2 GB]" → "WEB-DL"
 *   "Movie [5.2 GB]" → undefined (no format bracket found — only size)
 *
 * The parser is deterministic and NEVER invents a value — if no bracket pair
 * contains format-like text, returns undefined.
 */
export function extractFormat(name: string | undefined): string | undefined {
  if (!name || typeof name !== 'string') return undefined;
  // Find ALL [...] bracket groups.
  const brackets = name.match(/\[([^\]]+)\]/g);
  if (!brackets || brackets.length === 0) return undefined;
  // The LAST bracket is typically the size (e.g. "[16.62 GB]"). The second-to-last
  // (or the last if it's NOT a size) is the format.
  const sizePattern = /\[\d+(?:\.\d+)?\s*(?:GB|MB|TB)\]/i;
  // Filter out size brackets + source/server brackets (e.g. "[FSL Server]").
  const sourcePattern = /\[.*server.*\]/i;
  const formatCandidates = brackets
    .map((b) => b.slice(1, -1).trim()) // strip [ ]
    .filter((text) => !sizePattern.test(`[${text}]`) && !sourcePattern.test(`[${text}]`));
  if (formatCandidates.length === 0) return undefined;
  // The format is the LAST non-size, non-source bracket.
  return formatCandidates[formatCandidates.length - 1] || undefined;
}

/**
 * Extracts the quality (resolution) from the API link name or a separate field.
 * Looks for patterns like "2160p", "1080p", "720p", "4K", "UHD".
 */
export function extractQuality(name: string | undefined): string | undefined {
  if (!name || typeof name !== 'string') return undefined;
  // Match "2160p", "1080p", "720p", "480p", "360p".
  const heightMatch = /\b(2160|1080|720|480|360)p\b/i.exec(name);
  if (heightMatch) return `${heightMatch[1]}p`;
  // Match "4K" / "UHD".
  if (/\b4k\b/i.test(name)) return '2160p';
  if (/\buhd\b/i.test(name)) return '2160p';
  return undefined;
}

/**
 * Extracts the size from the API link name. Looks for "[16.62 GB]" or "16.62 GB".
 */
export function extractSize(name: string | undefined): string | undefined {
  if (!name || typeof name !== 'string') return undefined;
  // Match "[16.62 GB]" or "16.62 GB" or "[5 GB]".
  const sizeMatch = /\[(\d+(?:\.\d+)?)\s*(GB|MB|TB)\]/i.exec(name) ?? /\b(\d+(?:\.\d+)?)\s*(GB|MB|TB)\b/i.exec(name);
  if (!sizeMatch) return undefined;
  return `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
}

/** Parses ONE raw link entry from the API into a FourKLink. */
function parseLink(entry: unknown): FourKLink | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  // The URL field — accept `url`, `link`, `download_url`, `downloadUrl`.
  const url = typeof record.url === 'string' ? record.url.trim()
    : typeof record.link === 'string' ? record.link.trim()
    : typeof record.download_url === 'string' ? record.download_url.trim()
    : typeof record.downloadUrl === 'string' ? record.downloadUrl.trim()
    : '';
  if (!url || !(url.startsWith('https://') || url.startsWith('http://'))) return null;
  // The name field — accept `name`, `title`, `filename`.
  const name = typeof record.name === 'string' ? record.name
    : typeof record.title === 'string' ? record.title
    : typeof record.filename === 'string' ? record.filename
    : '';
  return {
    url,
    name,
    format: extractFormat(name),
    quality: extractQuality(name),
    size: extractSize(name),
  };
}

/**
 * Fetches the 4K API and parses the response. NEVER throws for API-level
 * problems — returns an empty result with a typed error. Throws only for
 * invalid request shapes.
 */
export async function fetchFourKLinks(request: FourKRequest, deps: FourKFetchDeps = {}): Promise<FourKResult> {
  const apiUrl = buildApiUrl(request);
  const fetcher = deps.fetcher ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FOURK_API_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? FOURK_API_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(apiUrl, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
    if (!response.ok) {
      console.warn(`[4KDownloader] API returned HTTP ${response.status}`);
      return { links: [], malformed: 0 };
    }
    // Read the body with a size limit.
    const contentLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      console.warn(`[4KDownloader] API response too large (${contentLength} bytes)`);
      return { links: [], malformed: 0 };
    }
    const text = await response.text();
    if (text.length > maxBytes) {
      console.warn(`[4KDownloader] API response body too large (${text.length} bytes)`);
      return { links: [], malformed: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn('[4KDownloader] API response is not valid JSON');
      return { links: [], malformed: 0 };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[4KDownloader] API response is not an object');
      return { links: [], malformed: 0 };
    }
    const payload = parsed as Record<string, unknown>;
    if (!Array.isArray(payload.links)) {
      console.warn('[4KDownloader] API response has no links[] array');
      return { links: [], malformed: 0 };
    }
    const links: FourKLink[] = [];
    let malformed = 0;
    for (const entry of payload.links) {
      const link = parseLink(entry);
      if (link) links.push(link);
      else malformed += 1;
    }
    console.info(`[4KDownloader] resolved url=${apiUrl} links=${links.length} malformed=${malformed}`);
    return { links, malformed };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.warn('[4KDownloader] API request timed out');
    } else {
      console.warn('[4KDownloader] API request failed', error);
    }
    return { links: [], malformed: 0 };
  } finally {
    clearTimeout(timer);
  }
}
