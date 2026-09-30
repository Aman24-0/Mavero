/**
 * Admin 2.0 — Link an existing provider file to a Mavero media item.
 *
 * POST /api/admin/media/assets/link
 * Body: { mediaItemId, providerSourceId, providerAssetId }
 *
 * This is the admin action for connecting a Vidara/Abyss file that was
 * uploaded outside of Mavero (e.g. via the Vidara dashboard) to a
 * canonical media_item. The admin explicitly selects which media_item
 * to link to which provider file — there is NO auto-matching.
 *
 * Security: admin-only (requireAdmin). Service-role client.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { ManagementService } from '$lib/server/hosting/management/service';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { HostingProviderError } from '$lib/server/hosting/errors';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const management = new ManagementService(adminClient, mediaService);

  let body: { mediaItemId?: string; providerSourceId?: string; providerAssetId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { mediaItemId, providerSourceId, providerAssetId } = body;
  if (!mediaItemId || !providerSourceId || !providerAssetId) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'mediaItemId, providerSourceId, and providerAssetId are required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  try {
    const result = await management.linkAsset(mediaItemId, providerSourceId, providerAssetId, user.id);
    if (result.ok) {
      return json({ ok: true, mediaAssetId: result.mediaAssetId }, { headers: NO_STORE_HEADERS });
    }
    return json({ ok: false, error: { code: result.error?.code ?? 'UNKNOWN', message: result.error?.message ?? 'Link failed.' } }, { status: 400, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof HostingProviderError) {
      return json({ ok: false, error: { code: error.code, message: error.message } }, { status: 400, headers: NO_STORE_HEADERS });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ ok: false, error: { code: 'UNKNOWN', message } }, { status: 500, headers: NO_STORE_HEADERS });
  }
};
