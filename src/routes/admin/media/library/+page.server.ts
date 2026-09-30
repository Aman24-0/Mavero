/**
 * Admin 2.0 — Phase C — Media Library server loader.
 *
 * Loads the initial page state server-side so the first render is
 * populated (no client-side fetch waterfall). The client fetches
 * subsequent pages / detail / folders via the new API endpoints.
 *
 * Loaded data:
 *   - page 1 of the library (default sort, no filters)
 *   - folder summary for the content-tree sidebar
 *   - hosting sources list for the provider filter
 *
 * Authorization: requireAdmin — same pattern as every other admin
 * route.
 */

import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { MediaLibraryService } from '$lib/server/hosting/library/service';

export const load: PageServerLoad = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new MediaLibraryService(adminClient);

  // Parse query-string state (so deep links render server-side).
  const sp = url.searchParams;
  const q = sp.get('q')?.trim() || undefined;
  const type = sp.get('type') || 'all';
  const yearStr = sp.get('year');
  const year = yearStr && /^\d{4}$/.test(yearStr) ? parseInt(yearStr, 10) : undefined;
  const provider = sp.get('provider') || undefined;
  const status = sp.get('status') || 'all';
  const sort = sp.get('sort') || 'recently_updated';
  const page = parseInt(sp.get('page') ?? '1', 10) || 1;
  const selectedId = sp.get('selected') || undefined;

  // Fetch initial page + folder summary + hosting sources in parallel.
  // If folderSummary or sources fail, we don't fail the whole page —
  // partial failure is part of Phase C's resilience contract.
  const [listResult, folderResult, sourcesResult] = await Promise.allSettled([
    service.list({ q, type: type as any, year, provider_source_id: provider, status: status as any, sort: sort as any, page, limit: 25 }),
    service.folderSummary(),
    adminClient
      .from('streaming_sources')
      .select('id, name, provider:streaming_providers(id, name, adapter_id)')
      .eq('enabled', true)
      .order('display_order', { ascending: true }),
  ]);

  if (listResult.status === 'rejected') {
    // List failure is fatal — the page can't render without it.
    throw new Error(`Media Library load failed: ${listResult.reason?.message ?? listResult.reason}`);
  }

  return {
    initialList: listResult.value,
    initialFolders: folderResult.status === 'fulfilled' ? folderResult.value : null,
    initialFoldersError: folderResult.status === 'rejected' ? String(folderResult.reason?.message ?? folderResult.reason) : null,
    hostingSources: sourcesResult.status === 'fulfilled' && sourcesResult.value.data
      ? sourcesResult.value.data.map(s => ({
          id: s.id,
          name: s.name,
          providerId: s.provider?.id ?? null,
          providerName: s.provider?.name ?? null,
          adapterId: s.provider?.adapter_id ?? null,
        }))
      : [],
    initialFilters: { q, type, year, provider, status, sort, page, selectedId },
  };
};
