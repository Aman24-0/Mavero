import { isMagnetUri } from '$lib/server/streaming/stremio/stream-normalize-downloader';

/**
 * MAVERO generic JSON downloader normalizer.
 *
 * Server-side, PURE (no I/O) normalizer for `type = 'json'` download
 * providers. The provider's URL template resolves to a JSON API endpoint;
 * Mavero fetches that endpoint server-side (see json-service.ts) and hands
 * the parsed document to THIS module, which converts it into a sanitized
 * list of download links for the generic inline UI (JsonDownload.svelte).
 *
 * DESIGN CONTRACTS (task spec):
 *   * NO provider-specific adapters — no Pantyflix code, no hardcoded hosts.
 *     The shapes below are the COMMON denominator across JSON download APIs.
 *   * Supported array containers (checked in this order at the document
 *     root): downloads, links, results, streams, files, data, sources.
 *   * Supported URL fields (first non-empty string wins):
 *     url, link, href, download_url, downloadUrl.
 *   * Supported metadata: server/source/provider/host, name/title/label/
 *     filename, quality/resolution, size/filesize/fileSize. Missing fields
 *     are gracefully OMITTED (never invented, never "0p").
 *   * Recursive fallback: when no root container produced a link, the whole
 *     document is walked with a STRICT depth/entry budget so malformed or
 *     adversarial JSON cannot cause unbounded work.
 *   * Only usable download URLs are accepted: http/https (parsed + scheme
 *     checked) or a magnet URI in the legitimate btih form — the SAME
 *     policy the existing downloader surfaces already permit (the Mavero
 *     Downloader panel shares/plays magnet URIs). Everything else
 *     (javascript:, data:, ftp:, file:, garbage) is rejected.
 *   * Deduplication: EXACT identical URL strings only. Two different hosts
 *     with identical metadata are BOTH kept.
 *   * A valid-JSON document with no recognizable links yields a CLEAN EMPTY
 *     result — never an exception, never an iframe fallback.
 *   * An explicit upstream failure (`ok === false` or a truthy `error`
 *     field) yields the `upstreamError` outcome — the endpoint surfaces a
 *     generic failure state and never exposes the raw upstream JSON.
 *
 * SECURITY: every metadata string is sanitized (control characters
 * stripped, length capped) before it reaches the client, and only the
 * whitelisted fields above are ever projected — arbitrary upstream JSON is
 * never passed through.
 */

// ---------------------------------------------------------------------------
// Field vocabularies (ordered — first match wins within each group)
// ---------------------------------------------------------------------------

/** Common top-level array container keys, in scan-priority order. */
export const JSON_DOWNLOAD_CONTAINER_KEYS = [
  'downloads',
  'links',
  'results',
  'streams',
  'files',
  'data',
  'sources',
] as const;

/** Recognized URL field names on an entry (first non-empty string wins). */
export const JSON_DOWNLOAD_URL_FIELDS = [
  'url',
  'link',
  'href',
  'download_url',
  'downloadUrl',
] as const;

/** Recognized display-name fields on an entry. */
const TITLE_FIELDS = ['name', 'title', 'label', 'filename'] as const;

/** Recognized server fields — `server` wins, `host` is the fallback spelling. */
const SERVER_FIELDS = ['server', 'host'] as const;

/** Recognized source fields — `source` wins, `provider` is the fallback. */
const SOURCE_FIELDS = ['source', 'provider'] as const;

/** Recognized quality/resolution fields. */
const QUALITY_FIELDS = ['quality', 'resolution'] as const;

/** Recognized size fields. */
const SIZE_FIELDS = ['size', 'filesize', 'fileSize'] as const;

// ---------------------------------------------------------------------------
// Bounds — malformed JSON must never cause unbounded work
// ---------------------------------------------------------------------------

/** Maximum recursion depth for the fallback walk. */
export const JSON_NORMALIZE_MAX_DEPTH = 6;
/** Maximum nodes (objects/arrays) visited per document. */
export const JSON_NORMALIZE_MAX_NODES = 400;
/** Maximum links collected per document. */
export const JSON_NORMALIZE_MAX_LINKS = 100;
/** Maximum accepted URL length (mirrors the manifest URL bound). */
const MAX_URL_LENGTH = 2048;
/** Maximum sanitized metadata text length. */
const FIELD_TEXT_MAX_LENGTH = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One sanitized, UI-ready download link. The URL is the EXACT upstream value. */
export type NormalizedJsonDownloadLink = {
  url: string;
  title?: string;
  server?: string;
  source?: string;
  quality?: string;
  size?: string;
};

