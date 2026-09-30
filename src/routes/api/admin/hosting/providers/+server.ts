/**
 * Admin 2.0 — Phase E — Hosting providers overview API.
 *
 * GET /api/admin/hosting/providers
 *   Returns the aggregated provider overview: identity + capabilities +
 *   health + asset counts + last sync. Partial-failure: if health fails
 *   for one provider, the rest still load.
 *
 * Query params:
 *   ?skipHealth=1  Skip the live health check (returns health=null for
 *                  all providers). Used for fast page load — the UI can
 *                  trigger a separate health refresh.
 *
 * Security: Admin-only. No credentials exposed. The read model
 * intentionally does NOT expose provider_metadata jsonb or playback_url.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { HostingControlService } from '$lib/server/hosting/control/service';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new HostingControlService(adminClient);

  const skipHealth = url.searchParams.get('skipHealth') === '1';

  try {
    const providers = await service.listProviders({ skipHealth });
    return json({ ok: true, providers }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load hosting providers.';
    return json({ ok: false, error: { code: 'HOSTING_PROVIDERS_FAILED', message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
