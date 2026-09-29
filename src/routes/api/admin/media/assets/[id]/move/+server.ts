/** Phase 8 — Move asset API. POST /api/admin/media/assets/:id/move */
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
  const parsed = await readJsonBody<{ targetFolderId?: string | null }>(request);
  if (!parsed.ok) return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid request body.' } }, { status: 400, headers: H });
  const adminClient = createSupabaseAdminClient();
  const svc = new ManagementService(adminClient, new CanonicalMediaService(adminClient));
  const result = await svc.moveAsset(params.id, parsed.value.targetFolderId ?? null, user.id);
  return json({ ok: result.ok, result, error: result.error }, { status: result.ok ? 200 : 502, headers: H });
};
