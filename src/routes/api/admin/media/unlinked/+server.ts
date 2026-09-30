/**
 * Admin 2.0 — Phase E — Unlinked provider assets API.
 *
 * GET /api/admin/media/unlinked
 *   DEPRECATED — side-effecting GET (runs a full sync). Retained for
 *   backwards compatibility with Phase 8 tests. Will be removed in a
 *   future phase.
 *
 * POST /api/admin/media/unlinked
 *   Returns unlinked provider assets. Does NOT trigger a sync — reads
 *   from media_assets directly. An asset is "unlinked" when:
 *     - media_item_id IS NULL, OR
 *     - mavero_status = 'missing' (admin detached it)
 *
 *   Query params:
 *     ?provider=vidara|abyss   Filter by adapter
 *     ?page=1
 *     ?limit=25 (max 100)
 *
 *   NOTE: this endpoint returns MAVERO's view of unlinked assets — i.e.
 *   assets that exist in the Mavero DB but are not linked to a canonical
 *   media item. To discover NEW provider-side files that Mavero doesn't
 *   know about at all, run a sync (POST /api/admin/media/sync) and read
 *   the `unlinkedFiles` field of the sync result.
 *
 * Security: Admin-only. No credentials exposed.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { SyncService } from '$lib/server/hosting/sync/service';
import { NO_STORE } from '$lib/server/http/cache-headers';

const H = { 'cache-control': NO_STORE } as const;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const syncService = new SyncService(adminClient);
  const provider = url.searchParams.get('provider');
  try {
    const results = provider ? [await syncService.syncProvider(provider)] : await syncService.syncAll();
    const unlinked = results.flatMap((r) => r.unlinkedFiles.map((f) => ({ ...f, provider: r.providerAdapterId })));
    return json({ ok: true, unlinked }, { headers: H });
  } catch (error) {
    return json({ ok: false, error: { code: 'SYNC_FAILED', message: error instanceof Error ? error.message : 'Unknown error.' } }, { status: 502, headers: H });
  }
};

export const POST: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  const provider = url.searchParams.get('provider');
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const offset = (page - 1) * limit;

  // Resolve source ids for the requested adapter (if any).
  let sourceFilter: string[] | null = null;
  if (provider) {
    const { data: providerRow } = await adminClient
      .from('streaming_providers')
      .select('id')
      .eq('adapter_id', provider)
      .maybeSingle();
    if (!providerRow) {
      return json({ ok: true, items: [], total: 0, page, limit, hasMore: false }, { headers: H });
    }
    const { data: sourceRows } = await adminClient
      .from('streaming_sources')
      .select('id')
      .eq('provider_id', providerRow.id);
    sourceFilter = (sourceRows ?? []).map((s) => s.id);
    if (sourceFilter.length === 0) {
      return json({ ok: true, items: [], total: 0, page, limit, hasMore: false }, { headers: H });
    }
  }

  // Query media_assets that are unlinked. Use PostgREST's .or() to express
  //   media_item_id IS NULL OR mavero_status = 'missing'
  let query = adminClient
    .from('media_assets')
    .select(`
      id, provider_source_id, provider_asset_id, filename, title,
      status, mavero_status, provider_status, source_quality,
      available_qualities, audio_languages, has_subtitles,
      duration_seconds, size_bytes, last_synced_at, created_at, updated_at,
      media_item_id
    `, { count: 'exact' })
    .or('media_item_id.is.null,mavero_status.eq.missing')
    .neq('status', 'deleted');

  if (sourceFilter) {
    query = query.in('provider_source_id', sourceFilter);
  }

  query = query.order('updated_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) {
    return json({ ok: false, error: { code: 'DB_ERROR', message: error.message } }, { status: 500, headers: H });
  }

  // Resolve adapter_id per source for the response.
  const sourceIds = [...new Set((data ?? []).map((r: any) => r.provider_source_id).filter(Boolean))];
  const adapterBySource = new Map<string, string>();
  if (sourceIds.length > 0) {
    const { data: sourceRows } = await adminClient
      .from('streaming_sources')
      .select('id, provider_id')
      .in('id', sourceIds);
    const providerIds = (sourceRows ?? []).map((s: any) => s.provider_id);
    if (providerIds.length > 0) {
      const { data: providerRows } = await adminClient
        .from('streaming_providers')
        .select('id, adapter_id')
        .in('id', providerIds);
      const adapterByProvider = new Map<string, string>();
      for (const p of (providerRows ?? []) as Array<{ id: string; adapter_id: string }>) {
        adapterByProvider.set(p.id, p.adapter_id);
      }
      for (const s of (sourceRows ?? []) as Array<{ id: string; provider_id: string }>) {
        const adapter = adapterByProvider.get(s.provider_id);
        if (adapter) adapterBySource.set(s.id, adapter);
      }
    }
  }

  const items = (data ?? []).map((row: any) => ({
    id: row.id,
    providerSourceId: row.provider_source_id,
    providerAdapterId: row.provider_source_id ? (adapterBySource.get(row.provider_source_id) ?? null) : null,
    providerAssetId: row.provider_asset_id,
    filename: row.filename,
    title: row.title,
    status: row.status,
    maveroStatus: row.mavero_status,
    providerStatus: row.provider_status,
    sourceQuality: row.source_quality,
    availableQualities: row.available_qualities ?? [],
    audioLanguages: row.audio_languages ?? [],
    hasSubtitles: row.has_subtitles,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const total = count ?? 0;
  return json({
    ok: true,
    items,
    total,
    page,
    limit,
    hasMore: offset + limit < total,
  }, { headers: H });
};
