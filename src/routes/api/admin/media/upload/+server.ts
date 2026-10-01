/**
 * Phase 6 — Admin upload operation creation + execution API.
 *
 * POST /api/admin/media/upload
 *   Creates an upload operation (queued state) and ensures the canonical
 *   media item + folder.
 *
 *   For remote URL uploads (Vidara only): executes the upload server-side.
 *   For local file uploads: returns the operation ID; the browser uploads
 *   directly to the provider's upload server (Vidara) or through a
 *   separate proxy route (Abyss).
 *
 * GET /api/admin/media/upload
 *   Lists recent upload operations.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { UploadService } from '$lib/server/hosting/upload/service';
import { getHostingAdapter } from '$lib/server/hosting/registry';
import { HostingProviderError } from '$lib/server/hosting/errors';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);
  const operations = await uploadService.listOperations(50);
  return json({ ok: true, operations }, { headers: NO_STORE_HEADERS });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid request body.' } }, { status: parsed.status, headers: NO_STORE_HEADERS });
  }

  const body = parsed.value as {
    tmdbId?: string;
    imdbId?: string;
    title?: string;
    year?: number;
    contentType?: string;
    season?: number;
    episode?: number;
    episodeTitle?: string;
    providerSourceId?: string;
    providerAdapterId?: string;
    uploadSource?: 'local' | 'remote';
    remoteUrl?: string;
    filename?: string;
    sourceQuality?: string;
  };

  // Validate required fields.
  //
  // Phase D §H: `providerAdapterId` is now OPTIONAL. When omitted, the
  // route derives it from `providerSourceId` via a DB lookup. This
  // eliminates the redundant field the client previously had to send
  // (worklog §556). Backward compat: callers that still send
  // `providerAdapterId` are accepted as-is.
  if (!body.tmdbId || !body.title || !body.contentType || !body.providerSourceId) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Missing required fields: tmdbId, title, contentType, providerSourceId.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  if (body.contentType !== 'movie' && body.contentType !== 'series' && body.contentType !== 'anime') {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'contentType must be movie, series, or anime.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);

  // Phase C audit fix: derive providerAdapterId via the CANONICAL resolver
  // instead of inline two-query lookup. Surfaces real errors (deleted
  // source, missing provider) with actionable codes.
  let providerAdapterId = body.providerAdapterId;
  if (!providerAdapterId) {
    try {
      const { resolveAdapterForSource, ProviderResolutionError } = await import('$lib/server/hosting/provider-resolver');
      const resolution = await resolveAdapterForSource(adminClient, body.providerSourceId);
      providerAdapterId = resolution.adapterId;
    } catch (err) {
      const { ProviderResolutionError } = await import('$lib/server/hosting/provider-resolver');
      if (err instanceof ProviderResolutionError) {
        return json({ ok: false, error: { code: 'VALIDATION', message: err.message } }, { status: 400, headers: NO_STORE_HEADERS });
      }
      const message = err instanceof Error ? err.message : 'Failed to resolve provider adapter.';
      return json({ ok: false, error: { code: 'VALIDATION', message } }, { status: 400, headers: NO_STORE_HEADERS });
    }
  }

  try {
    // Create the operation.
    const operation = await uploadService.createOperation({
      tmdbId: body.tmdbId,
      imdbId: body.imdbId ?? null,
      title: body.title!,
      year: body.year ?? null,
      contentType: body.contentType as 'movie' | 'series' | 'anime',
      season: body.season,
      episode: body.episode,
      episodeTitle: body.episodeTitle ?? null,
      providerSourceId: body.providerSourceId!,
      providerAdapterId,
      uploadSource: body.uploadSource ?? 'local',
      remoteUrl: body.remoteUrl,
      filename: body.filename,
      sourceQuality: body.sourceQuality,
      adminUserId: user.id,
    });

    // If remote URL upload, execute immediately.
    if (body.uploadSource === 'remote' && body.remoteUrl) {
      // Check adapter capability.
      const adapter = getHostingAdapter(providerAdapterId);
      if (!adapter) {
        return json({ ok: false, error: { code: 'ADAPTER_NOT_FOUND', message: 'No hosting adapter found for the selected provider.' } }, { status: 400, headers: NO_STORE_HEADERS });
      }
      const caps = adapter.getCapabilities();
      if (!caps.remoteUpload) {
        return json({ ok: false, error: { code: 'UNSUPPORTED', message: 'This provider does not support remote URL upload.' } }, { status: 400, headers: NO_STORE_HEADERS });
      }

      try {
        const updatedOp = await uploadService.executeRemoteUpload(operation.id);
        return json({ ok: true, operation: updatedOp }, { headers: NO_STORE_HEADERS });
      } catch (uploadError) {
        const err = uploadError instanceof HostingProviderError ? uploadError : new HostingProviderError('UNKNOWN', { cause: uploadError });
        return json({ ok: false, error: { code: err.code, message: err.message } }, { status: 502, headers: NO_STORE_HEADERS });
      }
    }

    // For local upload, return the operation ID. The browser will upload
    // directly to the provider (Vidara) or through a proxy route (Abyss).
    return json({ ok: true, operation }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error.';
    return json({ ok: false, error: { code: 'OPERATION_FAILED', message } }, { status: 500, headers: NO_STORE_HEADERS });
  }
};
