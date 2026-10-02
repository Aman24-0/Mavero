/**
 * Admin 2.0 — Hosting Control workspace page server.
 *
 * ARCHITECTURE (final 3-issue fix — Hosting navigation consolidation):
 * Hosting Control is the single hosting/operations workspace.
 * Tabs: providers | jobs | activity.
 *
 * The separate Sync tab was removed — every sync affordance now lives on
 * the Providers tab (Refresh health + Sync all providers in the page
 * action area, per-provider Sync on each provider card). The sync
 * backend actions, service, and audit history are unchanged.
 *
 * Legacy redirects (all server-side — no broken routes):
 *   ?tab=sync      → /admin/hosting          (canonical Providers view)
 *   ?tab=attention → /admin/hosting          (canonical Providers view)
 *   ?tab=assets    → /admin/media/library
 *   ?tab=history   → ?tab=activity
 *   /admin/operations?tab=X → /admin/hosting?tab=X
 */

import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { HostingControlService } from '$lib/server/hosting/control/service';
import { OperationsService } from '$lib/server/hosting/operations/service';
import { UploadService } from '$lib/server/hosting/upload/service';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import type { HostingProviderOverview } from '$lib/shared/hosting-types';
import type { OpsBadgeCounts } from '$lib/shared/operations-types';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const VALID_TABS = new Set(['providers', 'jobs', 'activity']);

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  const tab = url.searchParams.get('tab') ?? 'providers';

  // Redirect old Assets tab to Media Library.
  if (tab === 'assets') {
    throw redirect(303, '/admin/media/library');
  }

  // Map old Operations tab names to new Hosting Control tab names.
  // 'history' (old Operations Activity tab) → 'activity'
  if (tab === 'history') {
    const params = new URLSearchParams(url.searchParams);
    params.set('tab', 'activity');
    throw redirect(303, `${url.pathname}?${params.toString()}`);
  }

  // REMOVED TAB REDIRECTS (Hosting navigation consolidation):
  //   'sync'      — the separate Sync section was consolidated into the
  //                Providers tab (Sync all providers + Refresh health).
  //   'attention' — the Attention workspace tab was retired from the
  //                Hosting IA; failed/stale items remain visible under
  //                Jobs (Failed/Retryable/Stale filters) and Activity.
  // Old bookmarks and stale navigation land on the canonical Providers
  // view (the default tab) — never a broken route.
  if (tab === 'sync' || tab === 'attention') {
    throw redirect(303, '/admin/hosting');
  }

  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=providers|jobs|activity.');
  }

  let providers: HostingProviderOverview[] = [];
  let providersError: string | null = null;
  let badgeCounts: OpsBadgeCounts = { jobsActive: 0, attentionTotal: 0 };

  try {
    const adminClient = createSupabaseAdminClient();

    // Run the stale-operation reaper + badge counts + provider list.
    try {
      const mediaService = new CanonicalMediaService(adminClient);
      const uploadService = new UploadService(adminClient, mediaService);
      await uploadService.reapStaleOperations();
    } catch {
      // Reaper failure must NOT break the page.
    }

    try {
      const opsService = new OperationsService(adminClient);
      badgeCounts = await opsService.getBadgeCounts();
    } catch {
      // Badge counts are decorative.
    }

    try {
      const service = new HostingControlService(adminClient);
      providers = await service.listProviders({ skipHealth: true });
    } catch (err) {
      providersError = err instanceof Error ? err.message : 'Failed to load hosting providers.';
    }
  } catch {
    // Graceful fallback.
  }

  return {
    initialTab: tab,
    initialProviders: providers,
    initialProvidersError: providersError,
    badgeCounts,
  };
};
