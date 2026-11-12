/**
 * Reactivate a previously detached provider asset.
 *
 * POST /api/admin/media/assets/:id/reactivate
 *   Restores mavero_status from 'missing' back to 'available' (if status='ready')
 *   or 'processing', restoring playback. Does NOT modify the remote provider file.
 *
 * Security: Admin-only. No credentials exposed.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { ManagementService } from '$lib/server/hosting/management/service';
import { HostingProviderError } from '$lib/server/hosting/errors';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ params, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const svc = new ManagementService(adminClient, new CanonicalMediaService(adminClient));

  try {
    const result = await svc.reactivateAsset(params.id, user.id);
    return json({ ok: result.ok, result, error: result.error }, { status: result.ok ? 200 : 502, headers: NO_STORE_HEADERS });
  } catch (error) {
    const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
    return json({ ok: false, error: { code: err.code, message: err.message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
