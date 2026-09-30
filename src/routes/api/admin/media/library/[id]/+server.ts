/**
 * Admin 2.0 — Phase C — Media Library detail endpoint.
 *
 * GET /api/admin/media/library/[id]
 *
 * Returns a single media_item with all its provider assets and the
 * 20 most recent admin operations on it.
 *
 * Response shape:
 *   { ok: true, item: LibraryMediaItem, recent_operations: LibraryOperationSummary[] }
 *   OR
 *   { ok: false, error: { code, message } }  (404 if not found)
 *
 * Security: admin-only. Service-role client. No provider credentials
 * leak. provider_metadata jsonb is intentionally NOT returned.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { MediaLibraryService } from '$lib/server/hosting/library/service';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new MediaLibraryService(adminClient);

  const id = params.id;
  if (!id || id.length < 8) {
    return json(
      { ok: false, error: { code: 'INVALID_ID', message: 'A valid media item id is required.' } },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const result = await service.detail(id);
    if (!result) {
      return json(
        { ok: false, error: { code: 'NOT_FOUND', message: 'Media item not found.' } },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Admin Media Library] detail failed', id, message);
    return json(
      { ok: false, error: { code: 'DETAIL_QUERY_FAILED', message } },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
};
