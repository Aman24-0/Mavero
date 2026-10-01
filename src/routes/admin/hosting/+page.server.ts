/**
 * Admin 2.0 — Hosting Control workspace page server.
 *
 * Phase 2C consolidation: the Assets tab has been merged into Media
 * Library (/?view=files). Requests for ?tab=assets are redirected to
 * the canonical Media Library Provider Files view. The remaining tabs
 * (Providers, Sync) stay here.
 *
 * Tab routing: ?tab=providers|sync (defaults to providers).
 * ?tab=assets → 303 redirect to /admin/media/library?view=files
 */

import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { HostingControlService } from '$lib/server/hosting/control/service';
import type { HostingProviderOverview } from '$lib/shared/hosting-types';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const VALID_TABS = new Set(['providers', 'sync']);

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  const tab = url.searchParams.get('tab') ?? 'providers';

  // Phase 2C: redirect the old Assets tab to Media Library's Provider Files view.
  if (tab === 'assets') {
    throw redirect(303, '/admin/media/library?view=files');
  }

  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=providers|sync.');
  }

  // Phase 6: createSupabaseAdminClient() inside try/catch — prevents
  // uncaught 500 if PRIVATE_SUPABASE_SERVICE_ROLE_KEY is missing.
  let providers: HostingProviderOverview[] = [];
  let providersError: string | null = null;
  try {
    const adminClient = createSupabaseAdminClient();
    const service = new HostingControlService(adminClient);
    providers = await service.listProviders({ skipHealth: true });
  } catch (err) {
    providersError = err instanceof Error ? err.message : 'Failed to load hosting providers.';
  }

  return {
    initialTab: tab,
    initialProviders: providers,
    initialProvidersError: providersError,
  };
};
