/**
 * MAVERO stream selection engine (Phase 13) — the shared, PURE ranking and
 * filtering layer that turns RAW addon streams into the small set of USABLE
 * streaming candidates the player actually shows.
 *
 * PRODUCT CONTRACT (the "streaming player, not a download manager" rule):
 *   * MAVERO does NOT expose every stream an addon returns. A 30–50 stream
 *     raw addon response becomes a handful of ranked candidates (≤
 *     MAX_SELECTED_STREAMS_PER_ADDON), grouped into exactly FOUR user-facing
 *     quality buckets (1080p / 720p / 480p / 4K — never dozens of tabs).
 *   * DIRECT playable sources outrank conversion-required sources. HLS
 *     outranks other formats at the same quality. Dual/Multi-audio releases
 *     outrank single-audio ones at the same format. Heavy download-oriented
 *     releases (remux / BluRay remux / multi-GB-huge encodes) and explicit
 *     "Download Only" entries are deprioritized and hidden whenever any
 *     usable alternative exists.
 *   * Compatibility conversion is a FALLBACK, never the discovery strategy:
 *     the ranking never promotes a conversion candidate above a direct one,
 *     and the player starts FFmpeg ONLY when the user explicitly selects a
 *     fallback candidate.
 *   * The engine consumes ONLY metadata the addon already supplied (text,
 *     sizes, structured fields). It NEVER fetches media to inspect it, and
 *     it NEVER invents metadata: an unknown quality stays the `auto` bucket,
 *     a filename that merely says "Hindi" stays single-audio.
 *
 * Both the server (per-addon resolution) and the client (presentation
 * ordering) import THIS module so the two sides can never drift.
 *
 * Pure module: no DOM, no network, no $env, no server imports.
 */

/** The FOUR user-facing quality buckets (plus `auto` for unknown quality). */
export type QualityBucket = '1080p' | '720p' | '480p' | '4K' | 'auto';

/** Audio-configuration class derived from addon text / structured fields. */
export type AudioClass = 'multi' | 'dual' | 'single' | 'unknown';

/** Release weight: normal streaming source vs download-oriented heaviness. */
export type ReleaseClass = 'streaming' | 'heavy' | 'download-only';

/**
 * Playback path class (mirrors the compatibility tiers, user-facing).
 * `remux` (video stream-copy + audio normalization — minutes-fast) ranks
 * ABOVE `transcode` (full re-encode) when both are fallbacks: the task's
 * expected 1080p order is H.264 MKV (remux) before HEVC (transcode).
 */
export type PlayClass = 'direct' | 'uncertain' | 'remux' | 'transcode' | 'unsupported';

/** The usability verdict attached to one candidate stream. */
export type StreamUsability = {
  bucket: QualityBucket;
  audio: AudioClass;
  release: ReleaseClass;
  play: PlayClass;
  /** Deterministic composite rank — LOWER IS BETTER. */
  rank: number;
};

/** Minimal stream facts the engine consumes (a superset of the quality option). */
export type StreamSelectionInput = {
  url: string;
  protocol?: string;
  container?: string;
  codec?: string;
  filename?: string;
  name?: string;
  title?: string;
  description?: string;
  /** Structured addon audio languages (Phase 9 normalization output). */
  audioLanguages?: string[];
  /** Number of shape-checked addon subtitle tracks (NOT an audio signal). */
  subtitleCount?: number;
  /** behaviorHints.videoSize in bytes, when the addon supplied it. */
  videoSize?: number;
  /** Normalized resolution height, when confidently known. */
  height?: number;
  /**
   * The playback-path class, supplied by the CALLER from the shared
   * compatibility classifier (`classifyStreamCompatibility` → tier). Omitting
   * it degrades honestly to `uncertain` (attempt direct, badge visible).
   */
  playClass?: PlayClass;
};

