// LT-2 — LiveGT V1 client error model (Live TV data layer).
//
// Every failure path in the Live TV client surfaces as ONE typed error class
// (`LiveTvError`) with a machine-readable `kind`, so LT-3/LT-4 can branch on
// behavior (retry vs message vs ignore) instead of parsing strings.
//
// SECURITY CONTRACT (LT-2 brief §11/§14, plan §15):
//   * Error messages come from a FIXED safe-message table — they never
//     interpolate response bodies, signed MPD URLs, DRM key/keyId values,
//     backend stack traces or any other upstream text. The only contextual
//     data attached is non-sensitive: HTTP status, channel id, endpoint name.
//   * Raw backend bodies are never read into errors, so sensitive material
//     cannot leak even accidentally.
//
// HTTP STATUS MAPPING (verified against the live API, LT-0):
//   400 → bad_request   (documented for invalid ids)
//   404 → not_found     (OBSERVED for unknown AND malformed ids — the live
//                        API returns 404 where the docs describe 400; the
//                        actual behavior is preserved, never remapped)
//   429 → rate_limited
//   other 4xx → bad_request (status preserved on `error.status`)
//   5xx → server       (incl. the documented 502 "provider unavailable")

/** Machine-readable Live TV client failure categories. */
export type LiveTvErrorKind =
	| 'network' // fetch rejected (offline / DNS / CORS / connection reset)
	| 'timeout' // the client-side LiveGT metadata timeout fired
	| 'aborted' // the CALLER's AbortSignal fired (not an error for the UI)
	| 'bad_request' // HTTP 400 (or unmapped 4xx); locally rejected channel id
	| 'not_found' // HTTP 404 — unknown or malformed channel id (observed)
	| 'rate_limited' // HTTP 429
	| 'server' // HTTP 5xx — LiveGT/upstream problem (incl. documented 502)
	| 'invalid_response' // HTTP 200 whose JSON shape failed validation
	| 'no_playback_source' // resolution succeeded but zero usable sources
	| 'unsupported_drm'; // DRM present but not a supported type

/**
 * Fixed, user-safe message table. Values are deliberately generic — they are
 * safe to show in a UI and safe to log. Sensitive material NEVER appears here.
 */
const SAFE_MESSAGES: Record<LiveTvErrorKind, string> = {
	network: 'Live TV is unreachable right now.',
	timeout: 'Live TV took too long to respond.',
	aborted: 'Live TV request was cancelled.',
	bad_request: 'Live TV rejected the request.',
	not_found: 'This Live TV channel was not found.',
	rate_limited: 'Live TV is busy. Please try again in a moment.',
	server: 'Live TV is having trouble on their end.',
	invalid_response: 'Live TV returned an unexpected response.',
	no_playback_source: 'This channel has no playable stream right now.',
	unsupported_drm: 'This channel uses a protection method this app cannot play.'
};

/** Non-sensitive request context attached to a `LiveTvError`. */
export type LiveTvErrorContext = {
	/** HTTP status when the failure came from a response. */
	status?: number;
	/** Channel id the request was for (caller-supplied, not sensitive). */
	channelId?: string;
	/** Which logical endpoint failed: 'channels' | 'channel' | 'guide'. */
	endpoint?: 'channels' | 'channel' | 'guide';
};

/**
 * The single error type thrown by the Live TV client layer.
 *
 * `message` is always taken from the fixed safe table, so `String(error)` /
 * `error.message` / stack traces can never contain signed URLs, DRM material
 * or upstream response text.
 */
export class LiveTvError extends Error {
	readonly kind: LiveTvErrorKind;
	readonly status?: number;
	readonly channelId?: string;
	readonly endpoint?: 'channels' | 'channel' | 'guide';

	constructor(kind: LiveTvErrorKind, context: LiveTvErrorContext = {}) {
		super(SAFE_MESSAGES[kind]);
		this.name = 'LiveTvError';
		this.kind = kind;
		if (context.status !== undefined) this.status = context.status;
		if (context.channelId !== undefined) this.channelId = context.channelId;
		if (context.endpoint !== undefined) this.endpoint = context.endpoint;
	}
}

/** Type guard for callers that catch unknown values. */
export function isLiveTvError(value: unknown): value is LiveTvError {
	return value instanceof LiveTvError;
}

/**
 * Map an HTTP status to an error kind. 2xx returns null (not an error at the
 * transport layer — body validation happens separately).
 */
export function liveTvErrorKindForStatus(status: number): LiveTvErrorKind | null {
	if (status >= 200 && status < 300) return null;
	if (status === 404) return 'not_found';
	if (status === 429) return 'rate_limited';
	if (status >= 500) return 'server';
	return 'bad_request'; // 400 + every other unmapped 4xx
}
