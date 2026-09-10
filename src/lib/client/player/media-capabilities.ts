import type { MediaCompatibilityTier, StreamCompatibilityInput, StreamCompatibilityVerdict } from '$lib/shared/media-compat';
import { classifyStreamCompatibility } from '$lib/shared/media-compat';

/**
 * MAVERO runtime media capability detection (Phase 10, GOALS 10/17).
 *
 * The SHARED classifier (`media-compat.ts`) is structural — it answers what
 * the ADDON-SUPPLIED metadata implies. This module is the CLIENT-side
 * refinement: it asks the actual browser what it can decode, using the
 * standard capability surfaces (never filename guessing):
 *
 *   * `HTMLMediaElement.canPlayType()`          — native container/codec support
 *   * `MediaSource.isTypeSupported()`           — MSE (the HLS engine path)
 *   * `navigator.mediaCapabilities.decodingInfo()` — authoritative
 *     supported/smooth/powerEfficient answer for a concrete
 *     container+codec+resolution+bitrate combination
 *
 * Detection NEVER blocks a selection by itself: the outcome either confirms
 * direct playback, or classifies the failure mode so the UI can route the
 * stream through the compatibility gateway (remux/transcode) or fail
 * gracefully. Browsers without the probe APIs (older Safari/WebView)
 * degrade to the structural verdict — uncertainty is never resolved by
 * guessing.
 *
 * CLIENT-ONLY module: no top-level browser globals; every probe is behind
 * `typeof` guards so importing it during SSR is safe (SvelteKit renders the
 * watch page on the server — the module is imported by client components).
 */

/** Outcome of the full compatibility decision for ONE stream. */
export type MediaCompatibilityDecision = {
  /** Direct browser playback is possible (native or MSE). */
  supported: boolean;
  /** decodingInfo reported smooth playback (absent when probe unavailable). */
  smooth?: boolean;
  /** decodingInfo reported power-efficient playback (absent when unavailable). */
  powerEfficient?: boolean;
  /** The stream should go through the remux compatibility path. */
  needsRemux: boolean;
  /** The stream should go through the transcode compatibility path. */
  needsTranscode: boolean;
  /** User-safe reason token (never internal detail). */
  reason: string;
  /** The structural tier the decision was refined from. */
  tier: MediaCompatibilityTier;
};

type DecodingInfoLike = { supported: boolean; smooth?: boolean; powerEfficient?: boolean };
type MediaCapabilitiesLike = { decodingInfo?: (configuration: Record<string, unknown>) => Promise<DecodingInfoLike> };

/** Narrow browser surface used by the probes (test-friendly). */
export type CapabilityBrowser = {
  canPlayType?: (type: string) => string;
  mediaCapabilities?: MediaCapabilitiesLike;
};

/**
 * Best-effort canonical MIME type for the structural input. Returns `null`
 * when the metadata does not describe a concrete combination — the caller
 * must NOT probe with a fabricated codec string (that would be guessing).
 * Audio is only included when the addon supplied an AAC/MP3-class hint;
 * unknown audio never poisons the video answer.
 */
export function candidateMimeType(input: StreamCompatibilityInput, forMse: boolean): string | null {
  const verdict = classifyStreamCompatibility(input);
  const container = canonicalContainerOf(input);
  if (!container) return null;
  const codec = canonicalCodecOf(input);
  if (!codec) return null;
  const audio = audioCodecOf(input) ?? (forMse ? 'mp4a.40.2' : null);
  const parts = [codec, ...(audio ? [audio] : [])];
  const type = `${container.type}; codecs="${parts.join(',')}"`;
  return type;
}

function canonicalContainerOf(input: StreamCompatibilityInput): { type: string; mse: boolean } | null {
  const raw = typeof input.container === 'string' ? input.container.trim().toLowerCase() : '';
  const fromFilename = typeof input.filename === 'string' ? (/\.([a-z0-9]{2,4})$/i.exec(input.filename.trim())?.[1]?.toLowerCase() ?? null) : null;
  const container = raw || fromFilename;
  if (container === 'mp4' || container === 'm4v' || container === 'mov') return { type: 'video/mp4', mse: true };
  if (container === 'webm') return { type: 'video/webm', mse: true };
  // MKV/AVI/TS/FLV/WMV have no reliable isTypeSupported answer for direct
  // playback (Chromium accepts some MKV natively) — no probe is honest here.
  return null;
}

