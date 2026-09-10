import { protocolForUrl } from '$lib/server/resolver/safe-url';
import type { PlaybackProtocol } from '$lib/server/resolver/types';

/**
 * MAVERO Stremio stream resolver — stream response validation + normalization
 * (Phase 3).
 *
 * Converts an untrusted addon stream response into a predictable internal
 * representation. The addon JSON is NEVER trusted: every entry is classified
 * and only DIRECT HTTP/HTTPS media URLs may become playable sources.
 *
 * Hard HTTP/HLS-only policy (spec §11, §14–§16):
 *   * non-http(s) URL schemes are rejected (magnet:, javascript:, data:,
 *     blob:, file:, chrome-extension:, …)
 *   * torrent/P2P/debrid signals (infoHash fields, legacy `sources`/`peers`
 *     torrent fields, `.torrent` paths, torrent/debrid URL tokens) are
 *     rejected — torrent metadata is never transformed into a URL
 *   * `externalUrl` entries are "open elsewhere" links by protocol — never
 *     playable media — and are skipped
 *   * streams requiring custom request headers
 *     (`behaviorHints.proxyHeaders`) are EXCLUDED from the playable list:
 *     HTML5 playback cannot attach arbitrary headers, and Mavero does not
 *     proxy media in Phase 3. The requirement is preserved as in-memory
 *     diagnostics (header NAMES only, never values)
 *   * only the stream object's direct `url` field can become a source; no
 *     webpage URL is ever promoted to a media URL
 *
 * Server-fetch boundary (spec §12/§32): stream URLs are validated but NEVER
 * fetched by Mavero — the browser/player fetches them later. Media URLs
 * therefore get protocol/credential/torrent validation, not manifest-grade
 * SSRF/DNS blocking: the Mavero server never connects to them, and
 * legitimate unfamiliar CDN hostnames must not be rejected.
 *
 * Pure synchronous code — no I/O.
 */

export const STREAM_URL_MAX_LENGTH = 2048;
/** Defensive bound on entries processed per response. */
export const MAX_STREAM_ENTRIES = 200;
const FIELD_TEXT_MAX_LENGTH = 300;

/** Why one stream entry was excluded from the playable list (in-memory diagnostics). */
export type StreamSkipReason =
  | 'not-an-object'
  | 'missing-url'
  | 'invalid-url'
  | 'non-http-url'
  | 'credential-url'
  | 'torrent'
  | 'external-url'
  | 'header-dependent';

export type StremioStreamQuality = {
  /** Human label (`1080p`, or `Auto` when nothing confident is available). */
  label: string;
  height?: number;
  bitrate?: number;
};

export type NormalizedStremioStream = {
  /** Position of the entry inside the addon's `streams` array. */
  index: number;
  name?: string;
  title?: string;
  /** Validated DIRECT http(s) media URL — preserved verbatim (never rewritten). */
  url: string;
  protocol: PlaybackProtocol;
  /** Whether the playable URL is http or https (mixed-content decisions belong to later phases). */
  transport: 'http' | 'https';
  quality: StremioStreamQuality;
  bingeGroup?: string;
  filename?: string;
  videoSize?: number;
};

export type UnsupportedStremioStream = {
  index: number;
  name?: string;
  title?: string;
  url?: string;
  reason: StreamSkipReason;
  /** Header NAMES required via behaviorHints.proxyHeaders — never values. */
  requiredHeaderNames?: string[];
};

export type NormalizedStremioStreamResponse = {
  /** False when the response is not a `{ streams: [...] }` object at all. */
  valid: boolean;
  streams: NormalizedStremioStream[];
  unsupported: UnsupportedStremioStream[];
};

/**
 * Torrent/P2P stream SHAPES: legacy Stremio torrent streams carried
 * infoHash/sources/peers fields; debrid integrations expose magnet/debrid
 * fields. Any of these marks the whole entry as a torrent stream — never a
 * playable HTTP source (spec §15). Values are never read or stored.
 */
const TORRENT_STREAM_FIELDS: ReadonlySet<string> = new Set([
  'infoHash',
  'infohash',
  'info_hash',
  'magnetUri',
  'magnet',
  'btih',
  'sources',
  'peers',
]);

/** Unambiguous torrent/debrid URL tokens checked against hostname + path. */
const TORRENT_URL_TOKENS: readonly string[] = ['torrent', 'magnet', 'bittorrent', 'btih', 'debrid', 'infohash', 'info_hash'];

/** Heights Mavero confidently recognizes (no aggressive guesses). */
const KNOWN_QUALITY_HEIGHTS: ReadonlySet<number> = new Set([2160, 1440, 1080, 720, 576, 540, 480, 360, 240, 144]);
const QUALITY_HEIGHT_PATTERN = /\b(2160|1440|1080|720|576|540|480|360|240|144)p\b/i;

function textField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, FIELD_TEXT_MAX_LENGTH) : undefined;
}

function urlLooksTorrentish(url: URL): boolean {
  const target = `${url.hostname}${url.pathname}`.toLowerCase();
  if (TORRENT_URL_TOKENS.some((token) => target.includes(token))) return true;
  return url.pathname.toLowerCase().endsWith('.torrent');
}

function proxyHeaderNames(hints: Record<string, unknown>): string[] {
  const value = hints.proxyHeaders;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((key) => key.trim().length > 0 && key.length <= 100)
    .slice(0, 20);
}

function extractHeight(text: string): number | undefined {
  if (/\b4k\b/i.test(text) || /\buhd\b/i.test(text)) return 2160;
  const match = QUALITY_HEIGHT_PATTERN.exec(text);
  if (!match) return undefined;
  const height = Number(match[1]);
  return KNOWN_QUALITY_HEIGHTS.has(height) ? height : undefined;
}

