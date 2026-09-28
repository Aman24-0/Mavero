/**
 * Phase 6 Completion — Upload complete endpoint.
 *
 * POST /api/admin/media/upload/:id/complete
 *
 * Accepts the provider's upload result from the browser (after the
 * browser uploaded directly to Vidara's upload server) and:
 *   1. Validates the operation exists + is in 'uploading' state
 *   2. Normalizes the provider response through the Phase 3 adapter
 *   3. Creates/updates the media_assets row
 *   4. Transitions the operation to 'uploaded' → 'processing'
 *
 * Security:
 *   - Admin-only (requireAdmin)
 *   - Does NOT trust browser-supplied media identity, provider identity,
 *     destination folder, or admin identity — all derived from the
 *     server-side operation record.
 *   - Only accepts the provider's upload result (filecode, size, etc.)
 *   - Prevents duplicate completion (idempotent — if already completed,
 *     returns the existing state).
 *   - Prevents completion of cancelled/failed/ready operations.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { UploadService } from '$lib/server/hosting/upload/service';
import { getHostingAdapter } from '$lib/server/hosting/registry';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { readJsonBody } from '$lib/server/http/body';
import type { ProviderUploadResult } from '$lib/server/hosting/types';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

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

  // 2. Idempotency: if already uploaded/processing/ready, return current state.
  if (['uploaded', 'processing', 'ready'].includes(operation.status)) {
    return json({ ok: true, operation, message: 'Operation already completed.' }, { headers: NO_STORE_HEADERS });
  }

  // 3. Verify operation is in 'uploading' state.
  if (operation.status !== 'uploading') {
    return json({ ok: false, error: { code: 'INVALID_STATE', message: `Operation must be in 'uploading' state (current: ${operation.status}).` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 4. Parse the browser-supplied provider result.
  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid request body.' } }, { status: parsed.status, headers: NO_STORE_HEADERS });
  }

  const body = parsed.value as { providerResult?: Record<string, unknown> };
  if (!body.providerResult) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Missing providerResult in request body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 5. Look up the provider adapter.
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

  // 6. Normalize the provider result through the adapter's normalizer.
  // The browser sends the raw Vidara upload response. We normalize it
  // using the same Vidara normalize function the adapter uses.
  let normalizedResult: ProviderUploadResult;
  try {
    if (adapterId === 'vidara') {
      const { normalizeVidaraUploadResult } = await import('$lib/server/hosting/vidara/normalize');
      normalizedResult = normalizeVidaraUploadResult(body.providerResult as Parameters<typeof normalizeVidaraUploadResult>[0]);
    } else if (adapterId === 'abyss') {
      const { normalizeAbyssUploadResult } = await import('$lib/server/hosting/abyss/normalize');
      normalizedResult = normalizeAbyssUploadResult(body.providerResult as Parameters<typeof normalizeAbyssUploadResult>[0]);
    } else {
      return json({ ok: false, error: { code: 'UNSUPPORTED', message: 'Unknown provider adapter.' } }, { status: 400, headers: NO_STORE_HEADERS });
    }
  } catch {
    return json({ ok: false, error: { code: 'INVALID_RESULT', message: 'Provider upload result could not be normalized.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 7. Validate the provider asset ID is present.
  if (!normalizedResult.providerAssetId) {
    return json({ ok: false, error: { code: 'INVALID_RESULT', message: 'Provider upload result does not contain a provider asset ID.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 8. Complete the upload through the service.
  try {
    const updatedOp = await uploadService.completeUploadFromResult(
      params.id,
      normalizedResult,
      adapterId,
    );
    return json({ ok: true, operation: updatedOp }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload completion failed.';
    return json({ ok: false, error: { code: 'COMPLETION_FAILED', message } }, { status: 500, headers: NO_STORE_HEADERS });
  }
};
