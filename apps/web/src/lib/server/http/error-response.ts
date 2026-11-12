// Phase 3-J (audit OBS-8) — Error response consistency.
//
// Problem: API error responses were inconsistent. Most endpoints used
// `{ ok: false, error: { code, message } }`, but a few used
// `{ ok: false, error: { message } }` (no code). Some included
// `retry-after` headers; some didn't. Callers couldn't rely on a
// single shape for error handling.
//
// Fix: a small shared helper that produces a consistent error envelope.
// The helper NEVER leaks stack traces or secrets — the message is
// always a safe, user-facing string; the code is always a typed string
// from a closed set (the caller passes it).
//
// ENVELOPE SHAPE:
//   { ok: false, error: { code: string, message: string } }
//
// OPTIONAL:
//   * status — the HTTP status code (caller-provided; defaults to 500).
//   * retryAfter — seconds (for 429/503 responses; adds the retry-after
//     header).
//   * cacheControl — defaults to 'no-store' (error responses must NOT
//     be cached — a stale error is worse than none).
//
// The helper is intentionally TINY — it doesn't introduce a new error
// type hierarchy, doesn't replace the existing ContentServiceError or
// ResolverError, and doesn't change the response shape of existing
// endpoints (the envelope is backwards-compatible with what they
// already emit). It's a single function that callers can adopt
// incrementally.

import { json } from '@sveltejs/kit';

export type ErrorEnvelopeOptions = {
  /** The HTTP status code. Defaults to 500. */
  status?: number;
  /** Seconds — for 429/503 responses. Adds the retry-after header. */
  retryAfterSeconds?: number;
  /**
   * Cache-Control header value. Defaults to 'no-store' (error responses
   * must NOT be cached). Pass 'no-store' explicitly for clarity.
   */
  cacheControl?: string;
};

/**
 * Returns a consistent error Response with the envelope:
 *   { ok: false, error: { code, message } }
 *
 * SECURITY:
 *   * The message is ALWAYS a safe, user-facing string — NEVER the raw
 *     error message from an upstream library (which might contain
 *     credentials, paths, or stack traces).
 *   * The code is ALWAYS a typed string from a closed set (the caller
 *     passes it — never derive it from user input).
 *   * Stack traces are NEVER included in the response body.
 *   * The response is NEVER cached (default cache-control: no-store).
 *
 * BACKWARDS COMPATIBILITY:
 *   * Endpoints that already emit `{ ok: false, error: { code, message } }`
 *     can adopt this helper without changing their client-visible
 *     response shape.
 *   * Endpoints that emit `{ ok: false, error: { message } }` (no code)
 *     should adopt this helper — the added `code` field is additive
 *     (existing clients that only read `error.message` continue to work).
 */
export function errorResponse(
  code: string,
  message: string,
  options: ErrorEnvelopeOptions = {}
): Response {
  const status = options.status ?? 500;
  const headers: Record<string, string> = {
    'cache-control': options.cacheControl ?? 'no-store',
  };
  if (typeof options.retryAfterSeconds === 'number' && options.retryAfterSeconds > 0) {
    headers['retry-after'] = String(options.retryAfterSeconds);
  }
  return json({ ok: false, error: { code, message } }, { status, headers });
}

/**
 * Convenience helpers for the most common error shapes.
 * These call errorResponse() with the right status + code.
 */
export const errorResponses = {
  /** 400 Bad Request — validation failure. */
  invalidRequest(message: string = 'The request is invalid.'): Response {
    return errorResponse('INVALID_REQUEST', message, { status: 400 });
  },
  /** 401 Unauthorized — authentication required. */
  unauthorized(message: string = 'Authentication is required.'): Response {
    return errorResponse('UNAUTHORIZED', message, { status: 401 });
  },
  /** 403 Forbidden — authenticated but not allowed. */
  forbidden(message: string = 'This action is not allowed.'): Response {
    return errorResponse('FORBIDDEN', message, { status: 403 });
  },
  /** 404 Not Found — non-disclosing (same shape as a missing title). */
  notFound(message: string = 'The requested resource could not be found.'): Response {
    return errorResponse('NOT_FOUND', message, { status: 404 });
  },
  /** 429 Too Many Requests — rate limited. */
  rateLimited(retryAfterSeconds: number, message: string = 'Too many requests. Please try again shortly.'): Response {
    return errorResponse('RATE_LIMITED', message, { status: 429, retryAfterSeconds });
  },
  /** 500 Internal Server Error — non-disclosing (no stack trace). */
  internal(message: string = 'An unexpected error occurred. Please try again.'): Response {
    return errorResponse('INTERNAL_ERROR', message, { status: 500 });
  },
  /** 502 Bad Gateway — upstream service failure. */
  upstream(message: string = 'The upstream service is temporarily unavailable.'): Response {
    return errorResponse('UPSTREAM_ERROR', message, { status: 502 });
  },
  /** 503 Service Unavailable — temporary, retry later. */
  unavailable(retryAfterSeconds: number | undefined, message: string = 'This service is temporarily unavailable. Please try again shortly.'): Response {
    return errorResponse('SERVICE_UNAVAILABLE', message, { status: 503, retryAfterSeconds });
  },
};
