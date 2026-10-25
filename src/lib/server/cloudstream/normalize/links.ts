/**
 * MAVERO CloudStream link normalization (CS-2 — plan §8/§40.3/§40.6).
 *
 * The single construction + normalization point for CloudStream resolved
 * links. Quality parsing is a faithful port of the providers' Kotlin
 * `getIndexQuality`; size parsing handles the `[5.8 GB]` display forms the
 * extractors emit. Action semantics stay EXACTLY `stream-actions.ts`
 * (downstream CS-4) — CloudStream never invents its own capability model.
 */

import type { StreamKind } from '$lib/shared/stream-actions';

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * The stable normalized CloudStream result model (plan §40.3). Aligned with
 * the existing downloader stream view: `kind` uses the SAME vocabulary as
 * `StreamKind`, so action capabilities map EXACTLY onto stream-actions.
 */
export type CloudStreamNormalizedLink = {
  url: string;
  kind: StreamKind;
  quality?: string;
  codec?: string;
  container?: string;
  filename?: string;
  sizeBytes?: number;
  audioLanguages?: string[];
  /** Derived server-side for display (matches Stremio downloader §B2). */
  host?: string;
  /** Which provider produced this link (adapter id). */
  provider: string;
  /** Display label of the hosting server (e.g. 'GDFlix [Direct]'). */
  sourceName: string;
  /** Extractor that resolved this link, when applicable. */
  extractor?: string;
};

/** Raw link produced by an extractor port before provider attribution. */
export type CloudStreamExtractedLink = {
  url: string;
  kind: StreamKind;
  quality?: string;
  filename?: string;
  sizeBytes?: number;
  /** Extractor display label including server suffix ('GDFlix [Direct]'). */
  sourceName: string;
  /** Extractor id that produced this link. */
  extractor: string;
  /** File-name-derived codec/container when detectable. */
  codec?: string;
  container?: string;
  audioLanguages?: string[];
};

// ---------------------------------------------------------------------------
// Quality parsing — faithful port of getIndexQuality (all 4 Kotlin files)
// ---------------------------------------------------------------------------

/**
 * Extracts a numeric quality from free text: `1080p`→1080, `720P`→720,
 * `2160p`→2160, `8k`→4320, `4k`→2160, `2k`→1440. Unknown → undefined.
 */
export function parseIndexQuality(text: string | null | undefined): number | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const pMatch = /(\d{3,4})[pP]/.exec(text);
  if (pMatch) {
    const value = Number.parseInt(pMatch[1]!, 10);
    if (Number.isInteger(value) && value > 0) return value;
  }
  const lower = text.toLowerCase();
  if (lower.includes('8k')) return 4320;
  if (lower.includes('4k')) return 2160;
  if (lower.includes('2k')) return 1440;
  return undefined;
}

/** Human quality label from a numeric quality (1080 → '1080p'). */
export function qualityLabel(quality: number | undefined): string | undefined {
  if (quality === undefined || !Number.isInteger(quality) || quality <= 0) return undefined;
  return `${quality}p`;
}

// ---------------------------------------------------------------------------
// Size parsing — the `[5.8 GB]` / `1.3GB` / `450 MB` display forms
// ---------------------------------------------------------------------------

const SIZE_UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  kib: 1_024,
  mb: 1_000_000,
  mib: 1_048_576,
  gb: 1_000_000_000,
  gib: 1_073_741_824,
  tb: 1_000_000_000_000,
};

/** Parses '5.8 GB', '1.3GB', '450 MB', '1024 kB' into bytes. */
export function parseSizeBytes(text: string | null | undefined): number | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const match = /(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb)\b/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  const multiplier = SIZE_UNIT_MULTIPLIERS[unit];
  if (!Number.isFinite(value) || multiplier === undefined) return undefined;
  const bytes = Math.round(value * multiplier);
  // Sanity bound: > 10 TiB is not a single-file download link.
  if (bytes <= 0 || bytes > 10 * 1_099_511_627_776) return undefined;
  return bytes;
}

// ---------------------------------------------------------------------------
// Codec / container detection from file names (heuristic, display-only)
// ---------------------------------------------------------------------------

const CODEC_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:x264|h\.?264|avc)\b/i, 'H.264'],
  [/\b(?:x265|h\.?265|hevc)\b/i, 'H.265'],
  [/\b(?:x266|h\.?266|vvc)\b/i, 'H.266'],
  [/\bav1\b/i, 'AV1'],
  [/\b(?:xvid|divx)\b/i, 'Xvid'],
  [/\b(?:vp9|vp09)\b/i, 'VP9'],
];

const CONTAINER_PATTERNS: Array<[RegExp, string]> = [
  [/\.(?:mkv|mk3d)\b/i, 'MKV'],
  [/\.(?:mp4|m4v|mp4v)\b/i, 'MP4'],
  [/\.(?:avi)\b/i, 'AVI'],
  [/\.(?:mov|qt)\b/i, 'MOV'],
  [/\.(?:wmv)\b/i, 'WMV'],
  [/\.(?:flv)\b/i, 'FLV'],
  [/\.(?:webm)\b/i, 'WEBM'],
  [/\.(?:mpg|mpeg|ts|m2ts)\b/i, 'MPEG'],
];

/** Best-effort codec label from a file name (display-only, never invented). */
export function detectCodec(filename: string | null | undefined): string | undefined {
  if (typeof filename !== 'string' || !filename) return undefined;
  for (const [pattern, label] of CODEC_PATTERNS) {
    if (pattern.test(filename)) return label;
  }
  return undefined;
}

