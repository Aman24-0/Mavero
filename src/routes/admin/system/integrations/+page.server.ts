/**
 * Admin 2.0 — Phase G — Integrations page server.
 * Reuses the existing Stremio addon admin-service.
 */

import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { listAdminAddons } from '$lib/server/streaming/stremio/admin-addons';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/system/integrations' });
  const addons = await listAdminAddons(locals.supabase);
  return { addons, notice: url.searchParams.get('notice') };
};