// ---------------------------------------------------------------------------
// Policy constants — the CONFIGURABLE ranking/filtering policy (spec §4):
// tuned so useful 1080p/4K encodes survive while multi-tens-of-GB remuxes
// and explicit download-only releases do not reach the user.
// ---------------------------------------------------------------------------

/** Bucket display order for the player UI (task §12: 1080p first). */
export const QUALITY_DISPLAY_ORDER: readonly QualityBucket[] = ['1080p', '720p', '480p', '4K', 'auto'];

/** Per-quality candidates an addon may contribute (task §12: "best few"). */
export const MAX_STREAMS_PER_QUALITY = 2;

/** Total candidates ONE addon may contribute to the sheet. */
export const MAX_SELECTED_STREAMS_PER_ADDON = 8;

/** Equivalent-release dedupe: same bucket+codec+container+audio kept per key. */
export const MAX_EQUIVALENT_RELEASES = 2;

/**
 * Size ceilings per bucket (bytes). Deliberately GENEROUS so normal dual-audio
 * encodes (a 4–8 GB 1080p movie, a 15–25 GB 4K WEB-DL) always survive; only
 * genuinely huge download-oriented files trip the gate. `auto` uses the 1080p
 * ceiling (the most common real bucket).
 */
export const HEAVY_SIZE_BYTES_BY_BUCKET: Record<QualityBucket, number> = {
  '480p': 4 * 1024 ** 3,
  '720p': 8 * 1024 ** 3,
  '1080p': 14 * 1024 ** 3,
  '4K': 40 * 1024 ** 3,
  auto: 14 * 1024 ** 3,
};

/**
 * Untouched-disc markers (task §4). "BluRay" ALONE is a common legitimate
 * encode source tag ("BluRay x264") and must NOT trip this — the REMUX
 * family is the download-oriented signal.
 */
const HEAVY_RELEASE_PATTERN = /\bremux\b|\bbdremux\b|\bblu-?ray\s*remux\b|\buntouched\s*blu-?ray\b/i;

/**
 * Explicit download-only markers (task §16): "10Gbps Download Only",
 * "Download Only", link-speed bragging (real streaming sources never
 * advertise Gbps).
 */
const DOWNLOAD_ONLY_PATTERN = /\bdownload[\s-]*only\b|\b\d+\s*gbps\b/i;

/**
 * Dual-audio markers (task §3): explicit "Dual Audio", "2 Audio", and the
 * "LANG + LANG" two-language convention. A filename that merely says
 * "Hindi" is SINGLE audio — never dual.
 */
const DUAL_AUDIO_PATTERN = /\bdual[\s-]*audio\b|\b2\s*audios?\b|\b2audio\b/i;

/** Multi-audio markers: "Multi Audio(s)", "MULTI", "N Audio(s)" (N ≥ 3). */
const MULTI_AUDIO_PATTERN = /\bmulti[\s-]*audios?\b|\bmultiaudio\b|\b\d+\s*audios?\b|\bmulti\b/i;

/** Two-language "A + B" audio convention ("Hindi + English", "ENG+HIN"). */
const TWO_LANGUAGE_PATTERN = /\b[a-z]{3,9}\s*\+\s*[a-z]{3,9}\b/i;

/** Canonical three-letter codes recognized by the two-language convention. */
const LANGUAGE_CODES = new Set([
  'hindi', 'hin', 'eng', 'english', 'tam', 'tamil', 'tel', 'telugu', 'mal', 'malayalam',
  'kan', 'kannada', 'ben', 'bengali', 'pan', 'punjabi', 'mar', 'marathi', 'guj', 'gujarati',
  'urd', 'urdu', 'jpn', 'japanese', 'kor', 'korean', 'chi', 'mandarin', 'spa', 'spanish',
  'fre', 'french', 'ger', 'german', 'ita', 'italian', 'rus', 'russian', 'ara', 'arabic',
]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Maps a confident height (or quality text) onto ONE of the four buckets. */
export function bucketForHeight(height: number | undefined): QualityBucket {
  if (height === undefined) return 'auto';
  if (height >= 1440) return '4K'; // 2160/1440/UHD — the 4K bucket
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  // Sub-480p has no honest bucket — `auto` (displayed "Auto"), never 480p.
  return 'auto';
}

/** Parses an explicit "NN.N GB" size mention out of addon text (bytes). */
export function sizeFromText(texts: Array<string | undefined>): number | null {
  for (const text of texts) {
    if (!text) continue;
    const match = /\b(\d{2,3}(?:\.\d+)?)\s*gb\b/i.exec(text);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 10 && value <= 999) return Math.round(value * 1024 ** 3);
    }
  }
  return null;
}

