/**
 * Phase 6 Completion — Vidara upload-server endpoint.
 *
 * POST /api/admin/media/upload/:id/upload-server
 *
 * Obtains the Vidara upload server URL using server-side credentials.
 * Returns ONLY the upload server URL to the browser — NO API keys,
 * NO permanent credentials.
 *
 * Security:
 *   - Admin-only (requireAdmin)
 *   - Verifies operation exists + belongs to Vidara
 *   - Verifies operation is in 'queued' state
 *   - Returns only the temporary upload server URL
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
import { readJsonBody } from '$lib/server/http/body';

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

  // 2. Verify operation is in uploadable state.
  if (operation.status !== 'queued') {
    return json({ ok: false, error: { code: 'INVALID_STATE', message: `Operation is not queued (current: ${operation.status}).` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 3. Look up the provider adapter_id.
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

  // 4. Get the hosting adapter.
  const adapter = getHostingAdapter(adapterId);
  if (!adapter) {
    return json({ ok: false, error: { code: 'ADAPTER_NOT_FOUND', message: `No hosting adapter for ${adapterId}.` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 5. Verify adapter supports local upload.
  const caps = adapter.getCapabilities();
  if (!caps.localUpload) {
    return json({ ok: false, error: { code: 'UNSUPPORTED', message: 'This provider does not support local file upload.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 6. Update operation state: queued → uploading.
  await uploadService.updateOperationState(params.id, 'uploading', { upload_started_at: new Date().toISOString() });

  // 7. For Vidara: get the upload server URL.
  // The Vidara adapter's uploadFile() does a two-step process:
  //   1. GET /v1/upload/server → returns upload server URL
  //   2. POST file to the upload server URL
  // For browser-direct upload, we need to expose step 1's result.
  //
  // IMPORTANT (Phase 7 fix): Vidara authenticates via `api_key` query
  // parameter — NOT via a Bearer Authorization header. The previous
  // implementation passed a Bearer header to the shared HTTP fetcher,
  // which Vidara does not recognize, producing HTTP 401. The fix
  // delegates URL construction to the Vidara adapter's authenticated
  // URL builder (`buildVidaraUrl`) so the same auth scheme is used
  // everywhere. The shared HTTP fetcher is constructed with `null`
  // (no Authorization header) — matching the adapter.
  if (adapterId === 'vidara') {
    try {
      // Get the Vidara config to access the API key + base URL.
      const { getVidaraConfigOrNull } = await import('$lib/server/hosting/vidara/config');
      const config = getVidaraConfigOrNull();
      if (!config) {
        return json({ ok: false, error: { code: 'CONFIG_MISSING', message: 'Vidara API credentials are not configured.' } }, { status: 500, headers: NO_STORE_HEADERS });
      }

      // Build the authenticated URL (api_key query parameter, NOT Bearer).
      const { buildVidaraUrl } = await import('$lib/server/hosting/vidara/adapter');
      const { createHostingHttpFetcher } = await import('$lib/server/hosting/http-client');
      // `null` — no Authorization header. Vidara auth is in the URL query.
      const fetcher = createHostingHttpFetcher(null);
      const res = await fetcher({
        method: 'GET',
        url: buildVidaraUrl(config.baseUrl, '/v1/upload/server', null, config.apiKey),
      });

      // CRITICAL FIX: handle null res.json (empty/non-JSON response from
      // Vidara). The shared HTTP client captures the raw text + content
      // type for ALL responses. If Vidara returns a 200 with an empty
      // body or non-JSON content type, res.json is null — we must NOT
      // call extractVidaraUploadServerUrl(null) because it would throw
      // "Cannot read properties of null" which becomes a generic UNKNOWN
      // error.
      if (!res.json) {
        // Roll back to queued so the admin can retry.
        await uploadService.updateOperationState(params.id, 'queued', {});
        return json({
          ok: false,
          error: {
            code: 'INVALID_PROVIDER_RESPONSE',
            message: res.text
              ? `Vidara upload-server response was not valid JSON (content-type: ${res.contentType || 'missing'}).`
              : 'Vidara upload-server response was empty. The upload server could not be obtained.',
          },
        }, { status: 502, headers: NO_STORE_HEADERS });
      }

      // Extract the upload server URL from the response.
      const { extractVidaraUploadServerUrl } = await import('$lib/server/hosting/vidara/normalize');
      const uploadUrl = extractVidaraUploadServerUrl(res.json as Parameters<typeof extractVidaraUploadServerUrl>[0]);

      // Return ONLY the upload URL — no API key, no credentials.
      // The `api_key` query parameter is on the GET /v1/upload/server
      // request above, NOT on the returned uploadUrl, so the browser
      // never receives the API key.
      return json({ ok: true, uploadUrl }, { headers: NO_STORE_HEADERS });
    } catch (error) {
      const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
      // Roll back to queued so the admin can retry.
      await uploadService.updateOperationState(params.id, 'queued', {});
      // CRITICAL FIX: return the actual HTTP status code from the error
      // instead of always returning 502. The previous version returned
      // 502 for ALL errors — AUTHENTICATION (401), NETWORK, TRANSIENT
      // (500/502/503), TIMEOUT — which was misleading and caused the
      // frontend's safeJsonParse (before the fix) to show a generic
      // "(HTTP 502)" message instead of the actual error code/message.
      //
      // Now the HTTP status reflects the actual error category:
      //   AUTHENTICATION → 502 (provider auth failed — the route is a
      //     proxy so we return 502 "bad gateway" when the upstream
      //     rejects our credentials, not 401 which would imply the
      //     ADMIN's credentials are wrong)
      //   NETWORK → 502 (upstream unreachable)
      //   TRANSIENT → 502 (upstream returned 5xx)
      //   TIMEOUT → 504 (gateway timeout)
      //   UNSUPPORTED/VALIDATION → 400 (client-side issue)
      //   CONFIG_MISSING → 500 (server config issue)
      //   UNKNOWN → 502 (fallback)
      //
      // The actual error CODE is always in the JSON body so the
      // frontend can display it (after the safeJsonParse fix).
      const httpStatus = err.httpStatus ?? (err.code === 'TIMEOUT' ? 504 : err.code === 'UNSUPPORTED' || err.code === 'VALIDATION' ? 400 : 502);
      return json({ ok: false, error: { code: err.code, message: err.message } }, { status: httpStatus, headers: NO_STORE_HEADERS });
    }
  }

  // For Abyss: the server proxies the upload (no browser-direct flow).
  // Return an error — Abyss local upload goes through a different path.
  return json({ ok: false, error: { code: 'UNSUPPORTED', message: 'Browser-direct upload is not supported for this provider. Use the server-proxied upload route.' } }, { status: 400, headers: NO_STORE_HEADERS });
};
