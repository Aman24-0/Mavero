/**
 * MAVERO Stremio manifest service — typed errors (Phase 2).
 *
 * Convention: mirrors `discovery/errors.ts` — a closed error-code union with
 * fixed, SAFE human-readable messages. The messages are the ONLY text that
 * may be persisted into `streaming_addons.last_error`, so they must never
 * contain internal IP addresses, DNS details, stack traces, request headers,
 * credentials, or response bodies (Phase 2 spec §11).
 *
 * The only variable detail ever appended is an HTTP status number, which is
 * not sensitive.
 */

export type ManifestErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_URL'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_MANIFEST'
  | 'UNEXPECTED';

const messages: Record<ManifestErrorCode, string> = {
  INVALID_URL: 'The addon manifest URL is not a valid URL.',
  BLOCKED_URL: 'The addon manifest URL points to a destination that is not allowed.',
  TIMEOUT: 'The addon manifest request timed out.',
  NETWORK: 'The addon manifest endpoint could not be reached.',
  HTTP_ERROR: 'The addon manifest endpoint returned an HTTP error.',
  TOO_LARGE: 'The addon manifest response is too large.',
  INVALID_JSON: 'The addon manifest endpoint did not return valid JSON.',
  INVALID_MANIFEST: 'The addon manifest is not a valid Stremio manifest.',
  UNSUPPORTED_MANIFEST: 'The addon manifest does not declare any resources Mavero can use.',
  UNEXPECTED: 'An unexpected error occurred while checking the addon manifest.',
};

export type ManifestServiceErrorOptions = {
  /** Curated safe message override. Only ever pass fixed strings — never dynamic content. */
  message?: string;
  cause?: unknown;
  /** Safe numeric detail (HTTP status). Appended to the persisted message. */
  httpStatus?: number;
};

export class ManifestServiceError extends Error {
  readonly code: ManifestErrorCode;
  readonly httpStatus?: number;

  constructor(code: ManifestErrorCode, options: ManifestServiceErrorOptions = {}) {
    const base = options.message ?? messages[code];
    super(options.httpStatus !== undefined ? `${base} (HTTP ${options.httpStatus})` : base);
    this.name = 'ManifestServiceError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function asManifestServiceError(error: unknown, fallback: ManifestErrorCode = 'UNEXPECTED'): ManifestServiceError {
  if (error instanceof ManifestServiceError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') return new ManifestServiceError('TIMEOUT', { cause: error });
  return new ManifestServiceError(fallback, { cause: error });
}

/**
 * Failure classes for health-status handling (spec §10):
 * permanent failures mark the addon `unavailable`; temporary failures keep
 * the administrator's current status and only record the sanitized error.
 */
export const PERMANENT_MANIFEST_ERROR_CODES: ReadonlySet<ManifestErrorCode> = new Set<ManifestErrorCode>([
  'INVALID_URL',
  'BLOCKED_URL',
  'INVALID_MANIFEST',
  'UNSUPPORTED_MANIFEST',
]);

export function isPermanentManifestFailure(error: unknown): boolean {
  const serviceError = asManifestServiceError(error);
  return PERMANENT_MANIFEST_ERROR_CODES.has(serviceError.code);
}
