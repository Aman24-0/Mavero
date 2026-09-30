<script lang="ts">
  /**
   * Admin 2.0 — Phase F — AdminOpsAttention
   *
   * The Attention tab. Shows only things that need admin action:
   *   - Failed operations (retryable + permanent)
   *   - Stale operations (stuck > 60 min)
   *   - Unconfigured providers (credentials missing)
   *   - Degraded providers (health check failed)
   *
   * Items are sorted by severity (critical first) then by detectedAt.
   * The list is live-state based — no permanent "resolved" flag. If the
   * underlying state is still failed/stale, the item remains. When the
   * state becomes healthy, the item disappears naturally on next refresh.
   *
   * Actions:
   *   - Retry (for retryable failed ops)
   *   - Reconcile (for stale ops with media_asset_id)
   *   - Open provider (for unconfigured/degraded)
   *   - Open media / asset (contextual navigation)
   */

  import { onMount } from 'svelte';
  import { AlertCircle, AlertTriangle, Loader2, RefreshCw, RotateCcw, ExternalLink, X, ChevronLeft, ChevronRight, Ban, Server, Activity, Check } from 'lucide-svelte';
  import AdminStatus from './AdminStatus.svelte';
  import type { AttentionItem, AttentionQuery, AttentionCategory, AttentionSeverity } from '$lib/shared/operations-types';

  let items = $state<AttentionItem[]>([]);
  let total = $state(0);
  let page = $state(1);
  let limit = $state(25);
  let hasMore = $state(false);
  let counts = $state({ failed: 0, stale: 0, unconfigured: 0, degraded: 0, total: 0 });
  let loading = $state(false);
  let listError = $state<string | null>(null);

  let filters = $state<AttentionQuery>({
    category: 'all',
    severity: 'all',
    provider: 'all',
    page: 1,
    limit: 25,
  });

  let actionInProgress = $state(false);
  let actionError = $state<string | null>(null);
  let actionSuccess = $state<string | null>(null);

  async function loadAttention() {
    loading = true;
    listError = null;
    try {
      const params = new URLSearchParams();
      if (filters.category && filters.category !== 'all') params.set('category', String(filters.category));
      if (filters.severity && filters.severity !== 'all') params.set('severity', String(filters.severity));
      if (filters.provider && filters.provider !== 'all') params.set('provider', String(filters.provider));
      params.set('page', String(filters.page ?? 1));
      params.set('limit', String(filters.limit ?? 25));

      const res = await fetch(`/api/admin/operations/attention?${params.toString()}`);
      const data = await res.json();
      if (data.ok) {
        items = data.items;
        total = data.total;
        page = data.page;
        limit = data.limit;
        hasMore = data.hasMore;
        counts = data.counts;
      } else {
        listError = data.error?.message ?? 'Failed to load attention items.';
      }
    } catch {
      listError = 'Network error while loading attention items.';
    }
    loading = false;
  }

  let lastCategory = $state(filters.category);
  let lastSeverity = $state(filters.severity);
  let lastProvider = $state(filters.provider);

  $effect(() => {
    if (
      filters.category !== lastCategory ||
      filters.severity !== lastSeverity ||
      filters.provider !== lastProvider
    ) {
      lastCategory = filters.category;
      lastSeverity = filters.severity;
      lastProvider = filters.provider;
      filters.page = 1;
      void loadAttention();
    }
  });

  onMount(() => { void loadAttention(); });

  function severityTone(s: AttentionSeverity): 'red' | 'amber' | 'blue' {
    if (s === 'critical') return 'red';
    if (s === 'warning') return 'amber';
    return 'blue';
  }
  function severityLabel(s: AttentionSeverity): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function categoryLabel(c: AttentionCategory): string {
    return c.charAt(0).toUpperCase() + c.slice(1);
  }
  function categoryIcon(c: AttentionCategory): typeof AlertCircle {
    if (c === 'failed') return AlertCircle;
    if (c === 'stale') return AlertTriangle;
    if (c === 'unconfigured') return Server;
    if (c === 'degraded') return Activity;
    return AlertCircle;
  }

  function formatDate(iso: string): string {
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

  function pageNext() {
    if (!hasMore) return;
    filters.page = (filters.page ?? 1) + 1;
    void loadAttention();
  }
  function pagePrev() {
    if ((filters.page ?? 1) <= 1) return;
    filters.page = (filters.page ?? 1) - 1;
    void loadAttention();
  }

  async function retryItem(item: AttentionItem) {
    actionInProgress = true;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/upload/${item.sourceId}/retry`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        actionSuccess = 'Retry operation created.';
        await loadAttention();
      } else {
        actionError = data.error?.message ?? 'Retry failed.';
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Network error during retry.';
    }
    actionInProgress = false;
  }

  async function reconcileItem(item: AttentionItem) {
    if (!item.mediaAssetId) return;
    actionInProgress = true;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${item.mediaAssetId}/reconcile`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        actionSuccess = `Reconciled. Status: ${data.status ?? 'unknown'}.`;
        await loadAttention();
      } else {
        actionError = data.error?.message ?? 'Reconcile failed.';
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Network error during reconcile.';
    }
    actionInProgress = false;
  }
