import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { asResolverError } from '$lib/server/resolver/errors';
import { resolveSource } from '$lib/server/resolver/service';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';

export const POST: RequestHandler = async ({ request, locals }) => {
  const parsed = await readJsonBody<unknown>(request);
  if (!parsed.ok) return json({ ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The playback request is invalid.' } }, { status: parsed.status });
  const body = parsed.value;

  // Phase 1 (audit SEC-003): bounded per-identity rate limit — resolution
  // drives a bounded-but-real upstream budget per call.
  const verdict = checkRateLimit('resolve', clientIdentity(request.headers, locals.user?.id));
  if (!verdict.allowed) {
    return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(verdict.retryAfterSeconds) } });
  }

  try {
    const source = await resolveSource(locals.supabase, body);
    return json({ ok: true, source }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const resolverError = asResolverError(error);
    if (resolverError.code === 'INTERNAL_RESOLUTION_ERROR') console.error('[Playback] Resolution failed', { code: resolverError.code });
    return json({ ok: false, error: { code: resolverError.code, message: resolverError.message } }, { status: resolverError.status, headers: { 'cache-control': 'no-store' } });
  }
};
