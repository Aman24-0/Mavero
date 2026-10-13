/**
 * MAV-FOCUSED (2026-10) — Unlink asset API.
 * POST /api/admin/media/assets/:id/unlink
 *
 * Removes the Mavero-side media_assets association WITHOUT deleting the
 * provider file. The provider file remains on Vidara/Abyss and can be
 * re-linked to a different media item.
 *
 * Unlike detach (which sets mavero_status='missing' but keeps the row +
 * media_item_id association for reactivation), unlink DELETES the
 * media_assets row entirely — the association is gone, the file is
 * available for fresh linking.
 *
 * Authorization: admin-only (requireAdmin). The mediaAssetId comes from
 * the URL param (server-validated), not from the request body.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { ManagementService } from '$lib/server/hosting/management/service';
import { HostingProviderError } from '$lib/server/hosting/errors';
import { NO_STORE } from '$lib/server/http/cache-headers';

const H = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ params, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const svc = new ManagementService(adminClient, new CanonicalMediaService(adminClient));

  try {
    const result = await svc.unlinkAsset(params.id, user.id);
    return json({ ok: result.ok, result, error: result.error }, { status: result.ok ? 200 : 502, headers: H });
  } catch (error) {
    if (error instanceof HostingProviderError) {
      return json({ ok: false, error: { code: error.code, message: error.message } }, { status: 400, headers: H });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ ok: false, error: { code: 'UNKNOWN', message } }, { status: 500, headers: H });
  }
};
