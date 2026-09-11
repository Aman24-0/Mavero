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
/** Defensive bound on addon-provided subtitle tracks per stream (Phase 9). */
export const MAX_STREAM_SUBTITLES = 8;

/**
 * Phase 9: one addon-provided subtitle track, preserved verbatim. The URL is
 * validated for the PLAYBACK boundary later (https-only, credential-free);
 * here it is only shape-checked — subtitle URLs are never fetched by Mavero.
 */
export type NormalizedStreamSubtitle = {
  url: string;
  language?: string;
  label?: string;
};

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
  /** Addon-provided stream description (Phase 9, plain text). */
  description?: string;
  /** Validated DIRECT http(s) media URL — preserved verbatim (never rewritten). */
  url: string;
  protocol: PlaybackProtocol;
  /** Whether the playable URL is http or https (mixed-content decisions belong to later phases). */
  transport: 'http' | 'https';
  quality: StremioStreamQuality;
  bingeGroup?: string;
  filename?: string;
  videoSize?: number;
  /** Audio languages derived from ADDON-SUPPLIED text only (Phase 9). */
  audioLanguages?: string[];
  /** Container label derived from the addon filename/URL extension (Phase 9). */
  container?: string;
  /** Video codec label derived from ADDON-SUPPLIED text only (Phase 9). */
  codec?: string;
  /** Addon-provided subtitle tracks, shape-checked (Phase 9). */
  subtitles?: NormalizedStreamSubtitle[];
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

// ---------------------------------------------------------------------------
// Phase 9 — conservative metadata derivation from ADDON-SUPPLIED text.
//
// Everything below reads ONLY what the addon itself wrote into name/title/
// description/filename/URL. Mavero never invents a value: a language, codec
// or container label is emitted ONLY when the addon's own text (or the URL
// filename extension) explicitly carries it. Nothing is ever derived from the
// addon NAME, the content title or the country of origin.
// ---------------------------------------------------------------------------

/**
 * Audio-language lexicon for word-boundary detection in addon labels.
 * Deliberately narrow: common Indian + international audio languages that
 * Stremio addons actually write into stream names/titles (e.g.
 * "1080p HEVC Hindi 5.1", "Audio: Tamil").
 */
const AUDIO_LANGUAGE_WORDS: readonly string[] = [
  'Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Bengali',
  'Punjabi', 'Marathi', 'Gujarati', 'Urdu', 'Japanese', 'Korean', 'Mandarin',
  'Cantonese', 'Chinese', 'Spanish', 'French', 'German', 'Italian', 'Russian',
  'Arabic', 'Turkish', 'Portuguese', 'Indonesian', 'Thai', 'Vietnamese', 'Polish',
];
const AUDIO_LANGUAGE_PATTERN = new RegExp(
  `\\b(${AUDIO_LANGUAGE_WORDS.join('|')})\\b`,
  'gi',
);
/** Maximum audio languages displayed per stream (multi-audio files list two). */
const MAX_AUDIO_LANGUAGES = 2;

/**
 * Detects audio languages in ADDON-SUPPLIED text by word-boundary matching.
 * Returns them in order of first appearance, deduplicated, capped at two.
 * Never called with addon display names or content titles.
 */
export function detectAudioLanguages(texts: Array<string | undefined>): string[] | undefined {
  const found: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(AUDIO_LANGUAGE_PATTERN)) {
      const language = match[1];
      // Canonical capitalization from the lexicon (addon text may shout).
      const canonical = AUDIO_LANGUAGE_WORDS.find((word) => word.toLowerCase() === language.toLowerCase());
      if (canonical && !found.includes(canonical)) found.push(canonical);
      if (found.length >= MAX_AUDIO_LANGUAGES) return found;
    }
  }
  return found.length ? found : undefined;
}

/**
 * Video-codec labels detected ONLY in addon-supplied text. Canonicalized to
 * display labels; the first recognized token wins (streams advertise one
 * primary video codec).
 */
const CODEC_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bhevc\b|\bh\.?265\b|\bx265\b/i, 'HEVC'],
  [/\bh\.?264\b|\bavc\b|\bx264\b/i, 'H.264'],
  [/\bav1\b/i, 'AV1'],
  [/\bvp9\b/i, 'VP9'],
  [/\bmpeg-?2\b/i, 'MPEG-2'],
  [/\bdivx\b|\bxvid\b/i, 'DivX/Xvid'],
];

export function detectVideoCodec(texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    for (const [pattern, label] of CODEC_LABELS) {
      if (pattern.test(text)) return label;
    }
  }
  return undefined;
}

/**
 * Container labels derived from the FILE EXTENSION of the addon-supplied
 * filename (preferred) or the URL pathname. A recognized extension becomes a
 * display label ("MKV"); anything else stays absent — never guessed.
 */
