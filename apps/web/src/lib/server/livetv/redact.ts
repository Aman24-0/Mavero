// ============================================================================
// Unified Live TV — Phase 7 diagnostics redaction (server-only).
//
// Defense-in-depth for EVERY free-form diagnostic text the pipeline may
// store or emit (refresh-history rows, admin diagnostics, bounded error
// samples). The existing posture is STRUCTURAL (no credential fields exist;
// fetch/refresh errors are static typed strings) — this module guarantees
// that even a hypothetical leak path (a future free-form field, a provider
// echoing a signed URL in an unexpected place) cannot persist sensitive
// material in diagnostics.
//
// CRITICAL BOUNDARY (pinned by tests):
//   Redaction applies to LOGS, DIAGNOSTICS and HISTORY ONLY. Playback URL
//   construction and the Phase 5 playback router NEVER import this module —
//   legitimate signed parameters on an actual playback request are
//   preserved verbatim (media-auth.ts owns that surface).
// ============================================================================

/**
 * Query-parameter names whose VALUES are always sensitive in diagnostics.
 * Matched case-insensitively against the parameter NAME; `__hdnea__` (the
 * documented signed-playlist token), CDN signing parameters and the common
 * authorization material are covered explicitly.
 */
const SENSITIVE_PARAM_PATTERN = /(?:^|[-_])(?:token|key|secret|sig|signature|auth|authorization|hdnea|hdnts|cookie|password|credential|expires|st|exp|clock|sk|apikey)$/i;

/** Hard cap for any sanitized diagnostic string. */
export const LIVETV_DIAGNOSTIC_MAX_LENGTH = 240;

const REPLACEMENT = '[REDACTED]';

/**
 * Rewrites every sensitive query parameter VALUE in a URL-shaped string to
 * `[REDACTED]`, preserving the parameter NAME (operators still see WHICH
 * parameter carried the value). Non-URL strings pass through the text
 * sanitizer below. Safe to call on any string.
 */
export function redactLivetvUrl(raw: string): string {
        if (typeof raw !== 'string') return '';
        const trimmed = raw.trim().slice(0, 2048);
        if (!trimmed) return '';
        // Only treat values that look like URLs as URLs; everything else
        // falls through to the text sanitizer.
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return sanitizeLivetvDiagnosticText(trimmed);
        let parsed: URL;
        try {
                parsed = new URL(trimmed);
        } catch {
                return sanitizeLivetvDiagnosticText(trimmed);
        }
        for (const key of [...parsed.searchParams.keys()]) {
                if (SENSITIVE_PARAM_PATTERN.test(key)) {
                        // Note: URLSearchParams percent-encodes '[' / ']' — the
                        // URL form uses the bare token so the output stays
                        // human-readable AND the literal value is gone.
                        parsed.searchParams.set(key, 'REDACTED');
                }
        }
        // Credentials embedded in the authority are dropped entirely.
        parsed.username = '';
        parsed.password = '';
        // Drop the fragment — signed tokens sometimes hide there.
        parsed.hash = '';
        return parsed.toString();
}

/**
 * Bounds and sanitizes a free-form diagnostic string:
 *   * replaces `name=value` pairs whose NAME matches the sensitive pattern
 *     (in query strings AND in `k=v` / `k: v` prose forms),
 *   * neutralizes `__hdnea__=…` values wherever they appear,
 *   * strips control characters and collapses whitespace,
 *   * hard-caps the length (the value is truncated, never wrapped).
 */
export function sanitizeLivetvDiagnosticText(raw: string, maxLength: number = LIVETV_DIAGNOSTIC_MAX_LENGTH): string {
        if (typeof raw !== 'string') return '';
        let text = raw;
        // Authorization headers in prose (`Authorization: Bearer <token>`,
        // `authorization=…`, and the bare `Bearer <token>` form) — the token
        // itself is the secret. Runs BEFORE the generic prose rule (a value
        // may itself contain `name:` material the generic scan would consume).
        text = text.replace(/\bauthorization\s*[:=]\s*\S{8,2048}/gi, `authorization=${REPLACEMENT}`);
        text = text.replace(/\b(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,2048})/gi, (match, token: string) => match.slice(0, match.length - token.length) + REPLACEMENT);
        // Query-shaped `name=value` pairs (name carries a sensitive suffix).
        text = text.replace(/([?&;])([a-zA-Z0-9_.-]{1,64})=([^&;\s]{0,512})/g, (match, sep: string, name: string, value: string) => {
                if (SENSITIVE_PARAM_PATTERN.test(name)) return `${sep}${name}=${REPLACEMENT}`;
                return match;
        });
        // Prose-shaped `name=value` / `name: value` pairs (bounded key length,
        // bounded value length) — the same sensitive-name rule.
        text = text.replace(/\b([a-zA-Z0-9_.-]{1,64})[=:]\s?([^&;\s,]{4,512})/g, (match, name: string, value: string) => {
                if (SENSITIVE_PARAM_PATTERN.test(name)) return `${name}=${REPLACEMENT}`;
                return match;
        });
        // The documented signed-playlist token, in any embed form.
        text = text.replace(/__hdnea__=[^&;\s"']{0,512}/g, `__hdnea__=${REPLACEMENT}`);
        // Control characters out; whitespace collapsed (diagnostics are single-line).
        text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
        text = text.replace(/\s+/g, ' ').trim();
        if (maxLength > 0 && text.length > maxLength) {
                text = `${text.slice(0, Math.max(0, maxLength - 3))}...`;
        }
        return text;
}
