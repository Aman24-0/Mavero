import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { asResolverError } from '$lib/server/resolver/errors';
import { resolveSource } from '$lib/server/resolver/service';

export const POST: RequestHandler = async ({ request, locals }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'The playback request is invalid.' } }, { status: 400 });
  }

  try {
    const source = await resolveSource(locals.supabase, body);
    return json({ ok: true, source }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const resolverError = asResolverError(error);
    if (resolverError.code === 'INTERNAL_RESOLUTION_ERROR') console.error('[Playback] Resolution failed', resolverError.cause);
    return json({ ok: false, error: { code: resolverError.code, message: resolverError.message } }, { status: resolverError.status, headers: { 'cache-control': 'no-store' } });
  }
};