const CONTAINER_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['mkv', 'MKV'], ['mp4', 'MP4'], ['webm', 'WebM'], ['avi', 'AVI'],
  ['mov', 'MOV'], ['m4v', 'M4V'], ['ts', 'TS'], ['flv', 'FLV'], ['wmv', 'WMV'],
]);

export function detectContainer(filename: string | undefined, url: string): string | undefined {
  const candidates = [filename, url.split('#')[0].split('?')[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = /\.([a-z0-9]{2,4})$/i.exec(candidate.trim());
    const label = match ? CONTAINER_EXTENSIONS.get(match[1].toLowerCase()) : undefined;
    if (label) return label;
  }
  return undefined;
}

/**
 * Phase 12 (GOAL B): container label derived from ANY addon-supplied text.
 * Real scraper addons frequently serve extensionless URLs
 * (`https://provider.example/download/123`) while writing the container into
 * the stream's own text — `name: "Dhurandhar The Revenge (2026).mkv"`,
 * `title: "... WEB-DL ... .mkv"`, `description: "... .mkv ..."`. The addon
 * WROTE that fact, so it is a reliable container signal even though neither
 * the filename nor the URL carries an extension. The extension must appear
 * at a word-ish boundary (`.mkv` not followed by an alphanumeric) and only
 * recognized container extensions count — ordinary words never match.
 */
export function detectContainerFromTexts(texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    for (const [extension, label] of CONTAINER_EXTENSIONS) {
      if (new RegExp(`\\.${extension}(?![a-z0-9])`, 'i').test(text)) return label;
    }
  }
  return undefined;
}

/**
 * Shape-checks one addon-provided subtitle entry: http(s) URL (no
 * credentials, bounded length), optional language/label text. Anything
 * malformed is dropped silently — subtitle entries never fail the stream.
 */
function normalizeSubtitleEntry(entry: unknown): NormalizedStreamSubtitle | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const rawUrl = typeof record.url === 'string' ? record.url.trim() : '';
  if (!rawUrl || rawUrl.length > STREAM_URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  const language = textField(record.lang) ?? textField(record.language);
  const label = textField(record.label);
  return {
    url: parsed.toString(),
    ...(language ? { language } : {}),
    ...(label ? { label } : {}),
  };
}

function normalizeSubtitleTracks(value: unknown): NormalizedStreamSubtitle[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tracks: NormalizedStreamSubtitle[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_STREAM_SUBTITLES * 2)) {
    if (tracks.length >= MAX_STREAM_SUBTITLES) break;
    const track = normalizeSubtitleEntry(entry);
    if (!track || seen.has(track.url)) continue;
    seen.add(track.url);
    tracks.push(track);
  }
  return tracks.length ? tracks : undefined;
}

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
  // Phase 9: preserve the addon's own description text (plain text, bounded).
  const description = textField(record.description);
  const subtitles = normalizeSubtitleTracks(record.subtitles);

  // Preserve the URL exactly (spec §13): no silent http→https rewrite.
  const normalizedUrl = parsed.toString();
  // Phase 9 metadata derivation — strictly from ADDON-SUPPLIED text
  // (name/title/description/filename/URL). Language is never derived from
  // the addon display name, the content title or anything else.
  // Phase 12 (GOAL B): the codec lexicon ALSO reads the addon filename, and
  // the container ALSO falls back to an extension reference written in the
  // addon's own text — an extensionless URL whose name/title/description
  // carries ".mkv" must normalize with container MKV so the compatibility
  // classifier routes it to the remux path instead of a doomed direct play.
  const audioLanguages = detectAudioLanguages([name, title, description, filename]);
  const codec = detectVideoCodec([filename, name, title, description]);
  const container = detectContainer(filename, normalizedUrl) ?? detectContainerFromTexts([filename, name, title, description]);
  streams.push({
    index,
    name,
    title,
    ...(description ? { description } : {}),
    url: normalizedUrl,
    // Phase 11 (GOAL A): the protocol classifier receives the ADDON-SUPPLIED
    // text as well — an extensionless/signed HLS URL whose addon text
    // explicitly says HLS/m3u8 must normalize as `hls` (and later route to
    // the HLS engine) instead of `unknown` (native path → guaranteed
    // playback failure on non-Safari browsers). Only addon-supplied text is
    // eligible; nothing is guessed from the content title or addon name.
    protocol: protocolForUrl(normalizedUrl, { ...(name ? { name } : {}), ...(title ? { title } : {}), ...(description ? { description } : {}), ...(filename ? { filename } : {}) }),
    transport: parsed.protocol === 'https:' ? 'https' : 'http',
    quality: extractQuality(name, title, filename),
    bingeGroup,
    filename,
    videoSize,
    ...(audioLanguages ? { audioLanguages } : {}),
    ...(codec ? { codec } : {}),
    ...(container ? { container } : {}),
    ...(subtitles ? { subtitles } : {}),
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
