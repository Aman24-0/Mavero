/**
 * Phase 6 Completion — Abyss server-proxied upload.
 *
 * POST /api/admin/media/upload/:id/proxy-upload
 *
 * Accepts a file via multipart form data and proxies it to Abyss
 * through the server-side adapter (using the Abyss JWT, which the
 * browser cannot hold).
 *
 * LIMITATION: Netlify serverless functions have a body limit (~26MB
 * Pro tier). Files larger than this will fail with a 413 error.
 * This is a known platform limitation — for larger files, the admin
 * should use remote URL upload (not yet supported for Abyss —
 * documented as an unresolved limitation).
 *
 * Security:
 *   - Admin-only (requireAdmin)
 *   - Abyss JWT stays server-side (never sent to browser)
 *   - File is proxied through the server using the adapter
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { UploadService } from '$lib/server/hosting/upload/service';
import { getHostingAdapter } from '$lib/server/hosting/registry';
import { HostingProviderError } from '$lib/server/hosting/errors';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;
const MAX_PROXY_FILE_SIZE = 26 * 1024 * 1024; // 26 MB — Netlify body limit.

export const POST: RequestHandler = async ({ params, request, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);

  // 1. Get the operation.
  const operation = await uploadService.getOperation(params.id);
  if (!operation) {
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Upload operation not found.' } }, { status: 404, headers: NO_STORE_HEADERS });
  }

  if (operation.status !== 'queued') {
    return json({ ok: false, error: { code: 'INVALID_STATE', message: `Operation is not queued (current: ${operation.status}).` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 2. Parse multipart form data.
  const formData = await request.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof File)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Missing file.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 3. Check file size against platform limit.
  if (file.size > MAX_PROXY_FILE_SIZE) {
    return json({ ok: false, error: { code: 'FILE_TOO_LARGE', message: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB. Server-proxied upload is limited to ${MAX_PROXY_FILE_SIZE / 1024 / 1024} MB due to platform constraints. For larger files, use remote URL upload (currently only supported for Vidara).` } }, { status: 413, headers: NO_STORE_HEADERS });
  }

  // 4. Look up the adapter.
  const { data: sourceRow } = await adminClient
    .from('streaming_sources')
    .select('provider_id')
    .eq('id', operation.provider_source_id!)
    .maybeSingle();

  const { data: providerRow } = await adminClient
    .from('streaming_providers')
    .select('adapter_id')
    .eq('id', sourceRow?.provider_id ?? '')
    .maybeSingle();

  const adapterId = providerRow?.adapter_id;
  if (!adapterId) {
    return json({ ok: false, error: { code: 'ADAPTER_NOT_FOUND', message: 'Provider adapter_id not found.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const adapter = getHostingAdapter(adapterId);
  if (!adapter) {
    return json({ ok: false, error: { code: 'ADAPTER_NOT_FOUND', message: `No hosting adapter for ${adapterId}.` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 5. Update state: queued → uploading.
  await uploadService.updateOperationState(params.id, 'uploading', { upload_started_at: new Date().toISOString() });

  // 6. Execute the upload through the adapter.
  try {
    const fileBuffer = await file.arrayBuffer();
    const result = await adapter.uploadFile({
      content: fileBuffer,
      filename: file.name,
      providerFolderId: null,
    });

    // 7. Complete the upload.
    const updatedOp = await uploadService.completeUploadFromResult(
      params.id,
      result,
      adapterId,
    );
    return json({ ok: true, operation: updatedOp }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
    await uploadService.updateOperationState(params.id, 'failed', {
      failed_at: new Date().toISOString(),
      error_code: err.code,
      error_message: err.message,
    });
    return json({ ok: false, error: { code: err.code, message: err.message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