/** Derives the audio class from structured languages + addon text (task §3). */
export function audioClassFor(input: Pick<StreamSelectionInput, 'audioLanguages' | 'title' | 'name' | 'description' | 'filename' | 'subtitleCount'>): AudioClass {
  const texts = [input.title, input.name, input.description, input.filename];
  const structured = input.audioLanguages?.filter(Boolean).length ?? 0;
  // Structured Stremio audio metadata, when present, is the strongest signal.
  if (structured >= 3) return 'multi';
  for (const text of texts) {
    if (!text) continue;
    if (MULTI_AUDIO_PATTERN.test(text)) return 'multi';
  }
  if (DUAL_AUDIO_PATTERN.test(texts.filter(Boolean).join(' '))) return 'dual';
  if (structured === 2) return 'dual';
  // "Hindi + English" style two-language conventions.
  for (const text of texts) {
    if (!text) continue;
    const match = TWO_LANGUAGE_PATTERN.exec(text);
    if (match) {
      const [left, right] = match[0].toLowerCase().split('+').map((part) => part.trim());
      if (LANGUAGE_CODES.has(left) && LANGUAGE_CODES.has(right)) return 'dual';
    }
  }
  // The adjacent two-language convention ("Hindi English" — task pattern
  // list): TWO DISTINCT language words inside ONE addon text field.
  for (const text of texts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    const found = new Set<string>();
    for (const code of LANGUAGE_CODES) {
      if (new RegExp(`(^|[^a-z])${code}([^a-z]|$)`).test(lower)) found.add(code);
      if (found.size >= 2) return 'dual';
    }
  }
  if (structured === 1) return 'single';
  // A single language mentioned anywhere in the addon text is an honest
  // SINGLE-audio signal; no mention at all stays `unknown` (never invented).
  for (const text of texts) {
    if (!text) continue;
    if (/\b(hindi|english|tamil|telugu|malayalam|kannada|bengali|punjabi|marathi|gujarati|urdu|japanese|korean|mandarin|spanish|french|german|italian|russian|arabic|turkish|portuguese)\b/i.test(text)) return 'single';
  }
  return 'unknown';
}

/** Release weight: download-only / heavy / streaming (task §4/§16). */
export function releaseClassFor(input: Pick<StreamSelectionInput, 'title' | 'name' | 'description' | 'filename' | 'videoSize' | 'height'>): ReleaseClass {
  const texts = [input.title, input.name, input.description, input.filename];
  const joined = texts.filter(Boolean).join(' ');
  if (DOWNLOAD_ONLY_PATTERN.test(joined)) return 'download-only';
  if (HEAVY_RELEASE_PATTERN.test(joined)) return 'heavy';
  const height = input.height;
  const bucket = bucketForHeight(height);
  const size = input.videoSize ?? sizeFromText(texts);
  if (size !== undefined && size !== null && size > HEAVY_SIZE_BYTES_BY_BUCKET[bucket]) return 'heavy';
  return 'streaming';
}

