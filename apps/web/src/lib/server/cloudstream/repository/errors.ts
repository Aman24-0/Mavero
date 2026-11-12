/**
 * MAVERO CloudStream repository manager — typed errors (CS-1).
 *
 * Convention: mirrors `streaming/stremio/errors.ts` — a closed error-code
 * union with fixed, SAFE human-readable messages. The messages are the only
 * text that may be persisted into `cloudstream_repositories.last_error` /
 * `cloudstream_extensions.last_error` and surfaced to the admin UI, so they
 * must never contain internal IP addresses, DNS details, stack traces,
 * request headers, credentials, or response bodies (plan §10, §21).
 *
 * The only variable detail ever appended is an HTTP status number, which is
 * not sensitive.
 */

export type CloudStreamRepositoryErrorCode =
  | 'INVALID_URL'
  | 'INVALID_ID'
  | 'BLOCKED_URL'
  | 'DUPLICATE_REPOSITORY'
  | 'INVALID_REPOSITORY'
  | 'PLUGIN_LIST_INVALID'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'TOO_LARGE'
  | 'INVALID_JSON'
  | 'NOT_FOUND'
  | 'UNEXPECTED';

const messages: Record<CloudStreamRepositoryErrorCode, string> = {
  INVALID_URL: 'The CloudStream repository URL is not a valid URL.',
  INVALID_ID: 'The CloudStream repository or extension id is invalid.',
  BLOCKED_URL: 'The CloudStream repository URL points to a destination that is not allowed.',
  DUPLICATE_REPOSITORY: 'This CloudStream repository is already configured.',
  INVALID_REPOSITORY: 'The document is not a valid CloudStream repository index.',
  PLUGIN_LIST_INVALID: 'The repository plugin list is invalid.',
  TIMEOUT: 'The CloudStream repository request timed out.',
  NETWORK: 'The CloudStream repository endpoint could not be reached.',
  HTTP_ERROR: 'The CloudStream repository endpoint returned an HTTP error.',
  TOO_LARGE: 'The CloudStream repository response is too large.',
  INVALID_JSON: 'The CloudStream repository endpoint did not return valid JSON.',
  NOT_FOUND: 'The CloudStream repository or extension was not found.',
  UNEXPECTED: 'An unexpected error occurred while checking the CloudStream repository.',
};

export type CloudStreamRepositoryErrorOptions = {
  /** Curated safe message override. Only ever pass fixed strings — never dynamic content. */
  message?: string;
  cause?: unknown;
  /** Safe numeric detail (HTTP status). Appended to the surfaced message. */
  httpStatus?: number;
};

export class CloudStreamRepositoryError extends Error {
  readonly code: CloudStreamRepositoryErrorCode;
  readonly httpStatus?: number;

  constructor(code: CloudStreamRepositoryErrorCode, options: CloudStreamRepositoryErrorOptions = {}) {
    const base = options.message ?? messages[code];
    super(options.httpStatus !== undefined ? `${base} (HTTP ${options.httpStatus})` : base);
    this.name = 'CloudStreamRepositoryError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Permanently invalid repositories are marked `invalid` instead of `error`. */
export const PERMANENT_REPOSITORY_ERROR_CODES: ReadonlySet<CloudStreamRepositoryErrorCode> = new Set<CloudStreamRepositoryErrorCode>([
  'INVALID_URL',
  'BLOCKED_URL',
  'INVALID_REPOSITORY',
  'PLUGIN_LIST_INVALID',
  'DUPLICATE_REPOSITORY',
]);

export function isPermanentRepositoryFailure(error: unknown): boolean {
  return error instanceof CloudStreamRepositoryError && PERMANENT_REPOSITORY_ERROR_CODES.has(error.code);
}
