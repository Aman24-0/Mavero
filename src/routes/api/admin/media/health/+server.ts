/** Phase 10 — Provider health API. GET /api/admin/media/health */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { ProviderHealthService } from '$lib/server/hosting/health/service';
import { NO_STORE } from '$lib/server/http/cache-headers';
const H = { 'cache-control': NO_STORE } as const;
export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const healthService = new ProviderHealthService(adminClient);
  const provider = url.searchParams.get('provider');
  try {
    if (provider) {
      const report = await healthService.checkProvider(provider);
      return json({ ok: true, ...report }, { headers: H });
    }
    const result = await healthService.checkAll();
    return json({ ok: true, ...result }, { headers: H });
  } catch (error) {
    return json({ ok: false, error: { code: 'HEALTH_CHECK_FAILED', message: error instanceof Error ? error.message : 'Unknown error.' } }, { status: 502, headers: H });
  }
};
