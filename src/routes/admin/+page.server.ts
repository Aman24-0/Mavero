import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { getAdminOverview } from '$lib/server/streaming/admin-service';
import { getDownloadersAdminOverview } from '$lib/server/downloader/admin-service';
import { getAddonsAdminOverview } from '$lib/server/streaming/stremio/admin-addons';

export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const [overview, downloadersOverview, addonsOverview] = await Promise.all([
    getAdminOverview(locals.supabase),
    // Optional card on the overview — degrades gracefully if the new
    // table doesn't exist yet (pre-migration environments) so the admin
    // overview never 500s.
    getDownloadersAdminOverview(locals.supabase).catch(() => null),
    getAddonsAdminOverview(locals.supabase).catch(() => null),
  ]);
  return { overview, downloadersOverview, addonsOverview };
};
