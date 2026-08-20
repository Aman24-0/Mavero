import { json } from '@sveltejs/kit';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, setHeaders }) => {
  try {
    const config = await getPublicStreamingConfig(locals.supabase);
    setHeaders({ 'cache-control': 'private, max-age=15, stale-while-revalidate=30' });
    return json({ ok: true, config });
  } catch (error) {
    console.error('[Streaming] Public configuration failed', error);
    return json({ ok: false, error: { message: 'Streaming configuration is temporarily unavailable.' } }, { status: 503 });
  }
};