/** Normalizer outcome. */
export type JsonNormalizeResult = {
  links: NormalizedJsonDownloadLink[];
  /** The upstream document explicitly reported failure (ok=false / error). */
  upstreamError: boolean;
  /** Entry-shaped objects that produced no usable link (diagnostics only). */
  malformed: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trim, strip control characters, and cap the length of a metadata string. */
function sanitizeText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, FIELD_TEXT_MAX_LENGTH);
}

/** First non-empty sanitized string among the given fields, or undefined. */
function firstString(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string') {
      const sanitized = sanitizeText(value);
      if (sanitized) return sanitized;
    }
  }
  return undefined;
}

/**
 * Normalizes a quality/resolution value to a display string.
 *
 *   1080 (number)      -> "1080p"
 *   "1080" (string)    -> "1080p"
 *   "1080p"            -> "1080p"
 *   "4K" / "HD"        -> kept verbatim
 *   0 / "0" / negative / empty / garbage -> undefined (NEVER "0p")
 */
function normalizeQuality(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return `${Math.trunc(value)}p`;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? `${trimmed}p` : undefined;
  }
  return sanitizeText(trimmed) || undefined;
}

/** Formats a numeric byte count using the decimal SI convention (GB, MB…). */
function formatByteSize(bytes: number): string | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  const units: Array<[number, string]> = [
    [1e12, 'TB'],
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'KB'],
  ];
  for (const [factor, unit] of units) {
    if (bytes >= factor) {
      const value = (bytes / factor).toFixed(2).replace(/\.?0+$/, '');
      return `${value} ${unit}`;
    }
  }
  return `${Math.trunc(bytes)} B`;
}

/**
 * Normalizes a size value: strings are kept verbatim (sanitized); numbers are
 * interpreted as byte counts (the universal convention for numeric filesize
 * fields) and formatted. Anything unusable is omitted.
 */
function normalizeSize(value: unknown): string | undefined {
  if (typeof value === 'number') return formatByteSize(value);
  if (typeof value !== 'string') return undefined;
  return sanitizeText(value) || undefined;
}

/**
 * Validates ONE raw URL string against the downloader URL policy:
 *   * http/https — must parse as an absolute URL with the right scheme,
 *     no whitespace, bounded length;
 *   * magnet — must be in the legitimate btih form (isMagnetUri — the SAME
 *     validator the existing downloader surfaces use);
 *   * everything else (javascript:, data:, ftp:, file:, relative paths,
 *     garbage) is rejected.
 */
