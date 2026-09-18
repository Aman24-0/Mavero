import { json } from '@sveltejs/kit';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { PRIVATE_SHORT_CACHE } from '$lib/server/http/cache-headers';
import { errorResponse } from '$lib/server/http/error-response';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, setHeaders }) => {
  try {
    const config = await getPublicStreamingConfig(locals.supabase);
    // Phase 2-C: private cache — config may reflect admin-managed provider
    // state but is otherwise identical across users of the same deployment.
    setHeaders({ 'cache-control': PRIVATE_SHORT_CACHE });
    return json({ ok: true, config });
  } catch (error) {
    console.error('[Streaming] Public configuration failed', error);
    // Phase 3-J: consistent error envelope (was { ok: false, error: { message } }
    // — now { ok: false, error: { code, message } }, backwards-compatible).
    return errorResponse('STREAMING_CONFIG_UNAVAILABLE', 'Streaming configuration is temporarily unavailable.', { status: 503 });
  }
};
