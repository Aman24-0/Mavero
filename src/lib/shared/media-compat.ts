/**
 * MAVERO media compatibility classifier (Phase 10, GOALS 10/11/17).
 *
 * A browser cannot reliably play every Stremio source. The CLASSIFIER is
 * the shared, PURE, metadata-driven first stage of the compatibility
 * pipeline: it maps the metadata an addon ACTUALLY supplied (container,
 * codec, protocol, filename, size) plus any information the CLIENT could
 * observe at runtime onto a small set of compatibility tiers that drive
 * playback routing:
 *
 *   DIRECT_PLAYABLE     — play directly (native <video> or the HLS engine).
 *   DIRECT_UNCERTAIN    — attempt direct playback, but surface a "may not
 *                         play" badge; failures fall back gracefully.
 *   REMUX_REQUIRED      — codecs are browser-compatible but the container
 *                         is not (e.g. H.264+AAC in MKV): remux without
 *                         re-encoding (GOAL 13).
 *   TRANSCODE_REQUIRED  — the video/audio codec itself is (very likely)
 *                         unsupported (e.g. 10-bit HEVC): transcode to a
 *                         broadly compatible target (GOAL 14).
 *   UNSUPPORTED         — no compatibility path is defined for the
 *                         combination; fail fast with a clear message.
 *
 * NON-NEGOTIABLE RULES:
 *   * NEVER guess from a filename alone — a filename is only ONE signal and
 *     it never produces DIRECT_PLAYABLE by itself (uncertainty is the
 *     honest answer for missing metadata).
 *   * NEVER fabricate metadata the addon did not supply (Phase 9 rule): a
 *     stream with no codec/container information is DIRECT_UNCERTAIN, and
 *     the UI renders no compatibility badge for it.
 *   * Audio language is NEVER part of compatibility and NEVER invented
 *     here (Phase 9/10 rule — the PenguPlay South-Indian-audio case).
 *   * The classifier is static/structural. The CLIENT refines its answer
 *     with runtime capability probes (`media-capabilities.ts`); the server
 *     uses it only to decide which streams get compatibility references.
 *     A static tier NEVER hard-blocks a selection: DIRECT_UNCERTAIN,
 *     REMUX_REQUIRED and TRANSCODE_REQUIRED all remain user-selectable —
 *     the browser may still manage direct playback.
 *
 * Pure module: no DOM, no network, no imports beyond shared types.
 */

/** Compatibility tiers (GOAL 11). */
export type MediaCompatibilityTier =
  | 'DIRECT_PLAYABLE'
  | 'DIRECT_UNCERTAIN'
  | 'REMUX_REQUIRED'
  | 'TRANSCODE_REQUIRED'
  | 'UNSUPPORTED';

/** What the compatibility path would have to do to make a stream playable. */
export type MediaCompatAction = 'none' | 'remux' | 'transcode';

/** Addon-supplied stream facts the classifier may consume. */
export type StreamCompatibilityInput = {
  /** Normalized playback protocol ('hls' | 'mp4' | 'file' | 'dash' | 'unknown'). */
  protocol?: string;
  /** Container label derived from addon text/filename (e.g. "MKV", "MP4"). */
  container?: string;
  /** Video codec label derived from ADDON-SUPPLIED text (e.g. "HEVC", "H.264"). */
  codec?: string;
  /** Addon-provided filename (behaviorHints.filename), when supplied. */
  filename?: string;
  /**
   * Phase 12 (GOAL B): the addon's OTHER supplied text fields. An
   * extensionless URL stream whose addon text carries the container
   * (`name: "Movie (2026).mkv"`) or a codec/quality token
   * (`title: "1080p HEVC 10-bit"`) must classify exactly like the
   * filename-equivalent — the addon WROTE those facts. Only addon-supplied
   * text is ever accepted here; nothing is guessed from content titles or
   * addon display names by the CALLERS' contract.
   */
  name?: string;
  title?: string;
  description?: string;
  /** Bit depth hint derived from ADDON-SUPPLIED text (e.g. 10 for "10-bit"). */
  bitDepth?: number;
  /** Addon/manifest-provided resolution hints (runtime probe refinement). */
  width?: number;
  height?: number;
  bitrate?: number;
};

