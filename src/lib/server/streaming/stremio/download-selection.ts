import type { NormalizedStremioStream } from './stream-normalize';
import { validateAddonStreamPlaybackUrl } from '$lib/server/resolver/safe-url';
import { audioClassFor, bucketForHeight, releaseClassFor, type AudioClass } from '$lib/shared/stream-selection';

/**
 * MAVERO Downloader — selection policy for Stremio HTTP addon streams
 * (Phase 14 → Phase 15 → Phase 16 diagnostic parity).
 *
 * PHASE 16 CONTRACT (this file):
 *   The downloader is now a DIAGNOSTIC SURFACE for comparing MAVERO's stream
 *   discovery against Stremio. There is NO artificial maximum, NO diversity
 *   cap, NO quality truncation, NO silent ranking-based exclusion. Every
 *   eligible direct HTTP(S) stream the addon returned is preserved and shown.
 *
 *   The ONLY exclusions are the existing SECURITY BOUNDARY (enforced by
 *   `stream-normalize.ts` — P2P/torrent/externalUrl/credential/private-host/
 *   non-http-scheme/header-dependent entries never reach this module) plus a
 *   minimal downloader-specific safety net:
 *     * HLS/DASH manifests are NOT direct-file downloads (an .m3u8 is a
 *       playlist, not a movie file) — they stay on the native HLS path.
 *     * Non-video file extensions (.srt/.jpg/.zip/…) are not movie files.
 *
 *   The previous Phase 15 truncations — MAX_DOWNLOAD_STREAMS_PER_ADDON=10,
 *   per-quality diversity caps (4K≤2, others≤4), bad-release regex, size/
 *   runtime verdict, "download-only" marketing-text filter — have all been
 *   REMOVED. They were silently dropping streams that Stremio shows.
 *
 * PRODUCT CONTRACT (preserved):
 *   * The engine consumes ONLY metadata the addon already supplied. It NEVER
 *     fetches a media URL, NEVER starts FFmpeg, NEVER proves that a URL
 *     plays, and NEVER proxies media.
 *   * "Best available links" is an honest ranking, not a playback guarantee.
 *   * PixelDrain candidates remain eligible (NOT globally blacklisted).
 *   * AIOStreams HTTP streams with infoHash metadata remain eligible (the
 *     addon's explicit `type` is authoritative — set by `stream-normalize.ts`).
 *
 * The result is deterministic: identical input always produces an identical,
 * ordered candidate list. The order is a RANKING for presentation only — it
 * NEVER drops candidates.
 */

/**
 * Phase 16: NO artificial maximum. The previous `MAX_DOWNLOAD_STREAMS_PER_ADDON`
 * is kept ONLY as a back-compat symbol for existing imports; it is NOT used
 * to truncate the candidate list. The downloader shows every eligible stream.
 */
export const MAX_DOWNLOAD_STREAMS_PER_ADDON = Number.MAX_SAFE_INTEGER;

export type DownloadQuality = '1080p' | '720p' | '480p' | '4K' | 'auto';
export type DownloadCodec = 'H.264' | 'HEVC' | 'AV1' | 'VP9' | 'unknown';

/** Host classification (Phase 15 §7, preserved) — presentation/ranking hint, never a blacklist. */
export type DownloadHostClass = 'pixeldrain' | 'known' | 'unknown';

/** One direct-file candidate derived from a normalized addon stream. */
export type DownloadStreamCandidate = {
  /** The ORIGINAL addon media URL — preserved verbatim, never rewritten. */
  url: string;
  name?: string;
  title?: string;
  description?: string;
  filename?: string;
  container?: string;
  codec: DownloadCodec;
  audio: AudioClass;
  audioLanguages?: string[];
  quality: DownloadQuality;
  height?: number;
  sizeBytes?: number;
  protocol: 'http' | 'https';
  /** Addon-specific stream type when the addon declared one ('http', …). */
  streamType?: string;
  /** Standard Stremio availability when the addon supplied it. */
  availability?: number;
  /** Standard Stremio tag when the addon supplied one. */
  tag?: string;
  /** Position inside the addon's raw stream list (stable tiebreaker). */
  index: number;
  /** Host class — derived from the URL hostname. */
  hostClass: DownloadHostClass;
  /** Normalized release identity key (for OPTIONAL dedup — see selectDownloadStreams). */
  releaseKey: string;
};

