import { json } from '@sveltejs/kit';
import { ContentServiceError } from './types';

export function contentErrorResponse(error: unknown) {
  if (error instanceof ContentServiceError) {
    return json({ ok: false, error: { code: error.code, message: error.message, retryAfter: error.retryAfter } }, { status: error.status, headers: error.retryAfter ? { 'retry-after': String(error.retryAfter) } : undefined });
  }
  return json({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Content is temporarily unavailable.' } }, { status: 502 });
}
