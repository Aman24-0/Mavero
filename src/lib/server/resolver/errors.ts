import type { ResolverErrorCode, ResolverErrorShape } from './types';

const publicMessages: Record<ResolverErrorCode, string> = {
  INVALID_REQUEST: 'The playback request is invalid.',
  SOURCE_NOT_FOUND: 'This source could not be found.',
  PROVIDER_NOT_FOUND: 'This provider is unavailable.',
  PROVIDER_DISABLED: 'This provider is currently unavailable.',
  SOURCE_DISABLED: 'This source is currently unavailable.',
  SOURCE_MAINTENANCE: 'This source is temporarily unavailable.',
  UNSUPPORTED_MEDIA_TYPE: 'This source does not support this title type.',
  MISSING_IDENTIFIER: 'This title is missing an identifier required by the source.',
  INVALID_TEMPLATE: 'This source is not configured correctly.',
  INVALID_SOURCE_URL: 'This source returned an invalid playback URL.',
  INVALID_PROVIDER_ENDPOINT: 'This provider endpoint is not configured safely.',
  PROVIDER_RESPONSE_INVALID: 'The provider returned an invalid source.',
  SOURCE_EXPIRED: 'This playback source has expired.',
  RESOLUTION_UNAVAILABLE: 'This source is not available yet.',
  INTERNAL_RESOLUTION_ERROR: 'Playback resolution failed temporarily.',
};

const statusByCode: Record<ResolverErrorCode, number> = {
  INVALID_REQUEST: 400,
  SOURCE_NOT_FOUND: 404,
  PROVIDER_NOT_FOUND: 404,
  PROVIDER_DISABLED: 409,
  SOURCE_DISABLED: 409,
  SOURCE_MAINTENANCE: 503,
  UNSUPPORTED_MEDIA_TYPE: 422,
  MISSING_IDENTIFIER: 422,
  INVALID_TEMPLATE: 500,
  INVALID_SOURCE_URL: 502,
  INVALID_PROVIDER_ENDPOINT: 500,
  PROVIDER_RESPONSE_INVALID: 502,
  SOURCE_EXPIRED: 410,
  RESOLUTION_UNAVAILABLE: 503,
  INTERNAL_RESOLUTION_ERROR: 500,
};

export class ResolverError extends Error {
  readonly code: ResolverErrorCode;
  readonly status: number;
  readonly cause?: unknown;

  constructor(code: ResolverErrorCode, cause?: unknown) {
    super(publicMessages[code]);
    this.name = 'ResolverError';
    this.code = code;
    this.status = statusByCode[code];
    this.cause = cause;
  }

  toShape(): ResolverErrorShape {
    return { code: this.code, message: this.message, status: this.status };
  }
}

export function asResolverError(error: unknown): ResolverError {
  if (error instanceof ResolverError) return error;
  return new ResolverError('INTERNAL_RESOLUTION_ERROR', error);
}
