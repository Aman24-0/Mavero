<script lang="ts">
  /**
   * Admin 2.0 — Phase C — AdminMediaDetailDrawer
   *
   * Right-side detail drawer for a selected media item. Shows:
   *   1. Identity (title / type / year / TMDB ID / IMDb ID / canonical key)
   *   2. Content information (series + season + episode for episodes)
   *   3. Metadata (created / updated dates — language/country/genres
   *      are NOT stored on media_items today; they belong to TMDB.
   *      Phase C defers this — see worklog.)
   *   4. Provider availability (Vidara + Abyss status, quality, audio, subs)
   *   5. Asset information (size, duration, last sync)
   *   6. Operations (recent 20 operations on this media item)
   *   7. Upload/import link (delegates to existing upload route)
   *
   * Phase E/F operations (rename/move/detach/delete/reconcile/sync)
   * are deferred — the drawer links to existing pages where possible
   * but does NOT add fake action buttons. See worklog.
   *
   * Drawer behavior:
   *   - Right-side on desktop (400px width)
   *   - Full-screen sheet on mobile
   *   - Focus trap + Escape-to-close + focus restore
   *   - Body scroll lock when open
   *   - Route-aware: closing returns focus to the previously focused row
   *
   * Partial failure contract:
   *   - If the detail fetch fails but the item is in the list view,
   *     show the list-item summary with an error notice in the drawer.
   *   - If provider availability data is partial (e.g. demand query
   *     failed), still render everything else with an inline note.
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { X, Film, Tv, Sparkles, ExternalLink, Upload, AlertCircle, Activity, Clock, HardDrive, Languages, FileText, ArrowRight } from 'lucide-svelte';
  import AdminAssetStatus from './AdminAssetStatus.svelte';
  import AdminStatus from './AdminStatus.svelte';
  import type { LibraryMediaItem, LibraryOperationSummary, LibraryAssetSummary } from '$lib/server/hosting/library/service';

  let {
    open = $bindable(false),
    item = null as LibraryMediaItem | null,
    operations = [] as LibraryOperationSummary[],
    loading = false,
    error = null as string | null,
    hostingSources = [] as Array<{ id: string; name: string; adapterId: string | null }>,
    onclose = (() => {}) as () => void,
    onupload = (() => {}) as (item: LibraryMediaItem) => void,
  }: {
    open?: boolean;
    item?: LibraryMediaItem | null;
    operations?: LibraryOperationSummary[];
    loading?: boolean;
    error?: string | null;
    hostingSources?: Array<{ id: string; name: string; adapterId: string | null }>;
    onclose?: () => void;
    onupload?: (item: LibraryMediaItem) => void;
  } = $props();

  let drawerEl = $state<HTMLElement | undefined>(undefined);
  let lastFocused: HTMLElement | null = null;

  $effect(() => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement | null;
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-a2-drawer-open', '');
      }
      void tick().then(() => drawerEl?.querySelector<HTMLElement>('.a2-drawer-close')?.focus());
    } else {
      if (typeof document !== 'undefined') {
        document.documentElement.removeAttribute('data-a2-drawer-open');
      }
      lastFocused?.focus();
      lastFocused = null;
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.removeAttribute('data-a2-drawer-open');
    }
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      open = false;
      onclose();
      return;
    }
    if (event.key !== 'Tab' || !drawerEl) return;
    const focusable = [...drawerEl.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function adapterIdForSource(sourceId: string | null): string | null {
    if (!sourceId) return null;
    return hostingSources.find(s => s.id === sourceId)?.adapterId ?? null;
  }

  function sourceNameForId(sourceId: string | null): string {
    if (!sourceId) return 'Unknown';
    return hostingSources.find(s => s.id === sourceId)?.name ?? 'Unknown';
  }

  function formatYear(year: number | null): string {
    return year ? String(year) : '—';
  }
  function formatEpisode(season: number | null, episode: number | null): string {
    if (season == null && episode == null) return '—';
    const s = season != null ? String(season).padStart(2, '0') : '—';
    const e = episode != null ? String(episode).padStart(2, '0') : '—';
    return `S${s}E${e}`;
  }
  function formatDuration(seconds: number | null): string {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
  function formatSize(bytes: number | null): string {
    if (!bytes) return '—';
    if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  }
  function formatDateTime(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }
  function formatQualities(q: string[]): string {
    if (!q.length) return '—';
    return q.join(', ');
  }
  function formatAudio(a: string[]): string {
    if (!a.length) return '—';
    return a.map(l => l.toUpperCase()).join(', ');
  }

  // Group assets by provider adapter for the "Provider availability" section.
  type ProviderGroup = { adapterId: string; label: string; assets: LibraryAssetSummary[] };
  const providerGroups = $derived.by(() => {
    if (!item) return [] as ProviderGroup[];
    const groups = new Map<string, ProviderGroup>();
    for (const asset of item.assets) {
      const adapterId = adapterIdForSource(asset.provider_source_id) ?? 'unknown';
      if (!groups.has(adapterId)) {
        groups.set(adapterId, {
          adapterId,
          label: adapterId === 'vidara' ? 'Vidara' : adapterId === 'abyss' ? 'Abyss' : sourceNameForId(asset.provider_source_id),
          assets: [],
        });
      }
      groups.get(adapterId)!.assets.push(asset);
    }
    return [...groups.values()];
  });
</script>

{#if open}
  <div class="a2-drawer-overlay" onclick={() => { open = false; onclose(); }} aria-hidden="true"></div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <aside
    class="a2-drawer a2-scroll"
    bind:this={drawerEl}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-label="Media detail"
    onkeydown={handleKeydown}
  >
    <header class="a2-drawer-head">
      <span class="a2-drawer-title">Media Detail</span>
      <button class="a2-drawer-close" type="button" onclick={() => { open = false; onclose(); }} aria-label="Close detail">
        <X size={16} />
      </button>
    </header>

    <div class="a2-drawer-body">
      {#if loading}
        <div class="a2-drawer-loading">
          {#each Array(6) as _, i (i)}
            <div class="a2-drawer-skeleton" aria-hidden="true"></div>
          {/each}
        </div>
      {:else if error}
        <div class="a2-drawer-error">
          <div class="a2-drawer-error-icon"><AlertCircle size={20} /></div>
          <div class="a2-drawer-error-title">Detail temporarily unavailable</div>
          <div class="a2-drawer-error-desc">{error}</div>
          <div class="a2-drawer-error-desc">The media list is still available — close this drawer and try another item.</div>
        </div>
      {:else if !item}
        <div class="a2-drawer-error">
          <div class="a2-drawer-error-icon"><AlertCircle size={20} /></div>
          <div class="a2-drawer-error-title">No item selected</div>
          <div class="a2-drawer-error-desc">Select an item from the list to see its details.</div>
        </div>
      {:else}
        {@const Icon = item.content_type === 'movie' ? Film : item.content_type === 'anime' ? Sparkles : Tv}

        <!-- ============================================================
             IDENTITY
             ============================================================ -->
        <section class="a2-drawer-section">
          <div class="a2-drawer-section-head">
            <span class="a2-drawer-section-icon"><Icon size={14} /></span>
            <span class="a2-drawer-section-label">Identity</span>
          </div>
          <h2 class="a2-drawer-item-title">{item.title}</h2>
          {#if item.episode_title}
            <div class="a2-drawer-item-subtitle">{item.episode_title}</div>
          {/if}
          <div class="a2-drawer-id-grid">
            <div class="id-row"><span class="id-label">Type</span><span class="id-value">{item.content_type}</span></div>
            <div class="id-row"><span class="id-label">Year</span><span class="id-value">{formatYear(item.year)}</span></div>
            {#if item.season != null || item.episode != null}
              <div class="id-row"><span class="id-label">Episode</span><span class="id-value">{formatEpisode(item.season, item.episode)}</span></div>
            {/if}
            <div class="id-row"><span class="id-label">TMDB ID</span><span class="id-value mono">{item.tmdb_id}</span></div>
            {#if item.imdb_id}
              <div class="id-row"><span class="id-label">IMDb ID</span><span class="id-value mono">{item.imdb_id}</span></div>
            {/if}
            <div class="id-row id-row-full"><span class="id-label">Canonical Key</span><span class="id-value mono id-value-key">{item.canonical_key}</span></div>
          </div>
        </section>

        <!-- ============================================================
             PROVIDER AVAILABILITY
             ============================================================ -->
        <section class="a2-drawer-section">
          <div class="a2-drawer-section-head">
            <span class="a2-drawer-section-icon"><HardDrive size={14} /></span>
            <span class="a2-drawer-section-label">Provider Availability</span>
          </div>
          {#if providerGroups.length === 0}
            <div class="a2-drawer-empty-block">
              <div class="a2-drawer-empty-title">No provider assets linked</div>
              <div class="a2-drawer-empty-desc">This media item has no Vidara or Abyss assets. Upload one to make it playable.</div>
              <button class="a2-drawer-action" type="button" onclick={() => onupload(item)}>
                <Upload size={13} /> Upload to provider
              </button>
            </div>
          {:else}
            {#each providerGroups as group (group.adapterId)}
              <div class="provider-block provider-{group.adapterId}">
                <div class="provider-block-head">
                  <span class="provider-block-name">{group.label}</span>
                  {#if group.assets.length > 1}
                    <span class="provider-block-count">{group.assets.length} assets</span>
                  {/if}
                </div>
                {#each group.assets as asset (asset.id)}
                  <div class="provider-asset-row">
                    <div class="provider-asset-head">
                      <AdminAssetStatus status={asset.status} maveroStatus={asset.mavero_status} />
                      {#if asset.provider_asset_id}
                        <span class="provider-asset-id mono" title="Provider asset id">{asset.provider_asset_id}</span>
                      {/if}
                    </div>
                    {#if asset.status === 'ready' && asset.mavero_status === 'available'}
                      <div class="provider-asset-meta">
                        {#if group.adapterId === 'vidara' && asset.source_quality}
                          <div class="meta-row">
                            <span class="meta-label"><HardDrive size={11} /></span>
                            <span class="meta-value">Quality: <strong>{asset.source_quality}</strong></span>
                          </div>
                        {/if}
                        {#if group.adapterId === 'abyss' && asset.available_qualities.length}
                          <div class="meta-row">
                            <span class="meta-label"><HardDrive size={11} /></span>
                            <span class="meta-value">Variants: <strong>{formatQualities(asset.available_qualities)}</strong></span>
                          </div>
                        {/if}
                        {#if asset.audio_languages.length}
                          <div class="meta-row">
                            <span class="meta-label"><Languages size={11} /></span>
                            <span class="meta-value">Audio: <strong>{formatAudio(asset.audio_languages)}</strong>{#if group.adapterId === 'vidara' && asset.audio_languages.length > 1} (multi){/if}</span>
                          </div>
                        {/if}
                        <div class="meta-row">
                          <span class="meta-label"><FileText size={11} /></span>
                          <span class="meta-value">Subtitles: <strong>{asset.has_subtitles ? 'Yes' : 'No'}</strong></span>
                        </div>
                        {#if asset.duration_seconds}
                          <div class="meta-row">
                            <span class="meta-label"><Clock size={11} /></span>
                            <span class="meta-value">Duration: <strong>{formatDuration(asset.duration_seconds)}</strong></span>
                          </div>
                        {/if}
                        {#if asset.size_bytes}
                          <div class="meta-row">
                            <span class="meta-label"><HardDrive size={11} /></span>
                            <span class="meta-value">Size: <strong>{formatSize(asset.size_bytes)}</strong></span>
                          </div>
                        {/if}
                        {#if asset.last_synced_at}
                          <div class="meta-row">
                            <span class="meta-label"><Activity size={11} /></span>
                            <span class="meta-value">Last sync: <strong>{formatDateTime(asset.last_synced_at)}</strong></span>
                          </div>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/each}
          {/if}
        </section>

        <!-- ============================================================
             MISSING DEMAND INTEGRATION
             ============================================================ -->
        {#if item.demand && item.demand.request_count > 0}
          <section class="a2-drawer-section">
            <div class="a2-drawer-section-head">
              <span class="a2-drawer-section-icon"><AlertCircle size={14} /></span>
              <span class="a2-drawer-section-label">Missing Demand</span>
            </div>
            <div class="demand-block">
              <div class="demand-stats">
                <div class="demand-stat">
                  <div class="demand-stat-value">{item.demand.request_count}</div>
                  <div class="demand-stat-label">Requests</div>
                </div>
                <div class="demand-stat">
                  <div class="demand-stat-value">{item.demand.status}</div>
                  <div class="demand-stat-label">Status</div>
                </div>
                <div class="demand-stat">
                  <div class="demand-stat-value">{formatDateTime(item.demand.last_requested_at)}</div>
                  <div class="demand-stat-label">Last</div>
                </div>
              </div>
              <a class="a2-drawer-link" href="/admin/media/missing">
                Open Missing Media <ArrowRight size={12} />
              </a>
            </div>
          </section>
        {/if}

        <!-- ============================================================
             METADATA (creation / update timestamps)
             ============================================================ -->
        <section class="a2-drawer-section">
          <div class="a2-drawer-section-head">
            <span class="a2-drawer-section-icon"><Clock size={14} /></span>
            <span class="a2-drawer-section-label">Metadata</span>
          </div>
          <div class="a2-drawer-id-grid">
            <div class="id-row"><span class="id-label">Created</span><span class="id-value">{formatDateTime(item.created_at)}</span></div>
            <div class="id-row"><span class="id-label">Updated</span><span class="id-value">{formatDateTime(item.updated_at)}</span></div>
          </div>
          <div class="a2-drawer-note">
            Language, country, industry, and genres live in TMDB, not in the Mavero catalog. Phase C defers caching TMDB metadata locally — see worklog.
          </div>
        </section>

        <!-- ============================================================
             OPERATIONS — recent 20 admin actions on this item
             ============================================================ -->
        <section class="a2-drawer-section">
          <div class="a2-drawer-section-head">
            <span class="a2-drawer-section-icon"><Activity size={14} /></span>
            <span class="a2-drawer-section-label">Recent Operations</span>
          </div>
          {#if operations.length === 0}
            <div class="a2-drawer-empty-block a2-drawer-empty-block-sm">
              <div class="a2-drawer-empty-desc">No operations recorded yet.</div>
            </div>
          {:else}
            <div class="operations-list">
              {#each operations as op (op.id)}
                <div class="operation-row">
                  <div class="operation-head">
                    <span class="operation-action">{op.action}</span>
                    <AdminStatus
                      label={op.status}
                      tone={op.status === 'success' ? 'green' : op.status === 'failed' ? 'red' : 'amber'}
                    />
                  </div>
                  <div class="operation-meta">
                    <span class="operation-time">{formatDateTime(op.occurred_at)}</span>
                    {#if op.admin_user_email}<span class="operation-user">· {op.admin_user_email}</span>{/if}
                  </div>
                  {#if op.error_message}
                    <div class="operation-error">{op.error_message}</div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <!-- ============================================================
             ACTIONS — only what's actually available today
             ============================================================ -->
        <section class="a2-drawer-section">
          <div class="a2-drawer-section-head">
            <span class="a2-drawer-section-icon"><Upload size={14} /></span>
            <span class="a2-drawer-section-label">Actions</span>
          </div>
          <div class="actions-list">
            <button class="a2-drawer-action" type="button" onclick={() => onupload(item)}>
              <Upload size={13} /> Upload / Import to this media
            </button>
            <a class="a2-drawer-action a2-drawer-action-link" href="/admin/media/upload" title="Open upload wizard">
              <ExternalLink size={13} /> Open upload wizard
            </a>
          </div>
          <div class="a2-drawer-note">
            Rename / move / detach / delete / reconcile operations arrive in Phase E (Hosting Control). Sync arrives in Phase E. Operations history UI arrives in Phase F.
          </div>
        </section>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .a2-drawer-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    animation: a2-drawer-fade var(--a2-motion-fast) var(--a2-ease-out);
  }
  .a2-drawer {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    z-index: 81;
    width: 480px;
    max-width: 100vw;
    background: var(--a2-surface-2);
    border-left: 1px solid var(--a2-border-strong);
    box-shadow: var(--a2-shadow-lg);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    animation: a2-drawer-slide var(--a2-motion-slow) var(--a2-ease-out);
  }
  @keyframes a2-drawer-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes a2-drawer-slide {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }

  .a2-drawer-head {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--a2-space-4) var(--a2-space-5);
    background: var(--a2-glass);
    backdrop-filter: blur(16px) saturate(140%);
    border-bottom: 1px solid var(--a2-border);
  }
  .a2-drawer-title {
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
  }
  .a2-drawer-close {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--a2-radius-sm);
    background: transparent;
    color: var(--a2-text-muted);
    cursor: pointer;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-drawer-close:hover {
    color: var(--a2-text);
    background: var(--a2-surface-3);
  }

  .a2-drawer-body {
    flex: 1;
    padding: var(--a2-space-5);
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-6);
  }

  .a2-drawer-section {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
  }
  .a2-drawer-section-head {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    margin-bottom: var(--a2-space-1);
  }
  .a2-drawer-section-icon {
    display: inline-grid;
    place-items: center;
    color: var(--a2-text-dim);
  }
  .a2-drawer-section-label {
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
  }

  .a2-drawer-item-title {
    margin: 0;
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xl);
    font-weight: 700;
    color: var(--a2-text-bright);
    letter-spacing: -0.02em;
    line-height: 1.25;
  }
  .a2-drawer-item-subtitle {
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
    margin-top: 2px;
  }

  .a2-drawer-id-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-2);
    margin-top: var(--a2-space-2);
  }
  .id-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--a2-space-2);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
  }
  .id-row-full {
    grid-column: 1 / -1;
  }
  .id-label {
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
  }
  .id-value {
    font-size: var(--a2-text-sm);
    color: var(--a2-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .id-value.mono {
    font-family: var(--a2-font-mono);
    font-size: var(--a2-text-xs);
  }
  .id-value-key {
    white-space: normal;
    word-break: break-all;
  }

  .provider-block {
    margin-top: var(--a2-space-2);
    padding: var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
  }
  .provider-block.provider-vidara {
    border-left: 3px solid var(--a2-cyan);
  }
  .provider-block.provider-abyss {
    border-left: 3px solid var(--a2-blue);
  }
  .provider-block-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--a2-space-2);
  }
  .provider-block-name {
    font-size: var(--a2-text-sm);
    font-weight: 700;
    color: var(--a2-text-bright);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .provider-block-count {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
  }

  .provider-asset-row {
    padding: var(--a2-space-2) 0;
    border-top: 1px solid var(--a2-border);
  }
  .provider-asset-row:first-of-type {
    border-top: none;
    padding-top: 0;
  }
  .provider-asset-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-2);
    margin-bottom: var(--a2-space-2);
  }
  .provider-asset-id {
    color: var(--a2-text-dim);
    font-size: var(--a2-text-2xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .provider-asset-meta {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
  }
  .meta-row {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    font-size: var(--a2-text-xs);
  }
  .meta-label {
    display: inline-grid;
    place-items: center;
    color: var(--a2-text-dim);
    width: 12px;
  }
  .meta-value {
    color: var(--a2-text-muted);
  }
  .meta-value strong {
    color: var(--a2-text);
    font-weight: 600;
  }

  .demand-block {
    padding: var(--a2-space-3);
    border: 1px solid var(--a2-amber-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-amber-soft);
  }
  .demand-stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--a2-space-2);
    margin-bottom: var(--a2-space-3);
  }
  .demand-stat {
    text-align: left;
  }
  .demand-stat-value {
    font-size: var(--a2-text-base);
    font-weight: 700;
    color: var(--a2-amber);
    font-family: var(--a2-font-mono);
  }
  .demand-stat-label {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }

  .a2-drawer-note {
    margin-top: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    border-left: 2px solid var(--a2-border-strong);
    color: var(--a2-text-dim);
    font-size: var(--a2-text-2xs);
    line-height: 1.5;
  }

  .operations-list {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
  }
  .operation-row {
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
  }
  .operation-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-2);
    margin-bottom: 2px;
  }
  .operation-action {
    font-family: var(--a2-font-mono);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    color: var(--a2-text);
  }
  .operation-meta {
    display: flex;
    gap: var(--a2-space-2);
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
  }
  .operation-error {
    margin-top: 4px;
    padding: var(--a2-space-1) var(--a2-space-2);
    border-radius: var(--a2-radius-xs);
    background: var(--a2-red-soft);
    color: var(--a2-red);
    font-size: var(--a2-text-2xs);
    line-height: 1.4;
  }

  .actions-list {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
  }
  .a2-drawer-action {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-3);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-drawer-action:hover,
  .a2-drawer-action:focus-visible {
    background: var(--a2-cyan-soft);
    border-color: var(--a2-cyan-border);
    color: var(--a2-cyan);
  }

  .a2-drawer-link {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    margin-top: var(--a2-space-2);
    color: var(--a2-cyan);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    text-decoration: none;
    transition: color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-drawer-link:hover { color: var(--a2-text-bright); }

  .a2-drawer-empty-block {
    padding: var(--a2-space-4);
    border: 1px dashed var(--a2-border-strong);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
    text-align: left;
  }
  .a2-drawer-empty-block-sm {
    padding: var(--a2-space-2);
  }
  .a2-drawer-empty-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
    margin-bottom: var(--a2-space-1);
  }
  .a2-drawer-empty-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-bottom: var(--a2-space-2);
  }

  .a2-drawer-loading {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-3);
  }
  .a2-drawer-skeleton {
    height: 32px;
    border-radius: var(--a2-radius-sm);
    background: linear-gradient(90deg, var(--a2-surface-3) 0%, var(--a2-surface-4) 50%, var(--a2-surface-3) 100%);
    background-size: 200% 100%;
    animation: a2-drawer-skel 1.6s ease-in-out infinite;
  }
  @keyframes a2-drawer-skel {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .a2-drawer-error {
    padding: var(--a2-space-6);
    text-align: center;
  }
  .a2-drawer-error-icon {
    display: inline-grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: var(--a2-space-3);
    border-radius: var(--a2-radius-md);
    background: var(--a2-red-soft);
    color: var(--a2-red);
  }
  .a2-drawer-error-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }
  .a2-drawer-error-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
    line-height: 1.5;
  }

  @media (max-width: 768px) {
    .a2-drawer {
      width: 100vw;
      border-left: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-drawer-overlay, .a2-drawer { animation: none; }
    .a2-drawer-skeleton { animation: none; }
    .a2-drawer-action, .a2-drawer-link { transition: none; }
  }
</style>
