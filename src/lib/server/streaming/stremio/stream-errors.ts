/**
 * MAVERO Stremio stream resolver — typed errors (Phase 3).
 *
 * Convention: mirrors `stremio/errors.ts` (Phase 2) — a closed error-code
 * union with fixed, SAFE, human-readable messages. These errors are
 * per-addon diagnostics: ONE failing addon never fails the whole resolution
 * (spec §24). No message ever contains internal IPs, DNS details, stack
 * traces, request headers, credentials, or response bodies. The only
 * variable detail is a safe HTTP status number.
 *
 * Phase 3 performs NO database health mutation from stream failures — these
 * errors live in the in-memory resolution diagnostics only.
 */

export type StreamErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_URL'
  | 'BLOCKED_URL'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_RESPONSE'
  | 'UNEXPECTED';

const messages: Record<StreamErrorCode, string> = {
  INVALID_REQUEST: 'The stream resolution request is invalid.',
  INVALID_URL: 'The addon stream endpoint URL is not a valid URL.',
  BLOCKED_URL: 'The addon stream endpoint points to a destination that is not allowed.',
  TIMEOUT: 'The addon stream request timed out.',
  NETWORK: 'The addon stream endpoint could not be reached.',
  HTTP_ERROR: 'The addon stream endpoint returned an HTTP error.',
  TOO_LARGE: 'The addon stream response is too large.',
  INVALID_JSON: 'The addon stream endpoint did not return valid JSON.',
  INVALID_RESPONSE: 'The addon stream response is not a valid Stremio stream response.',
  UNEXPECTED: 'An unexpected error occurred while resolving addon streams.',
};

export type StreamServiceErrorOptions = {
  /** Curated safe message override. Only ever pass fixed strings — never dynamic content. */
  message?: string;
  cause?: unknown;
  /** Safe numeric detail (HTTP status). Appended to the diagnostic message. */
  httpStatus?: number;
};

export class StreamServiceError extends Error {
  readonly code: StreamErrorCode;
  readonly httpStatus?: number;

  constructor(code: StreamErrorCode, options: StreamServiceErrorOptions = {}) {
    const base = options.message ?? messages[code];
    super(options.httpStatus !== undefined ? `${base} (HTTP ${options.httpStatus})` : base);
    this.name = 'StreamServiceError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function asStreamServiceError(error: unknown, fallback: StreamErrorCode = 'UNEXPECTED'): StreamServiceError {
  if (error instanceof StreamServiceError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') return new StreamServiceError('TIMEOUT', { cause: error });
  return new StreamServiceError(fallback, { cause: error });
}
