/**
 * Admin 2.0 — Phase C — Media Library read model.
 *
 * A single, server-side aggregated read over `media_items` LEFT JOIN
 * `media_assets` (+ optional `media_availability_requests` for
 * missing-demand context). Designed for the Media Library UI:
 * paginated, filtered, sorted, with per-item provider availability
 * precomputed so the client doesn't issue N+1 follow-up requests.
 *
 * Why a dedicated read model:
 *   - Existing `/api/admin/media/operations` endpoint joins 3 tables
 *     but is operation-centric, not media-centric. Media Library is
 *     media-centric — every row is one canonical media identity with
 *     its provider assets nested inline.
 *   - Existing `/api/admin/media/search` hits TMDB (external), not
 *     the local catalog. Media Library searches the local catalog.
 *   - Without this read model, the client would need 1 + N requests
 *     (one for media_items, then one for media_assets per item).
 *
 * Authorization: caller is responsible for `requireAdmin()` — this
 * module uses the service-role client and bypasses RLS by design.
 *
 * No credentials ever leak: `media_assets.provider_metadata` is a
 * jsonb blob that may contain provider-internal fields; the read
 * model intentionally does NOT expose it to the client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

// ============================================================
// Types — public surface of the read model
// ============================================================

export type MediaContentType = 'movie' | 'series' | 'anime';

export type AssetStatus = 'queued' | 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'deleted';
export type MaveroStatus = 'available' | 'missing' | 'processing' | 'failed' | 'disabled' | 'stale';

export type LibrarySort = 'recently_updated' | 'recently_added' | 'title' | 'year' | 'status';

export type LibraryAssetSummary = {
  id: string;
  media_item_id: string;
  provider_source_id: string | null;
  provider_asset_id: string | null;
  status: AssetStatus;
  mavero_status: MaveroStatus;
  source_quality: string | null;
  available_qualities: string[];
  audio_languages: string[];
  has_subtitles: boolean;
  duration_seconds: number | null;
  size_bytes: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LibraryMediaItem = {
  id: string;
  canonical_key: string;
  content_type: MediaContentType;
  tmdb_id: string;
  imdb_id: string | null;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  episode_title: string | null;
  parent_media_id: string | null;
  created_at: string;
  updated_at: string;
  assets: LibraryAssetSummary[];
  /** Demand summary for this canonical key (null if no demand row exists). */
  demand: { request_count: number; last_requested_at: string; status: string } | null;
  /**
   * FINDING-003 fix: computed hosting state. Distinguishes:
   *   - 'hosted': at least one asset with status='ready' AND mavero_status='available'
   *   - 'processing': at least one active asset (uploading/uploaded/processing) but none ready
   *   - 'failed': ALL assets are 'failed' (mix of failed+deleted counts as failed)
   *   - 'pending': no assets BUT has demand (users requested it — upload needed)
   *   - 'catalog_only': no assets AND no demand (orphan from failed upload)
   *
   * The UI uses this to render a clear status badge instead of letting
   * orphaned items blend in with hosted content.
   */
  hosting_state: 'hosted' | 'processing' | 'failed' | 'pending' | 'catalog_only';
};