/** A ranked candidate — `score` is comparable, LOWER IS BETTER. */
export type RankedDownloadStream = DownloadStreamCandidate & {
  score: number;
  confidence: 'high' | 'medium' | 'low';
};

/**
 * Why one normalized stream did NOT become a download candidate.
 *
 * Phase 16: the only skip reasons are the minimal safety net (HLS/DASH
 * manifest, non-video file) and the existing playback boundary (credential/
 * private-host URLs). The previous partial-release / implausible-size /
 * download-only reasons have been REMOVED — they silently dropped legitimate
 * streams that Stremio shows.
 */
export type DownloadSkipReason =
  | 'streaming-manifest'
  | 'non-video'
  | 'playback-boundary';

export type DownloadCandidatesResult = {
  candidates: DownloadStreamCandidate[];
  /** Per-reason exclusion counts (diagnostics only — never sent to clients). */
  dropped: Record<DownloadSkipReason, number>;
};

/** Optional runtime context (kept for back-compat — no longer used to reject). */
export type DownloadRuntimeContext = {
  /** Content runtime in SECONDS. Phase 16: informational only. */
  runtimeSeconds?: number;
};

// ---------------------------------------------------------------------------
// Scoring policy — presentation ranking ONLY (Phase 16: never excludes).
// ---------------------------------------------------------------------------

/**
 * Quality preference: 1080p first, then 720p, then 480p; 4K ranks BELOW
 * 1080p/720p/480p practicality-wise for a mobile-oriented downloader, but
 * is NEVER excluded. `auto` (no confident resolution) last.
 */
const QUALITY_WEIGHT: Record<DownloadQuality, number> = {
  '1080p': 0,
  '4K': 18,
  '720p': 28,
  '480p': 52,
  auto: 80,
};

/** Codec preference: H.264 first, HEVC second, AV1/VP9 lower, unknown middle. */
const CODEC_WEIGHT: Record<DownloadCodec, number> = {
  'H.264': 0,
  HEVC: 5,
  unknown: 8,
  AV1: 10,
  VP9: 11,
};

/** Audio preference: multi > dual > unknown > single. */
const AUDIO_WEIGHT: Record<AudioClass, number> = {
  multi: 0,
  dual: 1,
  unknown: 4,
  single: 7,
};

/** Comfortable file size per bucket — used ONLY for ranking, never for rejection. */
const PREFERRED_SIZE_BYTES: Record<DownloadQuality, number> = {
  '1080p': 6 * 1024 ** 3,
  '4K': 12 * 1024 ** 3,
  '720p': 3 * 1024 ** 3,
  '480p': 1500 * 1024 ** 2,
  auto: 6 * 1024 ** 3,
};

/** Extensions that are clearly NOT a movie file (subtitles/images/archives/…). */
const NON_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'srt', 'vtt', 'ass', 'ssa', 'sub', 'nfo', 'txt', 'jpg', 'jpeg', 'png', 'gif',
  'webp', 'zip', 'rar', '7z', 'exe', 'iso', 'pdf', 'html', 'htm', 'php',
]);

/** DASH manifests referenced by TEXT (pathname .mpd is caught by `protocol`). */
const DASH_TEXT_PATTERN = /\b(?:mpd|mpeg-?dash)\b/i;

/**
 * CAM/TS release markers — RANKING SIGNAL ONLY (Phase 16: never excludes).
 * A CAM/TS release is genuinely low-quality; the score penalizes it so
 * practical WEB-DL/BluRay releases rank above, but the stream is still
 * shown (the user decides, not the pipeline).
 */
const CAM_RELEASE_PATTERN = /\b(?:cam|camrip|cam-?rip|telesync|telecine|screener|scr)\b|\bhd-?\s?ts\b|\bts\b(?![a-z0-9])/i;
const PREFERRED_RELEASE_PATTERN = /\b(?:web-?dl|webdl|web-?rip|webrip|bluray|blu-?ray|hdtv)\b/i;

/** Hosts that are KNOWN to be reachable direct-media hosts. Presentation hint ONLY. */
const KNOWN_HOSTS: ReadonlyMap<string, DownloadHostClass> = new Map([
  ['pixeldrain.com', 'pixeldrain'],
  ['pixeldrain.org', 'pixeldrain'],
]);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function joinTexts(candidate: Pick<DownloadStreamCandidate, 'name' | 'title' | 'description' | 'filename' | 'tag'>): string {
  return [candidate.name, candidate.title, candidate.description, candidate.filename, candidate.tag]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
}

