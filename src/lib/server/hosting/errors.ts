/**
 * Phase 3 — Hosting provider error model.
 *
 * Closed error-code vocabulary with fixed, SAFE messages. Mirrors
 * the existing `StreamServiceError` pattern (stremio/stream-errors.ts)
 * — no message ever contains credentials, response bodies, stack
 * traces, or internal provider detail.
 *
 * Retry classification:
 *   - RETRYABLE: RATE_LIMITED, TRANSIENT, NETWORK, TIMEOUT
 *   - PERMANENT (no retry): AUTHENTICATION, AUTHORIZATION, VALIDATION,
 *     NOT_FOUND, UNSUPPORTED, PROVIDER_PROCESSING, UNKNOWN
 *
 * FINDING-001 fix: extended with upload-lifecycle codes that surface
 * DB-level failures (previously masked behind STALE_OPERATION). These
 * are PERMANENT — the admin must fix the underlying data issue
 * (duplicate provider_asset_id, missing FK target, etc.) before
 * retrying.
 */

export type HostingErrorCode =
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TRANSIENT'
  | 'PROVIDER_PROCESSING'
  | 'UNSUPPORTED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'UNKNOWN'
  // Upload-lifecycle codes (FINDING-001). These surface the real DB
  // failure that previously caused silent STALE_OPERATION cascades.
  | 'STALE_OPERATION'
  | 'MISSING_ASSET_ID'
  | 'DUPLICATE_PROVIDER_ASSET'
  | 'FK_VIOLATION'
  | 'CHECK_VIOLATION'
  | 'ASSET_INSERT_FAILED'
  // Asset-lifecycle state codes (final remediation). Mavero-side state
  // machine rejections — deterministic, permanent.
  | 'ASSET_DELETED'
  | 'ASSET_STATE';

const messages: Record<HostingErrorCode, string> = {
  AUTHENTICATION: 'Provider authentication failed. Check server-side credentials.',
  AUTHORIZATION: 'The provider account is not authorized for this operation.',
  VALIDATION: 'The provider rejected the request as invalid.',
  NOT_FOUND: 'The requested provider resource was not found.',
  RATE_LIMITED: 'The provider rate limit was reached.',
  TRANSIENT: 'A transient provider error occurred.',
  PROVIDER_PROCESSING: 'The provider reported a processing failure.',
  UNSUPPORTED: 'This provider capability is not supported or not verified.',
  NETWORK: 'A network error occurred while contacting the provider.',
  TIMEOUT: 'The provider request timed out.',
  UNKNOWN: 'An unexpected error occurred while contacting the provider.',
  // Upload-lifecycle messages. The dynamic DB detail (constraint name,
  // original Postgres message) is appended by the throw site via the
  // `message` option — the static message here is the safe prefix.
  STALE_OPERATION: 'Operation is in processing state but has no associated media asset.',
  MISSING_ASSET_ID: 'The media asset has no provider_asset_id.',
  DUPLICATE_PROVIDER_ASSET: 'A media asset with this provider asset ID already exists.',
  FK_VIOLATION: 'The media asset references a missing media item or provider source.',
  CHECK_VIOLATION: 'The media asset row violated a database check constraint.',
  ASSET_INSERT_FAILED: 'Failed to insert the media asset row.',
  ASSET_DELETED: 'The provider file was permanently deleted — this state is terminal.',
  ASSET_STATE: 'The media asset is in a state that does not allow this operation.',
};

/** Whether an error code is retryable (transient failures only). */
export function isRetryable(code: HostingErrorCode): boolean {
  return code === 'RATE_LIMITED' || code === 'TRANSIENT' || code === 'NETWORK' || code === 'TIMEOUT';
}

export type HostingProviderErrorOptions = {
  /** Curated safe message override. Only ever pass fixed strings — never dynamic content. */
  message?: string;
  cause?: unknown;
  /** Safe numeric detail (HTTP status). */
  httpStatus?: number;
  /** Safe retry-after hint (seconds), when the provider reports one. */
  retryAfterSeconds?: number;
};

export class HostingProviderError extends Error {
  readonly code: HostingErrorCode;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;

  constructor(code: HostingErrorCode, options: HostingProviderErrorOptions = {}) {
    const base = options.message ?? messages[code];
    const suffix = options.httpStatus !== undefined ? ` (HTTP ${options.httpStatus})` : '';
    super(`${base}${suffix}`);
    this.name = 'HostingProviderError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Wrap an unknown error into a HostingProviderError. */
export function asHostingError(error: unknown, fallback: HostingErrorCode = 'UNKNOWN'): HostingProviderError {
  if (error instanceof HostingProviderError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') return new HostingProviderError('TIMEOUT', { cause: error });
  return new HostingProviderError(fallback, { cause: error });
}

/**
 * Classify an HTTP status code into a HostingErrorCode.
 * Used by the shared HTTP client after a failed request.
 */
export function classifyHttpError(status: number): HostingErrorCode {
  if (status === 401 || status === 403) return 'AUTHENTICATION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409 || status === 422) return 'VALIDATION';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'TRANSIENT';
  if (status >= 400) return 'VALIDATION';
  return 'UNKNOWN';
}
