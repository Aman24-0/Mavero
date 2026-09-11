import type { NormalizedStremioStream } from './stream-normalize';
import { validateAddonStreamPlaybackUrl } from '$lib/server/resolver/safe-url';
import { audioClassFor, bucketForHeight, releaseClassFor, type AudioClass } from '$lib/shared/stream-selection';

/**
 * MAVERO Downloader — selection policy for Stremio HTTP addon streams
 * (Phase 14).
 *
 * This is INTENTIONALLY a different algorithm from the player's
 * `selectAddonStreams` engine: the downloader answers "which DIRECT addon
 * links are the most practical for a user to open in an external player or
 * download?" — not "which stream will the native player render best?".
 *
 * PRODUCT CONTRACT:
 *   * HLS/DASH streaming manifests are NEVER download candidates (an
 *     .m3u8 playlist is not a movie file). They keep flowing through the
 *     native HLS player path instead.
 *   * The engine consumes ONLY metadata the addon already supplied
 *     (normalized addon text + structured fields). It NEVER fetches a media
 *     URL, NEVER starts FFmpeg, NEVER proves that a URL plays, and NEVER
 *     proxies media. "Best available links" is an honest ranking, not a
 *     playback guarantee.
 *   * P2P/torrent/externalUrl/credential/header-dependent/invalid entries
 *     never reach this module (they are excluded by stream normalization);
 *     the downloader additionally drops streaming manifests, non-video
 *     files, download-only releases and private/loopback URLs.
 *   * NO over-filtering: an addon that only has HEVC, only 4K, or only
 *     cleartext http:// still surfaces its best candidates. Heavy remuxes
 *     are DEMOTED (shown only when nothing better exists), never silently
 *     pretending the addon is empty.
 *
 * The result is deterministic: identical input always produces an
 * identical, ordered candidate list.
 */

/** Maximum BEST links shown per addon (task §3 — never the raw 30–50). */
export const MAX_DOWNLOAD_STREAMS_PER_ADDON = 4;

export type DownloadQuality = '1080p' | '720p' | '480p' | '4K' | 'auto';
export type DownloadCodec = 'H.264' | 'HEVC' | 'AV1' | 'VP9' | 'unknown';

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
};

/** A ranked candidate — `score` is comparable, LOWER IS BETTER. */
export type RankedDownloadStream = DownloadStreamCandidate & {
  score: number;
  confidence: 'high' | 'medium' | 'low';
};

/** Why one normalized stream did NOT become a download candidate. */
export type DownloadSkipReason =
  | 'streaming-manifest'
  | 'non-video'
  | 'playback-boundary'
  | 'download-only';

export type DownloadCandidatesResult = {
  candidates: DownloadStreamCandidate[];
  /** Per-reason exclusion counts (diagnostics only — never sent to clients). */
  dropped: Record<DownloadSkipReason, number>;
};

// ---------------------------------------------------------------------------
// Scoring policy — the documented, configurable preference tables.
// ---------------------------------------------------------------------------

/**
 * Quality preference (task §2): 1080p first, then 720p, then 480p; 4K is
 * ranked BELOW 1080p/720p/480p practicality-wise — a 33 GB 4K release must
 * never outrank a normal 1080p file. `auto` (no confident resolution) last.
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

/**
 * Comfortable file size per bucket. Sizes ABOVE these are progressively
 * penalized (log2 of the ratio × 8, capped) so a 30–50 GB monster sinks
 * below a normal encode while a slightly-large file barely moves.
 */
const PREFERRED_SIZE_BYTES: Record<DownloadQuality, number> = {
  '1080p': 6 * 1024 ** 3,
  '4K': 12 * 1024 ** 3,
  '720p': 3 * 1024 ** 3,
  '480p': 1500 * 1024 ** 2,
  auto: 6 * 1024 ** 3,
};

/** The heaviest size still tolerated per bucket before the heavy penalty stacks (task §2: 40–50 GB type files). */
const HARD_HEAVY_BYTES: Record<DownloadQuality, number> = {
  '1080p': 20 * 1024 ** 3,
  '4K': 50 * 1024 ** 3,
  '720p': 10 * 1024 ** 3,
  '480p': 5 * 1024 ** 3,
  auto: 20 * 1024 ** 3,
};