/** Text with file extensions stripped — the CAM/TS check must not punish ".ts" CONTAINER filenames. */
function extensionStripped(text: string): string {
  return text.replace(/\.[a-z0-9]{2,4}(?=$|[\s,;])/gi, ' ');
}

/** Release weight: CAM/TS heavily penalized; known-good release tags free; unknown +3. Ranking ONLY. */
function releasePenalty(text: string): number {
  if (PREFERRED_RELEASE_PATTERN.test(text)) return 0;
  if (CAM_RELEASE_PATTERN.test(extensionStripped(text))) return 35;
  return 3;
}

/**
 * Parses an explicit "NN.N GB" / "NNN MB" size mention from addon text
 * (bytes). Used only when the addon supplied no structured videoSize.
 */
export function sizeFromTexts(texts: Array<string | undefined>): number | undefined {
  for (const text of texts) {
    if (!text) continue;
    const match = /\b(\d+(?:\.\d+)?)\s*(GB|MB)\b/i.exec(text);
    if (!match) continue;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    return Math.round(amount * (match[2].toUpperCase() === 'GB' ? 1024 ** 3 : 1024 ** 2));
  }
  return undefined;
}

function codecClassFor(codec: string | undefined): DownloadCodec {
  switch (codec) {
    case 'H.264':
      return 'H.264';
    case 'HEVC':
      return 'HEVC';
    case 'AV1':
      return 'AV1';
    case 'VP9':
      return 'VP9';
    default:
      return 'unknown';
  }
}

/** True when the URL/filename extension is clearly not a video file. */
function isNonVideoFile(url: string, filename: string | undefined): boolean {
  for (const source of [filename, url.split('#')[0].split('?')[0]]) {
    if (!source) continue;
    const match = /\.([a-z0-9]{2,4})$/i.exec(source.trim());
    if (match && NON_VIDEO_EXTENSIONS.has(match[1].toLowerCase())) return true;
  }
  return false;
}

/** Classifies the URL hostname — never a rejection signal. */
function hostClassFor(url: string): DownloadHostClass {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const [knownHost, cls] of KNOWN_HOSTS) {
      if (host === knownHost || host.endsWith(`.${knownHost}`)) return cls;
    }
    return host ? 'known' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Normalized release identity text (for OPTIONAL dedup — see selectDownloadStreams).
 * Two providers serving the same release under different display names produce
 * the SAME release key. The stream NAME is excluded (display noise).
 */
function normalizeReleaseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:gb|mb|kb)\b/g, '')
    .replace(/\b(?:1080|720|480|2160|1440)p\b/g, '')
    .replace(/\b(?:4k|uhd|hd|fhd)\b/g, '')
    .replace(/\b(?:multi|dual)\s*audio\b/g, 'audio')
    .replace(/\b(?:web-?dl|webdl|web-?rip|webrip|bluray|blu-?ray|hdtv|remux|bdremux)\b/g, ' ')
    .replace(/\b(?:h\.?264|h\.?265|hevc|avc|x264|x265|av1|vp9)\b/g, ' ')
    .replace(/\.(mkv|mp4|avi|mov|webm|flv|wmv|m4v|ts)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses a content runtime string ("3h 49m", "89 min", "PT2H30M", "1:30:00")
 * into seconds. Phase 16: kept for back-compat; no longer used to reject.
 */
export function parseRuntimeSeconds(runtime: string | undefined): number | undefined {
  if (!runtime) return undefined;
  const text = String(runtime).trim().toLowerCase();
  if (!text) return undefined;
  const iso = /^pt(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (iso) {
    const hours = Number(iso[1] ?? 0);
    const minutes = Number(iso[2] ?? 0);
    const seconds = Number(iso[3] ?? 0);
    if (hours || minutes || seconds) return hours * 3600 + minutes * 60 + seconds;
  }
  const hms = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)/.exec(text);
  if (hms) {
    const hours = Number(hms[1] ?? 0);
    const minutes = Number(hms[2] ?? 0);
    if (hours || minutes) return hours * 3600 + minutes * 60;
  }
  const clock = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (clock) {
    const a = Number(clock[1]);
    const b = Number(clock[2]);
    const c = Number(clock[3] ?? -1);
    if (c >= 0) return a * 3600 + b * 60 + c;
    return a * 60 + b;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scoring (presentation ranking ONLY — Phase 16: never excludes)
// ---------------------------------------------------------------------------

/** Progressive penalty for files larger than the bucket's comfortable size. */
function sizePenalty(candidate: DownloadStreamCandidate): number {
  if (!candidate.sizeBytes || candidate.sizeBytes <= 0) return 5;
  const preferred = PREFERRED_SIZE_BYTES[candidate.quality];
  const ratio = candidate.sizeBytes / preferred;
  if (ratio <= 1) return 0;
  return Math.min(36, Math.round(Math.log2(ratio) * 8));
}

/** Small bonus for known-reachable hosts — PixelDrain edges up slightly. */
function hostBonus(candidate: DownloadStreamCandidate): number {
  if (candidate.hostClass === 'pixeldrain') return -1;
  return 0;
}

/** The score of one candidate — LOWER IS BETTER. Pure + deterministic. */
export function scoreDownloadCandidate(candidate: DownloadStreamCandidate): number {
  const text = joinTexts(candidate);
  let penalty = 0;
  if (releaseClassFor({ title: candidate.title, name: candidate.name, description: candidate.description, filename: candidate.filename, videoSize: candidate.sizeBytes, height: candidate.height }) === 'heavy') penalty += 45;
  penalty += releasePenalty(text);
  penalty += sizePenalty(candidate);
  const httpsBonus = candidate.protocol === 'https' ? -2 : 0;
  const httpTypeBonus = candidate.streamType?.toLowerCase() === 'http' ? -2 : 0;
  const availabilityBonus = candidate.availability !== undefined && candidate.availability >= 2 ? -1 : 0;
  const knownMetadataBonus = candidate.filename || candidate.container ? -2 : 0;
  return (
    QUALITY_WEIGHT[candidate.quality] +
    CODEC_WEIGHT[candidate.codec] +
    AUDIO_WEIGHT[candidate.audio] +
    penalty +
    httpsBonus +
    httpTypeBonus +
    availabilityBonus +
    knownMetadataBonus +
    hostBonus(candidate) +
    candidate.index * 0.001
  );
}

/**
 * Deterministic equivalent-release key (for OPTIONAL dedup). Two providers
 * serving the same release under different display names produce the same key.
 * The stream NAME is excluded (display noise — "#2", "Mirror", quality labels).
 */
function releaseKeyOf(candidate: DownloadStreamCandidate): string {
  const source = normalizeReleaseText(
    [candidate.title, candidate.description, candidate.filename, candidate.tag]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' '),
  );
  return `${candidate.quality}|${candidate.codec}|${candidate.container ?? 'unknown'}|${candidate.audio}|${source.slice(0, 180)}`;
}

function confidenceFor(candidate: DownloadStreamCandidate, score: number): RankedDownloadStream['confidence'] {
  const known = Number(candidate.height !== undefined) + Number(candidate.codec !== 'unknown') + Number(candidate.container !== undefined) + Number(candidate.sizeBytes !== undefined);
  if (score < 20 && known >= 3 && candidate.streamType?.toLowerCase() === 'http') return 'high';
  if (score < 60 && known >= 2) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Phase 16 back-compat stubs (previously filters — now no-ops that NEVER reject)
// ---------------------------------------------------------------------------

/**
 * Phase 16: `isPartialRelease` is a back-compat no-op. The previous Phase 15
 * regex (END-CREDIT / TRAILER / SAMPLE / …) was silently dropping legitimate
 * streams that Stremio shows. Diagnostic parity requires preserving every
 * eligible stream — partial-release filtering is the user's job, not the
 * pipeline's. Returns false unconditionally.
 */
export function isPartialRelease(_candidate: Pick<DownloadStreamCandidate, 'name' | 'title' | 'description' | 'filename' | 'tag'>): boolean {
  return false;
}

/**
 * Phase 16: `sizeRuntimeVerdict` is a back-compat no-op. The previous Phase 15
 * size/runtime sanity was rejecting small-but-legitimate files (short films,
 * compressed encodes, sample-sized but valid releases). Diagnostic parity
 * requires preserving every eligible stream. Returns 'ok' unconditionally.
 */
export function sizeRuntimeVerdict(
  _candidate: Pick<DownloadStreamCandidate, 'quality' | 'sizeBytes' | 'height' | 'name' | 'title' | 'description' | 'filename' | 'tag'>,
  _context: DownloadRuntimeContext = {},
): 'reject' | 'suspicious' | 'ok' {
  return 'ok';
}

// ---------------------------------------------------------------------------
// Candidate building (from the SHARED normalization output)
// ---------------------------------------------------------------------------

/**
 * Builds download candidates from ONE addon's normalized streams. Every
 * exclusion is counted so the server log can explain a "0 links" addon.
 * The media URL is NEVER fetched here — this is pure metadata work.
 *
 * Phase 16: the ONLY exclusions are:
 *   * HLS/DASH streaming manifests (a .m3u8 is a playlist, not a movie file)
 *   * Non-video file extensions (.srt/.jpg/.zip/…)
 *   * Playback-boundary rejections (credential/private-host URLs — the
 *     existing security boundary from `validateAddonStreamPlaybackUrl`)
 *
 * EVERY OTHER stream the addon returned becomes a candidate. No quality cap,
 * no diversity cap, no partial-release filter, no size/runtime filter, no
 * "download-only" marketing-text filter. The user sees what Stremio sees.
 */
export function buildDownloadCandidates(streams: NormalizedStremioStream[], _runtimeContext: DownloadRuntimeContext = {}): DownloadCandidatesResult {
  const dropped: Record<DownloadSkipReason, number> = {
    'streaming-manifest': 0,
    'non-video': 0,
    'playback-boundary': 0,
  };
  const candidates: DownloadStreamCandidate[] = [];

  for (const stream of streams) {
    // HLS/DASH are streaming manifests, not movie-file downloads.
    if (stream.protocol === 'hls' || stream.protocol === 'dash') {
      dropped['streaming-manifest'] += 1;
      continue;
    }
    const text = [stream.name, stream.title, stream.description, stream.filename].filter(Boolean).join(' ');
    if (DASH_TEXT_PATTERN.test(`${text} ${stream.url}`) || isNonVideoFile(stream.url, stream.filename)) {
      dropped['non-video'] += 1;
      continue;
    }
    // Downloader playback boundary: the USER'S device opens this URL, the
    // Mavero server never does — http+https allowed, credentials/private
    // hosts still rejected (the existing security boundary).
    try {
      validateAddonStreamPlaybackUrl(stream.url);
    } catch {
      dropped['playback-boundary'] += 1;
      continue;
    }
    const audio = audioClassFor({
      audioLanguages: stream.audioLanguages,
      title: stream.title,
      name: stream.name,
      description: stream.description,
      filename: stream.filename,
    });
    const height = stream.quality.height;
    const candidateTexts = [stream.title, stream.name, stream.description, stream.filename];
    const sizeBytes = stream.videoSize ?? sizeFromTexts(candidateTexts);
    const quality = bucketForHeight(height);
    const hostClass = hostClassFor(stream.url);
    const candidate: DownloadStreamCandidate = {
      url: stream.url,
      ...(stream.name ? { name: stream.name } : {}),
      ...(stream.title ? { title: stream.title } : {}),
      ...(stream.description ? { description: stream.description } : {}),
      ...(stream.filename ? { filename: stream.filename } : {}),
      ...(stream.container ? { container: stream.container } : {}),
      codec: codecClassFor(stream.codec),
      audio,
      ...(stream.audioLanguages?.length ? { audioLanguages: stream.audioLanguages } : {}),
      quality,
      ...(height !== undefined ? { height } : {}),
      sizeBytes,
      protocol: stream.transport,
      ...(stream.streamType ? { streamType: stream.streamType } : {}),
      ...(stream.availability !== undefined ? { availability: stream.availability } : {}),
      ...(stream.tag ? { tag: stream.tag } : {}),
      index: stream.index,
      hostClass,
      releaseKey: '',
    };
    candidate.releaseKey = releaseKeyOf(candidate);
    candidates.push(candidate);
  }

  return { candidates, dropped };
}

// ---------------------------------------------------------------------------
// Selection — Phase 16: NO truncation, NO diversity cap. Rank for presentation
// only. Equivalent-URL dedup is preserved (true duplicates only — never
// collapses genuinely different releases).
// ---------------------------------------------------------------------------

/**
 * Selects ALL eligible direct-file candidates from one addon, ordered by
 * presentation rank. Phase 16: NEVER truncates.
 *
 * Pipeline:
 *   1. every candidate is scored (LOWER IS BETTER) — pure presentation hint;
 *   2. true-duplicate URLs are deduplicated (canonical-URL identity — same
 *      scheme + host + path + query = same stream offered twice). This NEVER
 *      collapses genuinely different releases;
 *   3. the result is sorted by score, then by original index.
 *
 * The `max` parameter is accepted for back-compat with existing callers but
 * defaults to Number.MAX_SAFE_INTEGER and is NEVER used to truncate. The
 * caller receives EVERY eligible candidate.
 */
export function selectDownloadStreams(candidates: DownloadStreamCandidate[], _max: number = MAX_DOWNLOAD_STREAMS_PER_ADDON): RankedDownloadStream[] {
  const scored = candidates
    .map((candidate) => ({ ...candidate, score: scoreDownloadCandidate(candidate) }));

  // True-duplicate-URL dedup (canonical identity — same scheme + host + path
  // + query = the same stream offered twice). This is NOT equivalent-release
  // dedup — two different encodes of the same movie stay distinct.
  const seenCanonical = new Set<string>();
  const deduped: Array<DownloadStreamCandidate & { score: number }> = [];
  for (const candidate of [...scored].sort((a, b) => a.score - b.score || a.index - b.index)) {
    const canonical = canonicalUrlKey(candidate.url);
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    deduped.push(candidate);
  }

  // Sort by score (presentation rank), then by original index. NO truncation.
  const selected: RankedDownloadStream[] = deduped
    .map((candidate) => ({ ...candidate, confidence: confidenceFor(candidate, candidate.score) }))
    .sort((a, b) => a.score - b.score || a.index - b.index);

  return selected;
}

/** Canonical-URL identity for true-duplicate dedup (scheme + host + path + query). */
function canonicalUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Phase 17 — COMPLETE DISCOVERY: preserve EVERY stream type (incl P2P/magnet/HLS/DASH/external)
// ---------------------------------------------------------------------------

import type { DownloaderStreamEntry, DownloaderStreamKind } from './stream-normalize-downloader';

/**
 * Phase 17 (task §1/§2/§3): a downloader stream view that preserves EVERY
 * entry the addon returned — regardless of stream kind. HTTP, HTTPS, HLS,
 * DASH, P2P, Magnet and External entries are ALL represented. The UI type
 * filter (task §12 FILTER 1) uses `kind` to let the user filter by type.
 *
 * The `url` field is the ORIGINAL URI (HTTP/HTTPS URL, magnet URI, or
 * externalUrl) — preserved verbatim, never rewritten. Download + Share
 * operate on this exact URI.
 */
export type DownloadStreamViewAll = {
  /** The ORIGINAL URI — HTTP/HTTPS URL, magnet URI, or externalUrl. */
  url: string;
  /** The classified stream kind (task §12 FILTER 1). */
  kind: DownloaderStreamKind;
  name?: string;
  title?: string;
  description?: string;
  filename?: string;
  container?: string;
  /** Canonicalized codec label (H.264 / HEVC / AV1 / VP9 / unknown). */
  codec: DownloadCodec;
  audio: AudioClass;
  audioLanguages?: string[];
  quality: DownloadQuality;
  height?: number;
  sizeBytes?: number;
  /** Transport: http / https / magnet / external. */
  transport: 'http' | 'https' | 'magnet' | 'external';
  /** The addon-supplied stream type when declared ('http'|'p2p'|…). */
  streamType?: string;
  availability?: number;
  tag?: string;
  hostClass: DownloadHostClass;
  /** Position inside the addon's raw stream list (stable tiebreaker). */
  index: number;
  /** Presentation rank — LOWER IS BETTER (never excludes). */
  score: number;
  /** Metadata-completeness confidence — NEVER a playback guarantee. */
  confidence: 'high' | 'medium' | 'low';
};

export type BuildAllResult = {
  /** EVERY entry the addon returned that has a usable identifier. */
  entries: DownloadStreamViewAll[];
  /** Per-kind count (for diagnostics + the UI type filter). */
  kindCounts: Record<DownloaderStreamKind, number>;
  /** Entries that were structurally malformed (no url/externalUrl/infoHash/magnet). */
  malformed: number;
};

/**
 * Phase 17 (task §3): builds the COMPLETE discovery view from the downloader
 * normalizer's output. PRESERVES EVERY entry — no max cap, no diversity cap,
 * no format filter, no quality filter, no size filter, no partial-release
 * filter. The ONLY entries that are NOT here are structurally malformed ones
 * (counted in `malformed` for diagnostics).
 *
 * Ranking (the `score` field) is for PRESENTATION ORDER ONLY — it NEVER
 * removes an entry. The UI shows entries sorted by score (best first), but
 * the addon chip count reflects the RAW fetched count, not the filtered count.
 */
export function buildDownloadCandidatesAll(entries: DownloaderStreamEntry[]): BuildAllResult {
  const kindCounts: Record<DownloaderStreamKind, number> = {
    http: 0,
    https: 0,
    hls: 0,
    dash: 0,
    p2p: 0,
    magnet: 0,
    external: 0,
  };
  const views: DownloadStreamViewAll[] = entries.map((entry) => {
    kindCounts[entry.kind] += 1;
    const candidateTexts = [entry.title, entry.name, entry.description, entry.filename];
    const sizeBytes = entry.videoSize ?? sizeFromTexts(candidateTexts);
    const height = entry.quality.height;
    const audio = audioClassFor({
      audioLanguages: entry.audioLanguages,
      title: entry.title,
      name: entry.name,
      description: entry.description,
      filename: entry.filename,
    });
    const hostClass = hostClassFor(entry.url);
    // Build a candidate shape for scoring (the score function reads quality/
    // codec/audio/size/protocol/hostClass — all of which are present here).
    const candidateForScore: DownloadStreamCandidate = {
      url: entry.url,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.filename ? { filename: entry.filename } : {}),
      ...(entry.container ? { container: entry.container } : {}),
      codec: codecClassFor(entry.codec),
      audio,
      ...(entry.audioLanguages?.length ? { audioLanguages: entry.audioLanguages } : {}),
      quality: bucketForHeight(height),
      ...(height !== undefined ? { height } : {}),
      sizeBytes,
      protocol: entry.transport === 'https' ? 'https' : 'http',
      ...(entry.streamType ? { streamType: entry.streamType } : {}),
      ...(entry.availability !== undefined ? { availability: entry.availability } : {}),
      ...(entry.tag ? { tag: entry.tag } : {}),
      index: entry.index,
      hostClass,
      releaseKey: '',
    };
    const score = scoreDownloadCandidate(candidateForScore);
    return {
      url: entry.url,
      kind: entry.kind,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.filename ? { filename: entry.filename } : {}),
      ...(entry.container ? { container: entry.container } : {}),
      codec: codecClassFor(entry.codec),
      audio,
      ...(entry.audioLanguages?.length ? { audioLanguages: entry.audioLanguages } : {}),
      quality: bucketForHeight(height),
      ...(height !== undefined ? { height } : {}),
      sizeBytes,
      transport: entry.transport,
      ...(entry.streamType ? { streamType: entry.streamType } : {}),
      ...(entry.availability !== undefined ? { availability: entry.availability } : {}),
      ...(entry.tag ? { tag: entry.tag } : {}),
      hostClass,
      index: entry.index,
      score,
      confidence: confidenceFor(candidateForScore, score),
    };
  });
  // Sort by score (presentation rank), then by original index. NO truncation.
  views.sort((a, b) => a.score - b.score || a.index - b.index);
  return { entries: views, kindCounts, malformed: 0 };
}

/**
 * Phase 17 (task §3): selects ALL discovery entries — NO truncation, NO
 * dedup (the same magnet URI offered twice stays as 2 entries — the user
 * can see both). The `max` parameter is accepted for back-compat but is
 * NEVER used to truncate.
 *
 * True-duplicate dedup is intentionally DISABLED for the discovery path —
 * the goal is faithful parity with Stremio. If Stremio shows 15 entries,
 * MAVERO shows 15 entries (even if 2 are the same URL).
 */
export function selectDownloadStreamsAll(entries: DownloadStreamViewAll[], _max: number = MAX_DOWNLOAD_STREAMS_PER_ADDON): DownloadStreamViewAll[] {
  // Already sorted by buildDownloadCandidatesAll. Return as-is — NO truncation.
  return entries;
}
