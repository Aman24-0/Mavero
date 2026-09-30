<script lang="ts">
  /**
   * Admin 2.0 — Phase F — AdminOpsJobs
   *
   * The Jobs tab. Shows active + recent upload operations from
   * media_upload_operations with:
   *   - Status (queued/uploading/uploaded/processing/ready/failed/cancelled)
   *   - Operation type (upload/upload_remote/retry)
   *   - Media + provider + asset
   *   - Timing (queued/started/updated/duration)
   *   - Error code + message (for failed)
   *   - Stale badge (for ops stuck > 60 min)
   *   - Retryable badge (for retryable errors)
   *
   * Active jobs (queued/uploading/uploaded/processing) are prioritized
   * via the 'active' status filter.
   *
   * Clicking a row opens a detail drawer with the full timeline + actions:
   *   - Retry (if failed + retryable)
   *   - Cancel (if active)
   *   - Reconcile (if has media_asset_id)
   *   - Open media / asset
   */

  import { onMount, onDestroy } from 'svelte';
  import { Search, Filter, X, ChevronLeft, ChevronRight, RefreshCw, AlertCircle, Loader2, Clock, ExternalLink, Film, Tv, Sparkles, Activity, Check, Ban, RotateCcw } from 'lucide-svelte';
  import AdminStatus from './AdminStatus.svelte';
  import type { JobRow, JobQuery } from '$lib/shared/operations-types';

  let {
    badgeCounts = { jobsActive: 0, attentionTotal: 0 },
  }: {
    badgeCounts?: { jobsActive: number; attentionTotal: number };
  } = $props();

  let items = $state<JobRow[]>([]);
  let total = $state(0);
  let page = $state(1);
  let limit = $state(25);
  let hasMore = $state(false);
  let loading = $state(false);
  let listError = $state<string | null>(null);

  let filters = $state<JobQuery>({
    q: '',
    status: 'all',
    operationType: 'all',
    provider: 'all',
    retryable: null,
    stale: null,
    sort: 'recently_updated',
    page: 1,
    limit: 25,
  });

  let selectedJob = $state<JobRow | null>(null);
  let drawerOpen = $state(false);
  let mobileFiltersOpen = $state(false);
  let actionInProgress = $state(false);
  let actionError = $state<string | null>(null);
  let actionSuccess = $state<string | null>(null);

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  async function loadJobs() {
    loading = true;
    listError = null;
    try {
      const params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.status && filters.status !== 'all') params.set('status', String(filters.status));
      if (filters.operationType && filters.operationType !== 'all') params.set('operationType', String(filters.operationType));
      if (filters.provider && filters.provider !== 'all') params.set('provider', String(filters.provider));
      if (filters.retryable === true) params.set('retryable', 'true');
      else if (filters.retryable === false) params.set('retryable', 'false');
      if (filters.stale === true) params.set('stale', 'true');
      else if (filters.stale === false) params.set('stale', 'false');
      params.set('sort', String(filters.sort ?? 'recently_updated'));
      params.set('page', String(filters.page ?? 1));
      params.set('limit', String(filters.limit ?? 25));

      const res = await fetch(`/api/admin/operations/jobs?${params.toString()}`);
      const data = await res.json();
      if (data.ok) {
        items = data.items;
        total = data.total;
        page = data.page;
        limit = data.limit;
        hasMore = data.hasMore;
      } else {
        listError = data.error?.message ?? 'Failed to load jobs.';
      }
    } catch {
      listError = 'Network error while loading jobs.';
    }
    loading = false;
  }

  function debouncedSearch() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      filters.page = 1;
      void loadJobs();
    }, 300);
  }

  let lastStatus = $state(filters.status);
  let lastOpType = $state(filters.operationType);
  let lastProvider = $state(filters.provider);
  let lastRetryable = $state(filters.retryable);
  let lastStale = $state(filters.stale);
  let lastSort = $state(filters.sort);

  $effect(() => {
    if (
      filters.status !== lastStatus ||
      filters.operationType !== lastOpType ||
      filters.provider !== lastProvider ||
      filters.retryable !== lastRetryable ||
      filters.stale !== lastStale ||
      filters.sort !== lastSort
    ) {
      lastStatus = filters.status;
      lastOpType = filters.operationType;
      lastProvider = filters.provider;
      lastRetryable = filters.retryable;
      lastStale = filters.stale;
      lastSort = filters.sort;
      filters.page = 1;
      void loadJobs();
    }
  });

  onMount(() => {
    void loadJobs();
  });

  onDestroy(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
  });

  function statusTone(status: string, isStale: boolean = false): 'green' | 'amber' | 'red' | 'cyan' | 'neutral' {
    if (isStale) return 'amber';
    switch (status) {
      case 'ready': return 'green';
      case 'processing': case 'uploading': case 'uploaded': case 'queued': return 'amber';
      case 'failed': return 'red';
      case 'cancelled': return 'neutral';
      default: return 'neutral';
    }
  }
  function statusLabel(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function formatDuration(startedAt: string | null, endedAt: string | null): string {
    if (!startedAt) return '—';
    const start = new Date(startedAt).getTime();
    const end = endedAt ? new Date(endedAt).getTime() : Date.now();
    const diff = Math.max(0, end - start);
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ${Math.floor((diff % 60_000) / 1000)}s`;
    return `${Math.floor(diff / 3_600_000)}h ${Math.floor((diff % 3_600_000) / 60_000)}m`;
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
      return d.toLocaleDateString();
    } catch {
      return '—';
    }
  }

  function openDetail(job: JobRow) {
    selectedJob = job;
    drawerOpen = true;
    actionError = null;
    actionSuccess = null;
  }

  function pageNext() {
    if (!hasMore) return;
    filters.page = (filters.page ?? 1) + 1;
    void loadJobs();
  }
  function pagePrev() {
    if ((filters.page ?? 1) <= 1) return;
    filters.page = (filters.page ?? 1) - 1;
    void loadJobs();
  }
  function clearFilters() {
    filters = { q: '', status: 'all', operationType: 'all', provider: 'all', retryable: null, stale: null, sort: 'recently_updated', page: 1, limit: 25 };
    void loadJobs();
  }

  const activeFilterCount = $derived(
    (filters.status && filters.status !== 'all' ? 1 : 0) +
    (filters.operationType && filters.operationType !== 'all' ? 1 : 0) +
    (filters.provider && filters.provider !== 'all' ? 1 : 0) +
    (filters.retryable !== null ? 1 : 0) +
    (filters.stale !== null ? 1 : 0)
  );

  async function retryJob(job: JobRow) {
    actionInProgress = true;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/upload/${job.id}/retry`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        actionSuccess = 'Retry operation created. The new job is queued.';
        await loadJobs();
      } else {
        actionError = data.error?.message ?? 'Retry failed.';
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Network error during retry.';
    }
    actionInProgress = false;
  }

  async function cancelJob(job: JobRow) {
    actionInProgress = true;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/upload/${job.id}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        actionSuccess = 'Job cancelled.';
        await loadJobs();
      } else {
        actionError = data.error?.message ?? 'Cancel failed.';
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Network error during cancel.';
    }
    actionInProgress = false;
  }

  async function reconcileJob(job: JobRow) {
    if (!job.mediaAssetId) return;
    actionInProgress = true;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${job.mediaAssetId}/reconcile`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        actionSuccess = `Reconciled. Status: ${data.status ?? 'unknown'}.`;
        await loadJobs();
      } else {
        actionError = data.error?.message ?? 'Reconcile failed.';
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Network error during reconcile.';
    }
    actionInProgress = false;
  }

  function isActive(status: string): boolean {
    return ['queued', 'uploading', 'uploaded', 'processing'].includes(status);
  }
</script>

<section class="a2-ops-jobs" aria-label="Jobs">
  <!-- Filter bar -->
  <div class="a2-jobs-filters">
    <div class="a2-jobs-search">
      <Search size={14} style="position: absolute; left: var(--a2-space-3); color: var(--a2-text-dim); pointer-events: none;" />
      <input
        type="text"
        bind:value={filters.q}
        oninput={debouncedSearch}
        placeholder="Search operation ID, media title, provider asset ID…"
        class="a2-jobs-search-input"
        aria-label="Search jobs"
        autocomplete="off"
      />
    </div>
    <div class="a2-jobs-filter-row">
      <label class="a2-jobs-filter">
        <span class="a2-jobs-filter-label">Status</span>
        <select bind:value={filters.status} class="a2-jobs-select">
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="stale">Stale</option>
          <option value="queued">Queued</option>
          <option value="uploading">Uploading</option>
          <option value="processing">Processing</option>
          <option value="ready">Ready</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </label>
      <label class="a2-jobs-filter">
        <span class="a2-jobs-filter-label">Type</span>
        <select bind:value={filters.operationType} class="a2-jobs-select">
          <option value="all">All</option>
          <option value="upload">Upload</option>
          <option value="upload_remote">Remote upload</option>
          <option value="retry">Retry</option>
        </select>
      </label>
      <label class="a2-jobs-filter">
        <span class="a2-jobs-filter-label">Provider</span>
        <select bind:value={filters.provider} class="a2-jobs-select">
          <option value="all">All</option>
          <option value="vidara">Vidara</option>
          <option value="abyss">Abyss</option>
        </select>
      </label>
      <label class="a2-jobs-filter">
        <span class="a2-jobs-filter-label">Sort</span>
        <select bind:value={filters.sort} class="a2-jobs-select">
          <option value="recently_updated">Recently updated</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="failed">Failed first</option>
          <option value="stale">Stale first</option>
        </select>
      </label>
      {#if activeFilterCount > 0}
        <button type="button" class="a2-jobs-clear" onclick={clearFilters}>
          <X size={11} /> Clear ({activeFilterCount})
        </button>
      {/if}
    </div>
  </div>

  <button type="button" class="a2-jobs-mobile-filter-toggle" onclick={() => { mobileFiltersOpen = true; }}>
    <Filter size={13} /> Filters{#if activeFilterCount > 0} ({activeFilterCount}){/if}
  </button>

  {#if loading && items.length === 0}
    <div class="a2-jobs-loading" role="status">
      <Loader2 size={20} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" />
      <p>Loading jobs…</p>
    </div>
  {:else if listError}
    <div class="a2-jobs-error" role="alert">
      <AlertCircle size={20} />
      <div>
        <p class="a2-jobs-error-title">Unable to load operations</p>
        <p class="a2-jobs-error-desc">{listError}</p>
        <button type="button" class="a2-jobs-retry" onclick={loadJobs}>Retry</button>
      </div>
    </div>
  {:else if items.length === 0}
    <div class="a2-jobs-empty">
      <Activity size={32} />
      <h3>No active jobs</h3>
      <p>{filters.q || activeFilterCount > 0 ? 'Try adjusting your search or filters.' : 'All operations have completed. New uploads will appear here.'}</p>
    </div>
  {:else}
    <div class="a2-jobs-table-wrap" role="region" aria-label="Jobs table">
      <table class="a2-jobs-table">
        <thead>
          <tr>
            <th class="col-status">Status</th>
            <th class="col-type">Type</th>
            <th class="col-media">Media</th>
            <th class="col-provider">Provider</th>
            <th class="col-updated">Updated</th>
            <th class="col-duration">Duration</th>
            <th class="col-actions"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each items as job (job.id)}
            <tr onclick={() => openDetail(job)} class="a2-jobs-row" class:is-stale={job.isStale}>
              <td class="col-status">
                <div class="a2-jobs-status-cell">
                  <AdminStatus label={statusLabel(job.status)} tone={statusTone(job.status, job.isStale)} />
                  {#if job.isStale}<span class="a2-jobs-stale-badge">STALE</span>{/if}
                  {#if job.isRetryable}<span class="a2-jobs-retryable-badge">RETRYABLE</span>{/if}
                </div>
              </td>
              <td class="col-type">
                <span class="a2-jobs-type-badge" data-type={job.operationType}>{job.operationType}</span>
                {#if job.attemptNumber > 1}<span class="a2-jobs-attempt">×{job.attemptNumber}</span>{/if}
              </td>
              <td class="col-media">
                {#if job.mediaItem}
                  <div class="a2-jobs-media-cell">
                    <div class="a2-jobs-media-title" title={job.mediaItem.title}>{job.mediaItem.title}</div>
                    <div class="a2-jobs-media-meta">
                      {#if job.mediaItem.contentType === 'movie'}<Film size={10} />{:else if job.mediaItem.contentType === 'anime'}<Sparkles size={10} />{:else}<Tv size={10} />{/if}
                      {job.mediaItem.contentType}
                      {#if job.mediaItem.season != null && job.mediaItem.episode != null}
                        · S{String(job.mediaItem.season).padStart(2, '0')}E{String(job.mediaItem.episode).padStart(2, '0')}
                      {/if}
                    </div>
                  </div>
                {:else}
                  <span class="a2-jobs-dash">—</span>
                {/if}
              </td>
              <td class="col-provider">
                <span class="a2-jobs-provider-badge" data-adapter={job.providerAdapterId ?? ''}>
                  {job.providerAdapterId ?? '—'}
                </span>
              </td>
              <td class="col-updated mono">{formatDate(job.updatedAt)}</td>
              <td class="col-duration mono">{formatDuration(job.uploadStartedAt ?? job.queuedAt, job.readyAt ?? job.failedAt ?? job.cancelledAt)}</td>
              <td class="col-actions" onclick={(e) => e.stopPropagation()}>
                <button type="button" class="a2-jobs-row-action" onclick={() => openDetail(job)} aria-label="View details">
                  <ExternalLink size={12} />
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <footer class="a2-jobs-pagination">
      <span class="a2-jobs-pagination-info">
        {#if total > 0}
          Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
        {:else}
          0 results
        {/if}
      </span>
      <div class="a2-jobs-pagination-actions">
        <button type="button" class="a2-jobs-page-btn" onclick={pagePrev} disabled={page <= 1}>
          <ChevronLeft size={12} /> Prev
        </button>
        <span class="a2-jobs-page-num">Page {page}</span>
        <button type="button" class="a2-jobs-page-btn" onclick={pageNext} disabled={!hasMore}>
          Next <ChevronRight size={12} />
        </button>
      </div>
    </footer>
  {/if}

  <!-- Mobile filter sheet -->
  {#if mobileFiltersOpen}
    <div class="a2-jobs-filter-sheet-overlay" onclick={() => { mobileFiltersOpen = false; }} role="presentation">
      <div class="a2-jobs-filter-sheet" role="dialog" aria-modal="true" aria-labelledby="a2-jobs-filter-sheet-title" onclick={(e) => e.stopPropagation()}>
        <header class="a2-jobs-filter-sheet-head">
          <h2 id="a2-jobs-filter-sheet-title">Filters</h2>
          <button type="button" class="a2-jobs-filter-sheet-close" onclick={() => { mobileFiltersOpen = false; }} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div class="a2-jobs-filter-sheet-body">
          <label class="a2-jobs-filter a2-jobs-filter-full">
            <span class="a2-jobs-filter-label">Status</span>
            <select bind:value={filters.status} class="a2-jobs-select">
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="stale">Stale</option>
              <option value="queued">Queued</option>
              <option value="uploading">Uploading</option>
              <option value="processing">Processing</option>
              <option value="ready">Ready</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label class="a2-jobs-filter a2-jobs-filter-full">
            <span class="a2-jobs-filter-label">Type</span>
            <select bind:value={filters.operationType} class="a2-jobs-select">
              <option value="all">All</option>
              <option value="upload">Upload</option>
              <option value="upload_remote">Remote upload</option>
              <option value="retry">Retry</option>
            </select>
          </label>
          <label class="a2-jobs-filter a2-jobs-filter-full">
            <span class="a2-jobs-filter-label">Provider</span>
            <select bind:value={filters.provider} class="a2-jobs-select">
              <option value="all">All</option>
              <option value="vidara">Vidara</option>
              <option value="abyss">Abyss</option>
            </select>
          </label>
          <label class="a2-jobs-filter a2-jobs-filter-full">
            <span class="a2-jobs-filter-label">Sort</span>
            <select bind:value={filters.sort} class="a2-jobs-select">
              <option value="recently_updated">Recently updated</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="failed">Failed first</option>
              <option value="stale">Stale first</option>
            </select>
          </label>
        </div>
        <footer class="a2-jobs-filter-sheet-actions">
          <button type="button" class="a2-jobs-clear" onclick={clearFilters}>Clear all</button>
          <button type="button" class="a2-jobs-apply" onclick={() => { mobileFiltersOpen = false; }}>Apply</button>
        </footer>
      </div>
    </div>
  {/if}

  <!-- Detail drawer -->
  {#if drawerOpen && selectedJob}
    <div class="a2-job-drawer-overlay" onclick={() => { drawerOpen = false; }} role="presentation">
      <aside
        class="a2-job-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="a2-job-drawer-title"
        onclick={(e) => e.stopPropagation()}
      >
        <header class="a2-job-drawer-head">
          <div class="a2-job-drawer-head-left">
            <h2 id="a2-job-drawer-title" class="a2-job-drawer-title">
              {selectedJob.operationType === 'upload_remote' ? 'Remote upload' : selectedJob.operationType === 'retry' ? 'Retry upload' : 'Upload'}
            </h2>
            <span class="a2-job-drawer-subtitle mono">{selectedJob.id.slice(0, 8)}{#if selectedJob.attemptNumber > 1} · attempt {selectedJob.attemptNumber}{/if}</span>
          </div>
          <button type="button" class="a2-job-drawer-close" onclick={() => { drawerOpen = false; }} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div class="a2-job-drawer-body">
          {#if actionSuccess}
            <p class="a2-job-action-success" role="status"><Check size={12} /> {actionSuccess}</p>
          {/if}
          {#if actionError}
            <p class="a2-job-action-error" role="alert"><AlertCircle size={12} /> {actionError}</p>
          {/if}

          <section class="a2-job-drawer-section">
            <h3 class="a2-job-drawer-section-title">Identity</h3>
            <dl class="a2-job-drawer-dl">
              <div><dt>Operation ID</dt><dd class="mono">{selectedJob.id}</dd></div>
              <div><dt>Status</dt><dd><AdminStatus label={statusLabel(selectedJob.status)} tone={statusTone(selectedJob.status, selectedJob.isStale)} /></dd></div>
              <div><dt>Provider</dt><dd>{selectedJob.providerAdapterId ?? '—'}</dd></div>
              {#if selectedJob.providerAssetId}
                <div><dt>Provider asset</dt><dd class="mono">{selectedJob.providerAssetId}</dd></div>
              {/if}
              {#if selectedJob.sourceFilename}
                <div><dt>Filename</dt><dd>{selectedJob.sourceFilename}</dd></div>
              {/if}
              {#if selectedJob.sourceUrl}
                <div class="a2-job-drawer-full"><dt>Source URL</dt><dd class="mono a2-job-drawer-url">{selectedJob.sourceUrl}</dd></div>
              {/if}
            </dl>
          </section>

          {#if selectedJob.mediaItem}
            <section class="a2-job-drawer-section">
              <h3 class="a2-job-drawer-section-title">Media</h3>
              <dl class="a2-job-drawer-dl">
                <div><dt>Title</dt><dd>{selectedJob.mediaItem.title}</dd></div>
                <div><dt>Type</dt><dd>{selectedJob.mediaItem.contentType}</dd></div>
                <div><dt>TMDB</dt><dd class="mono">{selectedJob.mediaItem.tmdbId}</dd></div>
                {#if selectedJob.mediaItem.season != null && selectedJob.mediaItem.episode != null}
                  <div><dt>Episode</dt><dd>S{String(selectedJob.mediaItem.season).padStart(2, '0')}E{String(selectedJob.mediaItem.episode).padStart(2, '0')}</dd></div>
                {/if}
              </dl>
              <a class="a2-job-drawer-open-link" href={`/admin/media/library?selected=${selectedJob.mediaItem.id}`}>
                <ExternalLink size={12} /> Open in Media Library
              </a>
            </section>
          {/if}

          <section class="a2-job-drawer-section">
            <h3 class="a2-job-drawer-section-title">Timeline</h3>
            <ol class="a2-job-timeline" role="list">
              <li class="a2-job-timeline-item" class:is-done={true}>
                <span class="a2-job-timeline-dot"></span>
                <span class="a2-job-timeline-label">Queued</span>
                <span class="a2-job-timeline-time mono">{formatDate(selectedJob.queuedAt)}</span>
              </li>
              <li class="a2-job-timeline-item" class:is-done={Boolean(selectedJob.uploadStartedAt)}>
                <span class="a2-job-timeline-dot"></span>
                <span class="a2-job-timeline-label">Upload started</span>
                <span class="a2-job-timeline-time mono">{formatDate(selectedJob.uploadStartedAt)}</span>
              </li>
              <li class="a2-job-timeline-item" class:is-done={Boolean(selectedJob.uploadedAt)}>
                <span class="a2-job-timeline-dot"></span>
                <span class="a2-job-timeline-label">Uploaded</span>
                <span class="a2-job-timeline-time mono">{formatDate(selectedJob.uploadedAt)}</span>
              </li>
              <li class="a2-job-timeline-item" class:is-done={Boolean(selectedJob.processingStartedAt)}>
                <span class="a2-job-timeline-dot"></span>
                <span class="a2-job-timeline-label">Processing</span>
                <span class="a2-job-timeline-time mono">{formatDate(selectedJob.processingStartedAt)}</span>
              </li>
              <li class="a2-job-timeline-item" class:is-done={selectedJob.status === 'ready'} class:is-failed={selectedJob.status === 'failed'}>
                <span class="a2-job-timeline-dot"></span>
                <span class="a2-job-timeline-label">{selectedJob.status === 'failed' ? 'Failed' : selectedJob.status === 'ready' ? 'Ready' : selectedJob.status === 'cancelled' ? 'Cancelled' : 'Pending'}</span>
                <span class="a2-job-timeline-time mono">{formatDate(selectedJob.readyAt ?? selectedJob.failedAt ?? selectedJob.cancelledAt)}</span>
              </li>
            </ol>
          </section>

          {#if selectedJob.errorCode || selectedJob.errorMessage}
            <section class="a2-job-drawer-section">
              <h3 class="a2-job-drawer-section-title">Error</h3>
              <dl class="a2-job-drawer-dl">
                {#if selectedJob.errorCode}
                  <div><dt>Error code</dt><dd class="mono a2-job-error-code">{selectedJob.errorCode}</dd></div>
                {/if}
                <div class="a2-job-drawer-full"><dt>Message</dt><dd>{selectedJob.errorMessage ?? '—'}</dd></div>
                <div><dt>Retryable</dt><dd>{selectedJob.isRetryable ? 'Yes — transient error' : 'No — permanent error'}</dd></div>
              </dl>
            </section>
          {/if}

          <section class="a2-job-drawer-section">
            <h3 class="a2-job-drawer-section-title">Actions</h3>
            <div class="a2-job-drawer-actions">
              {#if selectedJob.status === 'failed' && selectedJob.isRetryable}
                <button type="button" class="a2-job-action a2-job-action-primary" onclick={() => retryJob(selectedJob!)} disabled={actionInProgress}>
                  {#if actionInProgress}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<RotateCcw size={12} />{/if}
                  Retry
                </button>
              {:else if selectedJob.status === 'failed' && !selectedJob.isRetryable}
                <div class="a2-job-action-unavailable">
                  <Ban size={12} /> Retry unavailable — permanent error ({selectedJob.errorCode})
                </div>
              {/if}
              {#if isActive(selectedJob.status)}
                <button type="button" class="a2-job-action a2-job-action-warn" onclick={() => cancelJob(selectedJob!)} disabled={actionInProgress}>
                  <Ban size={12} /> Cancel
                </button>
              {/if}
              {#if selectedJob.mediaAssetId}
                <button type="button" class="a2-job-action" onclick={() => reconcileJob(selectedJob!)} disabled={actionInProgress}>
                  <RefreshCw size={12} /> Reconcile
                </button>
              {/if}
            </div>
          </section>
        </div>
      </aside>
    </div>
  {/if}
</section>

<style>
  .a2-ops-jobs { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  .a2-jobs-filters { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-jobs-search { position: relative; display: flex; align-items: center; }
  .a2-jobs-search-input { width: 100%; padding: var(--a2-space-2) var(--a2-space-3) var(--a2-space-2) var(--a2-space-8); background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-family: var(--a2-font-sans); font-size: var(--a2-text-sm); transition: border-color var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-jobs-search-input:focus { outline: none; border-color: var(--a2-cyan); box-shadow: 0 0 0 3px var(--a2-cyan-soft); }

  .a2-jobs-filter-row { display: flex; gap: var(--a2-space-2); align-items: flex-end; flex-wrap: wrap; }
  .a2-jobs-filter { display: flex; flex-direction: column; gap: 2px; }
  .a2-jobs-filter-full { width: 100%; }
  .a2-jobs-filter-label { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-jobs-select { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-family: var(--a2-font-sans); font-size: var(--a2-text-xs); padding: 4px 8px; cursor: pointer; transition: border-color var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-jobs-select:focus { outline: none; border-color: var(--a2-cyan); }

  .a2-jobs-clear { display: inline-flex; align-items: center; gap: 2px; padding: 4px 8px; background: transparent; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-jobs-clear:hover { color: var(--a2-red); border-color: var(--a2-red-border); }

  .a2-jobs-mobile-filter-toggle { display: none; align-items: center; gap: var(--a2-space-1); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; }

  .a2-jobs-loading { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); color: var(--a2-text-muted); font-size: var(--a2-text-sm); }
  .a2-jobs-error { display: flex; gap: var(--a2-space-3); align-items: flex-start; padding: var(--a2-space-4); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-md); color: var(--a2-red); }
  .a2-jobs-error-title { margin: 0 0 4px; font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-red); }
  .a2-jobs-error-desc { margin: 0 0 8px; font-size: var(--a2-text-xs); color: var(--a2-text-muted); }
  .a2-jobs-retry { padding: 4px 12px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-jobs-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-jobs-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-jobs-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }

  .a2-jobs-table-wrap { overflow-x: auto; background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-jobs-table { width: 100%; border-collapse: collapse; font-size: var(--a2-text-xs); }
  .a2-jobs-table thead th { padding: var(--a2-space-2) var(--a2-space-3); text-align: left; font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--a2-border-strong); white-space: nowrap; background: var(--a2-surface-3); position: sticky; top: 0; }
  .a2-jobs-table tbody tr { border-bottom: 1px solid var(--a2-border); cursor: pointer; transition: background var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-jobs-table tbody tr:hover { background: var(--a2-surface-3); }
  .a2-jobs-table tbody tr.is-stale { background: var(--a2-amber-soft); }
  .a2-jobs-table tbody tr.is-stale:hover { background: var(--a2-surface-3); }
  .a2-jobs-table tbody td { padding: var(--a2-space-2) var(--a2-space-3); vertical-align: top; color: var(--a2-text); }

  .a2-jobs-status-cell { display: flex; flex-direction: column; gap: 2px; }
  .a2-jobs-stale-badge { display: inline-block; padding: 1px 4px; background: var(--a2-amber-soft); border: 1px solid var(--a2-amber-border); border-radius: var(--a2-radius-xs); font-size: 9px; font-weight: 700; color: var(--a2-amber); letter-spacing: 0.05em; }
  .a2-jobs-retryable-badge { display: inline-block; padding: 1px 4px; background: var(--a2-cyan-soft); border: 1px solid var(--a2-cyan-border); border-radius: var(--a2-radius-xs); font-size: 9px; font-weight: 700; color: var(--a2-cyan); letter-spacing: 0.05em; }

  .a2-jobs-type-badge { display: inline-block; padding: 1px 6px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; color: var(--a2-text-muted); }
  .a2-jobs-attempt { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); margin-left: 4px; }

  .a2-jobs-media-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .a2-jobs-media-title { font-weight: 500; color: var(--a2-text); max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .a2-jobs-media-meta { display: inline-flex; align-items: center; gap: 3px; font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }
  .a2-jobs-dash { color: var(--a2-text-dim); }

  .a2-jobs-provider-badge { display: inline-block; padding: 1px 6px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; color: var(--a2-cyan); }
  .a2-jobs-provider-badge[data-adapter="abyss"] { color: var(--a2-amber); }

  .col-actions { width: 32px; text-align: right; }
  .a2-jobs-row-action { background: transparent; border: none; cursor: pointer; color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs); display: inline-flex; align-items: center; justify-content: center; }
  .a2-jobs-row-action:hover { background: var(--a2-surface-4); color: var(--a2-cyan); }

  .a2-jobs-pagination { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); flex-wrap: wrap; padding: var(--a2-space-2) var(--a2-space-3); }
  .a2-jobs-pagination-info { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); font-family: var(--a2-font-mono); }
  .a2-jobs-pagination-actions { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-jobs-page-btn { display: inline-flex; align-items: center; gap: 2px; padding: 4px 10px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-jobs-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .a2-jobs-page-btn:hover:not(:disabled) { border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-jobs-page-num { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); font-family: var(--a2-font-mono); }

  .a2-jobs-filter-sheet-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.55); display: flex; align-items: flex-end; }
  .a2-jobs-filter-sheet { width: 100%; background: var(--a2-surface-1); border-top-left-radius: var(--a2-radius-lg); border-top-right-radius: var(--a2-radius-lg); border-top: 1px solid var(--a2-border-strong); display: flex; flex-direction: column; max-height: 80vh; animation: a2-sheet-up var(--a2-motion-normal, 240ms) var(--a2-ease-out); }
  @keyframes a2-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
  .a2-jobs-filter-sheet-head { display: flex; justify-content: space-between; align-items: center; padding: var(--a2-space-4); border-bottom: 1px solid var(--a2-border); }
  .a2-jobs-filter-sheet-head h2 { margin: 0; font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-jobs-filter-sheet-close { background: transparent; border: none; cursor: pointer; color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs); }
  .a2-jobs-filter-sheet-body { padding: var(--a2-space-4); display: flex; flex-direction: column; gap: var(--a2-space-3); overflow-y: auto; }
  .a2-jobs-filter-sheet-actions {
    padding-bottom: env(safe-area-inset-bottom, 0px); display: flex; gap: var(--a2-space-2); padding: var(--a2-space-3) var(--a2-space-4); border-top: 1px solid var(--a2-border); }
  .a2-jobs-apply { flex: 1; padding: var(--a2-space-2); background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; }

  .a2-job-drawer-overlay { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(2px); display: flex; justify-content: flex-end; animation: a2-fade-in var(--a2-motion-normal, 240ms) var(--a2-ease-out); }
  @keyframes a2-fade-in { from { opacity: 0; } to { opacity: 1; } }
  .a2-job-drawer { width: 100%; max-width: 480px; background: var(--a2-surface-1); border-left: 1px solid var(--a2-border-strong); display: flex; flex-direction: column; overflow-y: auto; animation: a2-slide-in var(--a2-motion-normal, 240ms) var(--a2-ease-out); }
  @keyframes a2-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

  .a2-job-drawer-head {
    padding-top: env(safe-area-inset-top, 0px); display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-4); border-bottom: 1px solid var(--a2-border); position: sticky; top: 0; background: var(--a2-surface-1); z-index: 1; }
  .a2-job-drawer-head-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .a2-job-drawer-title { margin: 0; font-family: var(--a2-font-sans); font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-job-drawer-subtitle { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
  .a2-job-drawer-close {
    min-width: 44px;
    min-height: 44px; background: transparent; border: none; cursor: pointer; color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs); }
  .a2-job-drawer-close:hover { background: var(--a2-surface-3); color: var(--a2-text); }

  .a2-job-drawer-body { padding: var(--a2-space-4); display: flex; flex-direction: column; gap: var(--a2-space-5); }
  .a2-job-drawer-section { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-job-drawer-section-title { margin: 0; font-family: var(--a2-font-sans); font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-cyan); text-transform: uppercase; letter-spacing: 0.1em; }
  .a2-job-drawer-dl { display: grid; grid-template-columns: 1fr 1fr; gap: var(--a2-space-2) var(--a2-space-4); margin: 0; }
  .a2-job-drawer-dl > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .a2-job-drawer-dl > div.a2-job-drawer-full { grid-column: 1 / -1; }
  .a2-job-drawer-dl dt { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-job-drawer-dl dd { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text); word-break: break-all; }
  .a2-job-drawer-url { font-size: var(--a2-text-2xs); }

  .a2-job-drawer-open-link { display: inline-flex; align-items: center; gap: var(--a2-space-1); padding: var(--a2-space-1) var(--a2-space-2); background: var(--a2-cyan-soft); border: 1px solid var(--a2-cyan-border); border-radius: var(--a2-radius-xs); color: var(--a2-cyan); font-size: var(--a2-text-2xs); font-weight: 600; text-decoration: none; align-self: flex-start; }

  .a2-job-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--a2-space-2); position: relative; }
  .a2-job-timeline::before { content: ''; position: absolute; left: 5px; top: 12px; bottom: 12px; width: 1px; background: var(--a2-border); }
  .a2-job-timeline-item { display: grid; grid-template-columns: 12px 1fr auto; gap: var(--a2-space-3); align-items: center; position: relative; }
  .a2-job-timeline-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--a2-surface-4); border: 1px solid var(--a2-border-strong); position: relative; z-index: 1; }
  .a2-job-timeline-item.is-done .a2-job-timeline-dot { background: var(--a2-green); border-color: var(--a2-green); }
  .a2-job-timeline-item.is-failed .a2-job-timeline-dot { background: var(--a2-red); border-color: var(--a2-red); }
  .a2-job-timeline-label { font-size: var(--a2-text-xs); color: var(--a2-text); font-weight: 500; }
  .a2-job-timeline-item.is-done .a2-job-timeline-label { color: var(--a2-text-bright); }
  .a2-job-timeline-time { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }

  .a2-job-error-code { color: var(--a2-red); font-weight: 700; }

  .a2-job-action-success { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0; padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-2xs); }
  .a2-job-action-error { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0; padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-2xs); }

  .a2-job-drawer-actions { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-job-action { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-family: var(--a2-font-sans); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; text-align: left; transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-job-action:hover:not(:disabled) { background: var(--a2-cyan-soft); border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-job-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .a2-job-action-primary { background: var(--a2-cyan); color: var(--a2-surface-1); border-color: var(--a2-cyan); }
  .a2-job-action-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .a2-job-action-warn { color: var(--a2-amber); }
  .a2-job-action-warn:hover:not(:disabled) { background: var(--a2-amber-soft); border-color: var(--a2-amber); color: var(--a2-amber); }
  .a2-job-action-unavailable { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-3); border: 1px dashed var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); }

  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  @media (max-width: 768px) {
    .a2-jobs-filters { display: none; }
    .a2-jobs-mobile-filter-toggle { display: inline-flex; }
    .a2-job-drawer { max-width: 100%; }
    .a2-job-drawer-dl { grid-template-columns: 1fr; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-job-drawer, .a2-job-drawer-overlay, .a2-jobs-filter-sheet,
    .a2-job-action, .a2-jobs-select, .a2-jobs-search-input,
    .a2-jobs-table tbody tr { animation: none; transition: none; }
  }
</style>
