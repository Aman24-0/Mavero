import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { getAdminOverview } from '$lib/server/streaming/admin-service';
import { getDownloadersAdminOverview } from '$lib/server/downloader/admin-service';
import { getAddonsAdminOverview } from '$lib/server/streaming/stremio/admin-addons';
import { getLivetvAdminOverview } from '$lib/server/livetv/admin-service';

export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const [overview, downloadersOverview, addonsOverview, livetvOverview] = await Promise.all([
    getAdminOverview(locals.supabase),
    // Optional cards on the overview — each degrades gracefully if its
    // tables don't exist yet (pre-migration environments) so the admin
    // overview never 500s.
    getDownloadersAdminOverview(locals.supabase).catch(() => null),
    getAddonsAdminOverview(locals.supabase).catch(() => null),
    // Unified Live TV (Phase 4) — the mobile-reachability surface for the
    // /admin/system/livetv workspace (System destinations live on the
    // Overview for mobile, per the mav_focused_admin_nav contract).
    getLivetvAdminOverview(locals.supabase).catch(() => null),
  ]);
  return { overview, downloadersOverview, addonsOverview, livetvOverview };
};
