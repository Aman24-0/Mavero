/** Phase 8 — Rename asset API. POST /api/admin/media/assets/:id/rename */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { ManagementService } from '$lib/server/hosting/management/service';
import { readJsonBody } from '$lib/server/http/body';
import { NO_STORE } from '$lib/server/http/cache-headers';
const H = { 'cache-control': NO_STORE } as const;
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const parsed = await readJsonBody<{ newName?: string }>(request);
  if (!parsed.ok || !parsed.value.newName) return json({ ok: false, error: { code: 'VALIDATION', message: 'newName is required.' } }, { status: 400, headers: H });
  const adminClient = createSupabaseAdminClient();
  const svc = new ManagementService(adminClient, new CanonicalMediaService(adminClient));
  const result = await svc.renameAsset(params.id, parsed.value.newName, user.id);
  return json({ ok: result.ok, result, error: result.error }, { status: result.ok ? 200 : 502, headers: H });
};
