import { json } from '@sveltejs/kit';
import { discover } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isContentType } from '$lib/server/content/types';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import type { RequestHandler } from './$types';

// Public catalog discover endpoint.
//
// Phase 2-C (audit PERF-003): the response is identical for every user —
// no auth dimension, no Adult Mode dimension. TMDB's `include_adult=false`
// is enforced at the adapter layer, so only non-adult content ever reaches
// this response. Safe to cache publicly at the CDN.

export const GET: RequestHandler = async ({ params, url, setHeaders }) => {
  if (!isContentType(params.type)) {
    return json({ ok: false, error: { code: 'INVALID_TYPE', message: 'Unsupported content type.' } }, { status: 400 });
  }

  const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? 1) || 1, 20));
  try {
    const result = await discover(params.type, page);
    // Phase 2-C: cache publicly — no user/adult dimension on this response.
    setHeaders({ 'cache-control': PUBLIC_CATALOG_CACHE });
    return json({ ok: true, ...result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
