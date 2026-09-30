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

    // 2. Batch-fetch asset counts per source.
    const sourceIds = [...sourceByProvider.values()].map((s) => s.id);
    const { data: assetRows, error: assetErr } = await this.client
      .from('media_assets')
      .select('provider_source_id, status, mavero_status')
      .in('provider_source_id', sourceIds);
    // assetCounts is partial-failure — if the query fails, we still return
    // providers with assetCounts=null.
    const countsBySource = new Map<string, { total: number; ready: number; processing: number; failed: number; deleted: number; unlinked: number }>();
    if (!assetErr && assetRows) {
      for (const row of assetRows as Array<{ provider_source_id: string | null; status: string; mavero_status: string }>) {
        if (!row.provider_source_id) continue;
        const c = countsBySource.get(row.provider_source_id) ?? { total: 0, ready: 0, processing: 0, failed: 0, deleted: 0, unlinked: 0 };
        c.total += 1;
        if (row.status === 'ready') c.ready += 1;
        else if (row.status === 'processing' || row.status === 'uploaded' || row.status === 'uploading' || row.status === 'queued') c.processing += 1;
        else if (row.status === 'failed') c.failed += 1;
        else if (row.status === 'deleted') c.deleted += 1;
        if (row.mavero_status === 'missing' && row.status !== 'deleted') c.unlinked += 1;
        countsBySource.set(row.provider_source_id, c);
      }
    }

    // 3. Batch-fetch last sync timestamp per source (max of last_synced_at).
    const lastSyncBySource = new Map<string, string>();
    if (sourceIds.length > 0) {
      const { data: syncRows, error: syncErr } = await this.client
        .from('media_assets')
        .select('provider_source_id, last_synced_at')
        .in('provider_source_id', sourceIds)
        .not('last_synced_at', 'is', null)
        .order('last_synced_at', { ascending: false });
      if (!syncErr && syncRows) {
        for (const row of syncRows as Array<{ provider_source_id: string | null; last_synced_at: string | null }>) {
          if (!row.provider_source_id || !row.last_synced_at) continue;
          if (!lastSyncBySource.has(row.provider_source_id)) {
            lastSyncBySource.set(row.provider_source_id, row.last_synced_at);
          }
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

      const assetCounts = source ? (countsBySource.get(source.id) ?? null) : null;
      const lastSyncAt = source ? (lastSyncBySource.get(source.id) ?? null) : null;

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

    // Provider filter — map adapter_id → source_id via a sub-query.
    // We resolve the source_id(s) for the requested adapter up-front so
    // the main query stays a simple .in() filter.
    if (query.provider && query.provider !== 'all') {
      const sourceIds = await this.sourceIdsForAdapter(query.provider);
      if (sourceIds.length === 0) {
        return { items: [], total: 0, page, limit, hasMore: false };
      }
      assetsQuery = assetsQuery.in('provider_source_id', sourceIds);
    }

    // Status filter — applies to media_assets.status
    if (query.status && query.status !== 'all') {
      assetsQuery = assetsQuery.eq('status', query.status);
    }

    // Linked / unlinked filter.
    //   linked = media_item_id IS NOT NULL AND mavero_status != 'missing'
    //   unlinked = media_item_id IS NULL OR mavero_status = 'missing'
    if (query.linked === 'linked') {
      assetsQuery = assetsQuery.not('media_item_id', 'is', null).neq('mavero_status', 'missing');
    } else if (query.linked === 'unlinked') {
      // Two conditions OR'd — Supabase's .or() takes a PostgREST filter string.
      assetsQuery = assetsQuery.or('media_item_id.is.null,mavero_status.eq.missing');
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

    const { data: assets, error: assetsError, count } = await assetsQuery;
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
      // An asset is "unlinked" if media_item_id is null OR mavero_status is 'missing'.
      // The UI uses this to render the UNLINKED badge.
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
    // Batch-fetch the source → adapter mapping for the source_ids on this page.
    const sourceIdsOnPage = [...new Set(items.map((i) => i.providerSourceId).filter(Boolean))] as string[];
    if (sourceIdsOnPage.length > 0) {
      const adapterBySource = await this.adapterBySourceIds(sourceIdsOnPage);
      for (const item of items) {
        if (item.providerSourceId) {
          item.providerAdapterId = adapterBySource.get(item.providerSourceId) ?? null;
        }
      }
    }

    return {
      items,
      total,
      page,
      limit,
      hasMore: offset + limit < total,
    };
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
