/**
 * Phase 6 Completion — Subtitle upload endpoint.
 *
 * POST /api/admin/media/upload/:id/subtitle
 *
 * Uploads a subtitle file to the provider via the Phase 3 adapter.
 * Accepts multipart form data: file + language + optional label.
 *
 * Security:
 *   - Admin-only (requireAdmin)
 *   - Verifies operation exists + has a media_asset_id
 *   - Verifies adapter supports subtitles
 *   - Does NOT expose provider credentials
 *   - Subtitle failure does NOT affect the main media upload state
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

  // 2. Verify operation has a media asset (upload must be at least uploaded).
  if (!operation.media_asset_id) {
    return json({ ok: false, error: { code: 'INVALID_STATE', message: 'Operation has no associated media asset. Complete the upload first.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 3. Parse multipart form data.
  const formData = await request.formData();
  const file = formData.get('file');
  const language = formData.get('language') as string | null;
  const label = formData.get('label') as string | null;
  const isDefault = formData.get('default') === '1';

  if (!file || !(file instanceof File)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Missing subtitle file.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!language || !language.trim()) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Missing language code.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 4. Look up the provider adapter.
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

  // 5. Verify adapter supports subtitles.
  const caps = adapter.getCapabilities();
  if (!caps.subtitles) {
    return json({ ok: false, error: { code: 'UNSUPPORTED', message: 'This provider does not support subtitle upload.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 6. Get the provider asset ID from the media_assets row.
  const { data: asset } = await adminClient
    .from('media_assets')
    .select('provider_asset_id')
    .eq('id', operation.media_asset_id)
    .maybeSingle();

  const providerAssetId = (asset as { provider_asset_id: string | null })?.provider_asset_id;
  if (!providerAssetId) {
    return json({ ok: false, error: { code: 'INVALID_STATE', message: 'Media asset has no provider_asset_id.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 7. Upload the subtitle through the adapter.
  try {
    const fileBuffer = await file.arrayBuffer();
    await adapter.uploadSubtitle({
      providerAssetId,
      content: fileBuffer,
      filename: file.name,
      language: language.trim(),
      isDefault,
    });

    // 8. Record the subtitle operation in media_operations.
    await adminClient.from('media_operations').insert({
      media_item_id: operation.media_item_id,
      media_asset_id: operation.media_asset_id,
      provider_source_id: operation.provider_source_id,
      upload_operation_id: operation.id,
      action: 'subtitle_upload',
      status: 'success',
      details: JSON.parse(JSON.stringify({ language: language.trim(), label: label ?? null, filename: file.name, isDefault })),
    });

    // 9. Update the media_assets has_subtitles flag.
    await adminClient.from('media_assets').update({ has_subtitles: true }).eq('id', operation.media_asset_id);

    return json({ ok: true, message: 'Subtitle uploaded successfully.' }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });

    // Record the subtitle failure in media_operations — do NOT change the
    // main upload operation's state. The media upload remains intact.
    await adminClient.from('media_operations').insert({
      media_item_id: operation.media_item_id,
      media_asset_id: operation.media_asset_id,
      provider_source_id: operation.provider_source_id,
      upload_operation_id: operation.id,
      action: 'subtitle_upload',
      status: 'failed',
      details: JSON.parse(JSON.stringify({ language: language.trim(), label: label ?? null, filename: file.name })),
      error_code: err.code,
      error_message: err.message,
    });

    return json({ ok: false, error: { code: err.code, message: `Subtitle upload failed: ${err.message}` } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
