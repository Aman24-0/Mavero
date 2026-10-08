// LT-3 — Live TV playback error model (engine-neutral, Live TV only).
//
// The PLAYBACK-layer counterpart of LT-2's `errors.ts` (data-layer
// LiveTvError). This model describes failures of the PLAYBACK ENGINE itself
// (initialization, manifest loading, DRM, media errors) — not LiveGT API
// failures. LT-4's UI branches on `kind`; it never parses strings and never
// sees raw Shaka error objects.
//
// SECURITY CONTRACT (LT-3 brief, live-tv-plan.md §10/§15):
//   * Messages come from a FIXED safe table — they never interpolate Shaka
//     error text, signed MPD URLs, ClearKey key/keyId values, response
//     bodies or any other upstream material. Shaka's own error `message`
//     field is NEVER read anywhere in this codebase (it may embed URIs).
//   * The only contextual data carried is the numeric Shaka `code` (a
//     stable public enum value — safe to log/display) and nothing else.
//
// ISOLATION: this model belongs to the Live TV playback path ONLY. The VOD
// player's error surfaces (PlaybackManager / media-compat / hls-engine)
// are untouched and must not import this module.

/** Machine-readable Live TV playback failure categories. */
export type LiveTvPlaybackErrorKind =
        | 'invalid_source' // no usable DASH source (empty/malformed sources array)
        | 'init_failed' // Shaka/player initialization failed (construction/attach)
        | 'manifest_load_failed' // the MPD could not be fetched or parsed
        | 'drm_config_failed' // ClearKey data invalid / DRM config rejected
        | 'drm_playback_failed' // EME/CDM playback failure (protected content)
        | 'network_failed' // network-level failure during playback
        | 'unsupported_browser' // browser runtime cannot support the DASH/ClearKey path
        | 'autoplay_blocked' // play() rejected by the browser autoplay policy
        | 'aborted' // operation cancelled (destroy / supersession / signal) — NOT an error for the UI
        | 'playback_failed'; // any other/unknown playback failure

/**
 * Fixed, user-safe message table. Deliberately generic — safe to show in a
 * UI, safe to log. Sensitive material (keys, signed URLs, tokens) can never
 * appear here because nothing is interpolated, ever.
 */
const SAFE_PLAYBACK_MESSAGES: Record<LiveTvPlaybackErrorKind, string> = {
        invalid_source: 'This channel has no playable stream right now.',
        init_failed: 'Live TV playback could not start in this browser.',
        manifest_load_failed: 'This channel stream could not be loaded.',
        drm_config_failed: 'This channel is protected and could not be set up for playback.',
        drm_playback_failed: 'This channel uses protection this browser cannot play.',
        network_failed: 'The Live TV connection was interrupted.',
        unsupported_browser: 'This browser cannot play Live TV streams.',
        autoplay_blocked: 'Playback needs a tap to start.',
        aborted: 'Live TV playback was cancelled.',
        playback_failed: 'Live TV playback failed. Try switching channels or retrying.'
};

/**
 * The single error type thrown/rejected by the Live TV playback engine.
 *
 * `message` always comes from the fixed safe table; `code` is the OPTIONAL
 * numeric Shaka error code (a stable public enum value) preserved for
 * diagnostics — it is a plain number, never upstream text.
 */
export class LiveTvPlaybackError extends Error {
        readonly kind: LiveTvPlaybackErrorKind;
        /** Optional stable numeric engine error code (Shaka public enum value). */
        readonly code?: number;

        constructor(kind: LiveTvPlaybackErrorKind, code?: number) {
                super(SAFE_PLAYBACK_MESSAGES[kind]);
                this.name = 'LiveTvPlaybackError';
                this.kind = kind;
                if (typeof code === 'number' && Number.isFinite(code)) this.code = code;
        }
}

/** Type guard for callers that catch unknown values. */
export function isLiveTvPlaybackError(value: unknown): value is LiveTvPlaybackError {
        return value instanceof LiveTvPlaybackError;
}

/**
 * LT-15 — Should this failure activate the automatic embed fallback?
 *
 * TRUE only for a GENUINE native playback failure: an `LiveTvPlaybackError`
 * whose kind means the native engine could not (or can no longer) present
 * the stream — every fatal playback kind EXCEPT the two non-failures:
 *   * `autoplay_blocked` — the stream loaded fine; the browser just needs
 *     a tap to start (the existing product behavior is the tap-to-play
 *     CTA, and that stays authoritative — this is NOT a stream failure);
 *   * `aborted` — caller cancellation (switch/destroy), never surfaced.
 *
 * FALSE for EVERYTHING that is not a native playback failure, including:
 *   * `LiveTvError` (LT-2 data layer) — catalogue fetches, channel
 *     resolution/metadata, guide/EPG, search: the directive forbids
 *     falling back for those (the embed page shares the same upstream —
 *     a data-layer failure gives the embed nothing to play either);
 *   * unknown/error values — conservative default: no fallback.
 *
 * Pure classification only; this function never touches playback material.
 */
export function shouldFallbackToEmbed(err: unknown): boolean {
        if (!isLiveTvPlaybackError(err)) return false;
        return err.kind !== 'autoplay_blocked' && err.kind !== 'aborted';
}