/**
 * Explicit download-oriented markers (task §2): "Download Only" entries and
 * link-speed bragging ("10Gbps") are marketing for download managers, not
 * practical streaming sources — the shared release classifier excludes them.
 */
const CAM_RELEASE_PATTERN = /\b(?:cam|camrip|cam-?rip|telesync|telecine|screener|scr)\b|\bhd-?\s?ts\b|\bts\b(?![a-z0-9])/i;
const PREFERRED_RELEASE_PATTERN = /\b(?:web-?dl|webdl|web-?rip|webrip|bluray|blu-?ray|hdtv)\b/i;

/** Extensions that are clearly NOT a movie file (subtitles/images/archives/…). */
const NON_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'srt', 'vtt', 'ass', 'ssa', 'sub', 'nfo', 'txt', 'jpg', 'jpeg', 'png', 'gif',
  'webp', 'zip', 'rar', '7z', 'exe', 'iso', 'pdf', 'html', 'htm', 'php',
]);

/** DASH manifests referenced by TEXT (pathname .mpd is caught by `protocol`). */
const DASH_TEXT_PATTERN = /\b(?:mpd|mpeg-?dash)\b/i;

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

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Release weight: CAM/TS heavily penalized; known-good release tags free; unknown +3. */
function releasePenalty(text: string): number {
  if (PREFERRED_RELEASE_PATTERN.test(text)) return 0;
  if (CAM_RELEASE_PATTERN.test(extensionStripped(text))) return 35;
  return 3;
}

/** Progressive penalty for files larger than the bucket's comfortable size. */
function sizePenalty(candidate: DownloadStreamCandidate): number {
  if (!candidate.sizeBytes || candidate.sizeBytes <= 0) return 5;
  const preferred = PREFERRED_SIZE_BYTES[candidate.quality];
  const ratio = candidate.sizeBytes / preferred;
  if (ratio <= 1) return 0;
  return Math.min(36, Math.round(Math.log2(ratio) * 8));
}

/** The score of one candidate — LOWER IS BETTER. Pure + deterministic. */
export function scoreDownloadCandidate(candidate: DownloadStreamCandidate): number {
  const text = joinTexts(candidate);
  let penalty = 0;
  // The shared release classifier demotes remux / huge-size releases and
  // excludes download-only upstream; a surviving 'heavy' pays a fixed toll.
  if (releaseClassFor({ title: candidate.title, name: candidate.name, description: candidate.description, filename: candidate.filename, videoSize: candidate.sizeBytes, height: candidate.height }) === 'heavy') penalty += 45;
  if (candidate.sizeBytes && candidate.sizeBytes > HARD_HEAVY_BYTES[candidate.quality]) penalty += 70;
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
    candidate.index * 0.001
  );
}

/**
 * Deterministic equivalent-release key: same quality + codec + container +
 * audio class + normalized RELEASE text = the same file offered twice. The
 * stream NAME is deliberately NOT part of the identity (names are display
 * noise — "#2", "Mirror", quality labels) — two providers serving the same
 * release under different entry names are still one practical link.
 */
