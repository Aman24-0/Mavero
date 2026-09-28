/**
 * Phase 6 — Upload operation retry API.
 * POST /api/admin/media/upload/:id/retry
 *   Creates a new operation linked to the original (parent_operation_id).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { UploadService } from '$lib/server/hosting/upload/service';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);
  try {
    const operation = await uploadService.retryOperation(params.id);
    return json({ ok: true, operation }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Retry failed.';
    return json({ ok: false, error: { code: 'RETRY_FAILED', message } }, { status: 400, headers: NO_STORE_HEADERS });
  }
};