export function isUsableDownloadUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url || url.length > MAX_URL_LENGTH) return false;
  if (/\s/.test(url)) return false;
  if (url.toLowerCase().startsWith('magnet:')) return isMagnetUri(url);
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The raw URL value of an entry — first non-empty string among URL_FIELDS. */
function entryUrl(record: Record<string, unknown>): string | null {
  for (const field of JSON_DOWNLOAD_URL_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Whether the object carries ANY recognized URL field with a string value. */
function hasUrlField(record: Record<string, unknown>): boolean {
  return JSON_DOWNLOAD_URL_FIELDS.some((field) => typeof record[field] === 'string' && record[field].trim() !== '');
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

/**
 * Parses ONE entry object into a normalized link (or null when the entry has
 * no usable URL — counted malformed). The returned `url` is the EXACT
 * upstream string: never rewritten, proxied, or transformed.
 */
function parseEntry(record: Record<string, unknown>): NormalizedJsonDownloadLink | null {
  const rawUrl = entryUrl(record);
  if (!rawUrl) return null;
  if (!isUsableDownloadUrl(rawUrl)) return null;
  // Missing metadata is OMITTED (the key is absent, not undefined) so the
  // wire payload and deep-equality checks see exactly what the API supplied.
  const link: NormalizedJsonDownloadLink = { url: rawUrl };
  const title = firstString(record, TITLE_FIELDS);
  if (title !== undefined) link.title = title;
  const server = firstString(record, SERVER_FIELDS);
  if (server !== undefined) link.server = server;
  const source = firstString(record, SOURCE_FIELDS);
  if (source !== undefined) link.source = source;
  const quality = normalizeQuality(firstPresent(record, QUALITY_FIELDS));
  if (quality !== undefined) link.quality = quality;
  const size = normalizeSize(firstPresent(record, SIZE_FIELDS));
  if (size !== undefined) link.size = size;
  return link;
}

/** First usable field among `fields` (present, non-null, not an empty string). */
function firstPresent(record: Record<string, unknown>, fields: readonly string[]): unknown {
  for (const field of fields) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Document scanning (bounded)
// ---------------------------------------------------------------------------

type ScanState = {
  links: NormalizedJsonDownloadLink[];
  seenUrls: Set<string>;
  malformed: number;
  visitedNodes: number;
};

/** Whether the scan budget (nodes + links) is exhausted. */
function budgetExhausted(state: ScanState): boolean {
  return state.visitedNodes >= JSON_NORMALIZE_MAX_NODES || state.links.length >= JSON_NORMALIZE_MAX_LINKS;
}

/** Adds a parsed entry to the state (exact-URL dedupe only). */
function accept(state: ScanState, entry: Record<string, unknown>): void {
  if (state.links.length >= JSON_NORMALIZE_MAX_LINKS) return;
  const link = parseEntry(entry);
  if (!link) {
    state.malformed += 1;
    return;
  }
  // Deduplicate ONLY exact identical URL strings — two entries with the same
  // URL are the same link; two different hosts with identical metadata are
  // different links and both stay.
  if (state.seenUrls.has(link.url)) return;
  state.seenUrls.add(link.url);
  state.links.push(link);
}

/**
 * Bounded recursive walk over a JSON node. Entry-shaped objects (any object
 * carrying a recognized URL field) are parsed as entries; other objects and
 * arrays are descended into while the depth/node budget lasts.
 */
function scanNode(node: unknown, depth: number, state: ScanState): void {
  if (budgetExhausted(state) || depth > JSON_NORMALIZE_MAX_DEPTH) return;
  state.visitedNodes += 1;
  if (state.visitedNodes > JSON_NORMALIZE_MAX_NODES) return;

  if (Array.isArray(node)) {
    for (const element of node) {
      if (budgetExhausted(state)) return;
      if (isPlainObject(element) && hasUrlField(element)) {
        accept(state, element);
      } else if (Array.isArray(element) || isPlainObject(element)) {
        scanNode(element, depth + 1, state);
      }
    }
    return;
  }

  if (isPlainObject(node)) {
    // An object WITH a URL field is an entry leaf — parse, never descend
    // (an entry's nested objects are metadata, not more links).
    if (hasUrlField(node)) {
      accept(state, node);
      return;
    }
    for (const value of Object.values(node)) {
      if (budgetExhausted(state)) return;
      if (Array.isArray(value) || isPlainObject(value)) {
        scanNode(value, depth + 1, state);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalizes a parsed JSON download-API document into sanitized links.
 *
 * Order of inspection:
 *   1. Explicit upstream failure: `ok === false` or a truthy `error` field
 *      short-circuits to the upstreamError outcome (no scanning).
 *   2. Root container fast path: every known container key holding an array
 *      is scanned, in the listed order, and the results are aggregated
 *      (exact-URL dedupe applies).
 *   3. Fallback walk: when (2) produced no links, the rest of the document
 *      is walked recursively under the strict depth/node budget.
 *
 * Never throws for document-shape problems — a valid-JSON document with no
 * recognizable links returns a clean empty result.
 */
export function normalizeJsonDownloadPayload(body: unknown): JsonNormalizeResult {
  // A top-level array is not one of the named containers, but it is still a
  // reasonable shape ("[{url:...}, ...]") — walk it directly.
  if (Array.isArray(body)) {
    const state: ScanState = { links: [], seenUrls: new Set(), malformed: 0, visitedNodes: 0 };
    scanNode(body, 0, state);
    return { links: state.links, upstreamError: false, malformed: state.malformed };
  }

  if (!isPlainObject(body)) {
    return { links: [], upstreamError: false, malformed: 0 };
  }

  // 1. Explicit upstream failure — surface a generic failure state, never
  //    the raw upstream JSON.
  const explicitFailure = body.ok === false || Boolean(body.error);
  if (explicitFailure) {
    return { links: [], upstreamError: true, malformed: 0 };
  }

  const state: ScanState = { links: [], seenUrls: new Set(), malformed: 0, visitedNodes: 0 };

  // 2. Root container fast path — aggregate every known container array.
  const scannedRootKeys = new Set<string>();
  for (const key of JSON_DOWNLOAD_CONTAINER_KEYS) {
    if (budgetExhausted(state)) break;
    const container = body[key];
    if (Array.isArray(container)) {
      scannedRootKeys.add(key);
      scanNode(container, 0, state);
    }
  }

  // 3. Fallback walk over everything else (nested containers such as
  //    data.downloads[], or nonstandard shapes).
  if (state.links.length === 0) {
    for (const [key, value] of Object.entries(body)) {
      if (budgetExhausted(state)) break;
      if (scannedRootKeys.has(key)) continue;
      if (Array.isArray(value) || isPlainObject(value)) {
        scanNode(value, 0, state);
      }
    }
  }

  return { links: state.links, upstreamError: false, malformed: state.malformed };
}
