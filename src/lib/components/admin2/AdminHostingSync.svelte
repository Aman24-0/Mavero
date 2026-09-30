<script lang="ts">
  /**
   * Admin 2.0 — Phase E — AdminHostingSync
   *
   * The Sync tab. Shows:
   *   - Sync actions (Sync All + per-provider Sync)
   *   - Last sync summary per provider (asset counts, last sync timestamp)
   *   - Unlinked provider assets (assets in Mavero DB with no media link)
   *
   * Sync flow:
   *   1. Admin clicks "Sync All" or per-provider "Sync"
   *   2. POST /api/admin/media/sync?provider=<adapter> (or no param for all)
   *   3. The endpoint calls SyncService.syncProvider / syncAll
   *   4. Returns SyncResult[] with updatedAssets, deletedAssets, unlinkedFiles, errors
   *   5. UI shows the result inline + refreshes the unlinked list
   *
   * Unlinked assets:
   *   - Loaded from POST /api/admin/media/unlinked (Phase E new endpoint —
   *     does NOT trigger a sync, reads from media_assets directly).
   *   - An asset is "unlinked" when media_item_id IS NULL OR mavero_status='missing'.
   *   - Each row shows: provider, file, provider asset ID, quality, audio,
   *     subtitles, discovered time, status, actions (Open in Assets).
   *
   * Sync state machine:
   *   idle → syncing → success / partial / failed
   *
   * Partial failure: if one provider fails, the rest still report their
   * results. The UI shows per-provider outcome badges.
   */

  import { onMount } from 'svelte';
  import { RefreshCw, Loader2, AlertCircle, Check, X, AlertTriangle, Unlink, ExternalLink, FileVideo, Trash2 } from 'lucide-svelte';
  import AdminStatus from './AdminStatus.svelte';

  let {
    providers = [] as Array<{ adapterId: string; name: string; enabled: boolean; lastSyncAt: string | null; assetCounts: { total: number; ready: number; processing: number; failed: number; deleted: number; unlinked: number } | null }>,
    onopenassets = (() => {}) as (adapterId: string) => void,
  }: {
    providers?: Array<{ adapterId: string; name: string; enabled: boolean; lastSyncAt: string | null; assetCounts: { total: number; ready: number; processing: number; failed: number; deleted: number; unlinked: number } | null }>;
    onopenassets?: (adapterId: string) => void;
  } = $props();

  type SyncState = 'idle' | 'syncing' | 'success' | 'partial' | 'failed';
  type SyncResultRow = {
    providerAdapterId: string;
    totalProviderAssets: number;
    updatedAssets: number;
    deletedAssets: number;
    unlinkedFileCount: number;
    errorCount: number;
    errors: Array<{ providerAssetId: string; errorCode: string; errorMessage: string }>;
    outcome: 'success' | 'partial' | 'failed';
    errorMessage: string | null;
  };

  let syncState = $state<SyncState>('idle');
  let syncResults = $state<SyncResultRow[]>([]);
  let syncError = $state<string | null>(null);
  let syncingProvider = $state<string | null>(null);

  // Unlinked assets state
  let unlinked = $state<Array<{
    id: string;
    providerAdapterId: string | null;
    providerAssetId: string | null;
    filename: string | null;
    title: string | null;
    status: string;
    maveroStatus: string;
    sourceQuality: string | null;
    hasSubtitles: boolean;
    lastSyncedAt: string | null;
    updatedAt: string;
  }>>([]);
  let unlinkedLoading = $state(false);
  let unlinkedError = $state<string | null>(null);
  let unlinkedTotal = $state(0);
  let unlinkedPage = $state(1);
  let unlinkedHasMore = $state(false);

  onMount(() => {
    void loadUnlinked();
  });

  // ============================================================
  // Sync
  // ============================================================
  async function syncAll() {
    syncState = 'syncing';
    syncError = null;
    syncingProvider = null;
    try {
      const res = await fetch('/api/admin/media/sync', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        syncResults = (data.results as any[]).map((r) => ({
          providerAdapterId: r.providerAdapterId,
          totalProviderAssets: r.totalProviderAssets,
          updatedAssets: r.updatedAssets,
          deletedAssets: r.deletedAssets,
          unlinkedFileCount: r.unlinkedFiles?.length ?? 0,
          errorCount: r.errors?.length ?? 0,
          errors: r.errors ?? [],
          outcome: r.errors?.length > 0 ? 'partial' : 'success',
          errorMessage: null,
        }));
        const hasFailed = syncResults.some((r) => r.outcome === 'failed' || r.errorCount > 0);
        syncState = hasFailed ? 'partial' : 'success';
        // Refresh unlinked list after sync.
        void loadUnlinked();
      } else {
        syncState = 'failed';
        syncError = data.error?.message ?? 'Sync failed.';
      }
    } catch (err) {
      syncState = 'failed';
      syncError = err instanceof Error ? err.message : 'Network error during sync.';
    }
  }

  async function syncProvider(adapterId: string) {
    syncingProvider = adapterId;
    syncError = null;
    try {
      const res = await fetch(`/api/admin/media/sync?provider=${adapterId}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        const r = data.results[0];
        const result: SyncResultRow = {
          providerAdapterId: r.providerAdapterId,
          totalProviderAssets: r.totalProviderAssets,
          updatedAssets: r.updatedAssets,
          deletedAssets: r.deletedAssets,
          unlinkedFileCount: r.unlinkedFiles?.length ?? 0,
          errorCount: r.errors?.length ?? 0,
          errors: r.errors ?? [],
          outcome: r.errors?.length > 0 ? 'partial' : 'success',
          errorMessage: null,
        };
        // Replace or append the result for this provider.
        syncResults = [...syncResults.filter((x) => x.providerAdapterId !== adapterId), result];
        syncState = result.outcome === 'success' ? 'success' : 'partial';
        void loadUnlinked();
      } else {
        syncState = 'failed';
        syncError = data.error?.message ?? `Sync failed for ${adapterId}.`;
      }
    } catch (err) {
      syncState = 'failed';
      syncError = err instanceof Error ? err.message : `Network error during ${adapterId} sync.`;
    }
    syncingProvider = null;
  }

  // ============================================================
  // Unlinked assets
  // ============================================================
  async function loadUnlinked() {
    unlinkedLoading = true;
    unlinkedError = null;
    try {
      const res = await fetch(`/api/admin/media/unlinked?page=${unlinkedPage}&limit=25`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        unlinked = data.items;
        unlinkedTotal = data.total;
        unlinkedHasMore = data.hasMore;
      } else {
        unlinkedError = data.error?.message ?? 'Failed to load unlinked assets.';
      }
    } catch {
      unlinkedError = 'Network error while loading unlinked assets.';
    }
    unlinkedLoading = false;
  }

  function unlinkedPrev() {
    if (unlinkedPage <= 1) return;
    unlinkedPage -= 1;
    void loadUnlinked();
  }
  function unlinkedNext() {
    if (!unlinkedHasMore) return;
    unlinkedPage += 1;
    void loadUnlinked();
  }

  // ============================================================
  // Helpers
  // ============================================================
  function outcomeTone(o: 'success' | 'partial' | 'failed'): 'green' | 'amber' | 'red' {
    if (o === 'success') return 'green';
    if (o === 'partial') return 'amber';
    return 'red';
  }
  function outcomeLabel(o: 'success' | 'partial' | 'failed'): string {
    if (o === 'success') return 'Success';
    if (o === 'partial') return 'Partial';
    return 'Failed';
  }
  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return '—';
    }
  }
</script>

<section class="a2-hosting-sync" aria-label="Sync">
  <!-- Sync actions -->
  <header class="a2-sync-head">
    <div>
      <h2 class="a2-sync-title">Provider synchronization</h2>
      <p class="a2-sync-desc">
        Sync reconciles Mavero's view of provider assets with the provider's own view.
        Discovers new files, detects deletions, and updates asset status.
      </p>
    </div>
    <button type="button" class="a2-sync-all-btn" onclick={syncAll} disabled={syncState === 'syncing'}>
      {#if syncState === 'syncing' && !syncingProvider}
        <Loader2 size={13} style="animation: a2-spin 1s linear infinite;" /> Syncing…
      {:else}
        <RefreshCw size={13} /> Sync all providers
      {/if}
    </button>
  </header>

  {#if syncError}
    <p class="a2-sync-error" role="alert"><AlertCircle size={12} /> {syncError}</p>
  {/if}

  <!-- Per-provider sync cards -->
  <ul class="a2-sync-providers" role="list">
    {#each providers as p (p.adapterId)}
      {@const result = syncResults.find((r) => r.providerAdapterId === p.adapterId)}
      <li class="a2-sync-provider">
        <header class="a2-sync-provider-head">
          <div class="a2-sync-provider-id">
            <span class="a2-sync-provider-badge" data-adapter={p.adapterId}>{p.adapterId}</span>
            <span class="a2-sync-provider-name">{p.name}</span>
          </div>
          {#if result}
            <AdminStatus label={outcomeLabel(result.outcome)} tone={outcomeTone(result.outcome)} />
          {/if}
        </header>

        <dl class="a2-sync-provider-meta">
          <div><dt>Last sync</dt><dd>{formatDate(p.lastSyncAt)}</dd></div>
          <div><dt>Total assets</dt><dd>{p.assetCounts?.total ?? '—'}</dd></div>
          <div><dt>Ready</dt><dd>{p.assetCounts?.ready ?? '—'}</dd></div>
          <div><dt>Unlinked</dt><dd>{p.assetCounts?.unlinked ?? '—'}</dd></div>
        </dl>

        {#if result}
          <dl class="a2-sync-provider-result">
            <div><dt>Discovered</dt><dd>{result.totalProviderAssets}</dd></div>
            <div><dt>Updated</dt><dd>{result.updatedAssets}</dd></div>
            <div><dt>Deleted</dt><dd>{result.deletedAssets}</dd></div>
            <div><dt>New unlinked</dt><dd>{result.unlinkedFileCount}</dd></div>
            {#if result.errorCount > 0}
              <div class="a2-sync-provider-errors">
                <dt>Errors</dt>
                <dd>
                  <ul>
                    {#each result.errors.slice(0, 3) as err}
                      <li class="mono">{err.errorCode}: {err.errorMessage}</li>
                    {/each}
                    {#if result.errors.length > 3}
                      <li class="a2-sync-error-more">+{result.errors.length - 3} more</li>
                    {/if}
                  </ul>
                </dd>
              </div>
            {/if}
          </dl>
        {/if}

        <footer class="a2-sync-provider-actions">
          <button
            type="button"
            class="a2-sync-provider-btn"
            onclick={() => syncProvider(p.adapterId)}
            disabled={syncState === 'syncing' || !p.enabled}
          >
            {#if syncingProvider === p.adapterId}
              <Loader2 size={12} style="animation: a2-spin 1s linear infinite;" /> Syncing…
            {:else}
              <RefreshCw size={12} /> Sync
            {/if}
          </button>
          <button type="button" class="a2-sync-provider-btn" onclick={() => onopenassets(p.adapterId)}>
            <ExternalLink size={12} /> Open assets
          </button>
        </footer>
      </li>
    {/each}
  </ul>

  {#if syncResults.length > 0}
    <p class="a2-sync-summary">
      {#if syncState === 'success'}
        <Check size={12} /> Sync completed successfully.
      {:else if syncState === 'partial'}
        <AlertTriangle size={12} /> Sync completed with partial failures — see per-provider details.
      {:else if syncState === 'failed'}
        <X size={12} /> Sync failed.
      {/if}
    </p>
  {/if}

  <!-- Unlinked assets -->
  <section class="a2-sync-unlinked" aria-label="Unlinked provider assets">
    <header class="a2-sync-unlinked-head">
      <h3 class="a2-sync-unlinked-title">
        <Unlink size={14} /> Unlinked provider assets
      </h3>
      <p class="a2-sync-unlinked-desc">
        Provider assets that exist in Mavero's DB but are not linked to a canonical media item.
        These may be orphaned files or assets detached by an admin.
      </p>
    </header>

    {#if unlinkedLoading && unlinked.length === 0}
      <div class="a2-sync-unlinked-loading" role="status">
        <Loader2 size={16} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" />
        <span>Loading unlinked assets…</span>
      </div>
    {:else if unlinkedError}
      <p class="a2-sync-error" role="alert"><AlertCircle size={12} /> {unlinkedError}</p>
    {:else if unlinked.length === 0}
      <div class="a2-sync-unlinked-empty">
        <Check size={20} />
        <p>No unlinked provider assets. All provider assets are linked to media items.</p>
      </div>
    {:else}
      <ul class="a2-sync-unlinked-list" role="list">
        {#each unlinked as asset (asset.id)}
          <li class="a2-sync-unlinked-row">
            <div class="a2-sync-unlinked-row-id">
              <span class="a2-sync-provider-badge" data-adapter={asset.providerAdapterId ?? ''}>{asset.providerAdapterId ?? '—'}</span>
              <div class="a2-sync-unlinked-row-file">
                <div class="a2-sync-unlinked-row-name">{asset.filename ?? asset.title ?? 'Unnamed'}</div>
                {#if asset.providerAssetId}
                  <div class="a2-sync-unlinked-row-id mono">{asset.providerAssetId}</div>
                {/if}
              </div>
            </div>
            <div class="a2-sync-unlinked-row-meta">
              <AdminStatus label={asset.status} tone={asset.status === 'ready' ? 'green' : asset.status === 'failed' ? 'red' : 'amber'} />
              <span class="a2-sync-unlinked-row-quality mono">{asset.sourceQuality ?? '—'}</span>
              <span class="a2-sync-unlinked-row-subs">{asset.hasSubtitles ? 'subs' : ''}</span>
              <span class="a2-sync-unlinked-row-date">{formatDate(asset.updatedAt)}</span>
            </div>
          </li>
        {/each}
      </ul>

      <footer class="a2-sync-unlinked-pagination">
        <span class="a2-sync-unlinked-info">
          {unlinkedTotal} unlinked {unlinkedTotal === 1 ? 'asset' : 'assets'}
          {#if unlinkedTotal > 0}· page {unlinkedPage}{/if}
        </span>
        <div class="a2-sync-unlinked-page-actions">
          <button type="button" class="a2-sync-unlinked-page-btn" onclick={unlinkedPrev} disabled={unlinkedPage <= 1}>Prev</button>
          <button type="button" class="a2-sync-unlinked-page-btn" onclick={unlinkedNext} disabled={!unlinkedHasMore}>Next</button>
        </div>
      </footer>
    {/if}
  </section>
</section>

<style>
  .a2-hosting-sync { display: flex; flex-direction: column; gap: var(--a2-space-4); }

  .a2-sync-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: var(--a2-space-3); flex-wrap: wrap;
  }
  .a2-sync-title {
    margin: 0 0 4px;
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-base); font-weight: 700;
    color: var(--a2-text-bright);
  }
  .a2-sync-desc {
    margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted);
    max-width: 560px; line-height: 1.5;
  }
  .a2-sync-all-btn {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-4);
    background: var(--a2-cyan); color: var(--a2-surface-1);
    border: 1px solid var(--a2-cyan);
    border-radius: var(--a2-radius-sm);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xs); font-weight: 600;
    cursor: pointer;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
    white-space: nowrap;
  }
  .a2-sync-all-btn:hover:not(:disabled) { filter: brightness(1.1); }
  .a2-sync-all-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .a2-sync-error {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-red-soft); border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-red); font-size: var(--a2-text-2xs);
  }

  .a2-sync-providers {
    list-style: none; margin: 0; padding: 0;
    display: grid; grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-3);
  }
  @media (max-width: 768px) {
    .a2-sync-providers { grid-template-columns: 1fr; }
  }
  .a2-sync-provider {
    display: flex; flex-direction: column; gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .a2-sync-provider-head {
    display: flex; justify-content: space-between; align-items: center;
    gap: var(--a2-space-2);
  }
  .a2-sync-provider-id { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-sync-provider-badge {
    display: inline-block;
    padding: 1px 6px;
    background: var(--a2-surface-4);
    border-radius: var(--a2-radius-xs);
    font-family: var(--a2-font-mono);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    text-transform: uppercase;
    color: var(--a2-cyan);
  }
  .a2-sync-provider-badge[data-adapter="abyss"] { color: var(--a2-amber); }
  .a2-sync-provider-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }

  .a2-sync-provider-meta, .a2-sync-provider-result {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-2) var(--a2-space-4);
    margin: 0;
  }
  .a2-sync-provider-meta > div, .a2-sync-provider-result > div {
    display: flex; flex-direction: column; gap: 1px;
  }
  .a2-sync-provider-meta dt, .a2-sync-provider-result dt {
    font-size: var(--a2-text-2xs); color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
  }
  .a2-sync-provider-meta dd, .a2-sync-provider-result dd {
    margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text);
    font-family: var(--a2-font-mono);
  }
  .a2-sync-provider-result {
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border-radius: var(--a2-radius-sm);
    border: 1px solid var(--a2-border);
  }
  .a2-sync-provider-errors { grid-column: 1 / -1; }
  .a2-sync-provider-errors dd ul {
    list-style: none; margin: 4px 0 0; padding: 0;
    display: flex; flex-direction: column; gap: 2px;
  }
  .a2-sync-provider-errors dd li { font-size: var(--a2-text-2xs); color: var(--a2-red); }
  .a2-sync-error-more { color: var(--a2-text-dim) !important; font-style: italic; }

  .a2-sync-provider-actions {
    display: flex; gap: var(--a2-space-1);
    padding-top: var(--a2-space-2);
    border-top: 1px solid var(--a2-border);
  }
  .a2-sync-provider-btn {
    flex: 1;
    display: inline-flex; align-items: center; justify-content: center; gap: var(--a2-space-1);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xs); font-weight: 600;
    cursor: pointer;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-sync-provider-btn:hover:not(:disabled) {
    background: var(--a2-cyan-soft); border-color: var(--a2-cyan); color: var(--a2-cyan);
  }
  .a2-sync-provider-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .a2-sync-summary {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    font-size: var(--a2-text-2xs);
  }
  .a2-sync-summary:has(svg) { color: var(--a2-text); }

  /* ---- Unlinked ---- */
  .a2-sync-unlinked {
    display: flex; flex-direction: column; gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .a2-sync-unlinked-head { display: flex; flex-direction: column; gap: 4px; }
  .a2-sync-unlinked-title {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; font-size: var(--a2-text-sm); font-weight: 700; color: var(--a2-text-bright);
  }
  .a2-sync-unlinked-desc {
    margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); line-height: 1.5;
  }

  .a2-sync-unlinked-loading {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-3);
    color: var(--a2-text-muted); font-size: var(--a2-text-xs);
  }

  .a2-sync-unlinked-empty {
    display: flex; align-items: center; gap: var(--a2-space-3);
    padding: var(--a2-space-3);
    color: var(--a2-green);
    font-size: var(--a2-text-xs);
  }
  .a2-sync-unlinked-empty p { margin: 0; color: var(--a2-text-muted); }

  .a2-sync-unlinked-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column;
    gap: var(--a2-space-1);
  }
  .a2-sync-unlinked-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
  }
  .a2-sync-unlinked-row-id { display: inline-flex; align-items: center; gap: var(--a2-space-3); min-width: 0; flex: 1; }
  .a2-sync-unlinked-row-file { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .a2-sync-unlinked-row-name {
    font-size: var(--a2-text-xs); font-weight: 600; color: var(--a2-text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .a2-sync-unlinked-row-id { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }
  .a2-sync-unlinked-row-meta {
    display: inline-flex; align-items: center; gap: var(--a2-space-3);
    font-size: var(--a2-text-2xs); color: var(--a2-text-muted);
  }
  .a2-sync-unlinked-row-quality { color: var(--a2-text); }
  .a2-sync-unlinked-row-subs { color: var(--a2-text-dim); }
  .a2-sync-unlinked-row-date { font-family: var(--a2-font-mono); }

  .a2-sync-unlinked-pagination {
    display: flex; justify-content: space-between; align-items: center;
    gap: var(--a2-space-2);
    padding-top: var(--a2-space-2);
    border-top: 1px solid var(--a2-border);
  }
  .a2-sync-unlinked-info { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-sync-unlinked-page-actions { display: inline-flex; gap: var(--a2-space-1); }
  .a2-sync-unlinked-page-btn {
    padding: 4px 10px;
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-2xs); font-weight: 600;
    cursor: pointer;
  }
  .a2-sync-unlinked-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .a2-sync-unlinked-page-btn:hover:not(:disabled) { border-color: var(--a2-cyan); color: var(--a2-cyan); }

  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .a2-sync-unlinked-row { flex-direction: column; align-items: flex-start; }
    .a2-sync-unlinked-row-meta { flex-wrap: wrap; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-sync-all-btn, .a2-sync-provider-btn, .a2-sync-unlinked-page-btn { transition: none; }
  }
</style>
