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
import { UploadService } from '$lib/server/hosting/upload/service';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const VALID_TABS = new Set(['jobs', 'history', 'attention']);

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  const tab = url.searchParams.get('tab') ?? 'jobs';
  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=jobs|history|attention.');
  }

  // Phase 6: createSupabaseAdminClient() inside try/catch — prevents
  // uncaught 500 if PRIVATE_SUPABASE_SERVICE_ROLE_KEY is missing.
  let badgeCounts = { jobsActive: 0, attentionTotal: 0 };
  let reapedCount = 0;
  try {
    const adminClient = createSupabaseAdminClient();
    const service = new OperationsService(adminClient);

    // FINDING-015 + FINDING-016 fix: run the stale-operation reaper
    // on every Operations Center page load. This guarantees that
    // operations stuck in `uploading`/`uploaded`/`processing` for
    // more than 30 minutes are auto-failed with a clear
    // `STALE_TIMEOUT` error, instead of lingering forever. The reaper
    // is idempotent and admin-triggered (no background cron needed).
    // It runs BEFORE badge counts so the counts reflect the reaped state.
    try {
      const mediaService = new CanonicalMediaService(adminClient);
      const uploadService = new UploadService(adminClient, mediaService);
      reapedCount = await uploadService.reapStaleOperations();
    } catch {
      // Reaper failure must NOT break the page — best-effort.
    }

    // Preload badge counts (used by the nav badges + the tab strip).
    try {
      badgeCounts = await service.getBadgeCounts();
    } catch {
      // Badge counts are decorative — don't break the page if they fail.
    }
  } catch {
    // Phase 6: graceful fallback — empty badge counts if admin client fails.
  }

  return {
    initialTab: tab,
    badgeCounts,
    // Surface the reaped count so the UI can show a notice if any
    // operations were auto-failed during this page load.
    reapedCount,
  };
};
