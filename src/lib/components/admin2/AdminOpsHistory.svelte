<script lang="ts">
  /**
   * Admin 2.0 — Phase F — AdminOpsHistory
   *
   * The Activity / History tab. Shows the immutable audit timeline from
   * media_operations. Every admin action (upload, sync, rename, move,
   * detach, delete, reconcile, etc.) is recorded here.
   *
   * Layout: dense timeline (newest first) with:
   *   - Timestamp
   *   - Action (with icon)
   *   - Status (success/failed/pending)
   *   - Media + provider + asset
   *   - Actor (admin email)
   *   - Error (if failed)
   *
   * Clicking a row opens a detail drawer with full metadata + contextual
   * navigation to the related media/asset.
   */

  import { onMount, onDestroy } from 'svelte';
  import { Search, Filter, X, ChevronLeft, ChevronRight, AlertCircle, Loader2, ExternalLink, Film, Tv, Sparkles, Check, X as XIcon, Clock, Activity, Upload, RefreshCw, Pencil, FolderInput, Unlink, Trash2, FileText, Database } from 'lucide-svelte';
  import AdminStatus from './AdminStatus.svelte';
  import type { HistoryRow, HistoryQuery, HistoryAction } from '$lib/shared/operations-types';

  let items = $state<HistoryRow[]>([]);
  let total = $state(0);
  let page = $state(1);
  let limit = $state(25);
  let hasMore = $state(false);
  let loading = $state(false);
  let listError = $state<string | null>(null);

  let filters = $state<HistoryQuery>({
    q: '',
    action: 'all',
    status: 'all',
    provider: 'all',
    page: 1,
    limit: 25,
  });

  let selectedEvent = $state<HistoryRow | null>(null);
  let drawerOpen = $state(false);
  let mobileFiltersOpen = $state(false);

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  async function loadHistory() {
    loading = true;
    listError = null;
    try {
      const params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.action && filters.action !== 'all') params.set('action', String(filters.action));
      if (filters.status && filters.status !== 'all') params.set('status', String(filters.status));
      if (filters.provider && filters.provider !== 'all') params.set('provider', String(filters.provider));
      params.set('page', String(filters.page ?? 1));
      params.set('limit', String(filters.limit ?? 25));

      const res = await fetch(`/api/admin/operations/history?${params.toString()}`);
      const data = await res.json();
      if (data.ok) {
        items = data.items;
        total = data.total;
        page = data.page;
        limit = data.limit;
        hasMore = data.hasMore;
      } else {
        listError = data.error?.message ?? 'Failed to load history.';
      }
    } catch {
      listError = 'Network error while loading history.';
    }
    loading = false;
  }

  function debouncedSearch() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      filters.page = 1;
      void loadHistory();
    }, 300);
  }

  let lastAction = $state(filters.action);
  let lastStatus = $state(filters.status);
  let lastProvider = $state(filters.provider);

  $effect(() => {
    if (
      filters.action !== lastAction ||
      filters.status !== lastStatus ||
      filters.provider !== lastProvider
    ) {
      lastAction = filters.action;
      lastStatus = filters.status;
      lastProvider = filters.provider;
      filters.page = 1;
      void loadHistory();
    }
  });

  onMount(() => { void loadHistory(); });
  onDestroy(() => { if (searchDebounce) clearTimeout(searchDebounce); });

  function statusTone(status: string): 'green' | 'red' | 'amber' {
    if (status === 'success') return 'green';
    if (status === 'failed') return 'red';
    return 'amber';
  }

  function actionIcon(action: string): typeof Activity {
    switch (action) {
      case 'upload': case 'upload_remote': return Upload;
      case 'sync': return RefreshCw;
      case 'rename': return Pencil;
      case 'move': return FolderInput;
      case 'detach': return Unlink;
      case 'provider_delete': return Trash2;
      case 'subtitle_upload': return FileText;
      case 'ready': return Check;
      case 'failed': return XIcon;
      case 'retry': return RefreshCw;
      case 'create_media_item': case 'update_media_item': case 'delete_media_item': return Database;
      default: return Activity;
    }
  }

  function actionLabel(action: string): string {
    return action.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  function formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = now - d.getTime();
      if (diff < 60_000) return 'just now';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      return d.toLocaleString();
    } catch {
      return '—';
    }
  }

  function openDetail(event: HistoryRow) {
    selectedEvent = event;
    drawerOpen = true;
  }

  function pageNext() {
    if (!hasMore) return;
    filters.page = (filters.page ?? 1) + 1;
    void loadHistory();
  }
  function pagePrev() {
    if ((filters.page ?? 1) <= 1) return;
    filters.page = (filters.page ?? 1) - 1;
    void loadHistory();
  }
  function clearFilters() {
    filters = { q: '', action: 'all', status: 'all', provider: 'all', page: 1, limit: 25 };
    void loadHistory();
  }

  const activeFilterCount = $derived(
    (filters.action && filters.action !== 'all' ? 1 : 0) +
    (filters.status && filters.status !== 'all' ? 1 : 0) +
    (filters.provider && filters.provider !== 'all' ? 1 : 0)
  );

  const ACTION_OPTIONS: Array<{ value: string; label: string }> = [
    { value: 'all', label: 'All actions' },
    { value: 'upload', label: 'Upload' },
    { value: 'upload_remote', label: 'Remote upload' },
    { value: 'sync', label: 'Sync / Reconcile' },
    { value: 'rename', label: 'Rename' },
    { value: 'move', label: 'Move' },
    { value: 'detach', label: 'Detach' },
    { value: 'provider_delete', label: 'Provider delete' },
    { value: 'subtitle_upload', label: 'Subtitle upload' },
    { value: 'ready', label: 'Ready' },
    { value: 'failed', label: 'Failed' },
    { value: 'retry', label: 'Retry' },
    { value: 'resolve_availability', label: 'Resolve availability' },
  ];