/** One classified compatibility verdict, with the human-readable reason. */
export type StreamCompatibilityVerdict = {
  tier: MediaCompatibilityTier;
  action: MediaCompatAction;
  /** Short, user-safe reason token (never a stack/internal detail). */
  reason: string;
};

// ---------------------------------------------------------------------------
// Canonical label lexicons (lowercase). Only ADDON-SUPPLIED text reaches
// these — nothing is inferred from addon names, titles or countries.
// ---------------------------------------------------------------------------

const CONTAINER_ALIASES: Record<string, string> = {
  mkv: 'mkv',
  matroska: 'mkv',
  webm: 'webm',
  mp4: 'mp4',
  m4v: 'mp4',
  mov: 'mov',
  avi: 'avi',
  flv: 'flv',
  ts: 'ts',
  m2ts: 'ts',
  wmv: 'wmv',
};

const CODEC_ALIASES: Record<string, string> = {
  'h.264': 'h264',
  'h264': 'h264',
  h265: 'hevc',
  'h.265': 'hevc',
  hevc: 'hevc',
  'avc': 'h264',
  'avc1': 'h264',
  x264: 'h264',
  x265: 'hevc',
  'hevc-h265': 'hevc',
  vp9: 'vp9',
  vp8: 'vp8',
  av1: 'av1',
  'mpeg-2': 'mpeg2',
  mpeg2: 'mpeg2',
  divx: 'divx',
  xvid: 'xvid',
  // Server-normalized display label (Phase 9) for DivX/Xvid.
  'divx/xvid': 'divx',
};

const AUDIO_CODEC_ALIASES: Record<string, string> = {
  aac: 'aac',
  'eac3': 'eac3',
  'e-ac-3': 'eac3',
  'e-ac3': 'eac3',
  'dd+': 'eac3',
  ddplus: 'eac3',
  ac3: 'ac3',
  'ac-3': 'ac3',
  'dd5.1': 'ac3',
  dts: 'dts',
  'dts-hd': 'dts',
  'truehd': 'truehd',
  flac: 'flac',
  opus: 'opus',
  vorbis: 'vorbis',
  mp3: 'mp3',
};

/** Browsers with MSE support these audio codecs broadly; the rest need compat. */
const BROWSER_SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function firstContainerFrom(filename: string | undefined): string | null {
  if (!filename) return null;
  const match = /\.([a-z0-9]{2,4})$/i.exec(filename.trim());
  if (!match) return null;
  const alias = CONTAINER_ALIASES[match[1].toLowerCase()];
  return alias ?? match[1].toLowerCase();
}

/**
 * Extracts codec hints from ADDON-SUPPLIED text. Only exact word-boundary
 * lexicon matches count — "Thriller" never becomes a codec and a title
 * mentioning "10bit" in prose is still addon-supplied text, which is the
 * only honest signal available. Returns canonical codec + audio codec +
 * bit depth when the text carries them.
 */
export function codecHintsFromText(text: string | undefined): { codec: string | null; audio: string | null; bitDepth: number | null } {
  if (!text) return { codec: null, audio: null, bitDepth: null };
  const lower = text.toLowerCase();
  let codec: string | null = null;
  for (const [needle, canonical] of Object.entries(CODEC_ALIASES)) {
    if (new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(lower)) {
      codec = canonical;
      break;
    }
  }
  let audio: string | null = null;
  for (const [needle, canonical] of Object.entries(AUDIO_CODEC_ALIASES)) {
    if (new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(lower)) {
      audio = canonical;
      break;
    }
  }
  let bitDepth: number | null = null;
  if (/(^|[^a-z0-9])10\s?bit([^a-z0-9]|$)/.test(lower) || /(^|[^a-z0-9])hi10(p?)([^a-z0-9]|$)/.test(lower)) bitDepth = 10;
  else if (/(^|[^a-z0-9])8\s?bit([^a-z0-9]|$)/.test(lower)) bitDepth = 8;
  return { codec, audio, bitDepth };
}