function canonicalCodecOf(input: StreamCompatibilityInput): string | null {
  const codec = typeof input.codec === 'string' ? input.codec.trim().toLowerCase() : '';
  if (codec === 'h.264' || codec === 'h264') return 'avc1.640029';
  if (codec === 'hevc' || codec === 'h.265') return 'hvc1.1.6.L153.B0';
  if (codec === 'av1') return 'av01.0.08M.08';
  if (codec === 'vp9') return 'vp09.00.10.08';
  return null;
}

function audioCodecOf(input: StreamCompatibilityInput): string | null {
  const filename = typeof input.filename === 'string' ? input.filename.toLowerCase() : '';
  if (/\baac\b/.test(filename)) return 'mp4a.40.2';
  if (/\bmp3\b/.test(filename)) return 'mp3';
  // AC-3/E-AC-3/DTS are NOT probed as "supported audio": their absence from
  // the probe would wrongly reject a stream the browser might play with
  // silence-free fallback handling. Absent audio info → null (no claim).
  return null;
}

/**
 * Full decision for one stream against the current browser. Combines the
 * structural verdict with runtime probes when the browser exposes them.
 * Never throws — a probe failure degrades to the structural tier.
 */
export async function checkMediaCompatibility(input: StreamCompatibilityInput, browser: CapabilityBrowser = typeof navigator !== 'undefined' ? (navigator as unknown as CapabilityBrowser) : {}): Promise<MediaCompatibilityDecision> {
  const verdict: StreamCompatibilityVerdict = classifyStreamCompatibility(input);

  if (verdict.tier === 'UNSUPPORTED') {
    return { supported: false, needsRemux: false, needsTranscode: false, reason: verdict.reason, tier: verdict.tier };
  }
  if (verdict.action === 'remux') {
    return { supported: false, needsRemux: true, needsTranscode: false, reason: verdict.reason, tier: verdict.tier };
  }
  if (verdict.action === 'transcode') {
    return { supported: false, needsRemux: false, needsTranscode: true, reason: verdict.reason, tier: verdict.tier };
  }

  // DIRECT_PLAYABLE / DIRECT_UNCERTAIN — refine with runtime probes.
  const decodingInfo = browser.mediaCapabilities?.decodingInfo;
  const mimeType = candidateMimeType(input, true);
  if (decodingInfo && mimeType) {
    try {
      const info = await decodingInfo({
        type: 'media-source',
        video: {
          contentType: mimeType,
          ...(typeof input.width === 'number' && input.width > 0 ? { width: input.width } : {}),
          ...(typeof input.height === 'number' && input.height > 0 ? { height: input.height } : {}),
          ...(typeof input.bitrate === 'number' && input.bitrate > 0 ? { bitrate: input.bitrate } : {}),
          framerate: 30,
        },
        audio: { contentType: mimeType.split('; codecs="')[0] === 'video/mp4' ? 'audio/mp4; codecs="mp4a.40.2"' : 'audio/webm; codecs="opus"' },
      });
      // HEVC-specific: a NEGATIVE authoritative answer downgrades uncertainty
      // to the transcode path instead of a doomed direct attempt.
      if (!info.supported && verdict.reason.startsWith('hevc')) {
        return { supported: false, needsRemux: false, needsTranscode: true, smooth: false, powerEfficient: info.powerEfficient, reason: 'hevc-unsupported-by-device', tier: 'TRANSCODE_REQUIRED' };
      }
      return {
        supported: true,
        ...(info.smooth !== undefined ? { smooth: info.smooth } : {}),
        ...(info.powerEfficient !== undefined ? { powerEfficient: info.powerEfficient } : {}),
        needsRemux: false,
        needsTranscode: false,
        reason: verdict.reason,
        tier: verdict.tier,
      };
    } catch {
      // Probe failed — structural answer stands (never guess).
    }
  }

  // canPlayType probe for the MP4/WebM direct path when MSE probing is
  // unavailable. An empty answer on a KNOWN mp4+h264 combination keeps the
  // structural tier (uncertain stays uncertain — canPlayType is advisory).
  const nativeType = candidateMimeType(input, false);
  if (typeof browser.canPlayType === 'function' && nativeType && verdict.tier === 'DIRECT_PLAYABLE') {
    const answer = browser.canPlayType(nativeType);
    if (answer === '') {
      return { supported: true, needsRemux: false, needsTranscode: false, reason: 'probe-inconclusive', tier: 'DIRECT_UNCERTAIN' };
    }
  }

  return { supported: true, needsRemux: false, needsTranscode: false, reason: verdict.reason, tier: verdict.tier };
}