</script>

<section class="a2-ops-history" aria-label="Activity / History">
  <div class="a2-history-filters">
    <div class="a2-history-search">
      <Search size={14} style="position: absolute; left: var(--a2-space-3); color: var(--a2-text-dim); pointer-events: none;" />
      <input
        type="text"
        bind:value={filters.q}
        oninput={debouncedSearch}
        placeholder="Search operation ID, media title, error code…"
        class="a2-history-search-input"
        aria-label="Search history"
        autocomplete="off"
      />
    </div>
    <div class="a2-history-filter-row">
      <label class="a2-history-filter">
        <span class="a2-history-filter-label">Action</span>
        <select bind:value={filters.action} class="a2-history-select">
          {#each ACTION_OPTIONS as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
      <label class="a2-history-filter">
        <span class="a2-history-filter-label">Status</span>
        <select bind:value={filters.status} class="a2-history-select">
          <option value="all">All</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>
      </label>
      <label class="a2-history-filter">
        <span class="a2-history-filter-label">Provider</span>
        <select bind:value={filters.provider} class="a2-history-select">
          <option value="all">All</option>
          <option value="vidara">Vidara</option>
          <option value="abyss">Abyss</option>
        </select>
      </label>
      {#if activeFilterCount > 0}
        <button type="button" class="a2-history-clear" onclick={clearFilters}>
          <X size={11} /> Clear ({activeFilterCount})
        </button>
      {/if}
    </div>
  </div>

  <button type="button" class="a2-history-mobile-filter-toggle" onclick={() => { mobileFiltersOpen = true; }}>
    <Filter size={13} /> Filters{#if activeFilterCount > 0} ({activeFilterCount}){/if}
  </button>

  {#if loading && items.length === 0}
    <div class="a2-history-loading" role="status">
      <Loader2 size={20} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" />
      <p>Loading activity…</p>
    </div>
  {:else if listError}
    <div class="a2-history-error" role="alert">
      <AlertCircle size={20} />
      <div>
        <p class="a2-history-error-title">Unable to load operations</p>
        <p class="a2-history-error-desc">{listError}</p>
        <button type="button" class="a2-history-retry" onclick={loadHistory}>Retry</button>
      </div>
    </div>
  {:else if items.length === 0}
    <div class="a2-history-empty">
      <Clock size={32} />
      <h3>No activity yet</h3>
      <p>{filters.q || activeFilterCount > 0 ? 'Try adjusting your search or filters.' : 'Operations will appear here as admins upload, sync, and manage media.'}</p>
    </div>
  {:else}
    <ol class="a2-history-timeline" role="list">
      {#each items as event (event.id)}
        {@const Icon = actionIcon(event.action)}
        <li class="a2-history-row" onclick={() => openDetail(event)}>
          <div class="a2-history-row-time">
            <span class="a2-history-row-time-main mono">{formatDate(event.occurredAt)}</span>
          </div>
          <div class="a2-history-row-icon" data-status={event.status}>
            <Icon size={13} />
          </div>
          <div class="a2-history-row-body">
            <div class="a2-history-row-head">
              <span class="a2-history-row-action">{actionLabel(event.action)}</span>
              <AdminStatus label={event.status} tone={statusTone(event.status)} />
            </div>
            <div class="a2-history-row-meta">
              {#if event.mediaItem}
                <span class="a2-history-row-media">
                  {#if event.mediaItem.contentType === 'movie'}<Film size={10} />{:else if event.mediaItem.contentType === 'anime'}<Sparkles size={10} />{:else}<Tv size={10} />{/if}
                  {event.mediaItem.title}
                  {#if event.mediaItem.season != null && event.mediaItem.episode != null}
                    · S{String(event.mediaItem.season).padStart(2, '0')}E{String(event.mediaItem.episode).padStart(2, '0')}
                  {/if}
                </span>
              {/if}
              {#if event.providerAdapterId}
                <span class="a2-history-row-provider" data-adapter={event.providerAdapterId}>{event.providerAdapterId}</span>
              {/if}
              {#if event.adminUserEmail}
                <span class="a2-history-row-actor">{event.adminUserEmail}</span>
              {/if}
            </div>
            {#if event.errorMessage}
              <p class="a2-history-row-error">{event.errorMessage}</p>
            {/if}
          </div>
        </li>
      {/each}
    </ol>

    <footer class="a2-history-pagination">
      <span class="a2-history-pagination-info">
        {#if total > 0}
          Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
        {:else}
          0 results
        {/if}
      </span>
      <div class="a2-history-pagination-actions">
        <button type="button" class="a2-history-page-btn" onclick={pagePrev} disabled={page <= 1}>
          <ChevronLeft size={12} /> Prev
        </button>
        <span class="a2-history-page-num">Page {page}</span>
        <button type="button" class="a2-history-page-btn" onclick={pageNext} disabled={!hasMore}>
          Next <ChevronRight size={12} />
        </button>
      </div>
    </footer>
  {/if}

  <!-- Mobile filter sheet -->
  {#if mobileFiltersOpen}
    <div class="a2-history-filter-sheet-overlay" onclick={() => { mobileFiltersOpen = false; }} role="presentation">
      <div class="a2-history-filter-sheet" role="dialog" aria-modal="true" aria-labelledby="a2-history-filter-sheet-title" onclick={(e) => e.stopPropagation()}>
        <header class="a2-history-filter-sheet-head">
          <h2 id="a2-history-filter-sheet-title">Filters</h2>
          <button type="button" class="a2-history-filter-sheet-close" onclick={() => { mobileFiltersOpen = false; }} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div class="a2-history-filter-sheet-body">
          <label class="a2-history-filter a2-history-filter-full">
            <span class="a2-history-filter-label">Action</span>
            <select bind:value={filters.action} class="a2-history-select">
              {#each ACTION_OPTIONS as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </label>
          <label class="a2-history-filter a2-history-filter-full">
            <span class="a2-history-filter-label">Status</span>
            <select bind:value={filters.status} class="a2-history-select">
              <option value="all">All</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
              <option value="pending">Pending</option>
            </select>
          </label>
          <label class="a2-history-filter a2-history-filter-full">
            <span class="a2-history-filter-label">Provider</span>
            <select bind:value={filters.provider} class="a2-history-select">
              <option value="all">All</option>
              <option value="vidara">Vidara</option>
              <option value="abyss">Abyss</option>
            </select>
          </label>
        </div>
        <footer class="a2-history-filter-sheet-actions">
          <button type="button" class="a2-history-clear" onclick={clearFilters}>Clear all</button>
          <button type="button" class="a2-history-apply" onclick={() => { mobileFiltersOpen = false; }}>Apply</button>
        </footer>
      </div>
    </div>
  {/if}

  <!-- Detail drawer -->
  {#if drawerOpen && selectedEvent}
    <div class="a2-event-drawer-overlay" onclick={() => { drawerOpen = false; }} role="presentation">
      <aside
        class="a2-event-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="a2-event-drawer-title"
        onclick={(e) => e.stopPropagation()}
      >
        <header class="a2-event-drawer-head">
          <div class="a2-event-drawer-head-left">
            <h2 id="a2-event-drawer-title" class="a2-event-drawer-title">
              {actionLabel(selectedEvent.action)}
            </h2>
            <span class="a2-event-drawer-subtitle mono">{selectedEvent.id.slice(0, 8)} · {formatDate(selectedEvent.occurredAt)}</span>
          </div>
          <button type="button" class="a2-event-drawer-close" onclick={() => { drawerOpen = false; }} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div class="a2-event-drawer-body">
          <section class="a2-event-drawer-section">
            <h3 class="a2-event-drawer-section-title">Event</h3>
            <dl class="a2-event-drawer-dl">
              <div><dt>Action</dt><dd>{actionLabel(selectedEvent.action)}</dd></div>
              <div><dt>Status</dt><dd><AdminStatus label={selectedEvent.status} tone={statusTone(selectedEvent.status)} /></dd></div>
              <div><dt>Occurred</dt><dd>{formatDate(selectedEvent.occurredAt)}</dd></div>
              {#if selectedEvent.adminUserEmail}
                <div><dt>Actor</dt><dd>{selectedEvent.adminUserEmail}</dd></div>
              {/if}
              {#if selectedEvent.providerAdapterId}
                <div><dt>Provider</dt><dd>{selectedEvent.providerAdapterId}</dd></div>
              {/if}
              <div class="a2-event-drawer-full"><dt>Event ID</dt><dd class="mono">{selectedEvent.id}</dd></div>
            </dl>
          </section>

          {#if selectedEvent.mediaItem}
            <section class="a2-event-drawer-section">
              <h3 class="a2-event-drawer-section-title">Related media</h3>
              <dl class="a2-event-drawer-dl">
                <div><dt>Title</dt><dd>{selectedEvent.mediaItem.title}</dd></div>
                <div><dt>Type</dt><dd>{selectedEvent.mediaItem.contentType}</dd></div>
                <div><dt>TMDB</dt><dd class="mono">{selectedEvent.mediaItem.tmdbId}</dd></div>
                {#if selectedEvent.mediaItem.season != null && selectedEvent.mediaItem.episode != null}
                  <div><dt>Episode</dt><dd>S{String(selectedEvent.mediaItem.season).padStart(2, '0')}E{String(selectedEvent.mediaItem.episode).padStart(2, '0')}</dd></div>
                {/if}
              </dl>
              <a class="a2-event-drawer-open-link" href={`/admin/media/library?selected=${selectedEvent.mediaItem.id}`}>
                <ExternalLink size={12} /> Open in Media Library
              </a>
            </section>
          {/if}

          {#if selectedEvent.mediaAsset}
            <section class="a2-event-drawer-section">
              <h3 class="a2-event-drawer-section-title">Related asset</h3>
              <dl class="a2-event-drawer-dl">
                <div><dt>Asset ID</dt><dd class="mono">{selectedEvent.mediaAsset.id.slice(0, 8)}</dd></div>
                {#if selectedEvent.mediaAsset.providerAssetId}
                  <div><dt>Provider asset</dt><dd class="mono">{selectedEvent.mediaAsset.providerAssetId}</dd></div>
                {/if}
                <div><dt>Asset status</dt><dd>{selectedEvent.mediaAsset.status}</dd></div>
              </dl>
            </section>
          {/if}

          {#if selectedEvent.errorCode || selectedEvent.errorMessage}
            <section class="a2-event-drawer-section">
              <h3 class="a2-event-drawer-section-title">Error</h3>
              <dl class="a2-event-drawer-dl">
                {#if selectedEvent.errorCode}
                  <div><dt>Error code</dt><dd class="mono a2-event-error-code">{selectedEvent.errorCode}</dd></div>
                {/if}
                <div class="a2-event-drawer-full"><dt>Message</dt><dd>{selectedEvent.errorMessage ?? '—'}</dd></div>
              </dl>
            </section>
          {/if}

          {#if Object.keys(selectedEvent.details).length > 0}
            <section class="a2-event-drawer-section">
              <h3 class="a2-event-drawer-section-title">Metadata</h3>
              <pre class="a2-event-details">{JSON.stringify(selectedEvent.details, null, 2)}</pre>
            </section>
          {/if}

          {#if selectedEvent.uploadOperationId}
            <section class="a2-event-drawer-section">
              <h3 class="a2-event-drawer-section-title">Related job</h3>
              <p class="a2-event-related-job">This event is linked to upload operation <code class="mono">{selectedEvent.uploadOperationId.slice(0, 8)}</code>.</p>
            </section>
          {/if}
        </div>
      </aside>
    </div>
  {/if}
</section>

<style>
  .a2-ops-history { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  .a2-history-filters { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-history-search { position: relative; display: flex; align-items: center; }
  .a2-history-search-input { width: 100%; padding: var(--a2-space-2) var(--a2-space-3) var(--a2-space-2) var(--a2-space-8); background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-family: var(--a2-font-sans); font-size: var(--a2-text-sm); }
  .a2-history-search-input:focus { outline: none; border-color: var(--a2-cyan); box-shadow: 0 0 0 3px var(--a2-cyan-soft); }

  .a2-history-filter-row { display: flex; gap: var(--a2-space-2); align-items: flex-end; flex-wrap: wrap; }
  .a2-history-filter { display: flex; flex-direction: column; gap: 2px; }
  .a2-history-filter-full { width: 100%; }
  .a2-history-filter-label { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-history-select { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-family: var(--a2-font-sans); font-size: var(--a2-text-xs); padding: 4px 8px; cursor: pointer; }
  .a2-history-select:focus { outline: none; border-color: var(--a2-cyan); }

  .a2-history-clear { display: inline-flex; align-items: center; gap: 2px; padding: 4px 8px; background: transparent; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-history-clear:hover { color: var(--a2-red); border-color: var(--a2-red-border); }

  .a2-history-mobile-filter-toggle { display: none; align-items: center; gap: var(--a2-space-1); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; }

  .a2-history-loading { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); color: var(--a2-text-muted); font-size: var(--a2-text-sm); }
  .a2-history-error { display: flex; gap: var(--a2-space-3); align-items: flex-start; padding: var(--a2-space-4); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-md); color: var(--a2-red); }
  .a2-history-error-title { margin: 0 0 4px; font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-red); }
  .a2-history-error-desc { margin: 0 0 8px; font-size: var(--a2-text-xs); color: var(--a2-text-muted); }
  .a2-history-retry { padding: 4px 12px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-history-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-history-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-history-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }

  .a2-history-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
  .a2-history-row { display: grid; grid-template-columns: 140px 32px 1fr; gap: var(--a2-space-3); padding: var(--a2-space-3); border-bottom: 1px solid var(--a2-border); cursor: pointer; transition: background var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-history-row:hover { background: var(--a2-surface-3); }
  .a2-history-row:last-child { border-bottom: none; }

  .a2-history-row-time { display: flex; align-items: center; }
  .a2-history-row-time-main { color: var(--a2-text-dim); font-size: var(--a2-text-2xs); }

  .a2-history-row-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); flex-shrink: 0; }
  .a2-history-row-icon[data-status="success"] { background: var(--a2-green-soft); color: var(--a2-green); }
  .a2-history-row-icon[data-status="failed"] { background: var(--a2-red-soft); color: var(--a2-red); }
  .a2-history-row-icon[data-status="pending"] { background: var(--a2-amber-soft); color: var(--a2-amber); }

  .a2-history-row-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .a2-history-row-head { display: flex; align-items: center; gap: var(--a2-space-2); }
  .a2-history-row-action { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-history-row-meta { display: flex; align-items: center; gap: var(--a2-space-3); flex-wrap: wrap; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-history-row-media { display: inline-flex; align-items: center; gap: 3px; }
  .a2-history-row-provider { padding: 1px 4px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-family: var(--a2-font-mono); text-transform: uppercase; color: var(--a2-cyan); }
  .a2-history-row-provider[data-adapter="abyss"] { color: var(--a2-amber); }
  .a2-history-row-actor { color: var(--a2-text-dim); }
  .a2-history-row-error { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-red); }

  .a2-history-pagination { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); flex-wrap: wrap; padding: var(--a2-space-2) var(--a2-space-3); }
  .a2-history-pagination-info { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); font-family: var(--a2-font-mono); }
  .a2-history-pagination-actions { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-history-page-btn { display: inline-flex; align-items: center; gap: 2px; padding: 4px 10px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-history-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .a2-history-page-btn:hover:not(:disabled) { border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-history-page-num { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); font-family: var(--a2-font-mono); }

  .a2-history-filter-sheet-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.55); display: flex; align-items: flex-end; }
  .a2-history-filter-sheet { width: 100%; background: var(--a2-surface-1); border-top-left-radius: var(--a2-radius-lg); border-top-right-radius: var(--a2-radius-lg); border-top: 1px solid var(--a2-border-strong); display: flex; flex-direction: column; max-height: 80vh; animation: a2-sheet-up var(--a2-motion-normal, 240ms) var(--a2-ease-out); }
  @keyframes a2-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
  .a2-history-filter-sheet-head { display: flex; justify-content: space-between; align-items: center; padding: var(--a2-space-4); border-bottom: 1px solid var(--a2-border); }
  .a2-history-filter-sheet-head h2 { margin: 0; font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-history-filter-sheet-close { background: transparent; border: none; cursor: pointer; color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs); }
  .a2-history-filter-sheet-body { padding: var(--a2-space-4); display: flex; flex-direction: column; gap: var(--a2-space-3); overflow-y: auto; }
  .a2-history-filter-sheet-actions { display: flex; gap: var(--a2-space-2); padding: var(--a2-space-3) var(--a2-space-4); border-top: 1px solid var(--a2-border); }
  .a2-history-apply { flex: 1; padding: var(--a2-space-2); background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; }

  .a2-event-drawer-overlay { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(2px); display: flex; justify-content: flex-end; animation: a2-fade-in var(--a2-motion-normal, 240ms) var(--a2-ease-out); }
  @keyframes a2-fade-in { from { opacity: 0; } to { opacity: 1; } }
  .a2-event-drawer { width: 100%; max-width: 480px; background: var(--a2-surface-1); border-left: 1px solid var(--a2-border-strong); display: flex; flex-direction: column; overflow-y: auto; animation: a2-slide-in var(--a2-motion-normal, 240ms) var(--a2-ease-out); }
  @keyframes a2-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

  .a2-event-drawer-head { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-4); border-bottom: 1px solid var(--a2-border); position: sticky; top: 0; background: var(--a2-surface-1); z-index: 1; }
  .a2-event-drawer-head-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .a2-event-drawer-title { margin: 0; font-family: var(--a2-font-sans); font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-event-drawer-subtitle { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
  .a2-event-drawer-close { background: transparent; border: none; cursor: pointer; color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs); }
  .a2-event-drawer-close:hover { background: var(--a2-surface-3); color: var(--a2-text); }

  .a2-event-drawer-body { padding: var(--a2-space-4); display: flex; flex-direction: column; gap: var(--a2-space-5); }
  .a2-event-drawer-section { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-event-drawer-section-title { margin: 0; font-family: var(--a2-font-sans); font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-cyan); text-transform: uppercase; letter-spacing: 0.1em; }
  .a2-event-drawer-dl { display: grid; grid-template-columns: 1fr 1fr; gap: var(--a2-space-2) var(--a2-space-4); margin: 0; }
  .a2-event-drawer-dl > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .a2-event-drawer-dl > div.a2-event-drawer-full { grid-column: 1 / -1; }
  .a2-event-drawer-dl dt { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-event-drawer-dl dd { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text); word-break: break-all; }

  .a2-event-drawer-open-link { display: inline-flex; align-items: center; gap: var(--a2-space-1); padding: var(--a2-space-1) var(--a2-space-2); background: var(--a2-cyan-soft); border: 1px solid var(--a2-cyan-border); border-radius: var(--a2-radius-xs); color: var(--a2-cyan); font-size: var(--a2-text-2xs); font-weight: 600; text-decoration: none; align-self: flex-start; }

  .a2-event-error-code { color: var(--a2-red); font-weight: 700; }
  .a2-event-details { margin: 0; padding: var(--a2-space-3); background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); overflow-x: auto; max-height: 240px; }
  .a2-event-related-job { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-event-related-job code { color: var(--a2-text); }

  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  @media (max-width: 768px) {
    .a2-history-filters { display: none; }
    .a2-history-mobile-filter-toggle { display: inline-flex; }
    .a2-history-row { grid-template-columns: 28px 1fr; gap: var(--a2-space-2); }
    .a2-history-row-time { display: none; }
    .a2-event-drawer { max-width: 100%; }
    .a2-event-drawer-dl { grid-template-columns: 1fr; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-event-drawer, .a2-event-drawer-overlay, .a2-history-filter-sheet,
    .a2-history-row { animation: none; transition: none; }
  }
</style>
