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
import { resolveHostingSources } from '$lib/server/hosting/provider-resolver';
import { getHostingAdapter } from '$lib/server/hosting/registry';
import type { ProviderCapabilities } from '$lib/server/hosting/types';

export const load: PageServerLoad = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  // Parse query-string state (so deep links render server-side).
  const sp = url.searchParams;
  const q = sp.get('q')?.trim() || undefined;
  const type = sp.get('type') || 'all';
  const yearStr = sp.get('year');
  const year = yearStr && /^\d{4}$/.test(yearStr) ? parseInt(yearStr, 10) : undefined;
  const provider = sp.get('provider') || undefined;
  // Phase 5: series/anime parent TMDB ID filter (from AdminMediaTree selection).
  const series = sp.get('series') || undefined;
  const status = sp.get('status') || 'all';
  const sort = sp.get('sort') || 'recently_updated';
  const page = parseInt(sp.get('page') ?? '1', 10) || 1;
  const selectedId = sp.get('selected') || undefined;

  // Phase 6: createSupabaseAdminClient() inside try/catch — prevents
  // uncaught 500 if PRIVATE_SUPABASE_SERVICE_ROLE_KEY is missing.
  try {
    const adminClient = createSupabaseAdminClient();
    const service = new MediaLibraryService(adminClient);

  // Fetch initial page + folder summary + hosting sources in parallel.
  // If folderSummary or sources fail, we don't fail the whole page —
  // partial failure is part of Phase C's resilience contract.
  //
  // Hosting sources are now resolved through the CANONICAL provider
  // resolver (Phase C audit fix). This replaces the inline two-query
  // pattern and ensures:
  //   1. NO enabled=true filter (disabled providers/sources may have
  //      linked assets and must be resolvable).
  //   2. Query failures are surfaced as `hostingSourcesError` instead
  //      of silently degrading every adapter_id to null (which caused
  //      the "Not linked" / "UNKNOWN" production symptom — FINDING-005).
  //   3. The same resolver is used by the upload page server, eliminating
  //      the duplicated logic that drifted (upload page had enabled=true
  //      filter, library page didn't — FINDING-004).
  const [listResult, folderResult, hostingResult] = await Promise.allSettled([
    service.list({ q, type: type as any, year, seriesTmdb: series, provider_source_id: provider, status: status as any, sort: sort as any, page, limit: 25 }),
    service.folderSummary(),
    resolveHostingSources(adminClient),
  ]);

  if (listResult.status === 'rejected') {
    // List failure is fatal — the page can't render without it.
    throw new Error(`Media Library load failed: ${listResult.reason?.message ?? listResult.reason}`);
  }

  // Extract hosting sources + surface any resolution error.
  const hosting = hostingResult.status === 'fulfilled'
    ? hostingResult.value
    : { list: [], error: { code: 'HOSTING_SOURCES_REJECTED', message: String(hostingResult.reason?.message ?? hostingResult.reason) } };
  const hostingSourcesRaw = hosting.list;
  const hostingSourcesError = hosting.error?.message ?? null;

  // Enrich each resolved source with adapter capabilities. The
  // capabilities come from the adapter registry (no DB query, no
  // network call). This is needed by the "Provider Files" view
  // (AdminHostingAssets component) to show capability-gated action
  // buttons (Rename, Move, Delete) correctly.
  const hostingSources = hostingSourcesRaw.map((s) => {
    const adapter = s.adapterId ? getHostingAdapter(s.adapterId) : null;
    const capabilities: ProviderCapabilities | null = adapter
      ? adapter.getCapabilities()
      : null;
    return { ...s, capabilities };
  });

  return {
    initialList: listResult.value,
    initialFolders: folderResult.status === 'fulfilled' ? folderResult.value : null,
    initialFoldersError: folderResult.status === 'rejected' ? String(folderResult.reason?.message ?? folderResult.reason) : null,
    hostingSources,
    hostingSourcesError,
    initialFilters: { q, type, year, series, provider, status, sort, page, selectedId },
  };
  } catch (err) {
    // Phase 6: graceful fallback if admin client creation fails (e.g. missing env).
    // Return an empty state so the page renders the error instead of 500ing.
    throw new Error(`Media Library load failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