export type LibraryListResult = {
  items: LibraryMediaItem[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
};

export type LibraryOperationSummary = {
  id: string;
  action: string;
  status: string;
  occurred_at: string;
  error_code: string | null;
  error_message: string | null;
  admin_user_email: string | null;
  admin_user_display_name: string | null;
};

export type LibraryDetailResult = {
  item: LibraryMediaItem;
  recent_operations: LibraryOperationSummary[];
};

// ============================================================
// Query filters
// ============================================================

export type LibraryQuery = {
  q?: string;             // search across title / tmdb_id / imdb_id / canonical_key
  type?: MediaContentType | 'all';
  year?: number | null;
  /** Phase 5: filter by series/anime parent TMDB ID. Matches both the parent row and all its episode rows (they share tmdb_id). */
  seriesTmdb?: string | null;
  provider_source_id?: string | null;
  status?: AssetStatus | MaveroStatus | 'all';
  sort?: LibrarySort;
  page?: number;
  limit?: number;
  /**
   * FINDING-003 fix: when false (default), items with NO assets AND NO
   * demand are excluded from the list. These are "orphan" rows left
   * behind by failed uploads — they have a canonical identity but no
   * playable asset and nobody has requested them, so showing them in
   * Media Library is misleading (they look like hosted items with
   * "Not linked" pills + a demand count that doesn't exist).
   *
   * Items with demand but no assets are STILL shown (they're
   * "missing media" — users have requested them and the admin should
   * see them to know an upload is needed).
   *
   * Items with at least one non-deleted asset are always shown.
   *
   * Set to `true` to include orphans (for admin debugging / cleanup).
   */
  includeOrphans?: boolean;
};

// ============================================================
// Service
// ============================================================

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export class MediaLibraryService {
  constructor(private client: SupabaseClient<Database>) {}

  // ------------------------------------------------------------
  // Paginated, filtered, joined read.
  // ------------------------------------------------------------
  async list(query: LibraryQuery): Promise<LibraryListResult> {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const offset = (page - 1) * limit;
    const sort = query.sort ?? 'recently_updated';

    // Build the media_items query.
    let itemsQuery = this.client
      .from('media_items')
      .select('id, canonical_key, content_type, tmdb_id, imdb_id, title, year, season, episode, episode_title, parent_media_id, created_at, updated_at', { count: 'exact' });

    // Text search — supports title / tmdb_id / imdb_id / canonical_key
    if (query.q && query.q.trim()) {
      const q = query.q.trim();
      // If the search term looks like a TMDB ID (numeric), search tmdb_id directly.
      // Otherwise use ILIKE on title (no trigram index yet — Phase C accepts seq scan
      // for the typical admin-catalog size of <10k rows).
      if (/^\d+$/.test(q)) {
        itemsQuery = itemsQuery.eq('tmdb_id', q);
      } else if (q.startsWith('tt') && /^tt\d{7,10}$/.test(q)) {
        itemsQuery = itemsQuery.eq('imdb_id', q);
      } else if (q.includes(':')) {
        // Looks like a canonical_key (e.g. "movie:tmdb:123" or "series:tmdb:1399:s1:e1")
        itemsQuery = itemsQuery.eq('canonical_key', q);
      } else {
        itemsQuery = itemsQuery.ilike('title', `%${q}%`);
      }
    }

    if (query.type && query.type !== 'all') {
      itemsQuery = itemsQuery.eq('content_type', query.type);
    }
    if (query.year != null) {
      itemsQuery = itemsQuery.eq('year', query.year);
    }
    // Phase 5: filter by series/anime parent TMDB ID. Both the parent row
    // and all its episode rows share the same tmdb_id, so a single .eq()
    // filters to exactly that series + its episodes. The existing index
    // media_items_content_type_tmdb_id_idx covers this lookup.
    if (query.seriesTmdb) {
      itemsQuery = itemsQuery.eq('tmdb_id', query.seriesTmdb);
    }

    // Sorting — applied at the items layer
    switch (sort) {
      case 'recently_updated': itemsQuery = itemsQuery.order('updated_at', { ascending: false }); break;
      case 'recently_added':   itemsQuery = itemsQuery.order('created_at', { ascending: false }); break;
      case 'title':             itemsQuery = itemsQuery.order('title', { ascending: true }); break;
      case 'year':              itemsQuery = itemsQuery.order('year', { ascending: false, nullsFirst: false }); break;
      case 'status':
        // status lives on media_assets, not media_items. We sort by the
        // latest asset's updated_at as a proxy (matches what the UI shows).
        itemsQuery = itemsQuery.order('updated_at', { ascending: false }); break;
      default:                  itemsQuery = itemsQuery.order('updated_at', { ascending: false }); break;
    }

    itemsQuery = itemsQuery.range(offset, offset + limit - 1);

    const { data: items, error: itemsError, count } = await itemsQuery;
    if (itemsError) {
      throw new Error(`MediaLibraryService.list: ${itemsError.message}`);
    }
    if (!items || items.length === 0) {
      return { items: [], total: count ?? 0, page, limit, has_more: false };
    }

    // Batch-fetch assets AND demand rows for this page in parallel (Phase 2 perf).
    // Both depend only on the items page already fetched — no dependency on
    // each other. Previously these were two sequential awaits.
    const mediaItemIds = items.map(i => i.id);
    const canonicalKeys = items.map(i => i.canonical_key);
    const [assetsRes, demandsRes] = await Promise.all([
      this.client
        .from('media_assets')
        .select('id, media_item_id, provider_source_id, provider_asset_id, status, mavero_status, source_quality, available_qualities, audio_languages, has_subtitles, duration_seconds, size_bytes, last_synced_at, created_at, updated_at')
        .in('media_item_id', mediaItemIds)
        .order('updated_at', { ascending: false }),
      this.client
        .from('media_availability_requests')
        .select('canonical_key, request_count, last_requested_at, status')
        .in('canonical_key', canonicalKeys),
    ]);
    if (assetsRes.error) {
      throw new Error(`MediaLibraryService.list (assets): ${assetsRes.error.message}`);
    }
    const assets = assetsRes.data;
    if (demandsRes.error) {
      // Demand is decorative — partial failure should not break the list.
      // Log and continue with empty demand map.
      console.warn('[MediaLibrary] demand query failed', demandsRes.error.message);
    }
    const demands = demandsRes.data;

    // Index assets and demand by their foreign keys for O(1) lookup.
    const assetsByItem = new Map<string, LibraryAssetSummary[]>();
    for (const a of (assets ?? []) as Array<LibraryAssetSummary & { media_item_id: string }>) {
      const list = assetsByItem.get(a.media_item_id) ?? [];
      list.push(a);
      assetsByItem.set(a.media_item_id, list);
    }
    const demandByKey = new Map<string, { request_count: number; last_requested_at: string; status: string }>();
    for (const d of (demands ?? [])) {
      demandByKey.set(d.canonical_key, {
        request_count: d.request_count,
        last_requested_at: d.last_requested_at,
        status: d.status,
      });
    }

    // Filter by provider / asset-status — done in JS after fetch because
    // these are media_assets filters, not media_items filters. We keep
    // items whose asset list matches the filter; items with no matching
    // assets are dropped (when the filter is set).
    //
    // FINDING-003 fix: also filter out ORPHAN items (no assets AND no
    // demand) unless `includeOrphans` is explicitly true. These are
    // ghost rows from failed uploads — they have a canonical identity
    // but no playable asset and nobody has requested them. Showing them
    // in Media Library is misleading.
    const includeOrphans = query.includeOrphans === true;
    const filteredItems: typeof items = [];
    for (const item of items) {
      let itemAssets = assetsByItem.get(item.id) ?? [];
      const itemDemand = demandByKey.get(item.canonical_key) ?? null;

      // FINDING-003: drop orphan items (no assets AND no demand) unless
      // explicitly included. Do this BEFORE the provider/status filter
      // so the filter doesn't accidentally expose orphans.
      if (!includeOrphans && itemAssets.length === 0 && !itemDemand) {
        continue;
      }

      if (query.provider_source_id) {
        itemAssets = itemAssets.filter(a => a.provider_source_id === query.provider_source_id);
      }
      if (query.status && query.status !== 'all') {
        // The status filter applies to either the asset's `status` OR `mavero_status`
        // — both columns use overlapping vocabularies ('ready'/'failed'/'processing').
        itemAssets = itemAssets.filter(a => a.status === query.status || a.mavero_status === query.status);
      }
      // If a filter was applied and the item has no matching assets, skip it.
      // If no filter is applied, keep all items (including those with no assets —
      // they're "missing"/"pending" media which is itself a useful signal in the library).
      if ((query.provider_source_id || (query.status && query.status !== 'all')) && itemAssets.length === 0) {
        continue;
      }
      filteredItems.push(item);
      // Replace the assets array on the item with the filtered one.
      assetsByItem.set(item.id, itemAssets);
    }

    const total = count ?? 0;
    const resultItems: LibraryMediaItem[] = filteredItems.map(item => {
      const itemAssets = assetsByItem.get(item.id) ?? [];
      const itemDemand = demandByKey.get(item.canonical_key) ?? null;
      return {
        ...item,
        content_type: item.content_type as MediaContentType,
        assets: itemAssets,
        demand: itemDemand,
        hosting_state: computeHostingState(itemAssets, itemDemand),
      };
    });

    return {
      items: resultItems,
      total,
      page,
      limit,
      has_more: offset + limit < total,
    };
  }

  // ------------------------------------------------------------
  // Single media item detail with assets + recent operations.
  // ------------------------------------------------------------
  async detail(mediaItemId: string): Promise<LibraryDetailResult | null> {
    // 1. Fetch the media item.
    const { data: item, error: itemError } = await this.client
      .from('media_items')
      .select('id, canonical_key, content_type, tmdb_id, imdb_id, title, year, season, episode, episode_title, parent_media_id, created_at, updated_at')
      .eq('id', mediaItemId)
      .maybeSingle();
    if (itemError) throw new Error(`MediaLibraryService.detail (item): ${itemError.message}`);
    if (!item) return null;

    // 2. Fetch its assets in parallel with demand + recent operations.
    const [assetsRes, demandRes, opsRes] = await Promise.all([
      this.client
        .from('media_assets')
        .select('id, media_item_id, provider_source_id, provider_asset_id, status, mavero_status, source_quality, available_qualities, audio_languages, has_subtitles, duration_seconds, size_bytes, last_synced_at, created_at, updated_at')
        .eq('media_item_id', mediaItemId)
        .order('updated_at', { ascending: false }),
      this.client
        .from('media_availability_requests')
        .select('canonical_key, request_count, last_requested_at, status')
        .eq('canonical_key', item.canonical_key)
        .maybeSingle(),
      this.client
        .from('media_operations')
        .select('id, action, status, occurred_at, error_code, error_message, admin_user:profiles(display_name)')
        .eq('media_item_id', mediaItemId)
        .order('occurred_at', { ascending: false })
        .limit(20),
    ]);

    if (assetsRes.error) throw new Error(`MediaLibraryService.detail (assets): ${assetsRes.error.message}`);
    if (opsRes.error) throw new Error(`MediaLibraryService.detail (operations): ${opsRes.error.message}`);
    // demandRes.error is OK — demand is decorative.

    const assets: LibraryAssetSummary[] = (assetsRes.data ?? []) as LibraryAssetSummary[];

    const demand = demandRes.data
      ? {
          request_count: demandRes.data.request_count,
          last_requested_at: demandRes.data.last_requested_at,
          status: demandRes.data.status,
        }
      : null;

    const libraryItem: LibraryMediaItem = {
      ...item,
      content_type: item.content_type as MediaContentType,
      assets,
      demand,
      hosting_state: computeHostingState(assets, demand),
    };

    const recent_operations: LibraryOperationSummary[] = (opsRes.data ?? []).map((op: any) => ({
      id: op.id,
      action: op.action,
      status: op.status,
      occurred_at: op.occurred_at,
      error_code: op.error_code,
      error_message: op.error_message,
      admin_user_email: null, // Email lives in auth.users, not profiles — not accessible via PostgREST
      admin_user_display_name: op.admin_user?.display_name ?? null,
    }));

    return { item: libraryItem, recent_operations };
  }

  // ------------------------------------------------------------
  // Content-tree sidebar — folder summary by type.
  // Returns year counts for movies, season counts for series/anime.
  // ------------------------------------------------------------
  async folderSummary(): Promise<{
    movies: { year: number | null; count: number }[];
    series: { tmdb_id: string; title: string; year: number | null; season_count: number; episode_count: number }[];
    anime: { tmdb_id: string; title: string; year: number | null; season_count: number; episode_count: number }[];
    totals: { movies: number; series: number; anime: number };
  }> {
    // Movies: group by year.
    const { data: moviesByYear, error: moviesErr } = await this.client
      .from('media_items')
      .select('year')
      .eq('content_type', 'movie');
    if (moviesErr) throw new Error(`MediaLibraryService.folderSummary (movies): ${moviesErr.message}`);

    const movieYearMap = new Map<number | null, number>();
    for (const row of (moviesByYear ?? [])) {
      const key = row.year;
      movieYearMap.set(key, (movieYearMap.get(key) ?? 0) + 1);
    }
    const movies = [...movieYearMap.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

    // Series + anime: fetch parent series rows + child episode counts in parallel.
    const [seriesRes, animeRes] = await Promise.all([
      this.client
        .from('media_items')
        .select('id, tmdb_id, title, year')
        .eq('content_type', 'series')
        .is('parent_media_id', null),
      this.client
        .from('media_items')
        .select('id, tmdb_id, title, year')
        .eq('content_type', 'anime')
        .is('parent_media_id', null),
    ]);
    if (seriesRes.error) throw new Error(`MediaLibraryService.folderSummary (series): ${seriesRes.error.message}`);
    if (animeRes.error) throw new Error(`MediaLibraryService.folderSummary (anime): ${animeRes.error.message}`);

    const seriesParents = seriesRes.data ?? [];
    const animeParents = animeRes.data ?? [];

    // Batch-fetch episode counts per parent.
    const allParents = [...seriesParents, ...animeParents];
    const parentIds = allParents.map(p => p.id);
    const episodeCounts = new Map<string, number>();
    const seasonCounts = new Map<string, Set<number>>();
    if (parentIds.length > 0) {
      const { data: episodes, error: epErr } = await this.client
        .from('media_items')
        .select('parent_media_id, season')
        .in('parent_media_id', parentIds);
      if (epErr) throw new Error(`MediaLibraryService.folderSummary (episodes): ${epErr.message}`);
      for (const ep of (episodes ?? [])) {
        if (!ep.parent_media_id) continue;
        episodeCounts.set(ep.parent_media_id, (episodeCounts.get(ep.parent_media_id) ?? 0) + 1);
        const seasons = seasonCounts.get(ep.parent_media_id) ?? new Set<number>();
        if (ep.season != null) seasons.add(ep.season);
        seasonCounts.set(ep.parent_media_id, seasons);
      }
    }

    const series = seriesParents.map(p => ({
      tmdb_id: p.tmdb_id,
      title: p.title,
      year: p.year,
      season_count: seasonCounts.get(p.id)?.size ?? 0,
      episode_count: episodeCounts.get(p.id) ?? 0,
    })).sort((a, b) => a.title.localeCompare(b.title));

    const anime = animeParents.map(p => ({
      tmdb_id: p.tmdb_id,
      title: p.title,
      year: p.year,
      season_count: seasonCounts.get(p.id)?.size ?? 0,
      episode_count: episodeCounts.get(p.id) ?? 0,
    })).sort((a, b) => a.title.localeCompare(b.title));

    return {
      movies,
      series,
      anime,
      totals: {
        movies: movies.reduce((s, m) => s + m.count, 0),
        series: seriesParents.length,
        anime: animeParents.length,
      },
    };
  }
}

// ============================================================
// Helpers
// ============================================================

function clampPage(page: unknown): number {
  const n = typeof page === 'number' ? page : parseInt(String(page ?? '1'), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function clampLimit(limit: unknown): number {
  const n = typeof limit === 'number' ? limit : parseInt(String(limit ?? String(DEFAULT_LIMIT)), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * FINDING-003 fix: compute the hosting state of a media item from its
 * assets + demand. This is the canonical classification used by the
 * Media Library UI to distinguish hosted content from orphaned/pending
 * items.
 *
 * Classification rules (checked in order):
 *   1. 'hosted' — at least one asset with status='ready' AND mavero_status='available'
 *   2. 'processing' — at least one active asset (status in
 *      queued|uploading|uploaded|processing) that isn't failed/deleted
 *   3. 'failed' — ALL assets are 'failed' (a mix of failed+deleted
 *      also counts as failed since neither is playable)
 *   4. 'pending' — no assets BUT has demand (users requested it —
 *      upload needed)
 *   5. 'catalog_only' — no assets AND no demand (orphan from a failed
 *      upload — filtered out of the default Media Library view by the
 *      `includeOrphans` flag)
 */
function computeHostingState(
  assets: LibraryAssetSummary[],
  demand: { request_count: number; last_requested_at: string; status: string } | null,
): 'hosted' | 'processing' | 'failed' | 'pending' | 'catalog_only' {
  // Filter out deleted assets — they don't count toward any active state.
  const activeAssets = assets.filter(a => a.status !== 'deleted');

  if (activeAssets.length === 0) {
    // No active assets. If there's demand, it's "pending" (waiting for
    // upload). Otherwise it's a catalog-only orphan.
    return demand ? 'pending' : 'catalog_only';
  }

  // Check for hosted (at least one ready+available asset).
  const hasHosted = activeAssets.some(a => a.status === 'ready' && a.mavero_status === 'available');
  if (hasHosted) return 'hosted';

  // Check for processing (at least one asset in an active state).
  const hasProcessing = activeAssets.some(a =>
    a.status === 'queued' || a.status === 'uploading' || a.status === 'uploaded' || a.status === 'processing'
  );
  if (hasProcessing) return 'processing';

  // All active assets are 'failed' (or 'ready' but not 'available' —
  // e.g. detached with mavero_status='missing'). Treat as failed.
  return 'failed';
}
