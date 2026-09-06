import { ContentServiceError } from './types';

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 8000, ...requestInit } = init;
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

export function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