function releaseKeyOf(candidate: DownloadStreamCandidate): string {
  const source = [candidate.title, candidate.description, candidate.filename, candidate.tag]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:gb|mb)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${candidate.quality}|${candidate.codec}|${candidate.container ?? 'unknown'}|${candidate.audio}|${source.slice(0, 180)}`;
}

function confidenceFor(candidate: DownloadStreamCandidate, score: number): RankedDownloadStream['confidence'] {
  const known = Number(candidate.height !== undefined) + Number(candidate.codec !== 'unknown') + Number(candidate.container !== undefined) + Number(candidate.sizeBytes !== undefined);
  if (score < 20 && known >= 3 && candidate.streamType?.toLowerCase() === 'http') return 'high';
  if (score < 60 && known >= 2) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Candidate building (from the SHARED normalization output)
// ---------------------------------------------------------------------------

/**
 * Builds download candidates from ONE addon's normalized streams. Every
 * exclusion is counted so the server log can explain a "0 links" addon.
 * The media URL is NEVER fetched here — this is pure metadata work.
 */
export function buildDownloadCandidates(streams: NormalizedStremioStream[]): DownloadCandidatesResult {
  const dropped: Record<DownloadSkipReason, number> = {
    'streaming-manifest': 0,
    'non-video': 0,
    'playback-boundary': 0,
    'download-only': 0,
  };
  const candidates: DownloadStreamCandidate[] = [];

  for (const stream of streams) {
    // HLS/DASH are streaming manifests, not movie-file downloads (task §10).
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
    // hosts still rejected (same boundary the player's addon path uses).
    try {
      validateAddonStreamPlaybackUrl(stream.url);
    } catch {
      dropped['playback-boundary'] += 1;
      continue;
    }
    const candidateTexts = [stream.title, stream.name, stream.description, stream.filename];
    const release = releaseClassFor({
      title: stream.title,
      name: stream.name,
      description: stream.description,
      filename: stream.filename,
      videoSize: stream.videoSize,
      height: stream.quality.height,
    });
    if (release === 'download-only') {
      dropped['download-only'] += 1;
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
    candidates.push({
      url: stream.url,
      ...(stream.name ? { name: stream.name } : {}),
      ...(stream.title ? { title: stream.title } : {}),
      ...(stream.description ? { description: stream.description } : {}),
      ...(stream.filename ? { filename: stream.filename } : {}),
      ...(stream.container ? { container: stream.container } : {}),
      codec: codecClassFor(stream.codec),
      audio,
      ...(stream.audioLanguages?.length ? { audioLanguages: stream.audioLanguages } : {}),
      quality: bucketForHeight(height),
      ...(height !== undefined ? { height } : {}),
      sizeBytes: stream.videoSize ?? sizeFromTexts(candidateTexts),
      protocol: stream.transport,
      ...(stream.streamType ? { streamType: stream.streamType } : {}),
      ...(stream.availability !== undefined ? { availability: stream.availability } : {}),
      ...(stream.tag ? { tag: stream.tag } : {}),
      index: stream.index,
    });
  }

  return { candidates, dropped };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Selects the BEST practical direct-file candidates from one addon
 * (task §3): deterministic rank → equivalent-release dedupe → useful
 * quality diversity (4K capped at 1, other buckets at 2) → fill with the
 * next-best distinct releases. The result never claims a link was verified:
 * confidence reflects metadata completeness ONLY.
 */
export function selectDownloadStreams(candidates: DownloadStreamCandidate[], max: number = MAX_DOWNLOAD_STREAMS_PER_ADDON): RankedDownloadStream[] {
  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: scoreDownloadCandidate(candidate) }))
    .sort((a, b) => a.score - b.score || a.index - b.index);

  // Equivalent-release dedupe (first = best-scored wins).
  const seen = new Set<string>();
  const deduped: Array<DownloadStreamCandidate & { score: number }> = [];
  for (const candidate of ranked) {
    const key = releaseKeyOf(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  // Diversity pass: keep useful quality spread when the addon offers it.
  const counts = new Map<DownloadQuality, number>();
  const selected: RankedDownloadStream[] = [];
  for (const candidate of deduped) {
    if (selected.length >= max) break;
    const count = counts.get(candidate.quality) ?? 0;
    const cap = candidate.quality === '4K' ? 1 : 2;
    if (count >= cap) continue;
    counts.set(candidate.quality, count + 1);
    selected.push({ ...candidate, confidence: confidenceFor(candidate, candidate.score) });
  }

  // Fill pass: if fewer than `max` survived the caps (e.g. the addon only
  // has strong 1080p links), top up with the next-best distinct releases.
  if (selected.length < max) {
    const chosenIndexes = new Set(selected.map((entry) => entry.index));
    for (const candidate of deduped) {
      if (selected.length >= max) break;
      if (chosenIndexes.has(candidate.index)) continue;
      chosenIndexes.add(candidate.index);
      selected.push({ ...candidate, confidence: confidenceFor(candidate, candidate.score) });
    }
  }

  return selected;
}
