/**
 * MAVERO CloudStream Downloader 2 error taxonomy (CS-3 — plan §13/§40.3).
 *
 * The CLOSED machine-readable error vocabulary for the
 * `/api/downloader/mavero2*` endpoints, plus the mapping from the CS-2
 * runtime failure categories into the client-facing codes.
 *
 * SECURITY (plan §20/§21):
 *   * Every message is a SAFE, curated, static string — never internal
 *     stack traces, never upstream error bodies, never URLs with tokens.
 *   * The CS-2 failure category + message stay available for SERVER LOGS
 *     (observability), but the client envelope carries only the closed
 *     vocabulary code + its curated message.
 */

import type { CloudStreamDownloaderErrorCode } from '$lib/shared/cloudstream-types';
import type { CloudStreamFailureCategory } from '../types/runtime';

/** Typed service error for the Downloader 2 pipeline (mirrors StreamServiceError). */
export class CloudStreamDownloaderError extends Error {
  readonly code: CloudStreamDownloaderErrorCode;

  constructor(code: CloudStreamDownloaderErrorCode, message: string) {
    super(message);
    this.name = 'CloudStreamDownloaderError';
    this.code = code;
  }
}

/** Safe, curated client-facing messages per closed error code. */
const ERROR_MESSAGES: Record<CloudStreamDownloaderErrorCode, string> = {
  INVALID_REQUEST: 'The Mavero Downloader 2 request is invalid.',
  EXTENSION_NOT_FOUND: 'This CloudStream extension is not installed.',
  EXTENSION_DISABLED: 'This CloudStream extension is disabled.',
  ADAPTER_NOT_AVAILABLE: 'No Mavero adapter is available for this extension.',
  UNSUPPORTED_MEDIA: 'This extension does not support the requested media type.',
  NO_RESULTS: 'The provider had no results for this title.',
  PROVIDER_TIMEOUT: 'The provider resolution timed out.',
  EXTRACTOR_FAILED: 'The link extraction failed for this provider.',
  NETWORK_ERROR: 'The provider could not be reached.',
  RATE_LIMITED: 'Too many requests. Please slow down and try again shortly.',
  INTERNAL_ERROR: 'Mavero Downloader 2 is temporarily unavailable.',
};

/** The curated safe message for a closed error code. */
export function downloaderErrorMessage(code: CloudStreamDownloaderErrorCode): string {
  return ERROR_MESSAGES[code];
}

/**
 * Maps a CS-2 runtime failure category onto the closed Downloader 2 error
 * vocabulary (documented mapping — plan §40.7):
 *
 *   SEARCH_FAILED   → NETWORK_ERROR   (provider search request failed)
 *   NO_MATCH        → NO_RESULTS      (search answered, nothing matched)
 *   LOAD_FAILED     → NETWORK_ERROR   (matched page could not be loaded)
 *   NO_LINKS        → NO_RESULTS      (page loaded, no download links)
 *   EXTRACTOR_FAILED→ EXTRACTOR_FAILED
 *   TIMEOUT         → PROVIDER_TIMEOUT
 *   BLOCKED_URL     → NETWORK_ERROR   (SSRF guard rejected — safe, no detail)
 *   UNSUPPORTED     → UNSUPPORTED_MEDIA
 *   UNEXPECTED      → INTERNAL_ERROR
 */
export function failureCategoryToErrorCode(
  category: CloudStreamFailureCategory,
): CloudStreamDownloaderErrorCode {
  switch (category) {
    case 'SEARCH_FAILED':
    case 'LOAD_FAILED':
    case 'BLOCKED_URL':
      return 'NETWORK_ERROR';
    case 'NO_MATCH':
    case 'NO_LINKS':
      return 'NO_RESULTS';
    case 'EXTRACTOR_FAILED':
      return 'EXTRACTOR_FAILED';
    case 'TIMEOUT':
      return 'PROVIDER_TIMEOUT';
    case 'UNSUPPORTED':
      return 'UNSUPPORTED_MEDIA';
    case 'UNEXPECTED':
    default:
      return 'INTERNAL_ERROR';
  }
}

/**
 * HTTP status for a top-level Downloader 2 envelope error (documented
 * mapping — the single-extension endpoint surfaces validation states as
 * structured envelope errors; the batch endpoint reports per-extension
 * failures as failed GROUPS instead):
 *
 *   INVALID_REQUEST          → 400 (client-fixed)
 *   EXTENSION_NOT_FOUND      → 404 (resource absent)
 *   EXTENSION_DISABLED       → 409 (state conflict — exists but disabled)
 *   ADAPTER_NOT_AVAILABLE    → 409 (state conflict — no adapter)
 *   UNSUPPORTED_MEDIA        → 400 (client-fixable request shape)
 *   RATE_LIMITED             → 429
 *   everything else          → 503 (mirrors RESOLUTION_UNAVAILABLE parity)
 */
export function downloaderErrorStatus(code: CloudStreamDownloaderErrorCode): number {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_MEDIA':
      return 400;
    case 'EXTENSION_NOT_FOUND':
      return 404;
    case 'EXTENSION_DISABLED':
    case 'ADAPTER_NOT_AVAILABLE':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    default:
      return 503;
  }
}
