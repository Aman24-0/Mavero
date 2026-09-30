/**
 * Admin 2.0 — Phase C — Media Library folder summary endpoint.
 *
 * GET /api/admin/media/library/folders
 *
 * Returns a content-tree summary for the sidebar navigator:
 *   - movies grouped by year (with counts)
 *   - series listed with season + episode counts
 *   - anime listed with season + episode counts
 *   - totals for each top-level type
 *
 * This avoids loading the full media catalog into the browser. The
 * sidebar expands a year/series/anime to fetch the corresponding page
 * from the main /api/admin/media/library endpoint.
 *
 * Response shape:
 *   { ok: true, movies, series, anime, totals }
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { MediaLibraryService } from '$lib/server/hosting/library/service';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new MediaLibraryService(adminClient);

  try {
    const summary = await service.folderSummary();
    return json({ ok: true, ...summary }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Admin Media Library] folderSummary failed', message);
    return json(
      { ok: false, error: { code: 'FOLDER_SUMMARY_FAILED', message } },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
};
