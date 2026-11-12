/**
 * Phase 9 — Missing Media admin page server.
 */

import { error } from '@sveltejs/kit';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { DemandService } from '$lib/server/hosting/demand/service';
import { attachPosterPathsToDemands } from '$lib/server/hosting/demand/poster-enrichment';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  const status = url.searchParams.get('status') ?? 'open';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);

  // Phase 6: createSupabaseAdminClient() inside try/catch — prevents
  // uncaught 500 if PRIVATE_SUPABASE_SERVICE_ROLE_KEY is missing.
  try {
    const adminClient = createSupabaseAdminClient();

    // Phase 6 fix: auto-resolve stale 'open' demand requests that now have
    // a ready+available media asset. This catches demand rows that were
    // missed by the fire-and-forget resolveDemand() calls during upload/sync.
    // The sweep is best-effort — errors are silently absorbed.
    const demandService = new DemandService(adminClient);
    // Phase 6 fix: auto-resolve stale 'open' demand requests that now have
    // a ready+available media asset. This catches demand rows that were
    // missed by the fire-and-forget resolveDemand() calls during upload/sync.
    await demandService.sweepResolvedDemand();
    // ARCHITECTURE FIX: auto-reopen stale 'ready' demand requests whose
    // underlying asset was deleted/detached. Without this, demand stays
    // 'ready' forever after a delete — Missing Media never surfaces the
    // content as missing again. Does NOT reopen 'ignored' demands.
    await demandService.sweepStaleResolvedDemand();

    const { data: requests, error: err } = await adminClient
      .from('media_availability_requests')
      .select('*')
      .eq('status', status)
      .order('last_requested_at', { ascending: false })
      .limit(limit);

    if (err) throw error(500, 'Failed to load missing media requests.');

    // Task 5 (2026-10-15) — poster enrichment for the Link Media wizard.
    // A demand row carries no poster; the canonical media_items row for
    // the SAME identity (parent series/anime for episodic demands, the
    // movie row for movie demands) persists poster_path on every link
    // (migration 20261015000000) — ONE bounded batched lookup by tmdb_id
    // reuses it so the wizard shows the parent poster exactly like the
    // normal Media Library Add File flow. Demands with no local row get
    // no poster (the wizard then backfills from the content detail
    // endpoints — never a title search, never invented).
    const rows = (requests ?? []) as Array<Record<string, unknown>>;
    const tmdbIds = [...new Set(rows.map((r) => String(r.tmdb_id ?? '')).filter((id) => id.length > 0))];
    const posterRows: Array<{ tmdb_id: string; content_type: string; poster_path: string | null }> = [];
    if (tmdbIds.length > 0) {
      const { data: lookupRows } = await adminClient
        .from('media_items')
        .select('tmdb_id, content_type, poster_path')
        .in('tmdb_id', tmdbIds)
        .is('season', null)
        .is('episode', null);
      posterRows.push(...((lookupRows ?? []) as typeof posterRows));
    }
    attachPosterPathsToDemands(rows, posterRows);

    return { requests: rows as unknown as typeof requests, statusFilter: status };
  } catch (err) {
    // If it's already a SvelteKit error (e.g. throw error(500,...)), re-throw.
    if (err && typeof err === 'object' && 'status' in err) throw err;
    // Otherwise it's a config error (e.g. missing service-role key).
    throw error(500, err instanceof Error ? err.message : 'Failed to load missing media.');
  }
};
