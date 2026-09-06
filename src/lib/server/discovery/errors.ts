import type { DiscoveryErrorCode } from './types';

const messages: Record<DiscoveryErrorCode, string> = {
  SOURCE_NOT_FOUND: 'No public source was found on the page.',
  DISCOVERY_FAILED: 'Public page discovery failed.',
  RESOLUTION_FAILED: 'A discovered media candidate could not be resolved.',
  TIMEOUT: 'The public resolver timed out.',
  INVALID_MEDIA: 'The discovered media reference is invalid.',
  UNSUPPORTED_FORMAT: 'The discovered media format is not supported.',
  BLOCKED_SOURCE: 'The source requires protected access and cannot be resolved safely.',
  CANCELLED: 'The discovery request was cancelled.',
};

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;

  constructor(code: DiscoveryErrorCode, cause?: unknown) {
    super(messages[code]);
    this.name = 'DiscoveryError';
    this.code = code;
    this.cause = cause;
  }

  readonly cause?: unknown;
}

export function asDiscoveryError(error: unknown, fallback: DiscoveryErrorCode = 'DISCOVERY_FAILED'): DiscoveryError {
  if (error instanceof DiscoveryError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') return new DiscoveryError('CANCELLED', error);
  return new DiscoveryError(fallback, error);
}
