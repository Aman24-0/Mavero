/**
 * Admin 2.0 — Phase E — Hosting Control service.
 *
 * Aggregated read model for the Hosting Control workspace. Combines:
 *   - streaming_providers + streaming_sources (identity)
 *   - adapter capabilities (verified, never guessed)
 *   - ProviderHealthService (live health check)
 *   - media_assets (asset counts + last sync)
 *
 * Two read methods:
 *   - listProviders() — overview for the Providers tab
 *   - listAssets(query) — paginated, filtered, joined asset inventory for the Assets tab
 *
 * Why a dedicated read model:
 *   - The existing /api/admin/media/health endpoint returns health only — no
 *     identity, no capabilities, no asset counts.
 *   - The existing /api/admin/media/library endpoint is media-centric, not
 *     asset-centric. The Assets tab needs an asset-centric view (one row per
 *     media_asset, with the linked media_item nested inline).
 *   - Without this read model, the client would need 4+ requests per provider
 *     (identity, capabilities, health, counts).
 *
 * Partial-failure contract:
 *   - If health check fails for one provider, that provider's `health` is null
 *     but the rest of the overview still loads.
 *   - If asset count query fails for one provider, that provider's
 *     `assetCounts` is null but the rest still loads.
 *   - If a provider is not configured (no adapter), it's still listed with
 *     `health.status='misconfigured'`.
 *
 * SECURITY: SERVER-SIDE ONLY. No credentials are exposed. The read model
 * intentionally does NOT expose `provider_metadata` jsonb or `playback_url`
 * (resolver-only data).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { getHostingAdapter } from '../registry';
import { getVidaraConfigOrNull } from '../vidara/config';
import { getAbyssConfigOrNull } from '../abyss/config';
import { ProviderHealthService } from '../health/service';
import type {
  HostingProviderOverview,
  HostingProviderHealth,
  HostingAssetRow,
  HostingAssetQuery,
  HostingAssetListResult,
  HostingAssetFacetCounts,
  AssetLifecycleStatus,
  AssetMaveroStatus,
} from '$lib/shared/hosting-types';
import type { ProviderCapabilities } from '../types';

// ============================================================
// Static capability map — mirrors the adapter source constants.
// Read here (instead of importing the adapter, which requires
// credentials at module load) so the page server can run without
// $env being set. The Phase E test suite asserts they stay in sync.
// ============================================================

const ADAPTER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  vidara: {
    localUpload: true,
    remoteUpload: true,
    remoteUploadTypes: ['direct-file'] as const,
    folderManagement: true,
    nestedFolders: false,
    subtitles: true,
    multiAudio: true,
    transcoding: false,
    qualityVariants: false,
    processingStatus: true,
    rename: true,
    move: true,
    delete: true,
    thumbnails: true,
  },
  abyss: {
    localUpload: true,
    remoteUpload: false,
    remoteUploadTypes: [] as const,
    folderManagement: true,
    nestedFolders: true,
    subtitles: true,
    multiAudio: false,
    transcoding: true,
    qualityVariants: true,
    processingStatus: true,
    rename: true,
    move: true,
    delete: true,
    thumbnails: false,
  },
};

function isAdapterConfigured(adapterId: string): boolean {
  if (adapterId === 'vidara') return getVidaraConfigOrNull() !== null;
  if (adapterId === 'abyss') return getAbyssConfigOrNull() !== null;
  return false;
}

const HOSTING_ADAPTER_IDS = ['vidara', 'abyss'] as const;

// ============================================================
// Service
// ============================================================

const DEFAULT_ASSET_LIMIT = 25;
const MAX_ASSET_LIMIT = 100;

export class HostingControlService {
  private healthService: ProviderHealthService;

  constructor(private client: SupabaseClient<Database>) {
    this.healthService = new ProviderHealthService(client);
  }

  // ------------------------------------------------------------
  // Providers overview
  // ------------------------------------------------------------

  /**
   * Lists all hosting providers with their identity, capabilities, health,
   * and asset counts. Partial-failure: if health or counts fail for one
   * provider, the rest still load.
   *
   * @param options.skipHealth If true, skips the live health check (returns
   *   health=null for all providers). Used for fast page load — the UI can
   *   trigger a separate health check via /api/admin/hosting/providers?health=1.
   */
  async listProviders(options: { skipHealth?: boolean } = {}): Promise<HostingProviderOverview[]> {
    // 1. Fetch provider + source rows.
    const { data: providers, error: providersErr } = await this.client
      .from('streaming_providers')
      .select('id, name, slug, adapter_id, enabled, status')
      .in('adapter_id', [...HOSTING_ADAPTER_IDS]);
    if (providersErr) throw new Error(`HostingControl.listProviders: ${providersErr.message}`);

    const providerIds = (providers ?? []).map((p) => p.id);
    const { data: sources, error: sourcesErr } = await this.client
      .from('streaming_sources')
      .select('id, name, slug, provider_id, status, enabled')
      .in('provider_id', providerIds);
    if (sourcesErr) throw new Error(`HostingControl.listProviders (sources): ${sourcesErr.message}`);

    // Index sources by provider_id (one source per provider for hosting adapters).
    const sourceByProvider = new Map<string, { id: string; name: string; enabled: boolean }>();
    for (const s of sources ?? []) {
      sourceByProvider.set(s.provider_id, { id: s.id, name: s.name, enabled: Boolean(s.enabled) });
    }

    // 2. Batch-fetch asset counts per source AND last-sync timestamps in
    //    parallel (Phase 2 perf). Both queries scan media_assets for the
    //    same sourceIds set and have no dependency on each other.
    const sourceIds = [...sourceByProvider.values()].map((s) => s.id);
    const [assetRes, syncRes, auditRes] = await Promise.all([
      this.client
        .from('media_assets')
        .select('provider_source_id, provider_asset_id, status, mavero_status')
        .in('provider_source_id', sourceIds),
      sourceIds.length > 0
        ? this.client
            .from('media_assets')
            .select('provider_source_id, last_synced_at')
            .in('provider_source_id', sourceIds)
            .not('last_synced_at', 'is', null)
            .order('last_synced_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      // PROVIDER INVENTORY SOURCE (Abyss direct-upload discovery): the
      // LATEST provider-sync audit rows (details.sync=true distinguishes
      // the per-provider summary events from per-asset reconcile events).
      // `assets`/`ready` come from the latest SUCCESS/PARTIAL sync (a
      // failed sync's inventory is unknown, not zero); the latest row of
      // ANY outcome supplies lastSyncOutcome/lastSyncError so a broken
      // inventory sync is visible on the provider card even while the
      // API health check stays green.
      this.client
        .from('media_operations')
        .select('details, created_at')
        .eq('action', 'sync')
        .contains('details', { sync: true })
        .order('created_at', { ascending: false })
        .limit(40)
        .then((r) => ({ data: r.data ?? [], error: r.error })),
    ]);
    const assetRows = assetRes.data;
    const assetErr = assetRes.error;
    // assetCounts is partial-failure — if the query fails, we still return
    // providers with assetCounts=null.
    //
    // TOTAL-ASSETS SEMANTICS (final 3-issue fix): `total` and `ready` count
    // ONLY currently-usable assets — rows satisfying the project's canonical
    // availability predicate (status='ready' AND mavero_status='available'),
    // the exact same dual gate the playback resolver uses
    // (resolver/mavero-hosted.ts) and the Media Library / DemandService use.
    // Deleted, failed, queued, processing, uploaded, uploading, missing
    // (detached) and disabled rows are NEVER counted — a provider card that
    // says "TOTAL ASSETS: 3" with three deleted/failed rows is exactly the
    // production bug this fixes (live evidence: 3 deleted rows + 1 queued
    // row rendered as TOTAL 3 / READY 0 while zero files were usable).
    //
    // The remaining counters (processing / failed / deleted / detached) are
    // DIAGNOSTIC breakdowns of the non-usable rows — they intentionally do
    // NOT sum to `total`. The Media Library remains the full lifecycle
    // inventory (queued/processing/failed rows stay visible there); the
    // provider card is the usable-inventory view.
    const countsBySource = new Map<string, { total: number; ready: number; processing: number; failed: number; deleted: number; detached: number }>();
    // LINKED count per source (provider inventory `linked` field, LIVE):
    // media_assets rows that associate a REAL provider file with Mavero
    // media — provider_asset_id present AND not in the terminal deleted
    // state (a deleted row's remote file no longer exists, so it is not
    // a link to a working provider file). Detached-but-existing rows
    // still count as linked (the media association is intact).
    const linkedBySource = new Map<string, number>();
    if (!assetErr && assetRows) {
      for (const row of assetRows as Array<{ provider_source_id: string | null; provider_asset_id: string | null; status: string; mavero_status: string }>) {
        if (!row.provider_source_id) continue;
        const c = countsBySource.get(row.provider_source_id) ?? { total: 0, ready: 0, processing: 0, failed: 0, deleted: 0, detached: 0 };
        // Usable = ready + available (canonical playback predicate).
        if (row.status === 'ready' && row.mavero_status === 'available') {
          c.total += 1;
          c.ready += 1;
        } else if (row.status === 'processing' || row.status === 'uploaded' || row.status === 'uploading' || row.status === 'queued') c.processing += 1;
        else if (row.status === 'failed') c.failed += 1;
        else if (row.status === 'deleted') c.deleted += 1;
        // Detached (NOT "unlinked"): mavero_status='missing' on a non-deleted
        // row — the asset still belongs to its media_item; an admin detached
        // it from playback. The remote file may still exist.
        if (row.mavero_status === 'missing' && row.status !== 'deleted') c.detached += 1;
        countsBySource.set(row.provider_source_id, c);
        if (row.provider_asset_id && row.status !== 'deleted') {
          linkedBySource.set(row.provider_source_id, (linkedBySource.get(row.provider_source_id) ?? 0) + 1);
        }
      }
    }

    // 2b. Latest sync-audit maps (provider inventory + last sync outcome).
    // auditRows are ordered created_at DESC; the first row per adapter is
    // the LATEST attempt of any outcome (outcome/error), and the first
    // SUCCESS/PARTIAL row per adapter carries the inventory snapshot.
    // Pre-hardening audit rows have no details.inventory object — those
    // are skipped (inventory stays null = honest unknown, not a fake 0).
    type AuditRow = { details: { adapter?: unknown; outcome?: unknown; inventory?: { valid_files?: unknown; ready_files?: unknown } | null; first_error?: { errorMessage?: string } | null } | null; created_at: string | null; error_message?: string | null };
    const auditRows = (auditRes.data ?? []) as AuditRow[];
    const latestAuditByAdapter = new Map<string, AuditRow>();
    const inventoryAuditByAdapter = new Map<string, AuditRow>();
    if (!auditRes.error) {
      for (const row of auditRows) {
        const adapter = row.details?.adapter;
        if (typeof adapter !== 'string' || adapter.length === 0) continue;
        if (!latestAuditByAdapter.has(adapter)) latestAuditByAdapter.set(adapter, row);
        const outcome = row.details?.outcome;
        if ((outcome === 'success' || outcome === 'partial') && !inventoryAuditByAdapter.has(adapter)) {
          inventoryAuditByAdapter.set(adapter, row);
        }
      }
    }
    const inventoryByAdapter = new Map<string, { assets: number; ready: number; syncedAt: string }>();
    for (const [adapter, row] of inventoryAuditByAdapter) {
      const inv = row.details?.inventory;
      if (!inv || typeof inv !== 'object') continue; // pre-hardening audit — no snapshot
      const assets = Number(inv.valid_files);
      const ready = Number(inv.ready_files);
      if (!Number.isFinite(assets) || !Number.isFinite(ready)) continue;
      inventoryByAdapter.set(adapter, { assets, ready, syncedAt: row.created_at ?? new Date().toISOString() });
    }
    const lastSyncOutcomeByAdapter = new Map<string, 'success' | 'partial' | 'failed'>();
    const lastSyncErrorByAdapter = new Map<string, string>();
    for (const [adapter, row] of latestAuditByAdapter) {
      const outcome = row.details?.outcome;
      if (outcome === 'success' || outcome === 'partial' || outcome === 'failed') {
        lastSyncOutcomeByAdapter.set(adapter, outcome);
      }
      const message = row.error_message ?? row.details?.first_error?.errorMessage ?? null;
      if (outcome === 'failed' && typeof message === 'string' && message.length > 0) {
        lastSyncErrorByAdapter.set(adapter, message);
      }
    }

    // 3. Build last-sync map from the parallel-fetched syncRows.
    const lastSyncBySource = new Map<string, string>();
    const syncRows = syncRes.data;
    const syncErr = syncRes.error;
    if (!syncErr && syncRows) {
      for (const row of syncRows as Array<{ provider_source_id: string | null; last_synced_at: string | null }>) {
        if (!row.provider_source_id || !row.last_synced_at) continue;
        if (!lastSyncBySource.has(row.provider_source_id)) {
          lastSyncBySource.set(row.provider_source_id, row.last_synced_at);
        }
      }
    }

    // 4. Build the overview — health is checked in parallel.
    const overviews: HostingProviderOverview[] = [];
    for (const provider of providers ?? []) {
      const adapterId = provider.adapter_id as string;
      const source = sourceByProvider.get(provider.id) ?? null;
      const caps = ADAPTER_CAPABILITIES[adapterId] ?? null;

      // Skip unknown adapters — only Vidara + Abyss are hosting providers.
      if (!caps) continue;

      // An existing source with ZERO assets reports honest zeros (not
      // null — "unavailable" is reserved for query failure / missing
      // source row).
      const assetCounts = source
        ? (countsBySource.get(source.id) ?? { total: 0, ready: 0, processing: 0, failed: 0, deleted: 0, detached: 0 })
        : null;
      const lastSyncAt = source ? (lastSyncBySource.get(source.id) ?? null) : null;
      const snapshot = inventoryByAdapter.get(adapterId) ?? null;
      const inventory = snapshot
        ? {
            assets: snapshot.assets,
            ready: snapshot.ready,
            linked: source ? (linkedBySource.get(source.id) ?? 0) : 0,
            syncedAt: snapshot.syncedAt,
          }
        : null;

      overviews.push({
        adapterId,
        providerId: provider.id,
        sourceId: source?.id ?? null,
        name: provider.name,
        slug: provider.slug,
        enabled: Boolean(provider.enabled),
        sourceEnabled: source?.enabled ?? false,
        capabilities: caps,
        health: null, // filled below
        assetCounts: assetErr ? null : assetCounts,
        inventory,
        lastSyncOutcome: lastSyncOutcomeByAdapter.get(adapterId) ?? null,
        lastSyncError: lastSyncErrorByAdapter.get(adapterId) ?? null,
        lastSyncAt,
      });
    }

    // 5. Health checks — parallel, partial-failure per provider.
    if (!options.skipHealth) {
      const healthResults = await Promise.allSettled(
        overviews.map((o) => this.healthService.checkProvider(o.adapterId)),
      );
      overviews.forEach((o, i) => {
        const result = healthResults[i];
        if (result.status === 'fulfilled') {
          o.health = {
            status: result.value.status,
            configured: result.value.configured,
            latencyMs: result.value.latencyMs,
            lastError: result.value.lastError,
            checkedAt: result.value.checkedAt,
            quota: result.value.quota,
          } satisfies HostingProviderHealth;
        } else {
          // Health check itself threw — mark as unavailable with the error message.
          o.health = {
            status: 'unavailable',
            configured: isAdapterConfigured(o.adapterId),
            latencyMs: null,
            lastError: result.reason instanceof Error ? result.reason.message : 'Health check failed.',
            checkedAt: new Date().toISOString(),
            quota: null,
          } satisfies HostingProviderHealth;
        }
      });
    }

    return overviews;
  }

  // ------------------------------------------------------------
  // Asset inventory
  // ------------------------------------------------------------

  async listAssets(query: HostingAssetQuery): Promise<HostingAssetListResult> {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const offset = (page - 1) * limit;
    const sort = query.sort ?? 'recently_updated';

    // ==========================================================
    // ARCHITECTURE (final remediation):
    //
    // The Media Library is the ONE canonical asset-centric file manager.
    // rows / search / filters / counts / pagination total are ALL derived
    // from the same base query below — there is no second population.
    //
    // DEFAULT = 'active' status: terminal deleted files are EXCLUDED from
    // the normal inventory, search, counts, and pagination. 'deleted' is
    // an explicit opt-in audit view. A deleted asset is unreachable in the
    // default experience of every filter combination.
    // ==========================================================
    const statusFilter = query.status ?? 'active';

    // Resolve the provider filter once — the source ids are used by the
    // main query AND the facet queries so every number comes from the
    // same adapter resolution.
    let providerSourceIds: string[] | null = null;
    if (query.provider && query.provider !== 'all') {
      providerSourceIds = await this.sourceIdsForAdapter(query.provider);
      if (providerSourceIds.length === 0) {
        return { items: [], total: 0, page, limit, hasMore: false, counts: { contentType: { all: 0, movie: 0, series: 0, anime: 0 }, provider: { all: 0 } } };
      }
    }

    // Build the base query. We select from media_assets and LEFT JOIN
    // media_items via the Supabase nested-select syntax.
    let assetsQuery = this.client
      .from('media_assets')
      .select(`
        id, provider_source_id, provider_asset_id, provider_video_id, filename, title,
        status, mavero_status, provider_status, source_quality, available_qualities,
        audio_languages, has_subtitles, duration_seconds, size_bytes, playback_url,
        last_synced_at, created_at, updated_at, media_item_id,
        media_item:media_items(id, title, content_type, tmdb_id, imdb_id, canonical_key, year, season, episode)
      `, { count: 'exact' });

    // Provider filter — resolved above via the adapter→source mapping.
    if (providerSourceIds) {
      assetsQuery = assetsQuery.in('provider_source_id', providerSourceIds);
    }

    // Media-item deep-link filter (Jobs/Activity/Attention "Open media").
    if (query.mediaItemId) {
      assetsQuery = assetsQuery.eq('media_item_id', query.mediaItemId);
    }

    // Status filter — 'active' (default) excludes terminal deleted assets;
    // concrete statuses filter exactly; 'deleted' is the opt-in audit view.
    if (statusFilter === 'active') {
      assetsQuery = assetsQuery.neq('status', 'deleted');
    } else if (statusFilter !== 'all') {
      assetsQuery = assetsQuery.eq('status', statusFilter);
    }

    // Link-state filter (final remediation semantics).
    //   linked   = mavero_status != 'missing'  (every row HAS a media_item_id — NOT NULL)
    //   detached = mavero_status = 'missing'   (admin-detached; still belongs to the media_item)
    //   'unlinked' is accepted as a legacy alias for 'detached'.
    const linkState = query.linked === 'unlinked' ? 'detached' : query.linked;
    if (linkState === 'linked') {
      assetsQuery = assetsQuery.neq('mavero_status', 'missing');
    } else if (linkState === 'detached') {
      assetsQuery = assetsQuery.eq('mavero_status', 'missing');
    }

    // hasSubtitles filter
    if (query.hasSubtitles === true) {
      assetsQuery = assetsQuery.eq('has_subtitles', true);
    } else if (query.hasSubtitles === false) {
      assetsQuery = assetsQuery.eq('has_subtitles', false);
    }

    // Content type filter — applies to the joined media_item.
    if (query.contentType && query.contentType !== 'all') {
      assetsQuery = assetsQuery.eq('media_item.content_type', query.contentType);
    }

    // Text search — search filename, provider_asset_id, AND the joined
    // media_item's title / tmdb_id / imdb_id / canonical_key.
    if (query.q && query.q.trim()) {
      const q = query.q.trim();
      if (/^\d+$/.test(q)) {
        // Numeric — search tmdb_id via the join.
        assetsQuery = assetsQuery.eq('media_item.tmdb_id', q);
      } else if (q.startsWith('tt') && /^tt\d{7,10}$/.test(q)) {
        assetsQuery = assetsQuery.eq('media_item.imdb_id', q);
      } else if (q.includes(':')) {
        assetsQuery = assetsQuery.eq('media_item.canonical_key', q);
      } else {
        // ILIKE on filename OR provider_asset_id OR media_item.title.
        // PostgREST or-filter with embedded ilike.
        assetsQuery = assetsQuery.or(`filename.ilike.%${q}%,provider_asset_id.ilike.%${q}%,media_item.title.ilike.%${q}%`);
      }
    }

    // Sorting
    switch (sort) {
      case 'recently_updated': assetsQuery = assetsQuery.order('updated_at', { ascending: false }); break;
      case 'recently_added':   assetsQuery = assetsQuery.order('created_at', { ascending: false }); break;
      case 'status':            assetsQuery = assetsQuery.order('status', { ascending: true }); break;
      case 'provider':          assetsQuery = assetsQuery.order('provider_source_id', { ascending: true }); break;
      default:                  assetsQuery = assetsQuery.order('updated_at', { ascending: false }); break;
    }

    assetsQuery = assetsQuery.range(offset, offset + limit - 1);

    // ==========================================================
    // Facet counts — the SAME base scope (search + link-state +
    // hasSubtitles + status + media-item deep-link), with one facet
    // dimension's own filter removed so the chips always show what you
    // would get by clicking them. Two light queries (2 columns each),
    // run in parallel with the main page query. Deleted files never
    // contribute unless status='deleted' is explicitly selected.
    // ==========================================================
    const contentTypeFacetPromise = this.facetCountQuery({
      q: query.q,
      linked: query.linked,
      hasSubtitles: query.hasSubtitles,
      status: query.status ?? 'active',
      provider: query.provider,
      mediaItemId: query.mediaItemId,
      // contentType REMOVED — this IS the facet dimension
    });
    const providerFacetPromise = this.facetCountQuery({
      q: query.q,
      linked: query.linked,
      hasSubtitles: query.hasSubtitles,
      status: query.status ?? 'active',
      contentType: query.contentType,
      mediaItemId: query.mediaItemId,
      // provider REMOVED — this IS the facet dimension
    });

    const [mainRes, contentTypeFacetRes, providerFacetRes] = await Promise.all([
      assetsQuery,
      contentTypeFacetPromise,
      providerFacetPromise,
    ]);

    const { data: assets, error: assetsError, count } = mainRes;
    if (assetsError) {
      throw new Error(`HostingControl.listAssets: ${assetsError.message}`);
    }

    const total = count ?? 0;
    const items: HostingAssetRow[] = (assets ?? []).map((row: any) => {
      const mediaItem = row.media_item
        ? {
            id: row.media_item.id,
            title: row.media_item.title,
            contentType: row.media_item.content_type as 'movie' | 'series' | 'anime',
            tmdbId: row.media_item.tmdb_id,
            imdbId: row.media_item.imdb_id ?? null,
            canonicalKey: row.media_item.canonical_key,
            year: row.media_item.year ?? null,
            season: row.media_item.season ?? null,
            episode: row.media_item.episode ?? null,
          }
        : null;
      // An asset is "detached" if mavero_status is 'missing' (admin detach —
      // the row still belongs to its media_item). media_item_id cannot be
      // NULL under the live NOT NULL constraint. The UI uses
      // row.maveroStatus to render the DETACHED badge.
      return {
        id: row.id,
        providerSourceId: row.provider_source_id,
        providerAdapterId: null, // filled below via source lookup
        providerAssetId: row.provider_asset_id,
        providerVideoId: row.provider_video_id,
        filename: row.filename,
        title: row.title,
        status: row.status as AssetLifecycleStatus,
        maveroStatus: row.mavero_status as AssetMaveroStatus,
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
        mediaItem,
      };
    });

    // 6. Fill in providerAdapterId by looking up the source → provider → adapter chain.
    // Batch-fetch the source → adapter mapping for the source_ids on this page
    // AND for the provider facet counts (single resolution, shared result).
    const sourceIdsOnPage = [...new Set(items.map((i) => i.providerSourceId).filter(Boolean))] as string[];
    const facetSourceIds = [
      ...new Set(
        ((providerFacetRes?.rows ?? []) as Array<{ provider_source_id: string | null }>)
          .map((r) => r.provider_source_id)
          .filter(Boolean),
      ),
    ] as string[];
    const adapterBySource = await this.adapterBySourceIds([...new Set([...sourceIdsOnPage, ...facetSourceIds])]);
    for (const item of items) {
      if (item.providerSourceId) {
        item.providerAdapterId = adapterBySource.get(item.providerSourceId) ?? null;
      }
    }

    // 7. Aggregate the facet counts.
    const counts = this.aggregateFacetCounts(contentTypeFacetRes, providerFacetRes, adapterBySource);

    return {
      items,
      total,
      page,
      limit,
      hasMore: offset + limit < total,
      counts,
    };
  }

  // ------------------------------------------------------------
  // Facet count helpers
  // ------------------------------------------------------------

  /**
   * Builds one facet-count query over the same media_assets base scope.
   * Returns the raw rows ({provider_source_id, media_item.content_type})
   * so callers can group by any dimension; null means the facet query
   * failed (facet counts are partial-failure — the list still loads).
   */
  private async facetCountQuery(scope: {
    q?: string;
    linked?: HostingAssetQuery['linked'];
    hasSubtitles?: boolean | null;
    status?: HostingAssetQuery['status'];
    contentType?: 'movie' | 'series' | 'anime' | 'all';
    provider?: string;
    mediaItemId?: string | null;
  }): Promise<{ rows: Array<{ provider_source_id: string | null; content_type: string | null }> } | null> {
    try {
      let q = this.client
        .from('media_assets')
        // NOTE: embedded resource must be the TABLE name with an alias —
        // `media_item(content_type)` would look for a table literally named
        // "media_item" and fail with a PostgREST schema error (caught by the
        // live smoke test).
        .select('provider_source_id, media_item:media_items(content_type)');

      // Provider filter — resolve adapter → source ids.
      if (scope.provider && scope.provider !== 'all') {
        const sourceIds = await this.sourceIdsForAdapter(scope.provider);
        if (sourceIds.length === 0) return { rows: [] };
        q = q.in('provider_source_id', sourceIds);
      }

      if (scope.mediaItemId) {
        q = q.eq('media_item_id', scope.mediaItemId);
      }

      // Status — same semantics as the main query (default active).
      const statusFilter = scope.status ?? 'active';
      if (statusFilter === 'active') {
        q = q.neq('status', 'deleted');
      } else if (statusFilter !== 'all') {
        q = q.eq('status', statusFilter);
      }

      // Link state — same semantics as the main query.
      const linkState = scope.linked === 'unlinked' ? 'detached' : scope.linked;
      if (linkState === 'linked') {
        q = q.neq('mavero_status', 'missing');
      } else if (linkState === 'detached') {
        q = q.eq('mavero_status', 'missing');
      }

      if (scope.hasSubtitles === true) {
        q = q.eq('has_subtitles', true);
      } else if (scope.hasSubtitles === false) {
        q = q.eq('has_subtitles', false);
      }

      if (scope.contentType && scope.contentType !== 'all') {
        q = q.eq('media_item.content_type', scope.contentType);
      }

      if (scope.q && scope.q.trim()) {
        const term = scope.q.trim();
        if (/^\d+$/.test(term)) {
          q = q.eq('media_item.tmdb_id', term);
        } else if (term.startsWith('tt') && /^tt\d{7,10}$/.test(term)) {
          q = q.eq('media_item.imdb_id', term);
        } else if (term.includes(':')) {
          q = q.eq('media_item.canonical_key', term);
        } else {
          q = q.or(`filename.ilike.%${term}%,provider_asset_id.ilike.%${term}%,media_item.title.ilike.%${term}%`);
        }
      }

      const { data, error } = await q;
      if (error) return null;
      const rows = ((data ?? []) as any[]).map((r) => ({
        provider_source_id: (r.provider_source_id as string | null) ?? null,
        content_type: (r.media_item?.content_type as string | null) ?? null,
      }));
      return { rows };
    } catch {
      return null;
    }
  }

  /**
   * Groups facet rows into the API-facing counts object.
   * Content-type counts come from the content-type facet scope; provider
   * counts come from the provider facet scope (adapter ids resolved via
   * the shared source→adapter map). Unresolvable sources count toward 'all'
   * but not any adapter bucket.
   */
  private aggregateFacetCounts(
    contentTypeFacet: { rows: Array<{ provider_source_id: string | null; content_type: string | null }> } | null,
    providerFacet: { rows: Array<{ provider_source_id: string | null; content_type: string | null }> } | null,
    adapterBySource: Map<string, string>,
  ): HostingAssetFacetCounts | null {
    if (!contentTypeFacet || !providerFacet) return null;

    const contentTypeCounts: HostingAssetFacetCounts['contentType'] = { all: 0, movie: 0, series: 0, anime: 0 };
    for (const row of contentTypeFacet.rows) {
      contentTypeCounts.all += 1;
      if (row.content_type === 'movie') contentTypeCounts.movie += 1;
      else if (row.content_type === 'series') contentTypeCounts.series += 1;
      else if (row.content_type === 'anime') contentTypeCounts.anime += 1;
    }

    const providerCounts: HostingAssetFacetCounts['provider'] = { all: 0 };
    for (const row of providerFacet.rows) {
      providerCounts.all += 1;
      const adapterId = row.provider_source_id ? (adapterBySource.get(row.provider_source_id) ?? null) : null;
      if (adapterId) {
        providerCounts[adapterId] = (providerCounts[adapterId] ?? 0) + 1;
      }
    }

    return { contentType: contentTypeCounts, provider: providerCounts };
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  private async sourceIdsForAdapter(adapterId: string): Promise<string[]> {
    const { data: providerRow } = await this.client
      .from('streaming_providers')
      .select('id')
      .eq('adapter_id', adapterId)
      .maybeSingle();
    if (!providerRow) return [];
    const { data: sourceRows } = await this.client
      .from('streaming_sources')
      .select('id')
      .eq('provider_id', providerRow.id);
    return (sourceRows ?? []).map((s) => s.id);
  }

  private async adapterBySourceIds(sourceIds: string[]): Promise<Map<string, string>> {
    if (sourceIds.length === 0) return new Map();
    const { data: sourceRows } = await this.client
      .from('streaming_sources')
      .select('id, provider_id')
      .in('id', sourceIds);
    const sRows = (sourceRows ?? []) as Array<{ id: string; provider_id: string }>;
    const providerIds = sRows.map((s) => s.provider_id);
    if (providerIds.length === 0) return new Map();
    const { data: providerRows } = await this.client
      .from('streaming_providers')
      .select('id, adapter_id')
      .in('id', providerIds);
    const adapterByProvider = new Map<string, string>();
    for (const p of (providerRows ?? []) as Array<{ id: string; adapter_id: string | null }>) {
      if (p.adapter_id) adapterByProvider.set(p.id, p.adapter_id);
    }
    const result = new Map<string, string>();
    for (const s of sRows) {
      const adapter = adapterByProvider.get(s.provider_id);
      if (adapter) result.set(s.id, adapter);
    }
    return result;
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
  const n = typeof limit === 'number' ? limit : parseInt(String(limit ?? String(DEFAULT_ASSET_LIMIT)), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ASSET_LIMIT;
  return Math.min(Math.floor(n), MAX_ASSET_LIMIT);
}

// Re-exported for tests
export { ADAPTER_CAPABILITIES, isAdapterConfigured, HOSTING_ADAPTER_IDS };
