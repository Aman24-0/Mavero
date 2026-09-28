/**
 * Phase 6 — Upload operation status API.
 * GET /api/admin/media/upload/:id/status
 *   Returns the current operation state.
 * POST /api/admin/media/upload/:id/status
 *   Polls the provider processing status and updates the operation.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { UploadService } from '$lib/server/hosting/upload/service';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);
  const operation = await uploadService.getOperation(params.id);
  if (!operation) return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Operation not found.' } }, { status: 404, headers: NO_STORE_HEADERS });
  return json({ ok: true, operation }, { headers: NO_STORE_HEADERS });
};

export const POST: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);
  try {
    const result = await uploadService.pollProcessingStatus(params.id);
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Polling failed.';
    return json({ ok: false, error: { code: 'POLL_FAILED', message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
