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
  import { invalidateAll } from '$app/navigation';
  import { X, Film, Tv, Sparkles, ExternalLink, Upload, AlertCircle, Activity, Clock, HardDrive, Languages, FileText, ArrowRight, Link2, FileVideo, Loader2, RefreshCw, PowerOff, Zap, Trash2, Pencil, FolderInput } from 'lucide-svelte';
  import AdminAssetStatus from './AdminAssetStatus.svelte';
  import AdminStatus from './AdminStatus.svelte';
  import type { LibraryMediaItem, LibraryOperationSummary, LibraryAssetSummary } from '$lib/server/hosting/library/service';
  import { adapterIdForSource, sourceNameForId } from '$lib/shared/hosting-source-helpers';

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

  // Phase C audit fix: provider source resolution now uses the CANONICAL
  // shared helpers from $lib/shared/hosting-source-helpers. This
  // eliminates the duplicated logic that existed in AdminMediaTable,
  // AdminMediaCard, and this component.
  //
  // Key behavioral change: sourceNameForId() now returns null (NOT
  // 'Unknown') when the source isn't in hostingSources. The caller
  // (providerGroups below) decides what label to render — for a
  // genuinely unknown source, this is a data-resolution error that
  // should be surfaced, not masked behind a misleading "UNKNOWN" label
  // that looks like a real provider name.
  const resolveAdapter = (sourceId: string | null): string | null => adapterIdForSource(hostingSources, sourceId);
  const resolveSourceName = (sourceId: string | null): string | null => sourceNameForId(hostingSources, sourceId);

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
  //
  // Phase C audit fix: if resolveAdapter() returns null (the source ID
  // is not in hostingSources — either the source was deleted, or the
  // hostingSources query failed), the group's adapterId is 'unresolved'
  // and the label explicitly calls out the data-resolution problem
  // instead of rendering "UNKNOWN" (which looked like a real provider
  // name and hid the underlying issue).
  type ProviderGroup = { adapterId: string; label: string; assets: LibraryAssetSummary[]; unresolved: boolean };
  const providerGroups = $derived.by(() => {
    if (!item) return [] as ProviderGroup[];
    const groups = new Map<string, ProviderGroup>();
    for (const asset of item.assets) {
      const resolved = resolveAdapter(asset.provider_source_id);
      const adapterId = resolved ?? 'unresolved';
      if (!groups.has(adapterId)) {
        const sourceName = resolveSourceName(asset.provider_source_id);
        const label = resolved === 'vidara' ? 'Vidara'
          : resolved === 'abyss' ? 'Abyss'
          : sourceName ?? 'Unresolved source';
        groups.set(adapterId, {
          adapterId,
          label,
          assets: [],
          unresolved: resolved === null,
        });
      }
      groups.get(adapterId)!.assets.push(asset);
    }
    return [...groups.values()];
  });

  // Map of Mavero-hosted adapter_id ('vidara' | 'abyss') → the first
  // matching streaming_source id. Used both to render "Not linked"
  // placeholder blocks for providers with no assets and to supply the
  // providerSourceId required by the link endpoint.
  const maveroSourceByAdapter = $derived.by(() => {
    const map = new Map<string, string>();
    for (const s of hostingSources) {
      if (s.adapterId === 'vidara' || s.adapterId === 'abyss') {
        if (!map.has(s.adapterId)) map.set(s.adapterId, s.id);
      }
    }
    return map;
  });

  // Unified provider availability blocks. Combines:
  //   1. Every provider group that already has at least one linked asset
  //      (from providerGroups above).
  //   2. Every Mavero-hosted provider (vidara/abyss) that has NO linked
  //      asset — rendered as a "Not linked" placeholder block so the
  //      admin can see at a glance which provider is missing and use
  //      the "Link existing file" action without leaving the drawer.
  //
  // `sourceId` is the streaming_source id needed to POST a link request.
  // For Mavero providers it comes from maveroSourceByAdapter; for other
  // providers it is inferred from the first asset (linking is only
  // offered for Mavero providers, so a null sourceId there is fine).
  type ProviderBlock = {
    adapterId: string;
    sourceId: string | null;
    label: string;
    assets: LibraryAssetSummary[];
    hasAssets: boolean;
    isMaveroHosted: boolean;
    /** True if the provider source could not be resolved (deleted source or query failure). */
    unresolved: boolean;
  };
  const providerBlocks = $derived.by(() => {
    if (!item) return [] as ProviderBlock[];
    const blocks: ProviderBlock[] = [];
    const linkedMaveroAdapters = new Set<string>();

    for (const group of providerGroups) {
      const isMavero = group.adapterId === 'vidara' || group.adapterId === 'abyss';
      const sourceId = isMavero
        ? (maveroSourceByAdapter.get(group.adapterId) ?? null)
        : (group.assets[0]?.provider_source_id ?? null);
      blocks.push({
        adapterId: group.adapterId,
        sourceId,
        label: group.label,
        assets: group.assets,
        hasAssets: true,
        isMaveroHosted: isMavero,
        unresolved: group.unresolved,
      });
      if (isMavero) linkedMaveroAdapters.add(group.adapterId);
    }

    // Append "Not linked" blocks for Mavero providers with no assets.
    for (const [adapterId, sourceId] of maveroSourceByAdapter) {
      if (linkedMaveroAdapters.has(adapterId)) continue;
      blocks.push({
        adapterId,
        sourceId,
        label: adapterId === 'vidara' ? 'Vidara' : 'Abyss',
        assets: [],
        hasAssets: false,
        isMaveroHosted: true,
        unresolved: false,
      });
    }

    return blocks;
  });

  // ============================================================
  // "Link existing file" sheet state + handlers
  //
  // Opens a stacked modal above the drawer that fetches the provider's
  // unlinked files and lets the admin manually pick one to link to the
  // current media item. No auto-matching — the admin explicitly chooses.
  // On success the sheet closes and invalidateAll() refreshes the
  // library data so the newly linked asset appears immediately.
  // ============================================================
  type UnlinkedFile = {
    providerAssetId: string;
    title: string | null;
    filename: string | null;
    sizeBytes: number | null;
    durationSeconds: number | null;
    status: string;
    playbackUrl: string | null;
  };

  let linkSheetOpen = $state(false);
  let linkSheetAdapterId = $state<string | null>(null);
  let linkSheetSourceId = $state<string | null>(null);
  let linkSheetLabel = $state<string>('');
  let linkFiles = $state<UnlinkedFile[]>([]);
  let linkLoading = $state(false);
  let linkError = $state<string | null>(null);
  let linkingAssetId = $state<string | null>(null);

  // Reset link sheet state when the drawer closes so a stale sheet
  // never re-renders on the next open.
  $effect(() => {
    if (!open && linkSheetOpen) {
      linkSheetOpen = false;
      linkSheetAdapterId = null;
      linkSheetSourceId = null;
      linkSheetLabel = '';
      linkFiles = [];
      linkError = null;
      linkingAssetId = null;
    }
  });

  async function openLinkSheet(adapterId: string, sourceId: string, label: string) {
    linkSheetAdapterId = adapterId;
    linkSheetSourceId = sourceId;
    linkSheetLabel = label;
    linkSheetOpen = true;
    linkLoading = true;
    linkError = null;
    linkFiles = [];
    linkingAssetId = null;
    try {
      const res = await fetch(`/api/admin/hosting/providers/${adapterId}/files`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      linkFiles = (json.files ?? []) as UnlinkedFile[];
    } catch (err) {
      linkError = err instanceof Error ? err.message : 'Failed to load unlinked files.';
    } finally {
      linkLoading = false;
    }
  }

  function closeLinkSheet() {
    linkSheetOpen = false;
    linkSheetAdapterId = null;
    linkSheetSourceId = null;
    linkSheetLabel = '';
    linkFiles = [];
    linkError = null;
    linkingAssetId = null;
  }

  function handleLinkKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeLinkSheet();
    }
  }

  async function linkFile(file: UnlinkedFile) {
    if (!item || !linkSheetSourceId || !file.providerAssetId) return;
    linkingAssetId = file.providerAssetId;
    linkError = null;
    try {
      const res = await fetch('/api/admin/media/assets/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mediaItemId: item.id,
          providerSourceId: linkSheetSourceId,
          providerAssetId: file.providerAssetId,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      closeLinkSheet();
      // Refresh all server load functions so the library list, folder
      // summary, and hosting sources all reflect the newly linked asset.
      await invalidateAll();
    } catch (err) {
      linkError = err instanceof Error ? err.message : 'Failed to link file.';
    } finally {
      linkingAssetId = null;
    }
  }

  // ============================================================
  // Provider asset management actions: detach, reactivate, reconcile
  // ============================================================

  let actionLoading = $state<string | null>(null); // '<assetId>:<action>' when in-flight
  let actionError = $state<string | null>(null);
  let actionSuccess = $state<string | null>(null);
  let confirmDialog = $state<{ assetId: string; action: 'detach' | 'delete' } | null>(null);

  // Rename + Move modal state (Phase 2C consolidation — these actions
  // are now exposed in the Media Library drawer, consolidating the
  // Hosting Assets drawer's per-asset management into the canonical
  // media workspace).
  let renameModal = $state<{ assetId: string; currentName: string; newName: string } | null>(null);
  let moveModal = $state<{ assetId: string; targetFolderId: string } | null>(null);

  // Reset action state when drawer closes.
  $effect(() => {
    if (!open) {
      actionLoading = null;
      actionError = null;
      actionSuccess = null;
      confirmDialog = null;
      renameModal = null;
      moveModal = null;
    }
  });

  function isActionLoading(assetId: string, action: string): boolean {
    return actionLoading === `${assetId}:${action}`;
  }

  async function detachAsset(assetId: string) {
    confirmDialog = null;
    actionLoading = `${assetId}:detach`;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${assetId}/detach`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      actionSuccess = 'Asset detached. Remote provider file was NOT deleted.';
      await invalidateAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Failed to detach asset.';
    } finally {
      actionLoading = null;
    }
  }

  async function reactivateAsset(assetId: string) {
    actionLoading = `${assetId}:reactivate`;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${assetId}/reactivate`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      actionSuccess = 'Asset reactivated. Playback restored.';
      await invalidateAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Failed to reactivate asset.';
    } finally {
      actionLoading = null;
    }
  }

  async function reconcileAsset(assetId: string) {
    actionLoading = `${assetId}:reconcile`;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${assetId}/reconcile`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      actionSuccess = 'Asset reconciled with provider.';
      await invalidateAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Failed to reconcile asset.';
    } finally {
      actionLoading = null;
    }
  }

  // Phase 2C consolidation: Delete, Rename, Move — these were previously
  // only available in the Hosting Assets drawer. They now live in the
  // Media Library drawer so the admin has ONE canonical place to manage
  // provider assets. The endpoints are the same (POST /api/admin/media/assets/:id/{action}).

  async function deleteAsset(assetId: string) {
    confirmDialog = null;
    actionLoading = `${assetId}:delete`;
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${assetId}/delete`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error?.message ?? json?.result?.error?.message ?? `HTTP ${res.status}`);
      actionSuccess = 'Asset deleted from provider. Mavero asset marked as deleted.';
      await invalidateAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Failed to delete asset.';
    } finally {
      actionLoading = null;
    }
  }

  async function confirmRename() {
    if (!renameModal || !renameModal.newName.trim()) return;
    const { assetId, newName } = renameModal;
    actionLoading = `${assetId}:rename`;
    actionError = null;
    actionSuccess = null;
    renameModal = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${assetId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: newName.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      actionSuccess = 'Asset renamed at provider.';
      await invalidateAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Failed to rename asset.';
    } finally {
      actionLoading = null;
    }
  }

  async function confirmMove() {
    if (!moveModal) return;
    const { assetId, targetFolderId } = moveModal;
    actionLoading = `${assetId}:move`;
    actionError = null;
    actionSuccess = null;
    moveModal = null;
    try {
      const res = await fetch(`/api/admin/media/assets/${assetId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetFolderId: targetFolderId.trim() || null }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      actionSuccess = 'Asset moved at provider.';
      await invalidateAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Failed to move asset.';
    } finally {
      actionLoading = null;
    }
  }
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
          {#if providerBlocks.length === 0}
            <div class="a2-drawer-empty-block">
              <div class="a2-drawer-empty-title">No provider assets linked</div>
              <div class="a2-drawer-empty-desc">This media item has no Vidara or Abyss assets. Upload one to make it playable.</div>
              <button class="a2-drawer-action" type="button" onclick={() => onupload(item)}>
                <Upload size={13} /> Upload to provider
              </button>
            </div>
          {:else}
            {#each providerBlocks as block (block.adapterId)}
              <div class="provider-block provider-{block.adapterId}" class:provider-unresolved={block.unresolved}>
                <div class="provider-block-head">
                  <span class="provider-block-name">{block.label}</span>
                  <div class="provider-block-head-right">
                    {#if block.unresolved}
                      <span class="provider-block-status is-unresolved" title="The provider source for this asset could not be resolved. It may have been deleted, or the hosting sources query failed.">
                        Unresolved
                      </span>
                    {:else}
                      <span class="provider-block-status {block.hasAssets ? 'is-linked' : 'is-unlinked'}">
                        {block.hasAssets ? 'Linked' : 'Not linked'}
                      </span>
                    {/if}
                    {#if block.hasAssets && block.assets.length > 1}
                      <span class="provider-block-count">{block.assets.length} assets</span>
                    {/if}
                  </div>
                </div>
                {#if block.unresolved}
                  <div class="provider-block-unresolved-notice">
                    The provider source for this asset could not be resolved. This usually means
                    the streaming source was deleted after the asset was created, or the hosting
                    sources query failed. The asset still exists but its provider identity is unknown.
                  </div>
                {/if}
                {#if block.hasAssets}
                  {#each block.assets as asset (asset.id)}
                    <div class="provider-asset-row">
                      <div class="provider-asset-head">
                        <AdminAssetStatus status={asset.status} maveroStatus={asset.mavero_status} />
                        {#if asset.provider_asset_id}
                          <span class="provider-asset-id mono" title="Provider asset id">{asset.provider_asset_id}</span>
                        {/if}
                      </div>
                      {#if asset.status === 'ready' && asset.mavero_status === 'available'}
                        <div class="provider-asset-meta">
                          {#if block.adapterId === 'vidara' && asset.source_quality}
                            <div class="meta-row">
                              <span class="meta-label"><HardDrive size={11} /></span>
                              <span class="meta-value">Quality: <strong>{asset.source_quality}</strong></span>
                            </div>
                          {/if}
                          {#if block.adapterId === 'abyss' && asset.available_qualities.length}
                            <div class="meta-row">
                              <span class="meta-label"><HardDrive size={11} /></span>
                              <span class="meta-value">Variants: <strong>{formatQualities(asset.available_qualities)}</strong></span>
                            </div>
                          {/if}
                          {#if asset.audio_languages.length}
                            <div class="meta-row">
                              <span class="meta-label"><Languages size={11} /></span>
                              <span class="meta-value">Audio: <strong>{formatAudio(asset.audio_languages)}</strong>{#if block.adapterId === 'vidara' && asset.audio_languages.length > 1} (multi){/if}</span>
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
                      <!-- State-aware action buttons per asset -->
                      <div class="provider-asset-actions">
                        {#if asset.mavero_status === 'available' || asset.mavero_status === 'processing'}
                          <!-- LINKED: Reconcile + Detach -->
                          <button
                            class="a2-drawer-action a2-drawer-action-sm"
                            type="button"
                            onclick={() => reconcileAsset(asset.id)}
                            disabled={actionLoading !== null}
                            title="Re-check provider status"
                          >
                            {#if isActionLoading(asset.id, 'reconcile')}<Loader2 size={13} style="animation: a2-spin 1s linear infinite;" /> Reconciling…{:else}<RefreshCw size={13} /> Reconcile{/if}
                          </button>
                          <button
                            class="a2-drawer-action a2-drawer-action-sm a2-drawer-action-danger"
                            type="button"
                            onclick={() => { confirmDialog = { assetId: asset.id, action: 'detach' }; }}
                            disabled={actionLoading !== null}
                            title="Detach from this media item (remote file preserved)"
                          >
                            <PowerOff size={13} /> Detach
                          </button>
                        {:else if asset.mavero_status === 'missing' && asset.status !== 'deleted'}
                          <!-- DETACHED (not deleted): Reactivate.
                               A deleted asset (status='deleted') has no remote
                               file — Reactivate is not offered. The backend
                               also enforces this (ASSET_DELETED error). -->
                          <button
                            class="a2-drawer-action a2-drawer-action-sm a2-drawer-action-success"
                            type="button"
                            onclick={() => reactivateAsset(asset.id)}
                            disabled={actionLoading !== null}
                            title="Restore playback — sets mavero_status back to available"
                          >
                            {#if isActionLoading(asset.id, 'reactivate')}<Loader2 size={13} style="animation: a2-spin 1s linear infinite;" /> Reactivating…{:else}<Zap size={13} /> Reactivate{/if}
                          </button>
                        {/if}
                      </div>
                      <!-- Provider file actions: Rename, Move, Delete.
                           These operate on the provider-side file directly.
                           Available for ANY asset with a provider_asset_id,
                           regardless of mavero_status (linked/detached).
                           Consolidated from the Hosting Assets drawer. -->
                      {#if asset.provider_asset_id}
                        <div class="provider-asset-actions provider-asset-actions-file">
                          <button
                            class="a2-drawer-action a2-drawer-action-sm"
                            type="button"
                            onclick={() => { renameModal = { assetId: asset.id, currentName: asset.provider_asset_id ?? '', newName: asset.provider_asset_id ?? '' }; }}
                            disabled={actionLoading !== null}
                            title="Rename the provider-side file"
                          >
                            <Pencil size={13} /> Rename
                          </button>
                          <button
                            class="a2-drawer-action a2-drawer-action-sm"
                            type="button"
                            onclick={() => { moveModal = { assetId: asset.id, targetFolderId: '' }; }}
                            disabled={actionLoading !== null}
                            title="Move the provider-side file to a different folder"
                          >
                            <FolderInput size={13} /> Move
                          </button>
                          <button
                            class="a2-drawer-action a2-drawer-action-sm a2-drawer-action-danger"
                            type="button"
                            onclick={() => { confirmDialog = { assetId: asset.id, action: 'delete' }; }}
                            disabled={actionLoading !== null}
                            title="Permanently delete the file from the provider"
                          >
                            {#if isActionLoading(asset.id, 'delete')}<Loader2 size={13} style="animation: a2-spin 1s linear infinite;" /> Deleting…{:else}<Trash2 size={13} /> Delete{/if}
                          </button>
                        </div>
                      {/if}
                    </div>
                  {/each}
                {:else}
                  <div class="provider-block-notlinked">
                    <div class="provider-block-notlinked-desc">No {block.label} file linked to this media item yet. Upload a new file or link an existing one from the provider.</div>
                  </div>
                {/if}
                {#if block.isMaveroHosted && block.sourceId}
                  <button
                    class="a2-drawer-action a2-drawer-action-sm provider-link-btn"
                    type="button"
                    onclick={() => { if (block.sourceId) openLinkSheet(block.adapterId, block.sourceId, block.label); }}
                  >
                    <Link2 size={13} /> Link existing file
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
          {#if actionError}
            <div class="a2-drawer-action-error" role="alert"><AlertCircle size={13} /> {actionError}</div>
          {/if}
          {#if actionSuccess}
            <div class="a2-drawer-action-success-msg" role="status"><RefreshCw size={13} /> {actionSuccess}</div>
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
                    {#if op.admin_user_display_name}<span class="operation-user">· {op.admin_user_display_name}</span>{/if}
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

  <!-- ============================================================
       Detach confirmation dialog — renders above the drawer.
       Explicitly states that the remote provider file will NOT be deleted.
       ============================================================ -->
  {#if confirmDialog}
    <div class="a2-confirm-overlay" onclick={() => { confirmDialog = null; }} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="a2-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="a2-confirm-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        {#if confirmDialog.action === 'detach'}
          <h3 id="a2-confirm-title" class="a2-confirm-title"><PowerOff size={16} /> Detach provider asset?</h3>
          <p class="a2-confirm-desc">This will detach the provider asset from this media item. Playback will stop until the asset is reactivated or re-linked.</p>
          <p class="a2-confirm-note"><strong>The remote provider file will NOT be deleted.</strong> It remains available at the provider and can be re-linked later.</p>
          <div class="a2-confirm-actions">
            <button class="a2-drawer-action a2-drawer-action-sm" type="button" onclick={() => { confirmDialog = null; }} disabled={actionLoading !== null}>Cancel</button>
            <button class="a2-drawer-action a2-drawer-action-sm a2-drawer-action-danger" type="button" onclick={() => { if (confirmDialog) detachAsset(confirmDialog.assetId); }} disabled={actionLoading !== null}>
              {#if isActionLoading(confirmDialog.assetId, 'detach')}<Loader2 size={13} style="animation: a2-spin 1s linear infinite;" /> Detaching…{:else}<PowerOff size={13} /> Detach{/if}
            </button>
          </div>
        {:else if confirmDialog.action === 'delete'}
          <h3 id="a2-confirm-title" class="a2-confirm-title"><Trash2 size={16} /> Delete provider file?</h3>
          <p class="a2-confirm-desc">This will <strong>permanently delete the file from the provider</strong> (Vidara/Abyss). The Mavero media asset will be marked as deleted.</p>
          <p class="a2-confirm-note"><strong>This action cannot be undone.</strong> The file will be removed from the provider's servers. If you only want to unlink without deleting, use Detach instead.</p>
          <div class="a2-confirm-actions">
            <button class="a2-drawer-action a2-drawer-action-sm" type="button" onclick={() => { confirmDialog = null; }} disabled={actionLoading !== null}>Cancel</button>
            <button class="a2-drawer-action a2-drawer-action-sm a2-drawer-action-danger" type="button" onclick={() => { if (confirmDialog) deleteAsset(confirmDialog.assetId); }} disabled={actionLoading !== null}>
              {#if isActionLoading(confirmDialog.assetId, 'delete')}<Loader2 size={13} style="animation: a2-spin 1s linear infinite;" /> Deleting…{:else}<Trash2 size={13} /> Delete permanently{/if}
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ============================================================
       Rename modal — renders above the drawer.
       ============================================================ -->
  {#if renameModal}
    <div class="a2-confirm-overlay" onclick={() => { renameModal = null; }} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="a2-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="a2-rename-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        <h3 id="a2-rename-title" class="a2-confirm-title"><Pencil size={16} /> Rename provider file</h3>
        <p class="a2-confirm-desc">Enter a new name for the provider-side file. This calls the provider's rename API.</p>
        <label class="a2-rename-field">
          <span class="a2-rename-label">New name</span>
          <input
            type="text"
            class="a2-rename-input"
            value={renameModal.newName}
            oninput={(e) => { renameModal!.newName = (e.target as HTMLInputElement).value; }}
            placeholder="New file name"
            autocomplete="off"
          />
        </label>
        <div class="a2-confirm-actions">
          <button class="a2-drawer-action a2-drawer-action-sm" type="button" onclick={() => { renameModal = null; }} disabled={actionLoading !== null}>Cancel</button>
          <button class="a2-drawer-action a2-drawer-action-sm a2-drawer-action-primary" type="button" onclick={confirmRename} disabled={actionLoading !== null || !renameModal.newName.trim()}>
            {#if renameModal.assetId && isActionLoading(renameModal.assetId, 'rename')}<Loader2 size={13} style="animation: a2-spin 1s linear infinite;" /> Renaming…{:else}<Pencil size={13} /> Rename{/if}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ============================================================
       Move modal — renders above the drawer.
       ============================================================ -->
  {#if moveModal}
    <div class="a2-confirm-overlay" onclick={() => { moveModal = null; }} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="a2-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="a2-move-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        <h3 id="a2-move-title" class="a2-confirm-title"><FolderInput size={16} /> Move provider file</h3>
        <p class="a2-confirm-desc">Enter the destination folder ID at the provider. Leave empty to move to the root folder.</p>
        <label class="a2-rename-field">
          <span class="a2-rename-label">Target folder ID</span>
          <input
            type="text"
            class="a2-rename-input"
            value={moveModal.targetFolderId}
            oninput={(e) => { moveModal!.targetFolderId = (e.target as HTMLInputElement).value; }}
            placeholder="Folder ID (leave empty for root)"
            autocomplete="off"
          />
        </label>
        <div class="a2-confirm-actions">
          <button class="a2-drawer-action a2-drawer-action-sm" type="button" onclick={() => { moveModal = null; }} disabled={actionLoading !== null}>Cancel</button>
          <button class="a2-drawer-action a2-drawer-action-sm a2-drawer-action-primary" type="button" onclick={confirmMove} disabled={actionLoading !== null}>
            {#if moveModal.assetId && isActionLoading(moveModal.assetId, 'move')}<Loader2 size={13} style="animation: a2-spin 1s linear infinite;" /> Moving…{:else}<FolderInput size={13} /> Move{/if}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ============================================================
       "Link existing file" stacked sheet — renders above the drawer.
       Only shown when linkSheetOpen is true. Contains its own overlay,
       Escape handler, and loading / error / empty / list states.
       ============================================================ -->
  {#if linkSheetOpen}
    <div
      class="a2-link-overlay"
      onclick={() => closeLinkSheet()}
      aria-hidden="true"
    ></div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <aside
      class="a2-link-sheet a2-scroll"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      aria-label="Link existing file"
      onkeydown={handleLinkKeydown}
    >
      <header class="a2-link-head">
        <div class="a2-link-titles">
          <span class="a2-link-title">Link existing {linkSheetLabel} file</span>
          <span class="a2-link-desc">Select a provider file to link to this media item. No auto-matching — choose carefully.</span>
        </div>
        <button class="a2-link-close" type="button" onclick={() => closeLinkSheet()} aria-label="Close link sheet">
          <X size={16} />
        </button>
      </header>
      <div class="a2-link-body">
        {#if linkLoading}
          <div class="a2-link-state a2-link-loading">
            <Loader2 size={20} class="a2-spin" />
            <span>Loading unlinked {linkSheetLabel} files…</span>
          </div>
        {:else if linkError}
          <div class="a2-link-state a2-link-error">
            <div class="a2-link-state-icon"><AlertCircle size={20} /></div>
            <div class="a2-link-state-title">Failed to load files</div>
            <div class="a2-link-state-desc">{linkError}</div>
            {#if linkSheetAdapterId && linkSheetSourceId}
              <button
                class="a2-drawer-action a2-drawer-action-sm"
                type="button"
                onclick={() => linkSheetAdapterId && linkSheetSourceId && openLinkSheet(linkSheetAdapterId, linkSheetSourceId, linkSheetLabel)}
              >
                <RefreshCw size={13} /> Retry
              </button>
            {/if}
          </div>
        {:else if linkFiles.length === 0}
          <div class="a2-link-state a2-link-empty">
            <div class="a2-link-state-icon"><FileVideo size={20} /></div>
            <div class="a2-link-state-title">No unlinked files</div>
            <div class="a2-link-state-desc">All {linkSheetLabel} files are already linked to media items, or the provider has no uploaded files yet.</div>
          </div>
        {:else}
          <div class="a2-link-list">
            {#each linkFiles as file (file.providerAssetId)}
              <div class="a2-link-file">
                <div class="a2-link-file-main">
                  <div class="a2-link-file-title">
                    <FileVideo size={13} />
                    <span>{file.title || file.filename || file.providerAssetId}</span>
                  </div>
                  <div class="a2-link-file-meta">
                    <span class="a2-link-file-code mono" title="Provider asset id (filecode)">{file.providerAssetId}</span>
                    {#if file.filename}
                      <span class="a2-link-file-sep">·</span>
                      <span class="a2-link-file-name" title={file.filename}>{file.filename}</span>
                    {/if}
                  </div>
                  <div class="a2-link-file-meta a2-link-file-stats">
                    {#if file.sizeBytes}
                      <span class="a2-link-file-stat"><HardDrive size={11} /> {formatSize(file.sizeBytes)}</span>
                    {/if}
                    {#if file.durationSeconds}
                      <span class="a2-link-file-sep">·</span>
                      <span class="a2-link-file-stat"><Clock size={11} /> {formatDuration(file.durationSeconds)}</span>
                    {/if}
                    <span class="a2-link-file-sep">·</span>
                    <span class="a2-link-file-stat a2-link-file-status">{file.status}</span>
                  </div>
                </div>
                <button
                  class="a2-link-file-btn"
                  type="button"
                  disabled={linkingAssetId !== null}
                  onclick={() => linkFile(file)}
                >
                  {#if linkingAssetId === file.providerAssetId}
                    <Loader2 size={13} class="a2-spin" /> Linking…
                  {:else}
                    <Link2 size={13} /> Link
                  {/if}
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </aside>
  {/if}
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
    padding-top: env(safe-area-inset-top, 0px);
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
    min-width: 44px;
    min-height: 44px;
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

  /* ============================================================
     Provider block additions — status pill + "Not linked" body + link button
     ============================================================ */
  .provider-block-head-right {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
  }
  .provider-block-status {
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 2px var(--a2-space-2);
    border-radius: var(--a2-radius-xs);
    border: 1px solid var(--a2-border);
  }
  .provider-block-status.is-linked {
    color: var(--a2-cyan);
    background: var(--a2-cyan-soft);
    border-color: var(--a2-cyan-border);
  }
  .provider-block-status.is-unlinked {
    color: var(--a2-amber);
    background: var(--a2-amber-soft);
    border-color: var(--a2-amber-border);
  }
  .provider-block-status.is-unresolved {
    color: var(--a2-red);
    background: var(--a2-red-soft);
    border-color: var(--a2-red-border);
  }
  .provider-block-unresolved-notice {
    font-size: var(--a2-text-xs);
    color: var(--a2-red);
    line-height: 1.5;
    padding: var(--a2-space-2) var(--a2-space-3);
    margin: var(--a2-space-2) 0;
    background: var(--a2-red-soft);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
  }
  .provider-block.provider-unresolved {
    border-color: var(--a2-red-border);
  }
  .provider-block-notlinked {
    padding: var(--a2-space-2) 0;
  }
  .provider-block-notlinked-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    line-height: 1.5;
  }
  .a2-drawer-action-sm {
    padding: var(--a2-space-1) var(--a2-space-2);
    font-size: var(--a2-text-xs);
    gap: var(--a2-space-1);
  }
  .provider-link-btn {
    margin-top: var(--a2-space-2);
    width: fit-content;
  }

  /* ============================================================
     "Link existing file" stacked sheet — renders above the drawer
     ============================================================ */
  .a2-link-overlay {
    position: fixed;
    inset: 0;
    z-index: 82;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    animation: a2-drawer-fade var(--a2-motion-fast) var(--a2-ease-out);
  }
  .a2-link-sheet {
    position: fixed;
    z-index: 83;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, calc(100vw - 32px));
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-lg);
    box-shadow: var(--a2-shadow-lg);
    overflow: hidden;
    animation: a2-link-pop var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-link-pop {
    from { transform: translate(-50%, -50%) scale(.96); opacity: 0; }
    to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }
  .a2-link-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--a2-space-3);
    padding: var(--a2-space-4) var(--a2-space-4) var(--a2-space-3);
    border-bottom: 1px solid var(--a2-border);
    flex: 0 0 auto;
  }
  .a2-link-titles { min-width: 0; flex: 1; }
  .a2-link-title {
    display: block;
    font-size: var(--a2-text-base);
    font-weight: 700;
    color: var(--a2-text-bright);
    letter-spacing: -0.01em;
    line-height: 1.2;
  }
  .a2-link-desc {
    display: block;
    margin-top: 2px;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    line-height: 1.5;
  }
  .a2-link-close {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text-muted);
    background: transparent;
    cursor: pointer;
    flex: 0 0 auto;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-link-close:hover {
    color: var(--a2-text);
    border-color: var(--a2-cyan-border);
  }
  .a2-link-body {
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--a2-space-3) var(--a2-space-4);
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
  }

  /* Shared loading / error / empty state styling */
  .a2-link-state {
    padding: var(--a2-space-6);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--a2-space-2);
  }
  .a2-link-state-icon {
    display: inline-grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: var(--a2-space-1);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
    color: var(--a2-text-dim);
  }
  .a2-link-error .a2-link-state-icon {
    background: var(--a2-red-soft);
    color: var(--a2-red);
  }
  .a2-link-state-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }
  .a2-link-state-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    line-height: 1.5;
    max-width: 360px;
  }
  .a2-link-loading {
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
  }

  /* File list */
  .a2-link-list {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
  }
  .a2-link-file {
    display: flex;
    align-items: flex-start;
    gap: var(--a2-space-3);
    padding: var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-link-file:hover {
    border-color: var(--a2-cyan-border);
  }
  .a2-link-file-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
  }
  .a2-link-file-title {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .a2-link-file-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .a2-link-file-meta {
    display: flex;
    align-items: center;
    gap: var(--a2-space-1);
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    flex-wrap: wrap;
  }
  .a2-link-file-code {
    color: var(--a2-text-muted);
    font-size: var(--a2-text-2xs);
  }
  .a2-link-file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 280px;
  }
  .a2-link-file-sep {
    color: var(--a2-text-dim);
  }
  .a2-link-file-stat {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .a2-link-file-status {
    text-transform: capitalize;
  }
  .a2-link-file-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-1);
    padding: var(--a2-space-1) var(--a2-space-3);
    border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    cursor: pointer;
    flex: 0 0 auto;
    white-space: nowrap;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-link-file-btn:hover:not(:disabled) {
    background: var(--a2-surface-3);
    border-color: var(--a2-cyan);
  }
  .a2-link-file-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .a2-spin {
    animation: a2-spin 0.9s linear infinite;
  }
  @keyframes a2-spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 768px) {
    .a2-drawer {
      width: 100vw;
      border-left: none;
    }
    .a2-link-sheet {
      top: auto;
      bottom: 0;
      left: 0;
      right: 0;
      transform: none;
      width: 100%;
      max-height: 90vh;
      border-radius: var(--a2-radius-lg) var(--a2-radius-lg) 0 0;
      border-bottom: none;
      animation: a2-link-slide-up var(--a2-motion-normal, 240ms) var(--a2-ease-out);
    }
    @keyframes a2-link-slide-up {
      from { transform: translateY(100%); }
      to   { transform: translateY(0); }
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-drawer-overlay, .a2-drawer { animation: none; }
    .a2-drawer-skeleton { animation: none; }
    .a2-drawer-action, .a2-drawer-link { transition: none; }
    .a2-link-overlay, .a2-link-sheet { animation: none; }
    .a2-spin { animation: none; }
  }

  /* Provider asset action buttons */
  .provider-asset-actions { display: flex; gap: var(--a2-space-2); margin-top: var(--a2-space-2); flex-wrap: wrap; }
  .provider-asset-actions-file { padding-top: var(--a2-space-1); border-top: 1px dashed var(--a2-border); }
  .a2-rename-field { display: flex; flex-direction: column; gap: 4px; }
  .a2-rename-label { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-rename-input { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 8px 10px; font-family: var(--a2-font-mono); }
  .a2-rename-input:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-drawer-action-primary { background: var(--a2-cyan-soft); border-color: var(--a2-cyan-border); color: var(--a2-cyan); }
  .a2-drawer-action-danger { color: var(--a2-red); border-color: var(--a2-red-border); }
  .a2-drawer-action-danger:hover { background: var(--a2-red-soft); border-color: var(--a2-red); }
  .a2-drawer-action-success { color: var(--a2-green); border-color: var(--a2-green-border); }
  .a2-drawer-action-success:hover { background: var(--a2-green-soft); border-color: var(--a2-green); }
  .a2-drawer-action-error { display: flex; align-items: center; gap: 6px; padding: var(--a2-space-2) var(--a2-space-3); margin-top: var(--a2-space-2); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-2xs); }
  .a2-drawer-action-success-msg { display: flex; align-items: center; gap: 6px; padding: var(--a2-space-2) var(--a2-space-3); margin-top: var(--a2-space-2); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-2xs); }

  /* Detach confirmation dialog */
  .a2-confirm-overlay { position: fixed; inset: 0; z-index: 84; background: rgba(0, 0, 0, .6); display: flex; align-items: center; justify-content: center; padding: var(--a2-space-4); }
  .a2-confirm-dialog { width: 100%; max-width: 400px; background: var(--a2-surface-2); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-md); padding: var(--a2-space-4); display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .a2-confirm-title { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0; font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-confirm-desc { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted); line-height: 1.5; }
  .a2-confirm-note { margin: 0; font-size: var(--a2-text-xs); color: var(--a2-text); line-height: 1.5; padding: var(--a2-space-2); background: var(--a2-surface-3); border-radius: var(--a2-radius-sm); }
  .a2-confirm-actions { display: flex; gap: var(--a2-space-2); justify-content: flex-end; }

  @media (max-width: 640px) {
    .a2-confirm-dialog { max-width: 100%; }
    .a2-confirm-actions { flex-direction: column-reverse; }
    .a2-confirm-actions .a2-drawer-action { width: 100%; justify-content: center; }
    .provider-asset-actions { flex-direction: column; }
    .provider-asset-actions .a2-drawer-action { width: 100%; justify-content: center; }
  }
</style>
