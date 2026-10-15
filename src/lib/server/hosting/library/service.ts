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
 * TASK 2 (2026-10-15) — PARENT/EPISODE HIERARCHY.
 *
 * list() now returns TOP-LEVEL rows only (`parent_media_id IS NULL`):
 * every movie, every parent series row, every parent anime row. A
 * series/anime NEVER renders one card per episode — its episodes are
 * aggregated onto the parent card as `episode_summary`
 * (season_count / episode_count / linked_episode_count) and listed on
 * demand via episodes(parentId) for the accessible episode sheet.
 *
 * Query budget: list() performs exactly FOUR bounded batch queries
 * regardless of page size (items, episode children by parent id,
 * assets by media_item_id, demand by canonical_key) — still no N+1.
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
import {
  tmdbSeasonMetadataResolver,
  mergeSeasonMetadata,
  type SeasonMetadataResolver,
} from './season-metadata';

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

/**
 * TASK 2 — rollup of a parent series/anime's episodes onto the parent
 * card. `linked_episode_count` counts episodes with at least one
 * ACTIVE (non-deleted) provider asset — the number the parent card's
 * progress line renders.
 */
export type EpisodeSummary = {
  season_count: number;
  episode_count: number;
  linked_episode_count: number;
  /**
   * Task 1 (2026-10-15): true when season_count/episode_count come from
   * the COMPLETE TMDB season metadata (the honest "1/28" denominator).
   * False = metadata unavailable: episode_count is the local-row count
   * (a lower bound of LINKED episodes only) and the UI must NOT render a
   * "linked/total" fraction from it — it shows "N linked" instead.
   * A total is never invented.
   */
  metadata_available: boolean;
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
  /**
   * Deep-audit Issue B: RELATIVE TMDB poster/backdrop paths persisted on
   * the media_items row (migration 20261015000000). The library list must
   * RETURN them so AdminMediaList can build the TMDB image URL — the
   * previous select omitted both columns, so the UI could never render a
   * poster even when one was persisted. Client fallback when null: icon.
   */
  poster_path: string | null;
  backdrop_path: string | null;
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
   *
   * TASK 2: for parent series/anime rows this is the ROLLUP over the
   * parent's own assets (usually none) UNION all its episodes' assets —
   * a series with one hosted episode is 'hosted'.
   */
  hosting_state: 'hosted' | 'processing' | 'failed' | 'pending' | 'catalog_only';
  /**
   * TASK 2 — present (non-null) ONLY on top-level series/anime rows
   * returned by list(): the episode rollup described in EpisodeSummary.
   * Movies and episode rows carry null.
   */
  episode_summary: EpisodeSummary | null;
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

/**
 * TASK 2 — the episodes() read for the episode sheet: a parent series
 * or anime row plus ALL its episode rows (each with its own assets and
 * hosting state), ordered by season then episode.
 */
export type LibraryEpisodesResult = {
  parent: LibraryMediaItem;
  episodes: LibraryMediaItem[];
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

/** Row shape shared by the items/children fetches (identical projection). */
type MediaItemRow = {
  id: string;
  canonical_key: string;
  content_type: string;
  tmdb_id: string;
  imdb_id: string | null;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  episode_title: string | null;
  parent_media_id: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  created_at: string;
  updated_at: string;
};

const ITEM_PROJECTION =
  'id, canonical_key, content_type, tmdb_id, imdb_id, title, year, season, episode, episode_title, parent_media_id, poster_path, backdrop_path, created_at, updated_at';

const ASSET_PROJECTION =
  'id, media_item_id, provider_source_id, provider_asset_id, status, mavero_status, source_quality, available_qualities, audio_languages, has_subtitles, duration_seconds, size_bytes, last_synced_at, created_at, updated_at';

export class MediaLibraryService {
  private seasonMetadata: SeasonMetadataResolver;

  constructor(
    private client: SupabaseClient<Database>,
    /** Injectable for tests / alternate metadata sources; defaults to the
     * TMDB-backed public detail path (cached, in-flight-deduplicated). */
    seasonMetadataResolver?: SeasonMetadataResolver,
  ) {
    this.seasonMetadata = seasonMetadataResolver ?? tmdbSeasonMetadataResolver;
  }

  // ------------------------------------------------------------
  // Paginated, filtered, joined read — TOP-LEVEL rows only (Task 2:
  // movies + parent series/anime; episodes roll up onto the parent).
  // ------------------------------------------------------------
  async list(query: LibraryQuery): Promise<LibraryListResult> {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const offset = (page - 1) * limit;
    const sort = query.sort ?? 'recently_updated';

    // Build the media_items query.
    // Deep-audit Issue B: poster_path + backdrop_path are REQUIRED in the
    // projection — the Media Library grid/list views render them.
    // TASK 2: `parent_media_id IS NULL` restricts the page to TOP-LEVEL
    // rows — one card per movie, one card per series/anime PARENT. The
    // episode rows are fetched as children (second query below) and
    // rolled up into episode_summary.
    let itemsQuery = this.client
      .from('media_items')
      .select(ITEM_PROJECTION, { count: 'exact' })
      .is('parent_media_id', null);

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
    // media_items_content_type_tmdb_id_idx covers this lookup. (Task 2:
    // with the top-level filter this now matches the parent row only —
    // which is the one card the tree click should show.)
    if (query.seriesTmdb) {
      itemsQuery = itemsQuery.eq('tmdb_id', query.seriesTmdb);
    }

    // Sorting — applied at the items layer. Note for 'recently_updated':
    // every episode save upserts the parent row first (parent-ensure-first
    // in resolveMediaItemId) and the media_items_set_updated_at trigger
    // refreshes the parent's updated_at, so a parent with a newly linked
    // episode correctly floats up in this sort.
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

    // QUERY 1/4 — the top-level items page.
    const { data: items, error: itemsError, count } = await itemsQuery;
    if (itemsError) {
      throw new Error(`MediaLibraryService.list: ${itemsError.message}`);
    }
    if (!items || items.length === 0) {
      return { items: [], total: count ?? 0, page, limit, has_more: false };
    }
    const topLevel = items as MediaItemRow[];

    // QUERY 2/4 — episode children of the series/anime parents in this
    // page (ONE batched query; episode rows are never returned as
    // top-level cards).
    const parentIds = topLevel.filter(isEpisodicParent).map((i) => i.id);
    const childrenByParent = new Map<string, MediaItemRow[]>();
    if (parentIds.length > 0) {
      const { data: children, error: childrenError } = await this.client
        .from('media_items')
        .select(ITEM_PROJECTION)
        .in('parent_media_id', parentIds)
        .order('season', { ascending: true })
        .order('episode', { ascending: true });
      if (childrenError) {
        throw new Error(`MediaLibraryService.list (children): ${childrenError.message}`);
      }
      for (const child of (children ?? []) as MediaItemRow[]) {
        if (!child.parent_media_id) continue;
        const list = childrenByParent.get(child.parent_media_id) ?? [];
        list.push(child);
        childrenByParent.set(child.parent_media_id, list);
      }
    }
    const children = [...childrenByParent.values()].flat();

    // Batch-fetch assets AND demand rows for this page in parallel (Phase 2 perf).
    // Both depend only on the items page already fetched — no dependency on
    // each other. Previously these were two sequential awaits.
    // TASK 2: the asset/demand id sets now include the episode CHILDREN so
    // the parent rollup sees every episode's provider availability.
    const mediaItemIds = [...topLevel, ...children].map(i => i.id);
    const canonicalKeys = [...topLevel, ...children].map(i => i.canonical_key);
    const [assetsRes, demandsRes] = await Promise.all([
      this.client
        .from('media_assets')
        .select(ASSET_PROJECTION)
        .in('media_item_id', mediaItemIds)
        .order('updated_at', { ascending: false }),
      this.client
        .from('media_availability_requests')
        .select('canonical_key, request_count, last_requested_at, status')
        .in('canonical_key', canonicalKeys),
    ]);
    // QUERY 3/4 — assets batch; QUERY 4/4 — demand batch.
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
    //
    // ARCHITECTURE FIX: also exclude items whose ONLY assets are deleted.
    // A deleted provider file is terminal — it should NOT appear in the
    // active file manager. The item may still be visible in Missing Media
    // (if it has demand) or in Operations Activity (historical record).
    // This uses the same "active assets" concept as computeHostingState():
    // assets with status !== 'deleted'.
    //
    // TASK 2: for a PARENT row these rules apply to the ROLLUP — the
    // union of the parent's own assets and its episodes' assets, and the
    // union of the parent's + episodes' demand. A parent whose episodes
    // are all unlinked orphans is itself an orphan.
    const includeOrphans = query.includeOrphans === true;
    const resultItems: LibraryMediaItem[] = [];
    // Task 1: parents whose episode_summary needs the TMDB metadata
    // denominator (patched in place after ONE bounded batch below).
    const pendingMetadata: Array<{
      item: MediaItemRow;
      local: { seasonCount: number; episodeCount: number; episodesBySeason: Map<number, number> };
      linked: number;
      summary: EpisodeSummary;
    }> = [];
    for (const item of topLevel) {
      const isParent = isEpisodicParent(item);
      const ownChildren = isParent ? childrenByParent.get(item.id) ?? [] : [];
      // The asset/demand view of this card: movies use their own row;
      // parents use the union of their row and all episode rows (unionRows[0]
      // is the parent itself, so the parent's own demand wins priority).
      const unionRows = isParent ? [item, ...ownChildren] : [item];
      const unionAssets = unionRows.flatMap((r) => assetsByItem.get(r.id) ?? []);
      const firstDemandRow = unionRows.find((r) => demandByKey.has(r.canonical_key));
      const unionDemand = firstDemandRow ? demandByKey.get(firstDemandRow.canonical_key) ?? null : null;
      const activeUnionAssets = unionAssets.filter(a => a.status !== 'deleted');

      // Orphan filter (parents: no linked episode + no demand anywhere).
      if (!includeOrphans && activeUnionAssets.length === 0 && !unionDemand) {
        continue;
      }

      // Provider/status filters (parents: matched against episode assets).
      let filteredAssets = unionAssets;
      if (query.provider_source_id) {
        filteredAssets = filteredAssets.filter(a => a.provider_source_id === query.provider_source_id);
      }
      if (query.status && query.status !== 'all') {
        // The status filter applies to either the asset's `status` OR `mavero_status`
        // — both columns use overlapping vocabularies ('ready'/'failed'/'processing').
        filteredAssets = filteredAssets.filter(a => a.status === query.status || a.mavero_status === query.status);
      }
      // If a filter was applied and the card has no matching assets, skip it.
      // If no filter is applied, keep all items (including those with no active assets
      // but demand — they're "pending" media which is a useful signal in the library).
      if ((query.provider_source_id || (query.status && query.status !== 'all')) && filteredAssets.length === 0) {
        continue;
      }

      // Episode rollup (parents only).
      let episodeSummary: EpisodeSummary | null = null;
      if (isParent) {
        const seasons = new Set<number>();
        const episodesBySeason = new Map<number, number>();
        let linked = 0;
        for (const child of ownChildren) {
          if (child.season != null) {
            seasons.add(child.season);
            episodesBySeason.set(child.season, (episodesBySeason.get(child.season) ?? 0) + 1);
          }
          const childActive = (assetsByItem.get(child.id) ?? []).filter(a => a.status !== 'deleted');
          if (childActive.length > 0) linked++;
        }
        // Task 1: the DENOMINATOR comes from the complete TMDB season
        // metadata (never from the linked rows). Metadata is resolved in
        // ONE bounded batch after the loop — see below. The placeholder
        // object is pushed by reference and patched in place.
        episodeSummary = {
          season_count: seasons.size,
          episode_count: ownChildren.length,
          linked_episode_count: linked,
          metadata_available: false,
        };
        pendingMetadata.push({
          item,
          local: {
            seasonCount: seasons.size,
            episodeCount: ownChildren.length,
            episodesBySeason,
          },
          linked,
          summary: episodeSummary,
        });
      }

      resultItems.push({
        ...item,
        content_type: item.content_type as MediaContentType,
        // Movies keep their own asset list; parents carry the FILTERED
        // union (the badges/rollup need it; episode-level detail is
        // served by episodes()).
        assets: (isParent ? filteredAssets : (assetsByItem.get(item.id) ?? []).filter(a => a.status !== 'deleted')),
        demand: demandByKey.get(item.canonical_key) ?? null,
        hosting_state: computeHostingState(unionAssets, unionDemand),
        episode_summary: episodeSummary,
      });
    }

    // TASK 1 — metadata denominators for every surviving parent card:
    // ONE bounded batch (one resolver call per parent, all-settled — a
    // failure for one series never blocks the page; the cached TMDB
    // detail path deduplicates repeat loads). Local counts are kept as
    // the honest fallback when metadata is unavailable.
    if (pendingMetadata.length > 0) {
      const resolved = await Promise.allSettled(
        pendingMetadata.map((entry) => this.seasonMetadata(entry.item.content_type, entry.item.tmdb_id)),
      );
      for (let i = 0; i < pendingMetadata.length; i++) {
        const entry = pendingMetadata[i];
        const settled = resolved[i];
        const metadata = settled.status === 'fulfilled' ? settled.value : null;
        const merged = mergeSeasonMetadata(entry.local, metadata);
        entry.summary.season_count = merged.season_count;
        entry.summary.episode_count = merged.episode_count;
        entry.summary.metadata_available = merged.metadata_available;
      }
    }

    const total = count ?? 0;
    return {
      items: resultItems,
      total,
      page,
      limit,
      has_more: offset + limit < total,
    };
  }

  // ------------------------------------------------------------
  // TASK 2 — episode children of a parent series/anime, for the
  // accessible episode sheet. ONE batched query for the children plus
  // one for their assets (+ demand, tolerated).
  // ------------------------------------------------------------
  async episodes(parentMediaItemId: string): Promise<LibraryEpisodesResult | null> {
    // 1. The parent row (must be an episodic top-level row).
    const { data: parent, error: parentError } = await this.client
      .from('media_items')
      .select(ITEM_PROJECTION)
      .eq('id', parentMediaItemId)
      .maybeSingle();
    if (parentError) throw new Error(`MediaLibraryService.episodes (parent): ${parentError.message}`);
    if (!parent) return null;
    const parentRow = parent as MediaItemRow;
    if (!isEpisodicParent(parentRow)) {
      // Movies (and stray episode rows) have no episode sheet.
      return { parent: this.toLibraryItem(parentRow, [], null, null), episodes: [] };
    }

    // 2. Children ordered by season then episode.
    const { data: children, error: childrenError } = await this.client
      .from('media_items')
      .select(ITEM_PROJECTION)
      .eq('parent_media_id', parentMediaItemId)
      .order('season', { ascending: true })
      .order('episode', { ascending: true });
    if (childrenError) throw new Error(`MediaLibraryService.episodes (children): ${childrenError.message}`);
    const childRows = (children ?? []) as MediaItemRow[];

    // 3. Assets + demand for the parent and every child (batched).
    const allRows = [parentRow, ...childRows];
    const [assetsRes, demandsRes] = await Promise.all([
      this.client
        .from('media_assets')
        .select(ASSET_PROJECTION)
        .in('media_item_id', allRows.map(r => r.id))
        .order('updated_at', { ascending: false }),
      this.client
        .from('media_availability_requests')
        .select('canonical_key, request_count, last_requested_at, status')
        .in('canonical_key', allRows.map(r => r.canonical_key)),
    ]);
    if (assetsRes.error) throw new Error(`MediaLibraryService.episodes (assets): ${assetsRes.error.message}`);
    if (demandsRes.error) console.warn('[MediaLibrary] demand query failed', demandsRes.error.message);

    const assetsByItem = new Map<string, LibraryAssetSummary[]>();
    for (const a of (assetsRes.data ?? []) as Array<LibraryAssetSummary & { media_item_id: string }>) {
      const list = assetsByItem.get(a.media_item_id) ?? [];
      list.push(a);
      assetsByItem.set(a.media_item_id, list);
    }
    const demandByKey = new Map<string, { request_count: number; last_requested_at: string; status: string }>();
    for (const d of (demandsRes.data ?? [])) {
      demandByKey.set(d.canonical_key, {
        request_count: d.request_count,
        last_requested_at: d.last_requested_at,
        status: d.status,
      });
    }

    // 4. Parent rollup (allRows[0] is the parent itself, so the parent's
    // own demand wins priority in the find()).
    const unionAssets = allRows.flatMap(r => assetsByItem.get(r.id) ?? []);
    const firstDemandRow = allRows.find(r => demandByKey.has(r.canonical_key));
    const unionDemand = firstDemandRow ? demandByKey.get(firstDemandRow.canonical_key) ?? null : null;
    const seasons = new Set<number>();
    const episodesBySeason = new Map<number, number>();
    let linked = 0;
    for (const child of childRows) {
      if (child.season != null) {
        seasons.add(child.season);
        episodesBySeason.set(child.season, (episodesBySeason.get(child.season) ?? 0) + 1);
      }
      if ((assetsByItem.get(child.id) ?? []).some(a => a.status !== 'deleted')) linked++;
    }
    // Task 1: same metadata denominator contract as list() — ONE resolver
    // call for this parent; local counts are the honest fallback.
    const metadata = await this.seasonMetadata(parentRow.content_type, parentRow.tmdb_id).catch(() => null);
    const merged = mergeSeasonMetadata(
      { seasonCount: seasons.size, episodeCount: childRows.length, episodesBySeason },
      metadata,
    );
    const summary: EpisodeSummary = {
      season_count: merged.season_count,
      episode_count: merged.episode_count,
      linked_episode_count: linked,
      metadata_available: merged.metadata_available,
    };

    return {
      parent: this.toLibraryItem(parentRow, unionAssets, unionDemand, summary),
      episodes: childRows.map(child =>
        this.toLibraryItem(child, (assetsByItem.get(child.id) ?? []).filter(a => a.status !== 'deleted'), demandByKey.get(child.canonical_key) ?? null, null)
      ),
    };
  }

  // ------------------------------------------------------------
  // Single media item detail with assets + recent operations.
  // ------------------------------------------------------------
  async detail(mediaItemId: string): Promise<LibraryDetailResult | null> {
    // 1. Fetch the media item.
    // Deep-audit Issue B: poster fields included (same contract as list()).
    const { data: item, error: itemError } = await this.client
      .from('media_items')
      .select(ITEM_PROJECTION)
      .eq('id', mediaItemId)
      .maybeSingle();
    if (itemError) throw new Error(`MediaLibraryService.detail (item): ${itemError.message}`);
    if (!item) return null;
    const row = item as MediaItemRow;

    // 2. Fetch its assets in parallel with demand + recent operations.
    const [assetsRes, demandRes, opsRes] = await Promise.all([
      this.client
        .from('media_assets')
        .select(ASSET_PROJECTION)
        .eq('media_item_id', mediaItemId)
        .order('updated_at', { ascending: false }),
      this.client
        .from('media_availability_requests')
        .select('canonical_key, request_count, last_requested_at, status')
        .eq('canonical_key', row.canonical_key)
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

    const libraryItem = this.toLibraryItem(row, assets, demand, null);

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

  // ------------------------------------------------------------
  // Shared row → LibraryMediaItem mapper (Task 2: one projection, one
  // mapping contract for list/episodes/detail).
  // ------------------------------------------------------------
  private toLibraryItem(
    row: MediaItemRow,
    assets: LibraryAssetSummary[],
    demand: { request_count: number; last_requested_at: string; status: string } | null,
    episodeSummary: EpisodeSummary | null,
  ): LibraryMediaItem {
    return {
      id: row.id,
      canonical_key: row.canonical_key,
      content_type: row.content_type as MediaContentType,
      tmdb_id: row.tmdb_id,
      imdb_id: row.imdb_id,
      title: row.title,
      year: row.year,
      season: row.season,
      episode: row.episode,
      episode_title: row.episode_title,
      parent_media_id: row.parent_media_id,
      poster_path: row.poster_path,
      backdrop_path: row.backdrop_path,
      created_at: row.created_at,
      updated_at: row.updated_at,
      assets,
      demand,
      hosting_state: computeHostingState(assets, demand),
      episode_summary: episodeSummary,
    };
  }
}

// ============================================================
// Helpers
// ============================================================

/** A top-level series/anime row (the one-card-per-show contract). */
function isEpisodicParent(row: { content_type: string; parent_media_id: string | null }): boolean {
  return (row.content_type === 'series' || row.content_type === 'anime') && row.parent_media_id == null;
}

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
