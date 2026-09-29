/** Phase 8 — Unlinked provider files API. GET /api/admin/media/unlinked */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { SyncService } from '$lib/server/hosting/sync/service';
import { NO_STORE } from '$lib/server/http/cache-headers';
const H = { 'cache-control': NO_STORE } as const;
export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const syncService = new SyncService(adminClient);
  const provider = url.searchParams.get('provider');
  try {
    const results = provider ? [await syncService.syncProvider(provider)] : await syncService.syncAll();
    const unlinked = results.flatMap((r) => r.unlinkedFiles.map((f) => ({ ...f, provider: r.providerAdapterId })));
    return json({ ok: true, unlinked }, { headers: H });
  } catch (error) {
    return json({ ok: false, error: { code: 'SYNC_FAILED', message: error instanceof Error ? error.message : 'Unknown error.' } }, { status: 502, headers: H });
  }
};