/** Rank weight tables (documented ordering contract — see module docstring). */
const PLAY_WEIGHT: Record<PlayClass, number> = { direct: 0, uncertain: 1000, remux: 2000, transcode: 2500, unsupported: 100_000 };
const RELEASE_WEIGHT: Record<ReleaseClass, number> = { streaming: 0, heavy: 300, 'download-only': 50_000 };
const BUCKET_WEIGHT: Record<QualityBucket, number> = { '1080p': 0, '720p': 10, '480p': 20, '4K': 30, auto: 90 };
const PROTOCOL_WEIGHT: Record<string, number> = { hls: 0, mp4: 1, file: 2, dash: 9, unknown: 3 };
const AUDIO_WEIGHT: Record<AudioClass, number> = { multi: 0, dual: 1, unknown: 2, single: 3 };

/**
 * The composite rank of ONE stream. Deterministic; LOWER IS BETTER. The
 * weight scale encodes the product priority (task §5):
 *   play path (1000s) > release weight (100s) > quality bucket (10s) >
 *   format (1s) > audio (0.1s) > transport (< 0.1s).
 * The original index is the final tiebreaker so equal inputs never reorder.
 */
export function rankOf(input: StreamSelectionInput, index: number): StreamUsability {
  const release = releaseClassFor(input);
  const height = input.height;
  const bucket = bucketForHeight(height);
  const audio = audioClassFor(input);
  const play: PlayClass = input.playClass ?? 'uncertain';
  const protocolWeight = PROTOCOL_WEIGHT[input.protocol ?? 'unknown'] ?? 4;
  const transportWeight = input.url.startsWith('https://') ? 0 : 1;
  const rank =
    PLAY_WEIGHT[play] * 10 +
    RELEASE_WEIGHT[release] +
    BUCKET_WEIGHT[bucket] +
    protocolWeight +
    AUDIO_WEIGHT[audio] * 0.1 +
    transportWeight * 0.01 +
    index * 0.001;
  return { bucket, audio, release, play, rank: Math.round(rank * 1000) / 1000 };
}

// ---------------------------------------------------------------------------
// Selection (task §1/§2/§17)
// ---------------------------------------------------------------------------

export type SelectionEntry<T> = {
  /** Index into the caller's array (stable identity for the caller). */
  index: number;
  stream: T;
  usability: StreamUsability;
};

export type SelectionOptions = {
  /** Per-quality cap (default MAX_STREAMS_PER_QUALITY). */
  perQuality?: number;
  /** Total per-addon cap (default MAX_SELECTED_STREAMS_PER_ADDON). */
  total?: number;
};

/**
 * Selects the FINAL usable candidates from ONE addon's validated streams
 * (task §1/§2/§12/§17):
 *
 *   1. every stream is classified + ranked;
 *   2. download-only and unsupported streams are EXCLUDED outright;
 *   3. equivalent releases (same bucket + codec + container + audio class)
 *      are deduplicated to the best MAX_EQUIVALENT_RELEASES entries;
 *   4. per quality bucket (display order 1080p → 720p → 480p → 4K → auto)
 *      the best `perQuality` candidates survive — heavy releases only
 *      represent a bucket when NOTHING streaming-class exists for it;
 *   5. buckets are admitted in display order until `total` candidates.
 *
 * If EVERY candidate is heavy, the heavy ones still surface (last resort —
 * the user decides), but download-only never does. The result is ordered
 * bucket-display-first, rank-within-bucket-second. Pure + deterministic.
 */
