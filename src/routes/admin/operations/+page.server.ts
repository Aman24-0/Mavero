/**
 * Admin 2.0 — Phase F — Operations Center page server.
 *
 * Single entry point for the unified Operations workspace. Preloads
 * the initial tab's data + badge counts for the nav.
 *
 * Tab routing: ?tab=jobs|history|attention (defaults to jobs).
 */

import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { OperationsService } from '$lib/server/hosting/operations/service';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const VALID_TABS = new Set(['jobs', 'history', 'attention']);

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new OperationsService(adminClient);

  const tab = url.searchParams.get('tab') ?? 'jobs';
  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=jobs|history|attention.');
  }

  // Preload badge counts (used by the nav badges + the tab strip).
  let badgeCounts = { jobsActive: 0, attentionTotal: 0 };
  try {
    badgeCounts = await service.getBadgeCounts();
  } catch {
    // Badge counts are decorative — don't break the page if they fail.
  }

  return {
    initialTab: tab,
    badgeCounts,
  };
};
