/**
 * Phase F (audit fix) — Execute-remote endpoint for retry operations.
 *
 * POST /api/admin/media/upload/:id/execute-remote
 *
 * FINDING-013 fix: previously, retrying a REMOTE upload required the
 * client to call `POST /api/admin/media/upload` again (creating a THIRD
 * operation row) because there was no way to re-drive
 * `executeRemoteUpload` on an existing queued operation. The retry
 * endpoint (`/retry`) creates a new queued operation linked to the
 * parent, but for remote uploads the server needs to execute the
 * upload — the client can't do it directly.
 *
 * This endpoint closes that gap: it takes an existing queued operation
 * (typically created by `/retry`) and executes the remote upload
 * server-side. No new operation is created. The retry is now a clean
 * two-step: `/retry` (create queued child) → `/execute-remote` (drive it).
 *
 * Security: admin-only. The operation's `source_url` must already be
 * set (carried over from the parent by `retryOperation`).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { UploadService } from '$lib/server/hosting/upload/service';
import { HostingProviderError } from '$lib/server/hosting/errors';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);

  // 1. Get the operation.
  const operation = await uploadService.getOperation(params.id);
  if (!operation) {
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Upload operation not found.' } }, { status: 404, headers: NO_STORE_HEADERS });
  }

  // 2. Verify the operation is in a state that can be executed.
  //    `queued` is the normal entry state for a fresh retry.
  //    `failed` with STALE_OPERATION is also acceptable — the operation
  //    may have been auto-failed before execution had a chance to run
  //    (same recovery pattern as the /complete route, FINDING-014).
  if (operation.status === 'failed' && operation.error_code === 'STALE_OPERATION') {
    await uploadService.updateOperationState(params.id, 'queued', {
      failed_at: null,
      error_code: null,
      error_message: null,
    });
  } else if (operation.status !== 'queued') {
    return json({ ok: false, error: { code: 'INVALID_STATE', message: `Operation must be in 'queued' state (current: ${operation.status}).` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 3. Verify the operation has a source_url (required for remote upload).
  if (!operation.source_url) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'This operation has no source URL to upload. Use the local upload flow instead.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 4. Execute the remote upload.
  try {
    const updatedOp = await uploadService.executeRemoteUpload(params.id);
    return json({ ok: true, operation: updatedOp }, { headers: NO_STORE_HEADERS });
  } catch (uploadError) {
    const err = uploadError instanceof HostingProviderError ? uploadError : new HostingProviderError('UNKNOWN', { cause: uploadError });
    return json({ ok: false, error: { code: err.code, message: err.message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
