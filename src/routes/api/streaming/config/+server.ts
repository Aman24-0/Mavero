import { json } from '@sveltejs/kit';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { PRIVATE_SHORT_CACHE } from '$lib/server/http/cache-headers';
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
    return json({ ok: false, error: { message: 'Streaming configuration is temporarily unavailable.' } }, { status: 503 });
  }
};
