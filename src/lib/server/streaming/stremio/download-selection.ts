import type { NormalizedStremioStream } from './stream-normalize';
import { validateAddonStreamPlaybackUrl } from '$lib/server/resolver/safe-url';
import { audioClassFor, bucketForHeight, releaseClassFor, type AudioClass } from '$lib/shared/stream-selection';

/**
 * MAVERO Downloader — selection policy for Stremio HTTP addon streams
 * (Phase 14, hardened in Phase 15).
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
 *     files, download-only releases, partial-release names (END-CREDIT,
 *     TRAILER, SAMPLE, …), implausible size/runtime combinations and
 *     private/loopback URLs.
 *   * NO over-filtering: an addon that only has HEVC, only 4K, or only
 *     cleartext http:// still surfaces its best candidates. Heavy remuxes
 *     are DEMOTED (shown only when nothing better exists), never silently
 *     pretending the addon is empty.
 *
 * Phase 15 changes (task §8–§13):
 *   * MAX_DOWNLOAD_STREAMS_PER_ADDON raised 4 → 10. Diversity caps raised so
 *     a useful quality / codec / audio spread can fill the 10 slots without
 *     flooding them with the same release.
 *   * Bad-release filter: END-CREDIT / TRAILER / SAMPLE / POST-CREDIT /
 *     INTERVIEW / FEATURETTE / etc. are rejected BEFORE ranking. The match
 *     is punctuation/spacing tolerant and case-insensitive; legitimate movie
 *     filenames (e.g. "The Credit (2026)") are NOT punished.
 *   * Size/runtime sanity: when runtime is supplied, the average bitrate is
 *     estimated from file size + runtime. Implausible combinations (a 156 MB
 *     1080p file for a 3h49m movie) are rejected with high confidence; when
 *     runtime is absent, a generous per-bucket minimum-size floor catches
 *     sample-like high-resolution files without over-filtering short films.
 *   * Release deduplication now keys on resolution + codec + container +
 *     audio + NORMALIZED release text (extracted from filename/title/
 *     description, with size/url noise stripped). Equivalent releases never
 *     consume all 10 slots.
 *   * 4K handling: practical 4K WEB-DL/HEVC encodes stay eligible; enormous
 *     remux/untouched-BluRay 4K candidates are demoted via the existing
 *     heavy-release policy (size-aware scoring, never a global 4K ban).
 *   * Host classification: pixeldrain / known-host / unknown — used as a
 *     presentation + ranking hint, NEVER as a global blacklist (PixelDrain
 *     candidates remain eligible per task §6/§7).
 *
 * The result is deterministic: identical input always produces an
 * identical, ordered candidate list.
 */

/** Maximum BEST links shown per addon (task §8 — never the raw 30–50). */
export const MAX_DOWNLOAD_STREAMS_PER_ADDON = 10;

export type DownloadQuality = '1080p' | '720p' | '480p' | '4K' | 'auto';
export type DownloadCodec = 'H.264' | 'HEVC' | 'AV1' | 'VP9' | 'unknown';

/** Host classification (task §7) — presentation/ranking hint, never a global blacklist. */
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
  /** Host class — derived from the URL hostname (task §7). */
  hostClass: DownloadHostClass;
  /** Normalized release identity key (filename/title/description noise stripped). */
  releaseKey: string;
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
  | 'download-only'
  | 'partial-release'
  | 'implausible-size';

export type DownloadCandidatesResult = {
  candidates: DownloadStreamCandidate[];
  /** Per-reason exclusion counts (diagnostics only — never sent to clients). */
  dropped: Record<DownloadSkipReason, number>;
};

/** Optional runtime context for size/runtime sanity (task §10). */
export type DownloadRuntimeContext = {
  /** Content runtime in SECONDS. When absent, only the per-bucket size floor applies. */
  runtimeSeconds?: number;
};

// ---------------------------------------------------------------------------
// Scoring policy — the documented, configurable preference tables.
// ---------------------------------------------------------------------------

