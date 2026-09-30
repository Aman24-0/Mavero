<script lang="ts">
  /**
   * Admin 2.0 — Phase E — AdminHostingAssets
   *
   * The Assets tab. Shows a dense operational table of media_assets with:
   *   - Provider (Vidara / Abyss)
   *   - File name + provider asset ID
   *   - Linked media (or UNLINKED badge)
   *   - Type (movie/series/anime)
   *   - Status (queued/uploading/uploaded/processing/ready/failed/deleted)
   *   - Quality (source_quality for Vidara, available_qualities for Abyss)
   *   - Audio (multi-audio indicator for Vidara)
   *   - Subtitles (yes/no)
   *   - Updated
   *   - Actions (rename / move / detach / delete / reconcile)
   *
   * Server-side pagination + filtering + search via
   * GET /api/admin/hosting/assets. No N+1 provider API calls.
   *
   * Clicking a row opens a detail drawer with full asset metadata +
   * the management actions. Destructive actions (detach, delete) use
   * AdminConfirmDialog with strong confirmation.
   *
   * Action availability is driven by provider capabilities:
   *   - rename: caps.rename
   *   - move: caps.folderManagement
   *   - delete: caps.delete
   *   - reconcile: always available (uses existing SyncService.reconcileAsset)
   *   - detach: always available (Mavero-side operation, no provider call)
   *
   * Mobile: table collapses to a card list. Filters open a bottom sheet.
   */

  import { onMount, onDestroy } from 'svelte';
  import { Search, Filter, X, ChevronLeft, ChevronRight, Pencil, FolderInput, Unlink, Trash2, RefreshCw, ExternalLink, AlertCircle, Loader2, HardDrive, FileVideo, Check, Film, Tv, Sparkles } from 'lucide-svelte';
  import AdminStatus from './AdminStatus.svelte';
  import AdminConfirmDialog from './AdminConfirmDialog.svelte';
  import type { HostingAssetRow, HostingAssetQuery } from '$lib/shared/hosting-types';
  import type { ProviderCapabilities } from '$lib/server/hosting/types';

  let {
    initialProvider = null as string | null,
    providers = [] as Array<{ adapterId: string; name: string; capabilities: ProviderCapabilities }>,
    onopenprovider = (() => {}) as (adapterId: string) => void,
  }: {
    initialProvider?: string | null;
    providers?: Array<{ adapterId: string; name: string; capabilities: ProviderCapabilities }>;
    onopenprovider?: (adapterId: string) => void;
  } = $props();

  // ============================================================
  // State
  // ============================================================
  let items = $state<HostingAssetRow[]>([]);
  let total = $state(0);
  let page = $state(1);
  let limit = $state(25);
  let hasMore = $state(false);
  let loading = $state(false);
  let listError = $state<string | null>(null);

  let filters = $state<HostingAssetQuery>({
    q: '',
    provider: initialProvider ?? 'all',
    linked: 'all',
    status: 'all',
    contentType: 'all',
    hasSubtitles: null,
    sort: 'recently_updated',
    page: 1,
    limit: 25,
  });

  let selectedAsset = $state<HostingAssetRow | null>(null);
  let drawerOpen = $state(false);
  let drawerLoading = $state(false);
  let mobileFiltersOpen = $state(false);

  // Management action state.
  let actionInProgress = $state(false);
  let actionError = $state<string | null>(null);
  let actionSuccess = $state<string | null>(null);

  // Rename / move modal state.
  let renameOpen = $state(false);
  let renameValue = $state('');
  let moveOpen = $state(false);
  let moveTargetFolder = $state('');

  // Confirm dialog state (detach + delete).
  let confirmOpen = $state(false);
  let confirmAction = $state<'detach' | 'delete' | null>(null);
  let confirmAsset = $state<HostingAssetRow | null>(null);

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // ============================================================
  // Capabilities lookup by adapter id
  // ============================================================
  function capsForAdapter(adapterId: string | null): ProviderCapabilities | null {
    if (!adapterId) return null;
    return providers.find((p) => p.adapterId === adapterId)?.capabilities ?? null;
  }

  // ============================================================
  // Data loading
  // ============================================================
  async function loadAssets() {
    loading = true;
    listError = null;
    try {
      const params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.provider && filters.provider !== 'all') params.set('provider', String(filters.provider));
      if (filters.linked && filters.linked !== 'all') params.set('linked', String(filters.linked));
      if (filters.status && filters.status !== 'all') params.set('status', String(filters.status));
      if (filters.contentType && filters.contentType !== 'all') params.set('contentType', String(filters.contentType));
      if (filters.hasSubtitles === true) params.set('hasSubtitles', 'true');
      else if (filters.hasSubtitles === false) params.set('hasSubtitles', 'false');
      params.set('sort', String(filters.sort ?? 'recently_updated'));
      params.set('page', String(filters.page ?? 1));
      params.set('limit', String(filters.limit ?? 25));

      const res = await fetch(`/api/admin/hosting/assets?${params.toString()}`);
      const data = await res.json();
      if (data.ok) {
        items = data.items;
        total = data.total;
        page = data.page;
        limit = data.limit;
        hasMore = data.hasMore;
      } else {
        listError = data.error?.message ?? 'Failed to load assets.';
      }
    } catch {
      listError = 'Network error while loading assets.';
    }
    loading = false;
  }

  function syncUrl() {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.provider && filters.provider !== 'all') params.set('provider', String(filters.provider));
    if (filters.linked && filters.linked !== 'all') params.set('linked', String(filters.linked));
    if (filters.status && filters.status !== 'all') params.set('status', String(filters.status));
    if (filters.contentType && filters.contentType !== 'all') params.set('contentType', String(filters.contentType));
    if (filters.hasSubtitles === true) params.set('hasSubtitles', 'true');
    else if (filters.hasSubtitles === false) params.set('hasSubtitles', 'false');
    if (filters.sort && filters.sort !== 'recently_updated') params.set('sort', String(filters.sort));
    if (page > 1) params.set('page', String(page));
    const url = `${window.location.pathname}?tab=assets${params.toString() ? '&' + params.toString() : ''}`;
    window.history.replaceState(null, '', url);
  }

  function debouncedSearch() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      filters.page = 1;
      void loadAssets();
    }, 300);
  }

  // Re-fetch when filters change (except q, which is debounced).
  let lastProvider = $state(filters.provider);
  let lastLinked = $state(filters.linked);
  let lastStatus = $state(filters.status);
  let lastContentType = $state(filters.contentType);
  let lastHasSubtitles = $state(filters.hasSubtitles);
  let lastSort = $state(filters.sort);

  $effect(() => {
    if (
      filters.provider !== lastProvider ||
      filters.linked !== lastLinked ||
      filters.status !== lastStatus ||
      filters.contentType !== lastContentType ||
      filters.hasSubtitles !== lastHasSubtitles ||
      filters.sort !== lastSort
    ) {
      lastProvider = filters.provider;
      lastLinked = filters.linked;
      lastStatus = filters.status;
      lastContentType = filters.contentType;
      lastHasSubtitles = filters.hasSubtitles;
      lastSort = filters.sort;
      filters.page = 1;
      void loadAssets();
    }
  });

  onMount(() => {
    void loadAssets();
  });

  onDestroy(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
  });

  // ============================================================
  // Helpers
  // ============================================================
  function statusTone(status: string): 'green' | 'amber' | 'red' | 'cyan' | 'neutral' {
    switch (status) {
      case 'ready': return 'green';
      case 'processing': case 'uploading': case 'uploaded': case 'queued': return 'amber';
      case 'failed': return 'red';
      case 'deleted': return 'red';
      default: return 'neutral';
    }
  }
  function statusLabel(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function isUnlinked(asset: HostingAssetRow): boolean {
    return !asset.mediaItem || asset.maveroStatus === 'missing';
  }
  function formatQuality(asset: HostingAssetRow): string {
    if (asset.providerAdapterId === 'abyss' && asset.availableQualities.length > 0) {
      return asset.availableQualities.join(', ');
    }
    return asset.sourceQuality ?? '—';
  }
  function formatAudio(asset: HostingAssetRow): string {
    if (asset.audioLanguages.length === 0) return '—';
    if (asset.audioLanguages.length === 1) return asset.audioLanguages[0];
    return `${asset.audioLanguages.length} tracks`;
  }
  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = now - d.getTime();
      if (diff < 60_000) return 'just now';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
      return d.toLocaleDateString();
    } catch {
      return '—';
    }
  }
  function formatSize(bytes: number | null): string {
    if (bytes == null) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  function formatDuration(seconds: number | null): string {
    if (seconds == null) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function openDetail(asset: HostingAssetRow) {
    selectedAsset = asset;
    drawerOpen = true;
    actionError = null;
    actionSuccess = null;
  }

  function pageNext() {
    if (!hasMore) return;
    filters.page = (filters.page ?? 1) + 1;
    void loadAssets();
  }
  function pagePrev() {
    if ((filters.page ?? 1) <= 1) return;
    filters.page = (filters.page ?? 1) - 1;
    void loadAssets();
  }

  function clearFilters() {
    filters = { q: '', provider: 'all', linked: 'all', status: 'all', contentType: 'all', hasSubtitles: null, sort: 'recently_updated', page: 1, limit: 25 };
    void loadAssets();
  }

  const activeFilterCount = $derived(
    (filters.provider && filters.provider !== 'all' ? 1 : 0) +
    (filters.linked !== 'all' ? 1 : 0) +
    (filters.status !== 'all' ? 1 : 0) +
    (filters.contentType !== 'all' ? 1 : 0) +
    (filters.hasSubtitles !== null ? 1 : 0)
  );

  // ============================================================
  // Management actions
  // ============================================================
  async function executeAction(asset: HostingAssetRow, action: 'rename' | 'move' | 'detach' | 'delete' | 'reconcile', body?: Record<string, unknown>) {
    actionInProgress = true;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${asset.id}/${action}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (data.ok) {
        actionSuccess = `${action.charAt(0).toUpperCase() + action.slice(1)} succeeded.`;
        // Reload the list to reflect the change.
        await loadAssets();
        // If the selected asset is still in the list, update it.
        const sel = selectedAsset;
        if (sel) {
          const updated = items.find((i) => i.id === sel.id);
          if (updated) selectedAsset = updated;
        }
      } else {
        actionError = data.error?.message ?? `${action} failed.`;
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : `Network error during ${action}.`;
    }
    actionInProgress = false;
  }

  function startRename(asset: HostingAssetRow) {
    renameValue = asset.filename ?? asset.title ?? '';
    renameOpen = true;
  }
  async function confirmRename() {
    const asset = selectedAsset;
    if (!asset || !renameValue.trim()) return;
    renameOpen = false;
    await executeAction(asset, 'rename', { newName: renameValue.trim() });
  }

  function startMove(asset: HostingAssetRow) {
    moveTargetFolder = '';
    moveOpen = true;
  }
  async function confirmMove() {
    const asset = selectedAsset;
    if (!asset) return;
    moveOpen = false;
    await executeAction(asset, 'move', { targetFolderId: moveTargetFolder.trim() || null });
  }

  function startDetach(asset: HostingAssetRow) {
    confirmAsset = asset;
    confirmAction = 'detach';
    confirmOpen = true;
  }
  function startDelete(asset: HostingAssetRow) {
    confirmAsset = asset;
    confirmAction = 'delete';
    confirmOpen = true;
  }
  async function confirmDestructive() {
    if (!confirmAsset || !confirmAction) return;
    const asset = confirmAsset;
    const action = confirmAction;
    confirmOpen = false;
    await executeAction(asset, action);
  }

  async function reconcile(asset: HostingAssetRow) {
    await executeAction(asset, 'reconcile');
  }
</script>

<section class="a2-hosting-assets" aria-label="Assets">
  <!-- Filter bar -->
  <div class="a2-assets-filters">
    <div class="a2-assets-search">
      <Search size={14} class="a2-assets-search-icon" />
      <input
        type="text"
        bind:value={filters.q}
        oninput={debouncedSearch}
        placeholder="Search filename, provider asset ID, title, TMDB, IMDb…"
        class="a2-assets-search-input"
        aria-label="Search assets"
        autocomplete="off"
      />
    </div>
    <div class="a2-assets-filter-row">
      <label class="a2-assets-filter">
        <span class="a2-assets-filter-label">Provider</span>
        <select bind:value={filters.provider} class="a2-assets-select">
          <option value="all">All</option>
          <option value="vidara">Vidara</option>
          <option value="abyss">Abyss</option>
        </select>
      </label>
      <label class="a2-assets-filter">
        <span class="a2-assets-filter-label">Linked</span>
        <select bind:value={filters.linked} class="a2-assets-select">
          <option value="all">All</option>
          <option value="linked">Linked</option>
          <option value="unlinked">Unlinked</option>
        </select>
      </label>
      <label class="a2-assets-filter">
        <span class="a2-assets-filter-label">Status</span>
        <select bind:value={filters.status} class="a2-assets-select">
          <option value="all">All</option>
          <option value="ready">Ready</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
          <option value="deleted">Deleted</option>
        </select>
      </label>
      <label class="a2-assets-filter">
        <span class="a2-assets-filter-label">Type</span>
        <select bind:value={filters.contentType} class="a2-assets-select">
          <option value="all">All</option>
          <option value="movie">Movie</option>
          <option value="series">Series</option>
          <option value="anime">Anime</option>
        </select>
      </label>
      <label class="a2-assets-filter">
        <span class="a2-assets-filter-label">Sort</span>
        <select bind:value={filters.sort} class="a2-assets-select">
          <option value="recently_updated">Recently updated</option>
          <option value="recently_added">Recently added</option>
          <option value="status">Status</option>
          <option value="provider">Provider</option>
        </select>
      </label>
      {#if activeFilterCount > 0}
        <button type="button" class="a2-assets-clear" onclick={clearFilters}>
          <X size={11} /> Clear ({activeFilterCount})
        </button>
      {/if}
    </div>
  </div>

  <!-- Mobile filter toggle -->
  <button type="button" class="a2-assets-mobile-filter-toggle" onclick={() => { mobileFiltersOpen = true; }}>
    <Filter size={13} /> Filters{#if activeFilterCount > 0} ({activeFilterCount}){/if}
  </button>

  <!-- Loading / error / empty / table -->
  {#if loading && items.length === 0}
    <div class="a2-assets-loading" role="status">
      <Loader2 size={20} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" />
      <p>Loading assets…</p>
    </div>
  {:else if listError}
    <div class="a2-assets-error" role="alert">
      <AlertCircle size={20} />
      <div>
        <p class="a2-assets-error-title">Failed to load assets</p>
        <p class="a2-assets-error-desc">{listError}</p>
        <button type="button" class="a2-assets-retry" onclick={loadAssets}>Retry</button>
      </div>
    </div>
  {:else if items.length === 0}
    <div class="a2-assets-empty">
      <HardDrive size={32} />
      <h3>{filters.q || activeFilterCount > 0 ? 'No matching assets' : 'No assets yet'}</h3>
      <p>{filters.q || activeFilterCount > 0 ? 'Try adjusting your search or filters.' : 'Assets will appear here after the first upload or sync.'}</p>
    </div>
  {:else}
    <!-- Desktop table -->
    <div class="a2-assets-table-wrap" role="region" aria-label="Assets table">
      <table class="a2-assets-table">
        <thead>
          <tr>
            <th class="col-provider">Provider</th>
            <th class="col-file">File</th>
            <th class="col-media">Media</th>
            <th class="col-status">Status</th>
            <th class="col-quality">Quality</th>
            <th class="col-audio">Audio</th>
            <th class="col-subs">Subs</th>
            <th class="col-updated">Updated</th>
            <th class="col-actions"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each items as asset (asset.id)}
            <tr onclick={() => openDetail(asset)} class="a2-assets-row" class:is-unlinked={isUnlinked(asset)}>
              <td class="col-provider">
                <span class="a2-assets-provider-badge" data-adapter={asset.providerAdapterId ?? ''}>
                  {asset.providerAdapterId ?? '—'}
                </span>
              </td>
              <td class="col-file">
                <div class="a2-assets-file-cell">
                  <div class="a2-assets-file-name" title={asset.filename ?? asset.title ?? '—'}>
                    {asset.filename ?? asset.title ?? '—'}
                  </div>
                  {#if asset.providerAssetId}
                    <div class="a2-assets-file-id mono">{asset.providerAssetId}</div>
                  {/if}
                </div>
              </td>
              <td class="col-media">
                {#if isUnlinked(asset)}
                  <span class="a2-assets-unlinked-badge">UNLINKED</span>
                {:else if asset.mediaItem}
                  <div class="a2-assets-media-cell">
                    <div class="a2-assets-media-title" title={asset.mediaItem.title}>{asset.mediaItem.title}</div>
                    <div class="a2-assets-media-meta">
                      {#if asset.mediaItem.contentType === 'movie'}<Film size={10} />{:else if asset.mediaItem.contentType === 'anime'}<Sparkles size={10} />{:else}<Tv size={10} />{/if}
                      {asset.mediaItem.contentType}
                      {#if asset.mediaItem.season != null && asset.mediaItem.episode != null}
                        · S{String(asset.mediaItem.season).padStart(2, '0')}E{String(asset.mediaItem.episode).padStart(2, '0')}
                      {/if}
                    </div>
                  </div>
                {/if}
              </td>
              <td class="col-status">
                <AdminStatus label={statusLabel(asset.status)} tone={statusTone(asset.status)} />
              </td>
              <td class="col-quality mono">{formatQuality(asset)}</td>
              <td class="col-audio">
                <span class="a2-assets-audio" title={asset.audioLanguages.join(', ') || '—'}>
                  {formatAudio(asset)}
                </span>
              </td>
              <td class="col-subs">
                {#if asset.hasSubtitles}<Check size={12} style="color: var(--a2-green);" />{:else}<span class="a2-assets-dash">—</span>{/if}
              </td>
              <td class="col-updated mono">{formatDate(asset.updatedAt)}</td>
              <td class="col-actions" onclick={(e) => e.stopPropagation()}>
                <button type="button" class="a2-assets-row-action" onclick={() => openDetail(asset)} aria-label="View details">
                  <ExternalLink size={12} />
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <footer class="a2-assets-pagination">
      <span class="a2-assets-pagination-info">
        {#if total > 0}
          Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
        {:else}
          0 results
        {/if}
      </span>
      <div class="a2-assets-pagination-actions">
        <button type="button" class="a2-assets-page-btn" onclick={pagePrev} disabled={page <= 1}>
          <ChevronLeft size={12} /> Prev
        </button>
        <span class="a2-assets-page-num">Page {page}</span>
        <button type="button" class="a2-assets-page-btn" onclick={pageNext} disabled={!hasMore}>
          Next <ChevronRight size={12} />
        </button>
      </div>
    </footer>
  {/if}

  <!-- Mobile filter sheet -->
  {#if mobileFiltersOpen}
    <div class="a2-assets-filter-sheet-overlay" onclick={() => { mobileFiltersOpen = false; }} role="presentation">
      <div class="a2-assets-filter-sheet" role="dialog" aria-modal="true" aria-labelledby="a2-assets-filter-sheet-title" onclick={(e) => e.stopPropagation()}>
        <header class="a2-assets-filter-sheet-head">
          <h2 id="a2-assets-filter-sheet-title">Filters</h2>
          <button type="button" class="a2-assets-filter-sheet-close" onclick={() => { mobileFiltersOpen = false; }} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div class="a2-assets-filter-sheet-body">
          <label class="a2-assets-filter a2-assets-filter-full">
            <span class="a2-assets-filter-label">Provider</span>
            <select bind:value={filters.provider} class="a2-assets-select">
              <option value="all">All</option>
              <option value="vidara">Vidara</option>
              <option value="abyss">Abyss</option>
            </select>
          </label>
          <label class="a2-assets-filter a2-assets-filter-full">
            <span class="a2-assets-filter-label">Linked</span>
            <select bind:value={filters.linked} class="a2-assets-select">
              <option value="all">All</option>
              <option value="linked">Linked</option>
              <option value="unlinked">Unlinked</option>
            </select>
          </label>
          <label class="a2-assets-filter a2-assets-filter-full">
            <span class="a2-assets-filter-label">Status</span>
            <select bind:value={filters.status} class="a2-assets-select">
              <option value="all">All</option>
              <option value="ready">Ready</option>
              <option value="processing">Processing</option>
              <option value="failed">Failed</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
          <label class="a2-assets-filter a2-assets-filter-full">
            <span class="a2-assets-filter-label">Type</span>
            <select bind:value={filters.contentType} class="a2-assets-select">
              <option value="all">All</option>
              <option value="movie">Movie</option>
              <option value="series">Series</option>
              <option value="anime">Anime</option>
            </select>
          </label>
        </div>
        <footer class="a2-assets-filter-sheet-actions">
          <button type="button" class="a2-assets-clear" onclick={clearFilters}>Clear all</button>
          <button type="button" class="a2-assets-apply" onclick={() => { mobileFiltersOpen = false; }}>Apply</button>
        </footer>
      </div>
    </div>
  {/if}

  <!-- Detail drawer -->
  {#if drawerOpen && selectedAsset}
    {@const caps = capsForAdapter(selectedAsset.providerAdapterId)}
    <div class="a2-asset-drawer-overlay" onclick={() => { drawerOpen = false; }} role="presentation">
      <aside
        class="a2-asset-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="a2-asset-drawer-title"
        onclick={(e) => e.stopPropagation()}
      >
        <header class="a2-asset-drawer-head">
          <div class="a2-asset-drawer-head-left">
            <span class="a2-asset-drawer-icon" data-adapter={selectedAsset.providerAdapterId ?? ''}>
              <FileVideo size={18} />
            </span>
            <div>
              <h2 id="a2-asset-drawer-title" class="a2-asset-drawer-title">
                {selectedAsset.filename ?? selectedAsset.title ?? 'Unnamed asset'}
              </h2>
              <span class="a2-asset-drawer-subtitle">
                {selectedAsset.providerAdapterId ?? '—'}
                {#if selectedAsset.providerAssetId}· <span class="mono">{selectedAsset.providerAssetId}</span>{/if}
              </span>
            </div>
          </div>
          <button type="button" class="a2-asset-drawer-close" onclick={() => { drawerOpen = false; }} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div class="a2-asset-drawer-body">
          {#if actionSuccess}
            <p class="a2-asset-action-success" role="status"><Check size={12} /> {actionSuccess}</p>
          {/if}
          {#if actionError}
            <p class="a2-asset-action-error" role="alert"><AlertCircle size={12} /> {actionError}</p>
          {/if}

          <section class="a2-asset-drawer-section">
            <h3 class="a2-asset-drawer-section-title">Provider</h3>
            <dl class="a2-asset-drawer-dl">
              <div><dt>Provider</dt><dd>{selectedAsset.providerAdapterId ?? '—'}</dd></div>
              <div><dt>Asset ID</dt><dd class="mono">{selectedAsset.providerAssetId ?? '—'}</dd></div>
              <div><dt>File name</dt><dd>{selectedAsset.filename ?? '—'}</dd></div>
              <div><dt>Status</dt><dd><AdminStatus label={statusLabel(selectedAsset.status)} tone={statusTone(selectedAsset.status)} /></dd></div>
              {#if selectedAsset.providerStatus}
                <div><dt>Provider status</dt><dd class="mono">{selectedAsset.providerStatus}</dd></div>
              {/if}
              <div><dt>Last synced</dt><dd>{formatDate(selectedAsset.lastSyncedAt)}</dd></div>
            </dl>
          </section>

          <section class="a2-asset-drawer-section">
            <h3 class="a2-asset-drawer-section-title">Mavero link</h3>
            {#if isUnlinked(selectedAsset)}
              <div class="a2-asset-drawer-unlinked">
                <Unlink size={16} />
                <div>
                  <p class="a2-asset-drawer-unlinked-title">UNLINKED PROVIDER ASSET</p>
                  <p class="a2-asset-drawer-unlinked-desc">
                    This provider asset is not linked to a canonical Mavero media item.
                    {#if selectedAsset.maveroStatus === 'missing'}
                      It was detached by an admin — the provider file still exists.
                    {:else}
                      It has no media_item_id — sync did not match it to a canonical media item.
                    {/if}
                  </p>
                </div>
              </div>
            {:else if selectedAsset.mediaItem}
              <dl class="a2-asset-drawer-dl">
                <div><dt>Title</dt><dd>{selectedAsset.mediaItem.title}</dd></div>
                <div><dt>Type</dt><dd>{selectedAsset.mediaItem.contentType}</dd></div>
                <div><dt>TMDB</dt><dd class="mono">{selectedAsset.mediaItem.tmdbId}</dd></div>
                {#if selectedAsset.mediaItem.imdbId}
                  <div><dt>IMDb</dt><dd class="mono">{selectedAsset.mediaItem.imdbId}</dd></div>
                {/if}
                <div class="a2-asset-drawer-full"><dt>Canonical key</dt><dd class="mono a2-asset-drawer-key">{selectedAsset.mediaItem.canonicalKey}</dd></div>
                {#if selectedAsset.mediaItem.season != null && selectedAsset.mediaItem.episode != null}
                  <div><dt>Episode</dt><dd>S{String(selectedAsset.mediaItem.season).padStart(2, '0')}E{String(selectedAsset.mediaItem.episode).padStart(2, '0')}</dd></div>
                {/if}
              </dl>
              <a class="a2-asset-drawer-open-media" href={`/admin/media/library?selected=${selectedAsset.mediaItem.id}`}>
                <ExternalLink size={12} /> Open in Media Library
              </a>
            {/if}
          </section>

          <section class="a2-asset-drawer-section">
            <h3 class="a2-asset-drawer-section-title">Media properties</h3>
            <dl class="a2-asset-drawer-dl">
              <div><dt>Quality</dt><dd>{formatQuality(selectedAsset)}</dd></div>
              <div><dt>Audio</dt><dd>{formatAudio(selectedAsset)}{#if selectedAsset.providerAdapterId === 'vidara' && selectedAsset.audioLanguages.length > 1} (multi){/if}</dd></div>
              <div><dt>Subtitles</dt><dd>{selectedAsset.hasSubtitles ? 'Yes' : 'No'}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(selectedAsset.durationSeconds)}</dd></div>
              <div><dt>Size</dt><dd>{formatSize(selectedAsset.sizeBytes)}</dd></div>
            </dl>
          </section>

          <section class="a2-asset-drawer-section">
            <h3 class="a2-asset-drawer-section-title">Actions</h3>
            <div class="a2-asset-drawer-actions">
              <button type="button" class="a2-asset-action" onclick={() => reconcile(selectedAsset!)} disabled={actionInProgress || !selectedAsset.providerAssetId}>
                {#if actionInProgress}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<RefreshCw size={12} />{/if}
                Reconcile
              </button>
              <button type="button" class="a2-asset-action" onclick={() => startRename(selectedAsset!)} disabled={actionInProgress || !caps?.rename || !selectedAsset.providerAssetId}>
                <Pencil size={12} /> Rename
                {#if !caps?.rename}<span class="a2-asset-action-unsupported">unsupported</span>{/if}
              </button>
              <button type="button" class="a2-asset-action" onclick={() => startMove(selectedAsset!)} disabled={actionInProgress || !caps?.folderManagement || !selectedAsset.providerAssetId}>
                <FolderInput size={12} /> Move
                {#if !caps?.folderManagement}<span class="a2-asset-action-unsupported">unsupported</span>{/if}
              </button>
              <button type="button" class="a2-asset-action a2-asset-action-warn" onclick={() => startDetach(selectedAsset!)} disabled={actionInProgress}>
                <Unlink size={12} /> Detach
              </button>
              <button type="button" class="a2-asset-action a2-asset-action-danger" onclick={() => startDelete(selectedAsset!)} disabled={actionInProgress || !caps?.delete || !selectedAsset.providerAssetId}>
                <Trash2 size={12} /> Delete
                {#if !caps?.delete}<span class="a2-asset-action-unsupported">unsupported</span>{/if}
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  {/if}

  <!-- Rename modal -->
  {#if renameOpen && selectedAsset}
    <div class="a2-asset-modal-overlay" onclick={() => { renameOpen = false; }} role="presentation">
      <div class="a2-asset-modal" role="dialog" aria-modal="true" aria-labelledby="a2-asset-rename-title" onclick={(e) => e.stopPropagation()}>
        <h2 id="a2-asset-rename-title" class="a2-asset-modal-title">Rename asset</h2>
        <p class="a2-asset-modal-desc">Enter the new name. The provider-side file will be renamed; the Mavero media_asset metadata will be updated.</p>
        <label class="a2-asset-modal-field">
          <span class="a2-asset-modal-label">New name</span>
          <input type="text" bind:value={renameValue} class="a2-asset-modal-input" autocomplete="off" />
        </label>
        <footer class="a2-asset-modal-actions">
          <button type="button" class="a2-asset-modal-btn a2-asset-modal-cancel" onclick={() => { renameOpen = false; }}>Cancel</button>
          <button type="button" class="a2-asset-modal-btn a2-asset-modal-confirm" onclick={confirmRename} disabled={!renameValue.trim()}>Rename</button>
        </footer>
      </div>
    </div>
  {/if}

  <!-- Move modal -->
  {#if moveOpen && selectedAsset}
    {@const caps = capsForAdapter(selectedAsset.providerAdapterId)}
    <div class="a2-asset-modal-overlay" onclick={() => { moveOpen = false; }} role="presentation">
      <div class="a2-asset-modal" role="dialog" aria-modal="true" aria-labelledby="a2-asset-move-title" onclick={(e) => e.stopPropagation()}>
        <h2 id="a2-asset-move-title" class="a2-asset-modal-title">Move asset</h2>
        <p class="a2-asset-modal-desc">
          {#if caps?.nestedFolders}
            Enter the target folder ID (nested folders supported). Leave empty to move to root.
          {:else}
            Enter the target folder ID (flat folders only — this provider does not support nested folders). Leave empty to move to root.
          {/if}
        </p>
        <label class="a2-asset-modal-field">
          <span class="a2-asset-modal-label">Target folder ID</span>
          <input type="text" bind:value={moveTargetFolder} class="a2-asset-modal-input" placeholder="(root)" autocomplete="off" />
        </label>
        <footer class="a2-asset-modal-actions">
          <button type="button" class="a2-asset-modal-btn a2-asset-modal-cancel" onclick={() => { moveOpen = false; }}>Cancel</button>
          <button type="button" class="a2-asset-modal-btn a2-asset-modal-confirm" onclick={confirmMove}>Move</button>
        </footer>
      </div>
    </div>
  {/if}

  <!-- Destructive confirm -->
  <AdminConfirmDialog
    bind:open={confirmOpen}
    title={confirmAction === 'delete' ? 'Delete provider asset' : 'Detach asset from media'}
    description={confirmAction === 'delete'
      ? 'This will permanently delete the file from the provider. The Mavero media_asset will be marked as deleted. This action cannot be undone.'
      : 'This removes the link between the provider asset and the Mavero media item. The provider file is NOT deleted — it becomes an unlinked provider asset. The resolver will no longer serve it.'}
    confirmLabel={confirmAction === 'delete' ? 'Delete permanently' : 'Detach'}
    tone="danger"
    onconfirm={confirmDestructive}
  >
    {#if confirmAsset}
      <div class="a2-asset-confirm-body">
        <div class="a2-asset-confirm-row">
          <span>Provider</span><strong>{confirmAsset.providerAdapterId ?? '—'}</strong>
        </div>
        <div class="a2-asset-confirm-row">
          <span>File</span><strong>{confirmAsset.filename ?? confirmAsset.title ?? '—'}</strong>
        </div>
        {#if confirmAsset.mediaItem}
          <div class="a2-asset-confirm-row">
            <span>Linked media</span><strong>{confirmAsset.mediaItem.title}</strong>
          </div>
        {/if}
        {#if confirmAction === 'delete'}
          <p class="a2-asset-confirm-warning">
            <AlertCircle size={12} /> Irreversible: the provider file will be permanently deleted.
          </p>
        {/if}
      </div>
    {/if}
  </AdminConfirmDialog>
</section>

<style>
  .a2-hosting-assets { display: flex; flex-direction: column; gap: var(--a2-space-3); }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  /* ---- Filters ---- */
  .a2-assets-filters {
    display: flex; flex-direction: column; gap: var(--a2-space-2);
    padding: var(--a2-space-3);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .a2-assets-search {
    position: relative;
    display: flex; align-items: center;
  }
  .a2-assets-search-icon {
    position: absolute; left: var(--a2-space-3);
    color: var(--a2-text-dim); pointer-events: none;
  }
  .a2-assets-search-input {
    width: 100%;
    padding: var(--a2-space-2) var(--a2-space-3) var(--a2-space-2) var(--a2-space-8);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    transition: border-color var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-assets-search-input:focus {
    outline: none; border-color: var(--a2-cyan);
    box-shadow: 0 0 0 3px var(--a2-cyan-soft);
  }

  .a2-assets-filter-row {
    display: flex; gap: var(--a2-space-2); align-items: flex-end; flex-wrap: wrap;
  }
  .a2-assets-filter { display: flex; flex-direction: column; gap: 2px; }
  .a2-assets-filter-full { width: 100%; }
  .a2-assets-filter-label {
    font-size: var(--a2-text-2xs); color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
  }
  .a2-assets-select {
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xs);
    padding: 4px 8px;
    cursor: pointer;
    transition: border-color var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-assets-select:focus { outline: none; border-color: var(--a2-cyan); }

  .a2-assets-clear {
    display: inline-flex; align-items: center; gap: 2px;
    padding: 4px 8px;
    background: transparent; border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-2xs); font-weight: 600;
    cursor: pointer;
  }
  .a2-assets-clear:hover { color: var(--a2-red); border-color: var(--a2-red-border); }

  .a2-assets-mobile-filter-toggle {
    display: none;
    align-items: center; gap: var(--a2-space-1);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-xs); font-weight: 600;
    cursor: pointer;
  }

  /* ---- Loading / error / empty ---- */
  .a2-assets-loading {
    display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3);
    padding: var(--a2-space-8);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
  }
  .a2-assets-error {
    display: flex; gap: var(--a2-space-3); align-items: flex-start;
    padding: var(--a2-space-4);
    background: var(--a2-red-soft);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-md);
    color: var(--a2-red);
  }
  .a2-assets-error-title { margin: 0 0 4px; font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-red); }
  .a2-assets-error-desc { margin: 0 0 8px; font-size: var(--a2-text-xs); color: var(--a2-text-muted); }
  .a2-assets-retry {
    padding: 4px 12px;
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-2xs); font-weight: 600;
    cursor: pointer;
  }
  .a2-assets-empty {
    display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3);
    padding: var(--a2-space-8);
    text-align: center;
    color: var(--a2-text-muted);
  }
  .a2-assets-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-assets-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }

  /* ---- Table ---- */
  .a2-assets-table-wrap {
    overflow-x: auto;
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .a2-assets-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--a2-text-xs);
  }
  .a2-assets-table thead th {
    padding: var(--a2-space-2) var(--a2-space-3);
    text-align: left;
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    color: var(--a2-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--a2-border-strong);
    white-space: nowrap;
    background: var(--a2-surface-3);
    position: sticky; top: 0;
  }
  .a2-assets-table tbody tr {
    border-bottom: 1px solid var(--a2-border);
    cursor: pointer;
    transition: background var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-assets-table tbody tr:hover { background: var(--a2-surface-3); }
  .a2-assets-table tbody tr.is-unlinked { background: var(--a2-amber-soft); }
  .a2-assets-table tbody tr.is-unlinked:hover { background: var(--a2-surface-3); }
  .a2-assets-table tbody td {
    padding: var(--a2-space-2) var(--a2-space-3);
    vertical-align: top;
    color: var(--a2-text);
  }

  .a2-assets-provider-badge {
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
  .a2-assets-provider-badge[data-adapter="abyss"] { color: var(--a2-amber); }

  .a2-assets-file-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .a2-assets-file-name {
    font-weight: 600; color: var(--a2-text-bright);
    max-width: 220px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .a2-assets-file-id { color: var(--a2-text-dim); }

  .a2-assets-unlinked-badge {
    display: inline-block;
    padding: 1px 6px;
    background: var(--a2-amber-soft);
    border: 1px solid var(--a2-amber-border);
    border-radius: var(--a2-radius-xs);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    color: var(--a2-amber);
    letter-spacing: 0.05em;
  }
  .a2-assets-media-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .a2-assets-media-title {
    font-weight: 500; color: var(--a2-text);
    max-width: 200px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .a2-assets-media-meta {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: var(--a2-text-2xs); color: var(--a2-text-dim);
  }
  .a2-assets-dash { color: var(--a2-text-dim); }

  .col-actions { width: 32px; text-align: right; }
  .a2-assets-row-action {
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs);
    display: inline-flex; align-items: center; justify-content: center;
  }
  .a2-assets-row-action:hover { background: var(--a2-surface-4); color: var(--a2-cyan); }

  /* ---- Pagination ---- */
  .a2-assets-pagination {
    display: flex; justify-content: space-between; align-items: center;
    gap: var(--a2-space-3); flex-wrap: wrap;
    padding: var(--a2-space-2) var(--a2-space-3);
  }
  .a2-assets-pagination-info {
    font-size: var(--a2-text-2xs); color: var(--a2-text-muted);
    font-family: var(--a2-font-mono);
  }
  .a2-assets-pagination-actions { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-assets-page-btn {
    display: inline-flex; align-items: center; gap: 2px;
    padding: 4px 10px;
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-2xs); font-weight: 600;
    cursor: pointer;
  }
  .a2-assets-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .a2-assets-page-btn:hover:not(:disabled) { border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-assets-page-num { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); font-family: var(--a2-font-mono); }

  /* ---- Mobile filter sheet ---- */
  .a2-assets-filter-sheet-overlay {
    position: fixed; inset: 0; z-index: 90;
    background: rgba(0, 0, 0, 0.55);
    display: flex; align-items: flex-end;
  }
  .a2-assets-filter-sheet {
    width: 100%;
    background: var(--a2-surface-1);
    border-top-left-radius: var(--a2-radius-lg);
    border-top-right-radius: var(--a2-radius-lg);
    border-top: 1px solid var(--a2-border-strong);
    display: flex; flex-direction: column;
    max-height: 80vh;
    animation: a2-sheet-up var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
  .a2-assets-filter-sheet-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: var(--a2-space-4);
    border-bottom: 1px solid var(--a2-border);
  }
  .a2-assets-filter-sheet-head h2 {
    margin: 0; font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright);
  }
  .a2-assets-filter-sheet-close {
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs);
  }
  .a2-assets-filter-sheet-body {
    padding: var(--a2-space-4);
    display: flex; flex-direction: column; gap: var(--a2-space-3);
    overflow-y: auto;
  }
  .a2-assets-filter-sheet-actions {
    display: flex; gap: var(--a2-space-2);
    padding: var(--a2-space-3) var(--a2-space-4);
    border-top: 1px solid var(--a2-border);
  }
  .a2-assets-apply {
    flex: 1;
    padding: var(--a2-space-2);
    background: var(--a2-cyan); color: var(--a2-surface-1);
    border: none; border-radius: var(--a2-radius-sm);
    font-size: var(--a2-text-xs); font-weight: 600;
    cursor: pointer;
  }

  /* ---- Detail drawer ---- */
  .a2-asset-drawer-overlay {
    position: fixed; inset: 0; z-index: 80;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    display: flex; justify-content: flex-end;
    animation: a2-fade-in var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-fade-in { from { opacity: 0; } to { opacity: 1; } }
  .a2-asset-drawer {
    width: 100%; max-width: 480px;
    background: var(--a2-surface-1);
    border-left: 1px solid var(--a2-border-strong);
    display: flex; flex-direction: column;
    overflow-y: auto;
    animation: a2-slide-in var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

  .a2-asset-drawer-head {
    display: flex; justify-content: space-between; align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    border-bottom: 1px solid var(--a2-border);
    position: sticky; top: 0; background: var(--a2-surface-1); z-index: 1;
  }
  .a2-asset-drawer-head-left { display: inline-flex; align-items: center; gap: var(--a2-space-3); min-width: 0; }
  .a2-asset-drawer-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-4); color: var(--a2-cyan);
    flex-shrink: 0;
  }
  .a2-asset-drawer-icon[data-adapter="abyss"] { color: var(--a2-amber); }
  .a2-asset-drawer-title {
    margin: 0; font-size: var(--a2-text-base); font-weight: 700;
    color: var(--a2-text-bright);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .a2-asset-drawer-subtitle {
    font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em;
  }
  .a2-asset-drawer-close {
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs);
  }
  .a2-asset-drawer-close:hover { background: var(--a2-surface-3); color: var(--a2-text); }

  .a2-asset-drawer-body {
    padding: var(--a2-space-4);
    display: flex; flex-direction: column;
    gap: var(--a2-space-5);
  }
  .a2-asset-drawer-section { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-asset-drawer-section-title {
    margin: 0;
    font-family: var(--a2-font-sans); font-size: var(--a2-text-2xs); font-weight: 700;
    color: var(--a2-cyan);
    text-transform: uppercase; letter-spacing: 0.1em;
  }
  .a2-asset-drawer-dl {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-2) var(--a2-space-4);
    margin: 0;
  }
  .a2-asset-drawer-dl > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .a2-asset-drawer-dl > div.a2-asset-drawer-full { grid-column: 1 / -1; }
  .a2-asset-drawer-dl dt {
    font-size: var(--a2-text-2xs); color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
  }
  .a2-asset-drawer-dl dd {
    margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text);
    word-break: break-all;
  }
  .a2-asset-drawer-key { font-size: var(--a2-text-2xs); }

  .a2-asset-drawer-unlinked {
    display: flex; gap: var(--a2-space-3); align-items: flex-start;
    padding: var(--a2-space-3);
    background: var(--a2-amber-soft);
    border: 1px solid var(--a2-amber-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-amber);
  }
  .a2-asset-drawer-unlinked-title {
    margin: 0 0 4px; font-size: var(--a2-text-xs); font-weight: 700;
    color: var(--a2-amber); letter-spacing: 0.05em;
  }
  .a2-asset-drawer-unlinked-desc {
    margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted);
    line-height: 1.5;
  }

  .a2-asset-drawer-open-media {
    display: inline-flex; align-items: center; gap: var(--a2-space-1);
    padding: var(--a2-space-1) var(--a2-space-2);
    background: var(--a2-cyan-soft);
    border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-xs);
    color: var(--a2-cyan);
    font-size: var(--a2-text-2xs); font-weight: 600;
    text-decoration: none;
    align-self: flex-start;
  }

  .a2-asset-action-success {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-green-soft); border: 1px solid var(--a2-green-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-green); font-size: var(--a2-text-2xs);
  }
  .a2-asset-action-error {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-red-soft); border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-red); font-size: var(--a2-text-2xs);
  }

  .a2-asset-drawer-actions {
    display: flex; flex-direction: column; gap: var(--a2-space-2);
  }
  .a2-asset-action {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xs); font-weight: 600;
    cursor: pointer; text-align: left;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-asset-action:hover:not(:disabled) {
    background: var(--a2-cyan-soft);
    border-color: var(--a2-cyan);
    color: var(--a2-cyan);
  }
  .a2-asset-action:disabled { opacity: 0.4; cursor: not-allowed; }
  .a2-asset-action-warn { color: var(--a2-amber); }
  .a2-asset-action-warn:hover:not(:disabled) { background: var(--a2-amber-soft); border-color: var(--a2-amber); color: var(--a2-amber); }
  .a2-asset-action-danger { color: var(--a2-red); }
  .a2-asset-action-danger:hover:not(:disabled) { background: var(--a2-red-soft); border-color: var(--a2-red); color: var(--a2-red); }
  .a2-asset-action-unsupported {
    margin-left: auto;
    font-size: 9px; font-weight: 400;
    color: var(--a2-text-dim);
    text-transform: lowercase;
  }

  /* ---- Modals ---- */
  .a2-asset-modal-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    padding: var(--a2-space-4);
  }
  .a2-asset-modal {
    width: 100%; max-width: 420px;
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-lg);
    box-shadow: var(--a2-shadow-lg);
    padding: var(--a2-space-5);
    display: flex; flex-direction: column; gap: var(--a2-space-4);
  }
  .a2-asset-modal-title {
    margin: 0; font-size: var(--a2-text-base); font-weight: 700;
    color: var(--a2-text-bright);
  }
  .a2-asset-modal-desc {
    margin: 0; font-size: var(--a2-text-xs); color: var(--a2-text-muted);
    line-height: 1.5;
  }
  .a2-asset-modal-field { display: flex; flex-direction: column; gap: 4px; }
  .a2-asset-modal-label {
    font-size: var(--a2-text-2xs); color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
  }
  .a2-asset-modal-input {
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    padding: var(--a2-space-2) var(--a2-space-3);
  }
  .a2-asset-modal-input:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-asset-modal-actions {
    display: flex; gap: var(--a2-space-2); justify-content: flex-end;
    padding-top: var(--a2-space-2);
  }
  .a2-asset-modal-btn {
    padding: var(--a2-space-2) var(--a2-space-4);
    border: 1px solid transparent;
    border-radius: var(--a2-radius-sm);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm); font-weight: 600;
    cursor: pointer;
  }
  .a2-asset-modal-cancel {
    background: var(--a2-surface-3); border-color: var(--a2-border-strong); color: var(--a2-text);
  }
  .a2-asset-modal-confirm {
    background: var(--a2-cyan); color: var(--a2-surface-1); border-color: var(--a2-cyan);
  }
  .a2-asset-modal-confirm:disabled { opacity: 0.5; cursor: not-allowed; }

  .a2-asset-confirm-body {
    display: flex; flex-direction: column; gap: var(--a2-space-2);
    padding: var(--a2-space-3);
    background: var(--a2-surface-3);
    border-radius: var(--a2-radius-sm);
    font-size: var(--a2-text-xs);
  }
  .a2-asset-confirm-row {
    display: flex; justify-content: space-between; gap: var(--a2-space-3);
  }
  .a2-asset-confirm-row span { color: var(--a2-text-dim); }
  .a2-asset-confirm-row strong { color: var(--a2-text); font-weight: 600; }
  .a2-asset-confirm-warning {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: var(--a2-space-1) 0 0;
    color: var(--a2-red); font-size: var(--a2-text-2xs); font-weight: 600;
  }

  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  /* ---- Mobile ---- */
  @media (max-width: 768px) {
    .a2-assets-filters { display: none; }
    .a2-assets-mobile-filter-toggle { display: inline-flex; }
    .a2-asset-drawer { max-width: 100%; }
    .a2-asset-drawer-dl { grid-template-columns: 1fr; }
    .a2-asset-modal-actions { flex-direction: column-reverse; }
    .a2-asset-modal-btn { width: 100%; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-asset-drawer, .a2-asset-drawer-overlay, .a2-assets-filter-sheet,
    .a2-asset-action, .a2-assets-select, .a2-assets-search-input,
    .a2-assets-table tbody tr { animation: none; transition: none; }
  }
</style>
