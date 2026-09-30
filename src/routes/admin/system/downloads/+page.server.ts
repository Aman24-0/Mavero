/**
 * Admin 2.0 — Phase G — Downloads page server.
 * Reuses the existing downloader admin-service.
 */

import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { listAdminDownloadProviders, getDownloadersAdminOverview } from '$lib/server/downloader/admin-service';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/system/downloads' });
  const [providers, overview] = await Promise.all([
    listAdminDownloadProviders(locals.supabase),
    getDownloadersAdminOverview(locals.supabase),
  ]);
  return { providers, overview, notice: url.searchParams.get('notice') };
};