export function selectAddonStreams<T extends StreamSelectionInput>(streams: T[], options: SelectionOptions = {}): Array<SelectionEntry<T>> {
  const perQuality = options.perQuality ?? MAX_STREAMS_PER_QUALITY;
  const total = options.total ?? MAX_SELECTED_STREAMS_PER_ADDON;

  const classified: Array<SelectionEntry<T>> = streams.map((stream, index) => ({
    index,
    stream,
    usability: rankOf(stream, index),
  }));

  // 2. Hard exclusions: download-only is never a streaming candidate;
  //    unsupported has no playback path at all.
  const candidates = classified.filter((entry) => entry.usability.release !== 'download-only' && entry.usability.play !== 'unsupported');
  if (!candidates.length) return [];

  // 3. Equivalent-release dedupe (identical bucket+codec+container+audio).
  //    Restricted to KNOWN buckets: with no resolution/format/audio signal
  //    at all (`auto`) there is no basis to call two URLs the same release —
  //    dropping unknowns could hide the one live URL among dead twins. The
  //    per-quality cap already bounds auto-bucket noise.
  const equivalentKeyOf = (entry: SelectionEntry<T>): string => {
    const s = entry.stream;
    if (entry.usability.bucket === 'auto') return `auto|${entry.index}`; // never collapsed
    return [entry.usability.bucket, s.codec ?? '-', s.container ?? '-', entry.usability.audio].join('|');
  };
  const keyCount = new Map<string, number>();
  for (const entry of candidates) {
    const key = equivalentKeyOf(entry);
    keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
  }
  // Over-represented equivalence classes keep their best
  // MAX_EQUIVALENT_RELEASES entries (by rank — not arrival order).
  const keptByKey = new Map<string, SelectionEntry<T>[]>();
  for (const entry of [...candidates].sort((a, b) => a.usability.rank - b.usability.rank || a.index - b.index)) {
    const key = equivalentKeyOf(entry);
    if ((keyCount.get(key) ?? 0) <= MAX_EQUIVALENT_RELEASES) continue;
    const kept = keptByKey.get(key) ?? [];
    if (kept.length < MAX_EQUIVALENT_RELEASES) kept.push(entry);
    keptByKey.set(key, kept);
  }
  const deduped = candidates.filter((entry) => {
    const key = equivalentKeyOf(entry);
    if ((keyCount.get(key) ?? 0) <= MAX_EQUIVALENT_RELEASES) return true;
    return (keptByKey.get(key) ?? []).includes(entry);
  });

  // 4/5. Bucket sweep in display order; heavy only when nothing else exists
  //      for the bucket; global total cap.
  const picked: Array<SelectionEntry<T>> = [];
  for (const bucket of QUALITY_DISPLAY_ORDER) {
    if (picked.length >= total) break;
    const inBucket = deduped.filter((entry) => entry.usability.bucket === bucket);
    if (!inBucket.length) continue;
    const streaming = inBucket.filter((entry) => entry.usability.release === 'streaming').sort((a, b) => a.usability.rank - b.usability.rank || a.index - b.index);
    const heavy = inBucket.filter((entry) => entry.usability.release === 'heavy').sort((a, b) => a.usability.rank - b.usability.rank || a.index - b.index);
    const admitted = streaming.slice(0, perQuality);
    if (!admitted.length) admitted.push(...heavy.slice(0, perQuality));
    for (const entry of admitted) {
      if (picked.length >= total) break;
      picked.push(entry);
    }
  }
  // Last resort: every candidate was heavy → surface the best heavy ones so
  // the user still gets a choice (never download-only; filtered in step 2).
  if (!picked.length) {
    const heavyAll = deduped.filter((entry) => entry.usability.release === 'heavy').sort((a, b) => a.usability.rank - b.usability.rank || a.index - b.index);
    picked.push(...heavyAll.slice(0, total));
  }
  return picked;
}

/**
 * Stable comparator that orders two usability objects the way the sheet
 * displays them: quality-bucket display order first, rank second, original
 * index last. Used by the client merge (cross-addon ordering) and the sheet.
 */
export function compareUsability(a: { usability: StreamUsability; index?: number }, b: { usability: StreamUsability; index?: number }): number {
  const bucketA = QUALITY_DISPLAY_ORDER.indexOf(a.usability.bucket);
  const bucketB = QUALITY_DISPLAY_ORDER.indexOf(b.usability.bucket);
  if (bucketA !== bucketB) return bucketA - bucketB;
  if (a.usability.rank !== b.usability.rank) return a.usability.rank - b.usability.rank;
  return (a.index ?? 0) - (b.index ?? 0);
}
