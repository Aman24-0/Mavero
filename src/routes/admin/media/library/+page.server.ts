/**
 * Admin 2.0 — Media Library server loader.
 *
 * ARCHITECTURE: Media Library is now a single asset-centric file manager.
 * The server loader provides hosting sources (with adapter capabilities)
 * for the AdminHostingAssets component's capability-gated action buttons.
 *
 * The old media_items-centric list/folderSummary/drawer endpoints are
 * retained for backward compatibility (detail API, Missing Media links)
 * but are no longer the primary read model for the Media Library page.
 */

import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { resolveHostingSources } from '$lib/server/hosting/provider-resolver';
import { getHostingAdapter } from '$lib/server/hosting/registry';
import type { ProviderCapabilities } from '$lib/server/hosting/types';

export const load: PageServerLoad = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  let hostingSources: any[] = [];
  let hostingSourcesError: string | null = null;

  // Redirect old ?view=media and ?view=files URLs to the clean URL.
  if (url.searchParams.has('view')) {
    const params = new URLSearchParams(url.searchParams);
    params.delete('view');
    const { redirect } = await import('@sveltejs/kit');
    throw redirect(303, `${url.pathname}${params.toString() ? '?' + params.toString() : ''}`);
  }

  try {
    const adminClient = createSupabaseAdminClient();
    const result = await resolveHostingSources(adminClient);
    hostingSourcesError = result.error?.message ?? null;

    // Enrich each resolved source with adapter capabilities.
    hostingSources = result.list.map((s) => {
      const adapter = s.adapterId ? getHostingAdapter(s.adapterId) : null;
      const capabilities: ProviderCapabilities | null = adapter
        ? adapter.getCapabilities()
        : null;
      return { ...s, capabilities };
    });
  } catch (err) {
    hostingSourcesError = err instanceof Error ? err.message : String(err);
  }

  return {
    hostingSources,
    hostingSourcesError,
  };
};