/**
 * Phase 12 (GOAL B): container detection from ANY reliable addon-supplied
 * text. A stream named `Dhurandhar The Revenge (2026).mkv` served from an
 * extensionless URL (`https://provider.example/file/123456`) must classify
 * as MKV — the addon WROTE the container into its own text. The extension
 * must appear at a word-ish boundary (".mkv" followed by end/separator,
 * never ".mkvpass"), and only recognized container extensions count.
 * Returns the canonical container alias, or null.
 */
const CONTAINER_TEXT_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['mkv', 'mkv'], ['mp4', 'mp4'], ['webm', 'webm'], ['avi', 'avi'],
  ['mov', 'mov'], ['m4v', 'mp4'], ['ts', 'ts'], ['flv', 'flv'], ['wmv', 'wmv'],
]);

export function containerFromAddonText(texts: Array<string | undefined>): string | null {
  for (const text of texts) {
    if (!text) continue;
    for (const [extension, canonical] of CONTAINER_TEXT_EXTENSIONS) {
      if (new RegExp(`\\.${extension}(?![a-z0-9])`, 'i').test(text)) return canonical;
    }
  }
  return null;
}

/**
 * The core static classification (GOAL 11 examples). Input order of
 * precedence: protocol (HLS is segmented/fMP4 by definition) → container →
 * codec. Missing information degrades to DIRECT_UNCERTAIN, never to a
 * hard tier.
 *
 * Phase 12 (GOAL B): codec/container/bit-depth hints are derived from ALL
 * addon-supplied text (filename, name, title, description) — never from the
 * URL shape alone. Explicit structured fields (container/codec/bitDepth)
 * still win over text-derived hints.
 */
