import { ContentServiceError } from './types';

// Performance pass (Phase 1.3): retry on transient upstream failures (429
// rate-limit, 5xx). One retry with a short backoff — enough to ride out a
// transient blip without doubling latency on a hard failure. The backoff
// is: 429 → honor retry-after (capped at 2 s) or 500 ms; 5xx → 300 ms.
const RETRY_BACKOFF_MS = 300;
const RATE_LIMIT_BACKOFF_MS = 500;
const RATE_LIMIT_BACKOFF_CAP_MS = 2000;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffFor(error: ContentServiceError): number {
  if (error.status === 429) {
    const retryAfter = typeof error.retryAfter === 'number' ? error.retryAfter * 1000 : RATE_LIMIT_BACKOFF_MS;
    return Math.min(retryAfter, RATE_LIMIT_BACKOFF_CAP_MS);
  }
  return RETRY_BACKOFF_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce<T>(url: string, requestInit: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(requestInit.headers ?? {})
      }
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0) || undefined;
      throw new ContentServiceError('The content provider is rate limiting requests.', { code: 'RATE_LIMITED', status: 429, retryAfter });
    }

    if (!response.ok) {
      throw new ContentServiceError('The content provider returned an upstream error.', { code: 'UPSTREAM_ERROR', status: response.status >= 500 ? 502 : response.status });
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ContentServiceError('The content provider returned an invalid response.', { code: 'INVALID_RESPONSE', status: 502 });
    }
  } catch (error) {
    if (error instanceof ContentServiceError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ContentServiceError('The content provider request timed out.', { code: 'UPSTREAM_ERROR', status: 504 });
    }
    throw new ContentServiceError('The content provider is temporarily unavailable.', { code: 'UPSTREAM_ERROR', status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 8000, ...requestInit } = init;

  try {
    return await fetchOnce<T>(url, requestInit, timeoutMs);
  } catch (error) {
    // Performance pass (Phase 1.3): retry ONCE on 429 (rate-limit) or 5xx
    // (transient upstream failure). The backoff is short (300-500 ms) so
    // the total worst-case latency is ~8.3 s + backoff + 8 s — acceptable
    // for a single retry. Non-retryable errors (4xx other than 429, parse
    // errors, timeouts on the SECOND attempt) propagate immediately.
    if (error instanceof ContentServiceError && isRetryable(error.status)) {
      await sleep(backoffFor(error));
      return fetchOnce<T>(url, requestInit, timeoutMs);
    }
    throw error;
  }
}

export function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
