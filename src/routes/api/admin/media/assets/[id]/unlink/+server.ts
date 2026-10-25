/**
 * MAV-FOCUSED (2026-10) — Unlink asset API.
 * POST /api/admin/media/assets/:id/unlink
 *
 * Marks the media_assets row as `mavero_status='missing'` — the asset is
 * removed from playback availability, but the provider inventory row
 * (provider_asset_id, playback_url, status, sync history, etc.) is
 * PRESERVED. The provider file remains on Vidara/Abyss untouched.
 *
 * The asset can then be re-linked to the SAME or a DIFFERENT media item
 * via `linkAsset` (which recognizes `mavero_status='missing'` as a
 * re-link candidate).
 *
 * Semantically distinct from `detach`:
 *   * `detach` — temporary hide (admin intends to reactivate for same title).
 *   * `unlink` — remove incorrect association (admin intends to re-link
 *     to a different title).
 * Both set `mavero_status='missing'`; the difference is the audit action.
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
