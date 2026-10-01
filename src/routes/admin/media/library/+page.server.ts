/**
 * Admin 2.0 — Media Library server loader.
 *
 * ARCHITECTURE: Media Library is the single asset-centric file manager.
 * The page server:
 *   1. Redirects legacy ?view=media / ?view=files URLs to the clean URL
 *      (the old Media / Provider Files split no longer exists).
 *   2. Provides hosting sources (with adapter capabilities) for the
 *      AdminHostingAssets component's capability-gated action buttons.
 *   3. Reads the canonical URL params (provider, q, contentType, status,
 *      linked, sort, mediaItem) and passes them as initialFilters so the
 *      file manager initializes in the requested state. This is what
 *      makes Hosting Control provider navigation work end-to-end:
 *      /admin/media/library?provider=vidara → Provider filter = Vidara →
 *      the inventory query filters to Vidara assets only.
 *
 * The old media_items-centric list/folderSummary/drawer endpoints are
 * retained for backward compatibility (detail API, Link Existing media
 * picker) but are not the primary read model for this page.
 */

import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { resolveHostingSources } from '$lib/server/hosting/provider-resolver';
import { getHostingAdapter } from '$lib/server/hosting/registry';
import type { ProviderCapabilities } from '$lib/server/hosting/types';
import type { HostingAssetQuery } from '$lib/shared/hosting-types';

const VALID_STATUSES = new Set(['queued', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'deleted', 'active', 'all']);
const VALID_CONTENT_TYPES = new Set(['movie', 'series', 'anime', 'all']);
const VALID_LINKED = new Set(['linked', 'detached', 'unlinked', 'all']);
const VALID_SORTS = new Set(['recently_updated', 'recently_added', 'status', 'provider']);
const VALID_PROVIDERS = new Set(['vidara', 'abyss']);

export const load: PageServerLoad = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  let hostingSources: any[] = [];
  let hostingSourcesError: string | null = null;

  // Redirect old ?view=media and ?view=files URLs to the clean URL,
  // preserving every other query param.
  if (url.searchParams.has('view')) {
    const params = new URLSearchParams(url.searchParams);
    params.delete('view');
    const { redirect } = await import('@sveltejs/kit');
    throw redirect(303, `${url.pathname}${params.toString() ? '?' + params.toString() : ''}`);
  }

  // ------------------------------------------------------------
  // Canonical URL params → initialFilters for the file manager.
  // Values are validated against closed vocabularies; anything invalid
  // (or absent) falls back to the component defaults (status='active',
  // everything 'all').
  // ------------------------------------------------------------
  const providerParam = url.searchParams.get('provider');
  const statusParam = url.searchParams.get('status');
  const contentTypeParam = url.searchParams.get('contentType');
  const linkedParam = url.searchParams.get('linked');
  const sortParam = url.searchParams.get('sort');
  const mediaItemParam = url.searchParams.get('mediaItem');

  const initialFilters: Partial<HostingAssetQuery> = {
    q: url.searchParams.get('q') ?? '',
    provider: (providerParam && VALID_PROVIDERS.has(providerParam) ? providerParam : 'all') as HostingAssetQuery['provider'],
    linked: (linkedParam && VALID_LINKED.has(linkedParam) ? linkedParam : 'all') as HostingAssetQuery['linked'],
    status: (statusParam && VALID_STATUSES.has(statusParam) ? statusParam : 'active') as HostingAssetQuery['status'],
    contentType: (contentTypeParam && VALID_CONTENT_TYPES.has(contentTypeParam) ? contentTypeParam : 'all') as HostingAssetQuery['contentType'],
    sort: (sortParam && VALID_SORTS.has(sortParam) ? sortParam : 'recently_updated') as HostingAssetQuery['sort'],
    mediaItemId: mediaItemParam && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaItemParam) ? mediaItemParam : null,
  };

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
    initialFilters,
  };
};