</script>

<section class="a2-ops-attention" aria-label="Attention">
  <!-- Category summary cards -->
  <div class="a2-attention-summary">
    <button type="button" class="a2-attention-cat-card" class:is-active={filters.category === 'failed'} onclick={() => { filters.category = filters.category === 'failed' ? 'all' : 'failed'; }}>
      <span class="a2-attention-cat-icon a2-attention-cat-failed"><AlertCircle size={14} /></span>
      <span class="a2-attention-cat-count">{counts.failed}</span>
      <span class="a2-attention-cat-label">Failed</span>
    </button>
    <button type="button" class="a2-attention-cat-card" class:is-active={filters.category === 'stale'} onclick={() => { filters.category = filters.category === 'stale' ? 'all' : 'stale'; }}>
      <span class="a2-attention-cat-icon a2-attention-cat-stale"><AlertTriangle size={14} /></span>
      <span class="a2-attention-cat-count">{counts.stale}</span>
      <span class="a2-attention-cat-label">Stale</span>
    </button>
    <button type="button" class="a2-attention-cat-card" class:is-active={filters.category === 'unconfigured'} onclick={() => { filters.category = filters.category === 'unconfigured' ? 'all' : 'unconfigured'; }}>
      <span class="a2-attention-cat-icon a2-attention-cat-unconfigured"><Server size={14} /></span>
      <span class="a2-attention-cat-count">{counts.unconfigured}</span>
      <span class="a2-attention-cat-label">Unconfigured</span>
    </button>
    <button type="button" class="a2-attention-cat-card" class:is-active={filters.category === 'degraded'} onclick={() => { filters.category = filters.category === 'degraded' ? 'all' : 'degraded'; }}>
      <span class="a2-attention-cat-icon a2-attention-cat-degraded"><Activity size={14} /></span>
      <span class="a2-attention-cat-count">{counts.degraded}</span>
      <span class="a2-attention-cat-label">Degraded</span>
    </button>
  </div>

  {#if actionSuccess}
    <p class="a2-attention-action-success" role="status"><Check size={12} /> {actionSuccess}</p>
  {/if}
  {#if actionError}
    <p class="a2-attention-action-error" role="alert"><AlertCircle size={12} /> {actionError}</p>
  {/if}

  {#if loading && items.length === 0}
    <div class="a2-attention-loading" role="status">
      <Loader2 size={20} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" />
      <p>Loading attention items…</p>
    </div>
  {:else if listError}
    <div class="a2-attention-error" role="alert">
      <AlertCircle size={20} />
      <div>
        <p class="a2-attention-error-title">Unable to load operations</p>
        <p class="a2-attention-error-desc">{listError}</p>
        <button type="button" class="a2-attention-retry" onclick={loadAttention}>Retry</button>
      </div>
    </div>
  {:else if items.length === 0}
    <div class="a2-attention-empty">
      <Check size={32} />
      <h3>All systems clear</h3>
      <p>No failed, stale, unconfigured, or degraded items. Everything is operational.</p>
    </div>
  {:else}
    <ul class="a2-attention-list" role="list">
      {#each items as item (item.id)}
        {@const Icon = categoryIcon(item.category)}
        <li class="a2-attention-item" data-severity={item.severity}>
          <div class="a2-attention-item-icon" data-category={item.category}>
            <Icon size={16} />
          </div>
          <div class="a2-attention-item-body">
            <div class="a2-attention-item-head">
              <span class="a2-attention-item-title">{item.title}</span>
              <AdminStatus label={severityLabel(item.severity)} tone={severityTone(item.severity)} />
            </div>
            <p class="a2-attention-item-desc">{item.description}</p>
            <div class="a2-attention-item-meta">
              <span class="a2-attention-item-cat">{categoryLabel(item.category)}</span>
              {#if item.providerAdapterId}
                <span class="a2-attention-item-provider" data-adapter={item.providerAdapterId}>{item.providerAdapterId}</span>
              {/if}
              {#if item.errorCode}
                <span class="a2-attention-item-code mono">{item.errorCode}</span>
              {/if}
              <span class="a2-attention-item-date">{formatDate(item.detectedAt)}</span>
            </div>
            {#if item.canRetry || item.canReconcile || item.mediaItemId || item.providerAdapterId}
              <div class="a2-attention-item-actions">
                {#if item.canRetry}
                  <button type="button" class="a2-attention-action a2-attention-action-primary" onclick={() => retryItem(item)} disabled={actionInProgress}>
                    {#if actionInProgress}<Loader2 size={11} style="animation: a2-spin 1s linear infinite;" />{:else}<RotateCcw size={11} />{/if}
                    Retry
                  </button>
                {/if}
                {#if item.canReconcile}
                  <button type="button" class="a2-attention-action" onclick={() => reconcileItem(item)} disabled={actionInProgress}>
                    <RefreshCw size={11} /> Reconcile
                  </button>
                {/if}
                {#if item.mediaItemId}
                  <a class="a2-attention-action a2-attention-action-link" href={`/admin/media/library?selected=${item.mediaItemId}`}>
                    <ExternalLink size={11} /> Open media
                  </a>
                {/if}
                {#if item.providerAdapterId && (item.category === 'unconfigured' || item.category === 'degraded')}
                  <a class="a2-attention-action a2-attention-action-link" href="/admin/hosting?tab=providers">
                    <ExternalLink size={11} /> Open provider
                  </a>
                {/if}
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    <footer class="a2-attention-pagination">
      <span class="a2-attention-pagination-info">
        {#if total > 0}
          Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
        {:else}
          0 items
        {/if}
      </span>
      <div class="a2-attention-pagination-actions">
        <button type="button" class="a2-attention-page-btn" onclick={pagePrev} disabled={page <= 1}>
          <ChevronLeft size={12} /> Prev
        </button>
        <span class="a2-attention-page-num">Page {page}</span>
        <button type="button" class="a2-attention-page-btn" onclick={pageNext} disabled={!hasMore}>
          Next <ChevronRight size={12} />
        </button>
      </div>
    </footer>
  {/if}
</section>

<style>
  .a2-ops-attention { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  .a2-attention-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--a2-space-2); }
  .a2-attention-summary { grid-template-columns: 1fr 1fr; }
  @media (max-width: 640px) { .a2-attention-summary { grid-template-columns: 1fr 1fr; } }

  .a2-attention-cat-card { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); cursor: pointer; transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-attention-cat-card:hover { background: var(--a2-surface-3); border-color: var(--a2-border-strong); }
  .a2-attention-cat-card.is-active { border-color: var(--a2-cyan); background: var(--a2-cyan-soft); }

  .a2-attention-cat-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--a2-radius-sm); margin-bottom: 2px; }
  .a2-attention-cat-failed { background: var(--a2-red-soft); color: var(--a2-red); }
  .a2-attention-cat-stale { background: var(--a2-amber-soft); color: var(--a2-amber); }
  .a2-attention-cat-unconfigured { background: var(--a2-amber-soft); color: var(--a2-amber); }
  .a2-attention-cat-degraded { background: var(--a2-red-soft); color: var(--a2-red); }

  .a2-attention-cat-count { font-family: var(--a2-font-mono); font-size: var(--a2-text-xl); font-weight: 700; color: var(--a2-text-bright); }
  .a2-attention-cat-label { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }

  .a2-attention-action-success { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0; padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-2xs); }
  .a2-attention-action-error { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0; padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-2xs); }

  .a2-attention-loading { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); color: var(--a2-text-muted); font-size: var(--a2-text-sm); }
  .a2-attention-error { display: flex; gap: var(--a2-space-3); align-items: flex-start; padding: var(--a2-space-4); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-md); color: var(--a2-red); }
  .a2-attention-error-title { margin: 0 0 4px; font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-red); }
  .a2-attention-error-desc { margin: 0 0 8px; font-size: var(--a2-text-xs); color: var(--a2-text-muted); }
  .a2-attention-retry { padding: 4px 12px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }

  .a2-attention-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-attention-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-attention-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }
  .a2-attention-empty :global(svg) { color: var(--a2-green); }

  .a2-attention-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-attention-item { display: grid; grid-template-columns: 36px 1fr; gap: var(--a2-space-3); padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-attention-item[data-severity="critical"] { border-color: var(--a2-red-border); }
  .a2-attention-item[data-severity="warning"] { border-color: var(--a2-amber-border); }

  .a2-attention-item-icon { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--a2-radius-sm); flex-shrink: 0; }
  .a2-attention-item-icon[data-category="failed"] { background: var(--a2-red-soft); color: var(--a2-red); }
  .a2-attention-item-icon[data-category="stale"] { background: var(--a2-amber-soft); color: var(--a2-amber); }
  .a2-attention-item-icon[data-category="unconfigured"] { background: var(--a2-amber-soft); color: var(--a2-amber); }
  .a2-attention-item-icon[data-category="degraded"] { background: var(--a2-red-soft); color: var(--a2-red); }

  .a2-attention-item-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .a2-attention-item-head { display: flex; align-items: center; justify-content: space-between; gap: var(--a2-space-2); }
  .a2-attention-item-title { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-attention-item-desc { margin: 0; font-size: var(--a2-text-xs); color: var(--a2-text-muted); line-height: 1.5; }
  .a2-attention-item-meta { display: flex; align-items: center; gap: var(--a2-space-3); flex-wrap: wrap; font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }
  .a2-attention-item-cat { text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-attention-item-provider { padding: 1px 4px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-family: var(--a2-font-mono); text-transform: uppercase; color: var(--a2-cyan); }
  .a2-attention-item-provider[data-adapter="abyss"] { color: var(--a2-amber); }
  .a2-attention-item-code { color: var(--a2-red); }
  .a2-attention-item-date { margin-left: auto; }

  .a2-attention-item-actions { display: flex; gap: var(--a2-space-1); flex-wrap: wrap; padding-top: 4px; }
  .a2-attention-action { display: inline-flex; align-items: center; gap: var(--a2-space-1); padding: var(--a2-space-1) var(--a2-space-2); background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-xs); color: var(--a2-text); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; text-decoration: none; transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-attention-action:hover:not(:disabled) { background: var(--a2-cyan-soft); border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-attention-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .a2-attention-action-primary { background: var(--a2-cyan); color: var(--a2-surface-1); border-color: var(--a2-cyan); }
  .a2-attention-action-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .a2-attention-action-link { color: var(--a2-cyan); }

  .a2-attention-pagination { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); flex-wrap: wrap; padding: var(--a2-space-2) var(--a2-space-3); }
  .a2-attention-pagination-info { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); font-family: var(--a2-font-mono); }
  .a2-attention-pagination-actions { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-attention-page-btn { display: inline-flex; align-items: center; gap: 2px; padding: 4px 10px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-attention-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .a2-attention-page-btn:hover:not(:disabled) { border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-attention-page-num { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); font-family: var(--a2-font-mono); }

  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .a2-attention-summary { grid-template-columns: 1fr 1fr; }
  @media (max-width: 640px) {
    .a2-attention-item { grid-template-columns: 1fr; }
    .a2-attention-item-icon { width: 32px; height: 32px; }
    .a2-attention-item-date { margin-left: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-attention-cat-card, .a2-attention-action { transition: none; }
  }
</style>