/**
 * Quality preference (task §2/§13): 1080p first, then 720p, then 480p; 4K is
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
 * Per-bucket minimum-size floor (task §10): a 1080p file smaller than this
 * is almost certainly a sample/clip regardless of runtime. Tuned to be
 * generous — short films and 30-min episodes at 1080p can legitimately be
 * 300–500 MB. Files below the floor are flagged suspicious; combined with
 * a partial-release name they are rejected, otherwise they rank lower.
 */
const MIN_PLAUSIBLE_BYTES: Record<DownloadQuality, number> = {
  '1080p': 250 * 1024 ** 2,
  '4K': 600 * 1024 ** 2,
  '720p': 120 * 1024 ** 2,
  '480p': 60 * 1024 ** 2,
  auto: 60 * 1024 ** 2,
};

/**
 * Average-bitrate floor per bucket (bits per second). When runtime is
 * available, averageBitrate = sizeBytes * 8 / runtimeSeconds. A 1080p H.264
 * encode below 0.4 Mbps is implausible — even aggressively compressed 1080p
 * movies sit at 1.5–3 Mbps. Used to catch the "156 MB 1080p 3h49m" case.
 */
const MIN_PLAUSIBLE_BITRATE_BPS: Record<DownloadQuality, number> = {
  '1080p': 400_000,
  '4K': 800_000,
  '720p': 250_000,
  '480p': 120_000,
  auto: 120_000,
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
// Phase 15 — bad-release / partial-content rejection (task §9).
// ---------------------------------------------------------------------------

/**
 * Tokens that mark a stream as a PARTIAL / non-feature release (task §9).
 * Matched case-insensitively, punctuation/spacing tolerant: END-CREDIT,
 * END_CREDIT, END.CREDIT, END CREDIT, ENDCREDIT must all match.
 *
 * The tokens are bounded to whole-word-ish matches (non-alphanumeric on
 * either side) so legitimate filenames like "The Credit 2026" or "Endgame"
 * are NOT punished. The list is deliberately conservative — only releases
 * whose text EXPLICITLY advertises a partial/non-feature artifact qualify.
 *
 * `[\s\-_.]*` between the parts makes the match punctuation/spacing
 * tolerant (task §9: END-CREDIT / END_CREDIT / END.CREDIT / END CREDIT /
 * ENDCREDIT all match the same token).
 */
const PARTIAL_RELEASE_TOKENS: readonly string[] = [
  'end[\\s\\-_.]*credit', // END-CREDIT / END CREDIT / ENDCREDIT / END.CREDIT / END_CREDIT
  'post[\\s\\-_.]*credit', // POST-CREDIT / POST CREDIT / POSTCREDIT
  'credits',
  'trailer',
  'teaser',
  'preview',
  'sample',
  'clip',
  'extra',
  'extras',
  'bonus',
  'promo',
  'promotional',
  'interview',
  'behind[\\s\\-_.]*the[\\s\\-_.]*scenes',
  'making[\\s\\-_.]*of',
  'deleted[\\s\\-_.]*scene',
  'featurette',
];

const PARTIAL_RELEASE_PATTERN = new RegExp(
  `(?:^|[^a-z0-9])(?:${PARTIAL_RELEASE_TOKENS.join('|')})(?:[^a-z0-9]|$)`,
  'i',
);

/**
 * Hosts that are KNOWN to be reachable direct-media hosts (task §7).
 * PixelDrain is the canonical example — it is reachable from mpv-android
 * even when browser hotlink protection blocks Chrome. The list is a
 * presentation/ranking hint; absence from it NEVER causes a rejection.
 */
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

/** Classifies the URL hostname (task §7) — never a rejection signal. */
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
 * Normalized release identity text (task §11): the filename/title/
 * description with URLs, sizes and quality labels reduced to noise. Two
 * providers serving the same release under different display names produce
 * the SAME release key.
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
 * into seconds. Returns undefined when the value cannot be confidently parsed.
 */
export function parseRuntimeSeconds(runtime: string | undefined): number | undefined {
  if (!runtime) return undefined;
  const text = String(runtime).trim().toLowerCase();
  if (!text) return undefined;
  // ISO 8601 duration: PT2H30M / PT1H89M
  const iso = /^pt(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (iso) {
    const hours = Number(iso[1] ?? 0);
    const minutes = Number(iso[2] ?? 0);
    const seconds = Number(iso[3] ?? 0);
    if (hours || minutes || seconds) return hours * 3600 + minutes * 60 + seconds;
  }
  // "3h 49m" / "3 h 49 min" / "3h49m"
  const hms = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)/.exec(text);
  if (hms) {
    const hours = Number(hms[1] ?? 0);
    const minutes = Number(hms[2] ?? 0);
    if (hours || minutes) return hours * 3600 + minutes * 60;
  }
  // "HH:MM:SS" / "MM:SS"
  const clock = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (clock) {
    const a = Number(clock[1]);
    const b = Number(clock[2]);
    const c = Number(clock[3] ?? -1);
    if (c >= 0) return a * 3600 + b * 60 + c;
    return a * 60 + b;
  }
  // Bare minutes "89 min" already covered above; bare "89" is too ambiguous.
  return undefined;
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

/** Small bonus for known-reachable hosts (task §7) — PixelDrain edges up slightly. */
function hostBonus(candidate: DownloadStreamCandidate): number {
  if (candidate.hostClass === 'pixeldrain') return -1;
  return 0;
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
    hostBonus(candidate) +
    candidate.index * 0.001
  );
}

/**
 * Deterministic equivalent-release key (task §11): same quality + codec +
 * container + audio class + NORMALIZED release text = the same file offered
 * twice. The stream NAME is deliberately NOT part of the identity (names
 * are display noise — "#2", "Mirror", "a", "b", quality labels) — two
 * providers serving the same release under different entry names are still
 * one practical link. Only title/description/filename/tag carry release
 * semantics; the name is excluded explicitly per task §11.
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
// Bad-release + size/runtime sanity (task §9/§10)
// ---------------------------------------------------------------------------

/** True when the candidate text matches a partial/non-feature release marker. */
export function isPartialRelease(candidate: Pick<DownloadStreamCandidate, 'name' | 'title' | 'description' | 'filename' | 'tag'>): boolean {
  const text = joinTexts(candidate);
  if (!text.trim()) return false;
  return PARTIAL_RELEASE_PATTERN.test(text);
}

/**
 * Estimates whether a candidate's size/runtime combination is implausible
 * (task §10). Returns:
 *   - 'reject'    — high confidence the file is not a full-feature release
 *                   (tiny file at high resolution for a long movie, or a
 *                   sample-size file with a partial-release name).
 *   - 'suspicious'— anomalous but not confidently invalid; rank lower.
 *   - 'ok'        — passes the sanity check.
 *
 * Conservative by design: short movies can legitimately be small, and a
 * missing runtime never produces a 'reject' verdict on its own.
 */
export function sizeRuntimeVerdict(
  candidate: Pick<DownloadStreamCandidate, 'quality' | 'sizeBytes' | 'height' | 'name' | 'title' | 'description' | 'filename' | 'tag'>,
  context: DownloadRuntimeContext = {},
): 'reject' | 'suspicious' | 'ok' {
  const size = candidate.sizeBytes;
  if (!size || size <= 0) return 'ok';

  const bucket = candidate.quality;
  const minPlausible = MIN_PLAUSIBLE_BYTES[bucket];

  // Runtime-aware bitrate check — the strongest signal when available.
  if (context.runtimeSeconds && context.runtimeSeconds >= 600) {
    const bitrateBps = (size * 8) / context.runtimeSeconds;
    const floor = MIN_PLAUSIBLE_BITRATE_BPS[bucket];
    // Below half the floor → almost certainly not a full-feature release.
    if (bitrateBps < floor * 0.5) {
      // Combined with a tiny size → reject; otherwise suspicious.
      if (size < minPlausible) return 'reject';
      return 'suspicious';
    }
    if (bitrateBps < floor) return 'suspicious';
  }

  // No runtime: rely on the per-bucket minimum-size floor. Below the floor
  // at high resolution is suspicious (sample-like); never a hard reject on
  // its own — short films and 30-min episodes can legitimately be small.
  if (size < minPlausible && (bucket === '4K' || bucket === '1080p')) {
    return 'suspicious';
  }
  return 'ok';
}

// ---------------------------------------------------------------------------
// Candidate building (from the SHARED normalization output)
// ---------------------------------------------------------------------------

/**
 * Builds download candidates from ONE addon's normalized streams. Every
 * exclusion is counted so the server log can explain a "0 links" addon.
 * The media URL is NEVER fetched here — this is pure metadata work.
 */
export function buildDownloadCandidates(streams: NormalizedStremioStream[], runtimeContext: DownloadRuntimeContext = {}): DownloadCandidatesResult {
  const dropped: Record<DownloadSkipReason, number> = {
    'streaming-manifest': 0,
    'non-video': 0,
    'playback-boundary': 0,
    'download-only': 0,
    'partial-release': 0,
    'implausible-size': 0,
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
    // Phase 15 (task §9): partial / non-feature releases are rejected
    // BEFORE ranking — END-CREDIT, TRAILER, SAMPLE, etc. must never reach
    // the final candidate list. The match is punctuation/spacing tolerant
    // and case-insensitive; legitimate filenames are NOT punished.
    if (isPartialRelease({ name: stream.name, title: stream.title, description: stream.description, filename: stream.filename, tag: stream.tag })) {
      dropped['partial-release'] += 1;
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
    // Phase 15 (task §10): size/runtime sanity. High-confidence implausible
    // combinations are rejected; uncertain ones are kept but ranked lower.
    const verdict = sizeRuntimeVerdict(
      { quality, sizeBytes, height, name: stream.name, title: stream.title, description: stream.description, filename: stream.filename, tag: stream.tag },
      runtimeContext,
    );
    if (verdict === 'reject') {
      dropped['implausible-size'] += 1;
      continue;
    }
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
    // Suspicious (but not confidently invalid) candidates survive with a
    // ranking toll — the user still sees them, but practical releases lead.
    candidates.push(candidate);
  }

  return { candidates, dropped };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Selects the BEST practical direct-file candidates from one addon
 * (task §8/§12): deterministic rank → equivalent-release dedupe → useful
 * quality diversity (4K capped at 2, other buckets at 4) → fill with the
 * next-best distinct releases. The result never claims a link was verified:
 * confidence reflects metadata completeness ONLY.
 *
 * Phase 15 diversity caps (task §12): raised so a useful quality / codec /
 * audio spread can fill the 10 slots without flooding them with the same
 * release. Quality should still dominate — inferior sources are NOT
 * promoted merely to achieve diversity (the fill pass tops up with the
 * next-best distinct releases only after the diversity sweep).
 */
export function selectDownloadStreams(candidates: DownloadStreamCandidate[], max: number = MAX_DOWNLOAD_STREAMS_PER_ADDON): RankedDownloadStream[] {
  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: scoreDownloadCandidate(candidate) }))
    .sort((a, b) => a.score - b.score || a.index - b.index);

  // Equivalent-release dedupe (first = best-scored wins). Phase 15 (task
  // §11): the release key is now derived from NORMALIZED filename + title +
  // description text, so two providers serving the same release under
  // different display names collapse to one practical link.
  const seen = new Set<string>();
  const deduped: Array<DownloadStreamCandidate & { score: number }> = [];
  for (const candidate of ranked) {
    const key = candidate.releaseKey || releaseKeyOf(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  // Diversity pass: keep useful quality spread when the addon offers it.
  // Phase 15 (task §12): 4K capped at 2, other buckets at 4 — enough room
  // for 1080p / 720p / 480p / 4K to coexist without one bucket flooding.
  const counts = new Map<DownloadQuality, number>();
  const selected: RankedDownloadStream[] = [];
  for (const candidate of deduped) {
    if (selected.length >= max) break;
    const count = counts.get(candidate.quality) ?? 0;
    const cap = candidate.quality === '4K' ? 2 : 4;
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