/** Best-effort container label from a file name (display-only). */
export function detectContainer(filename: string | null | undefined): string | undefined {
  if (typeof filename !== 'string' || !filename) return undefined;
  for (const [pattern, label] of CONTAINER_PATTERNS) {
    if (pattern.test(filename)) return label;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Audio-language detection (heuristic, display-only)
// ---------------------------------------------------------------------------

const LANGUAGE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:dual[ _-]?audio)\b/i, 'Hindi'],
  [/\b(?:english|eng)\b/i, 'English'],
  [/\b(?:hindi|hin)\b/i, 'Hindi'],
  [/\b(?:tamil|tam)\b/i, 'Tamil'],
  [/\b(?:telugu|tel)\b/i, 'Telugu'],
  [/\b(?:bengali|bangla)\b/i, 'Bengali'],
  [/\b(?:punjabi)\b/i, 'Punjabi'],
  [/\b(?:marathi)\b/i, 'Marathi'],
  [/\b(?:urdu)\b/i, 'Urdu'],
  [/\b(?:chinese|mandarin)\b/i, 'Chinese'],
  [/\b(?:korean|kor)\b/i, 'Korean'],
  [/\b(?:japanese|jpn|jp)\b/i, 'Japanese'],
];

/** Best-effort audio language list from free text (display-only). */
export function detectAudioLanguages(text: string | null | undefined): string[] | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const found: string[] = [];
  for (const [pattern, label] of LANGUAGE_PATTERNS) {
    if (pattern.test(text) && !found.includes(label)) found.push(label);
  }
  return found.length > 0 ? found : undefined;
}

// ---------------------------------------------------------------------------
// Kind classification + host derivation
// ---------------------------------------------------------------------------

/** Classifies a resolved URL into the shared StreamKind vocabulary. */
export function classifyUrlKind(url: string): StreamKind {
  if (url.startsWith('magnet:')) return 'magnet';
  if (url.startsWith('https://')) return 'https';
  if (url.startsWith('http://')) return 'http';
  if (/\.m3u8(?:\?|$)/i.test(url)) return 'hls';
  if (/\.mpd(?:\?|$)/i.test(url)) return 'dash';
  return 'external';
}

/** Lowercased host for display (leading www. stripped; undefined when absent). */
export function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!host) return undefined;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return undefined;
  }
}

/** Pixeldrain API download-URL conversion (port of the Kotlin pattern). */
export function pixeldrainDownloadUrl(link: string): string | null {
  try {
    const url = new URL(link);
    if (!/^(?:www\.)?pixeldrain\.(?:com|io)$/i.test(url.hostname)) return null;
    const fileId = url.pathname.split('/').filter(Boolean).pop();
    if (!fileId) return null;
    if (/\/download$/i.test(url.pathname)) return link;
    return `https://pixeldrain.com/api/file/${fileId}?download`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalization + dedup
// ---------------------------------------------------------------------------

/** Normalizes one raw link into the stable model (host + metadata derived). */
export function normalizeCloudStreamLink(link: CloudStreamExtractedLink, provider: string): CloudStreamNormalizedLink {
  const normalized: CloudStreamNormalizedLink = {
    url: link.url,
    kind: link.kind,
    provider,
    sourceName: link.sourceName,
    host: hostOf(link.url),
  };
  if (link.quality !== undefined) normalized.quality = link.quality;
  if (link.filename !== undefined) normalized.filename = link.filename;
  if (link.sizeBytes !== undefined) normalized.sizeBytes = link.sizeBytes;
  if (link.codec !== undefined) normalized.codec = link.codec;
  if (link.container !== undefined) normalized.container = link.container;
  if (link.audioLanguages !== undefined && link.audioLanguages.length > 0) normalized.audioLanguages = link.audioLanguages;
  if (link.extractor !== undefined) normalized.extractor = link.extractor;
  return normalized;
}

/** True-URL dedup (plan §40.3: exact duplicates collapse, diversity kept). */
export function dedupeCloudStreamLinks(links: CloudStreamNormalizedLink[]): CloudStreamNormalizedLink[] {
  const seen = new Set<string>();
  const result: CloudStreamNormalizedLink[] = [];
  for (const link of links) {
    if (typeof link.url !== 'string' || link.url.length === 0) continue;
    const key = link.url;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}

/**
 * Builds a normalized link from an extractor result + provider attribution,
 * deriving quality/size/codec/container labels from the file name when the
 * extractor did not supply them (single derivation point).
 */
export function buildNormalizedLink(
  extracted: CloudStreamExtractedLink,
  provider: string,
): CloudStreamNormalizedLink {
  const enriched: CloudStreamExtractedLink = { ...extracted };
  if (enriched.quality === undefined && enriched.filename !== undefined) {
    const numeric = parseIndexQuality(enriched.filename);
    if (numeric !== undefined) enriched.quality = qualityLabel(numeric);
  }
  if (enriched.sizeBytes === undefined && enriched.filename !== undefined) {
    enriched.sizeBytes = parseSizeBytes(enriched.filename);
  }
  if (enriched.codec === undefined) enriched.codec = detectCodec(enriched.filename);
  if (enriched.container === undefined) enriched.container = detectContainer(enriched.filename);
  if (enriched.audioLanguages === undefined && enriched.filename !== undefined) {
    const languages = detectAudioLanguages(enriched.filename);
    if (languages !== undefined) enriched.audioLanguages = languages;
  }
  return normalizeCloudStreamLink(enriched, provider);
}