/**
 * Conservative quality extraction (spec §20): the most specific available
 * text wins (filename → title → name). Unknown quality becomes the label
 * `Auto` — no resolution is ever fabricated. Bitrate is only kept when the
 * addon states it; Mavero never derives one.
 */
function extractQuality(name: string | undefined, title: string | undefined, filename: string | undefined): StremioStreamQuality {
  for (const text of [filename, title, name]) {
    if (!text) continue;
    const height = extractHeight(text);
    if (height !== undefined) return { label: `${height}p`, height };
  }
  return { label: 'Auto' };
}

function behaviorHintsOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const hints = entry.behaviorHints;
  return hints && typeof hints === 'object' && !Array.isArray(hints) ? (hints as Record<string, unknown>) : undefined;
}

function classifyStreamEntry(entry: unknown, index: number, streams: NormalizedStremioStream[], unsupported: UnsupportedStremioStream[]): void {
  const name = entry && typeof entry === 'object' && !Array.isArray(entry) ? textField((entry as Record<string, unknown>).name) : undefined;
  const title = entry && typeof entry === 'object' && !Array.isArray(entry) ? textField((entry as Record<string, unknown>).title) : undefined;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    unsupported.push({ index, reason: 'not-an-object' });
    return;
  }
  const record = entry as Record<string, unknown>;

  // externalUrl = "open this elsewhere" by protocol — never playable media
  // for Mavero (spec §14). Skipped regardless of any other fields.
  const externalUrl = textField(record.externalUrl);
  if (externalUrl) {
    unsupported.push({ index, name, title, url: externalUrl, reason: 'external-url' });
    return;
  }

  // Torrent/P2P stream shapes (spec §15): rejected outright — torrent
  // metadata is never transformed into a URL, even when a direct URL also
  // happens to be present (conservative: Mavero never accepts
  // torrent-tagged streams).
  if ([...TORRENT_STREAM_FIELDS].some((field) => record[field] !== undefined && record[field] !== null)) {
    unsupported.push({ index, name, title, reason: 'torrent' });
    return;
  }

  const rawUrl = record.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    unsupported.push({ index, name, title, reason: 'missing-url' });
    return;
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > STREAM_URL_MAX_LENGTH || /[\s\u0000-\u001f]/.test(trimmed)) {
    unsupported.push({ index, name, title, url: trimmed, reason: 'invalid-url' });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    unsupported.push({ index, name, title, url: trimmed, reason: 'invalid-url' });
    return;
  }
  // http/https only (spec §11) — this single check also kills magnet:,
  // javascript:, data:, blob:, file:, chrome-extension: and every other scheme.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    unsupported.push({ index, name, title, url: trimmed, reason: 'non-http-url' });
    return;
  }
  if (parsed.username || parsed.password) {
    unsupported.push({ index, name, title, url: trimmed, reason: 'credential-url' });
    return;
  }
  if (urlLooksTorrentish(parsed)) {
    unsupported.push({ index, name, title, url: trimmed, reason: 'torrent' });
    return;
  }

  const hints = behaviorHintsOf(record);
  const headerNames = hints ? proxyHeaderNames(hints) : [];
  if (headerNames.length) {
    // Header-dependent streams (spec §16): HTML5 playback cannot attach
    // arbitrary request headers and Mavero builds no proxy in Phase 3 —
    // excluded from the playable list, requirement preserved as diagnostics.
    unsupported.push({ index, name, title, url: trimmed, reason: 'header-dependent', requiredHeaderNames: headerNames });
    return;
  }

  const filename = hints && typeof hints.filename === 'string' ? hints.filename.slice(0, FIELD_TEXT_MAX_LENGTH) : undefined;
  const rawVideoSize = hints?.videoSize;
  const videoSize = typeof rawVideoSize === 'number' && Number.isSafeInteger(rawVideoSize) && rawVideoSize > 0 ? rawVideoSize : undefined;
  const bingeGroup = hints && typeof hints.bingeGroup === 'string' ? hints.bingeGroup.slice(0, FIELD_TEXT_MAX_LENGTH) : undefined;

  // Preserve the URL exactly (spec §13): no silent http→https rewrite.
  const normalizedUrl = parsed.toString();
  streams.push({
    index,
    name,
    title,
    url: normalizedUrl,
    protocol: protocolForUrl(normalizedUrl),
    transport: parsed.protocol === 'https:' ? 'https' : 'http',
    quality: extractQuality(name, title, filename),
    bingeGroup,
    filename,
    videoSize,
  });
}

/**
 * Validates a parsed-JSON stream response and classifies every entry into
 * playable streams and excluded (unsupported) entries. A response that is
 * not an object, or whose `streams` is missing/not an array, is INVALID
 * (typed addon failure) — an EMPTY `streams` array is valid and simply
 * yields zero streams.
 */
export function normalizeStremioStreamResponse(value: unknown): NormalizedStremioStreamResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, streams: [], unsupported: [] };
  }
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.streams)) {
    return { valid: false, streams: [], unsupported: [] };
  }
  const streams: NormalizedStremioStream[] = [];
  const unsupported: UnsupportedStremioStream[] = [];
  const entries = payload.streams.length > MAX_STREAM_ENTRIES ? payload.streams.slice(0, MAX_STREAM_ENTRIES) : payload.streams;
  entries.forEach((entry, index) => classifyStreamEntry(entry, index, streams, unsupported));
  return { valid: true, streams, unsupported };
}
