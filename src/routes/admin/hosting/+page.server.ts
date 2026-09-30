/**
 * Admin 2.0 — Phase E — Hosting Control workspace page server.
 *
 * Single entry point for the unified Hosting workspace. The page
 * renders three contextual tabs (Providers / Assets / Sync) via
 * client-side state — the server loader just preloads the initial
 * tab's data + the shared provider list for the tabs themselves.
 *
 * Tab routing: ?tab=providers|assets|sync (defaults to providers).
 * The Assets tab has its own URL state (page, filters) which is
 * managed client-side.
 *
 * Security: admin-only. Uses service-role client for the aggregated
 * read model. No credentials exposed.
 */

import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { HostingControlService } from '$lib/server/hosting/control/service';
import type { HostingProviderOverview } from '$lib/shared/hosting-types';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const VALID_TABS = new Set(['providers', 'assets', 'sync']);

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  const tab = url.searchParams.get('tab') ?? 'providers';
  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=providers|assets|sync.');
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
