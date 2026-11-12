/**
 * Admin 2.0 — Phase F — Operations badge counts API.
 *
 * GET /api/admin/operations/counts
 *   Returns lightweight counts for nav badges:
 *     - jobsActive: queued + uploading + uploaded + processing
 *     - attentionTotal: failed + stale + unconfigured
 *
 * This endpoint is designed to be called frequently (on every page nav)
 * to keep badges fresh. It uses head:true count queries (no row data)
 * for minimum DB load.
 *
 * Security: Admin-only. No credentials exposed.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { OperationsService } from '$lib/server/hosting/operations/service';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new OperationsService(adminClient);

  try {
    const counts = await service.getBadgeCounts();
    return json({ ok: true, ...counts }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load counts.';
    return json({ ok: false, error: { code: 'COUNTS_FAILED', message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
