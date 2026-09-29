/**
 * Phase 8 — Asset reconcile API.
 *
 * POST /api/admin/media/assets/:id/reconcile
 *   Reconciles a single media_asset's processing status by polling
 *   the provider. Updates the asset + any associated upload operations.
 *
 * Security: Admin-only. No credentials exposed.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { SyncService } from '$lib/server/hosting/sync/service';
import { HostingProviderError } from '$lib/server/hosting/errors';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const syncService = new SyncService(adminClient);

  try {
    const result = await syncService.reconcileAsset(params.id);
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
    return json({ ok: false, error: { code: err.code, message: err.message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