export function classifyStreamCompatibility(input: StreamCompatibilityInput): StreamCompatibilityVerdict {
  const protocol = typeof input.protocol === 'string' ? input.protocol : 'unknown';
  const addonTexts = [input.filename, input.name, input.title, input.description];
  const allHints = addonTexts.reduce(
    (combined, text) => {
      const textHints = codecHintsFromText(text);
      return {
        codec: combined.codec ?? textHints.codec,
        audio: combined.audio ?? textHints.audio,
        bitDepth: combined.bitDepth ?? textHints.bitDepth,
      };
    },
    { codec: null as string | null, audio: null as string | null, bitDepth: null as number | null },
  );
  const container = (() => {
    const raw = typeof input.container === 'string' ? input.container.trim().toLowerCase() : '';
    if (raw) return CONTAINER_ALIASES[raw] ?? raw;
    return firstContainerFrom(input.filename) ?? containerFromAddonText([input.name, input.title, input.description]);
  })();
  const codec = (() => {
    const raw = typeof input.codec === 'string' ? input.codec.trim().toLowerCase() : '';
    if (raw) return CODEC_ALIASES[raw] ?? raw;
    return allHints.codec;
  })();
  const audio = allHints.audio;
  const bitDepth = input.bitDepth ?? allHints.bitDepth;

  // HLS: the browser/engine plays segmented media. Codecs inside fMP4
  // segments still matter, so an explicit HEVC/10-bit label stays UNCERTAIN
  // rather than playable — the runtime probe refines it on the client.
  if (protocol === 'hls') {
    if (codec === 'hevc' || bitDepth === 10) return { tier: 'DIRECT_UNCERTAIN', action: 'none', reason: 'hevc-hls' };
    return { tier: 'DIRECT_PLAYABLE', action: 'none', reason: 'hls' };
  }
  // DASH is not supported by the Mavero direct player path at all.
  if (protocol === 'dash') return { tier: 'UNSUPPORTED', action: 'none', reason: 'dash-unsupported' };

  // Codec-driven tiers (container-agnostic): the video codec is the hard
  // compatibility boundary, the container only decides remux vs transcode.
  if (codec === 'hevc' || bitDepth === 10) {
    // HEVC support exists on some devices (Edge, some Android) — the runtime
    // probe decides. MKV adds a second incompatibility (container), so it
    // skips straight to the transcode tier; MP4/unknown stays uncertain.
    if (container === 'mkv') return { tier: 'TRANSCODE_REQUIRED', action: 'transcode', reason: 'hevc-mkv' };
    return { tier: 'DIRECT_UNCERTAIN', action: 'none', reason: 'hevc-capability' };
  }
  if (codec === 'mpeg2' || codec === 'divx' || codec === 'xvid' || codec === 'wmv') {
    return { tier: 'TRANSCODE_REQUIRED', action: 'transcode', reason: 'legacy-codec' };
  }
  if (audio && !BROWSER_SAFE_AUDIO.has(audio) && (audio === 'dts' || audio === 'truehd' || audio === 'eac3')) {
    // Dolby/DTS families beyond AC-3 generally fail in browsers.
    return { tier: 'TRANSCODE_REQUIRED', action: 'transcode', reason: 'unsupported-audio' };
  }

  // Container-driven tiers for browser-safe video codecs (H.264/VP9/AV1…).
  if (container === 'mkv') {
    if (codec === 'h264' || codec === 'vp9' || codec === 'av1' || codec === null) {
      // GOAL 11: "H.264 + MKV → potentially REMUX_REQUIRED". Without an
      // explicit codec the honest answer is still the remux path (the
      // container is the only KNOWN problem).
      return { tier: 'REMUX_REQUIRED', action: 'remux', reason: 'mkv-container' };
    }
  }
  if (container === 'avi' || container === 'flv' || container === 'wmv') {
    return { tier: 'TRANSCODE_REQUIRED', action: 'transcode', reason: 'legacy-container' };
  }

  if (codec === 'h264' && (container === 'mp4' || container === 'ts' || container === null) && (!audio || BROWSER_SAFE_AUDIO.has(audio))) {
    return { tier: 'DIRECT_PLAYABLE', action: 'none', reason: 'h264-mp4' };
  }
  if (codec === 'vp9' || codec === 'av1') {
    if (container === 'webm' || container === 'mp4' || container === null) return { tier: 'DIRECT_PLAYABLE', action: 'none', reason: 'modern-codec' };
  }

  // Everything else: no fabricated certainty — attempt direct playback with
  // a visible "may not play" badge and graceful fallback.
  return { tier: 'DIRECT_UNCERTAIN', action: 'none', reason: 'unknown-format' };
}

/**
 * Whether a stream qualifies for a compatibility reference (signed token)
 * at resolution time. Only remux/transcode candidates get one — direct
 * playable and uncertain streams never need the compatibility gateway, and
 * HLS is already segmented (re-processing it is out of scope).
 */
export function needsCompatibilityPath(verdict: StreamCompatibilityVerdict): boolean {
  return verdict.action === 'remux' || verdict.action === 'transcode';
}

/**
 * Short, user-safe badge text for a tier (plain text, no internals).
 * Phase 13 (product copy): the primary list should read like a STREAMING
 * player — conversion is presented as the fallback it is, and jargon
 * ("remux") never reaches the user.
 */
export function compatibilityBadgeText(tier: MediaCompatibilityTier): string | null {
  if (tier === 'DIRECT_PLAYABLE') return null;
  if (tier === 'DIRECT_UNCERTAIN') return 'May not play';
  if (tier === 'REMUX_REQUIRED' || tier === 'TRANSCODE_REQUIRED') return 'Conversion fallback';
  return 'Not playable';
}
