<script lang="ts">
  /**
   * Admin 2.0 — AdminHostingAssets — THE Media Library file manager.
   *
   * The single asset-centric workspace for every hosted provider file
   * (media_assets joined with media_items + provider metadata):
   *   - Provider (Vidara / Abyss)
   *   - File name + provider asset ID
   *   - Linked media (or DETACHED badge)
   *   - Type (movie/series/anime)
   *   - Status (queued/uploading/uploaded/processing/ready/failed/deleted)
   *   - Quality (source_quality for Vidara, available_qualities for Abyss)
   *   - Audio (multi-audio indicator for Vidara)
   *   - Subtitles (yes/no)
   *   - Updated
   *   - Actions (reconcile / rename / move / detach / delete / reactivate)
   *
   * Server-side pagination + filtering + search + FACET COUNTS via
   * GET /api/admin/hosting/assets — the ONE canonical read model. rows,
   * search results, filters, counts, and the pagination total are all
   * derived from the same dataset.
   *
   * DELETED files are terminal: the default status filter is 'active'
   * (excludes deleted), and the explicit Deleted view shows them with NO
   * remote-mutation actions. After a successful delete the drawer
   * immediately reflects the terminal state.
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
   *   - reactivate: detached assets only (backend rejects deleted)
   *
   * URL state: provider / q / contentType / linked / status / sort /
   * mediaItem / page are read from the page server (initialFilters) and
   * kept in sync — this is what makes Hosting Control's provider
   * deep-link (?provider=vidara) and the Jobs/Activity/Attention
   * media deep-links (?mediaItem=<id>) work end-to-end.
   *
   * Mobile: table collapses to a card list; filters open the
   * Mavero-native chip-based AdminFilterSheet (no native <select>).
   */

  import { onMount, onDestroy } from 'svelte';
  import { Search, Filter, X, ChevronLeft, ChevronRight, Pencil, FolderInput, Unlink, Trash2, RefreshCw, ExternalLink, AlertCircle, Loader2, HardDrive, FileVideo, Check, Film, Tv, Sparkles, Zap, Link2 } from 'lucide-svelte';
  import AdminStatus from './AdminStatus.svelte';
  import AdminConfirmDialog from './AdminConfirmDialog.svelte';
  import type { HostingAssetRow, HostingAssetQuery, HostingAssetFacetCounts } from '$lib/shared/hosting-types';
  import type { ProviderCapabilities } from '$lib/server/hosting/types';
  import AdminFilterSheet from './AdminFilterSheet.svelte';

  let {
    initialFilters = {} as Partial<HostingAssetQuery>,
    providers = [] as Array<{ adapterId: string; name: string; capabilities: ProviderCapabilities }>,
    onopenprovider = (() => {}) as (adapterId: string) => void,
  }: {
    initialFilters?: Partial<HostingAssetQuery>;
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
  // Facet counts from the SAME inventory dataset (file counts).
  let counts = $state<HostingAssetFacetCounts | null>(null);

  // The single canonical filter state. DEFAULT status='active': terminal
  // deleted files are EXCLUDED from the normal inventory, search, counts,
  // and pagination — 'deleted' is an explicit opt-in audit view.
  // Initialized from the page server's URL params (provider deep-links from
  // Hosting Control, mediaItem deep-links from Jobs/Activity/Attention).
  // svelte-ignore state_referenced_locally
  let filters = $state<HostingAssetQuery>({
    q: initialFilters.q ?? '',
    provider: initialFilters.provider ?? 'all',
    linked: initialFilters.linked ?? 'all',
    status: initialFilters.status ?? 'active',
    contentType: initialFilters.contentType ?? 'all',
    hasSubtitles: null,
    sort: initialFilters.sort ?? 'recently_updated',
    mediaItemId: initialFilters.mediaItemId ?? null,
    page: 1,
    limit: 25,
  });

  let selectedAsset = $state<HostingAssetRow | null>(null);
  let drawerOpen = $state(false);
  let drawerLoading = $state(false);
  let mobileFiltersOpen = $state(false);

  // Management action state is declared in the executeAction section below.

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
      // status default 'active' is the API default — only send when the
      // admin explicitly picked something else.
      if (filters.status && filters.status !== 'active') params.set('status', String(filters.status));
      if (filters.contentType && filters.contentType !== 'all') params.set('contentType', String(filters.contentType));
      if (filters.hasSubtitles === true) params.set('hasSubtitles', 'true');
      else if (filters.hasSubtitles === false) params.set('hasSubtitles', 'false');
      if (filters.mediaItemId) params.set('mediaItem', filters.mediaItemId);
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
        counts = data.counts ?? null;
      } else {
        listError = data.error?.message ?? 'Failed to load assets.';
      }
    } catch {
      listError = 'Network error while loading assets.';
    }
    loading = false;
  }

  // Keep the URL in sync with the filter state — clean Media Library URLs
  // (no legacy ?tab=assets), preserving every canonical param so reload /
  // share / back-navigation reproduces the exact same dataset.
  function syncUrl() {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.provider && filters.provider !== 'all') params.set('provider', String(filters.provider));
    if (filters.linked && filters.linked !== 'all') params.set('linked', String(filters.linked));
    if (filters.status && filters.status !== 'active') params.set('status', String(filters.status));
    if (filters.contentType && filters.contentType !== 'all') params.set('contentType', String(filters.contentType));
    if (filters.hasSubtitles === true) params.set('hasSubtitles', 'true');
    else if (filters.hasSubtitles === false) params.set('hasSubtitles', 'false');
    if (filters.mediaItemId) params.set('mediaItem', filters.mediaItemId);
    if (filters.sort && filters.sort !== 'recently_updated') params.set('sort', String(filters.sort));
    if (page > 1) params.set('page', String(page));
    const url = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`;
    window.history.replaceState(null, '', url);
  }

  async function debouncedSearch() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      filters.page = 1;
      void loadAssets().then(() => syncUrl());
    }, 300);
  }

  // Re-fetch when filters change (except q, which is debounced).
  // svelte-ignore state_referenced_locally
  let lastProvider = $state(filters.provider);
  // svelte-ignore state_referenced_locally
  let lastLinked = $state(filters.linked);
  // svelte-ignore state_referenced_locally
  let lastStatus = $state(filters.status);
  // svelte-ignore state_referenced_locally
  let lastContentType = $state(filters.contentType);
  // svelte-ignore state_referenced_locally
  let lastHasSubtitles = $state(filters.hasSubtitles);
  // svelte-ignore state_referenced_locally
  let lastSort = $state(filters.sort);
  // svelte-ignore state_referenced_locally
  let lastMediaItem = $state(filters.mediaItemId);

  $effect(() => {
    if (
      filters.provider !== lastProvider ||
      filters.linked !== lastLinked ||
      filters.status !== lastStatus ||
      filters.contentType !== lastContentType ||
      filters.hasSubtitles !== lastHasSubtitles ||
      filters.sort !== lastSort ||
      filters.mediaItemId !== lastMediaItem
    ) {
      lastProvider = filters.provider;
      lastLinked = filters.linked;
      lastStatus = filters.status;
      lastContentType = filters.contentType;
      lastHasSubtitles = filters.hasSubtitles;
      lastSort = filters.sort;
      lastMediaItem = filters.mediaItemId;
      filters.page = 1;
      void loadAssets().then(() => syncUrl());
    }
  });

  onMount(() => {
    void loadAssets().then(() => syncUrl());
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
  function isDetached(asset: HostingAssetRow): boolean {
    // DETACHED (not "unlinked"): mavero_status='missing' — an admin
    // detached the asset from playback; the row still belongs to its
    // canonical media_item (media_item_id is NOT NULL) and the remote
    // file may still exist.
    return asset.maveroStatus === 'missing';
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
    void loadAssets().then(() => syncUrl());
  }
  function pagePrev() {
    if ((filters.page ?? 1) <= 1) return;
    filters.page = (filters.page ?? 1) - 1;
    void loadAssets().then(() => syncUrl());
  }

  function clearFilters() {
    filters = { q: '', provider: 'all', linked: 'all', status: 'active', contentType: 'all', hasSubtitles: null, sort: 'recently_updated', mediaItemId: null, page: 1, limit: 25 };
    void loadAssets().then(() => syncUrl());
  }

  const activeFilterCount = $derived(
    (filters.provider && filters.provider !== 'all' ? 1 : 0) +
    (filters.linked !== 'all' ? 1 : 0) +
    (filters.status !== 'active' && filters.status !== 'all' ? 1 : 0) +
    (filters.contentType !== 'all' ? 1 : 0) +
    (filters.hasSubtitles !== null ? 1 : 0) +
    (filters.mediaItemId ? 1 : 0)
  );

  // Media-item deep-link chip (from Jobs / Activity / Attention).
  let deepLinkMediaTitle = $state<string | null>(null);
  $effect(() => {
    if (filters.mediaItemId && items.length > 0) {
      const found = items.find((i) => i.mediaItem?.id === filters.mediaItemId);
      deepLinkMediaTitle = found?.mediaItem?.title ?? null;
    } else if (!filters.mediaItemId) {
      deepLinkMediaTitle = null;
    }
  });

  function clearMediaItemFilter() {
    filters.mediaItemId = null;
  }

  // ============================================================
  // Management actions
  // ============================================================
  // Tracks WHICH action is in progress (not just a boolean) so the UI
  // can show a specific loading state on the clicked button and keep
  // other buttons disabled.
  let actionInProgress = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let actionSuccess = $state<string | null>(null);

  async function executeAction(asset: HostingAssetRow, action: 'rename' | 'move' | 'detach' | 'delete' | 'reconcile' | 'reactivate', body?: Record<string, unknown>) {
    actionInProgress = action;
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
        // Refresh the drawer's selected asset:
        //  - DELETE: the asset is TERMINAL (status='deleted', mavero_status='missing')
        //    and is excluded from the reloaded (active) list, so reflect the
        //    server-confirmed terminal state locally — the drawer immediately
        //    renders the "permanently deleted, no actions" notice and the
        //    Delete button disappears. No second click can call the provider
        //    (the backend is idempotent as a second guard).
        //  - Other actions: update from the reloaded list when present.
        const sel = selectedAsset;
        if (sel) {
          if (action === 'delete') {
            selectedAsset = { ...sel, status: 'deleted', maveroStatus: 'missing' };
          } else {
            const updated = items.find((i) => i.id === sel.id);
            if (updated) selectedAsset = updated;
          }
        }
        syncUrl();
      } else {
        // Provider failure — surface the real error from the API.
        // Do NOT close the drawer; keep the asset available for retry.
        // The error message from ManagementService.deleteAsset includes
        // the real provider error code (e.g. VALIDATION, NOT_FOUND)
        // and message, so the admin knows exactly what went wrong.
        actionError = data.error?.message ?? data.result?.error?.message ?? `${action} failed.`;
        // Reload the list anyway so the failed operation appears in the
        // asset's operation history (if the drawer shows it). This also
        // ensures the asset's status is current — the service does NOT
        // mark it deleted on failure, so it should still be in the list.
        await loadAssets();
      }
    } catch (err) {
      // Network error (fetch threw) — separate from provider errors.
      actionError = err instanceof Error
        ? `Network error: ${err.message}`
        : `Network error during ${action}.`;
    }
    actionInProgress = null;
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

  // ============================================================
  // Reactivate — for detached assets (mavero_status='missing').
  // Calls the canonical POST /api/admin/media/assets/:id/reactivate
  // endpoint. This is a Mavero lifecycle operation — it does NOT
  // depend on provider capabilities (no remote call, no upload).
  // ============================================================
  async function reactivate(asset: HostingAssetRow) {
    await executeAction(asset, 'reactivate');
  }

  // ============================================================
  // Link Existing File — header-level action for GENUINE provider-side
  // files that have NO media_assets row (uploaded out-of-band via the
  // Vidara/Abyss dashboard and discovered by provider sync). The old
  // drawer-based variant was gated on mediaItem===null, which is an
  // impossible state under the NOT NULL media_item_id constraint (dead
  // path) — it has been removed.
  //
  // Flow: pick a provider file (from
  // /api/admin/hosting/providers/[adapterId]/files — files NOT in
  // media_assets), then search for and select the canonical media_item,
  // then call POST /api/admin/media/assets/link with
  // { mediaItemId, providerSourceId, providerAssetId } — which INSERTs
  // a new media_assets row with current provider metadata.
  // ============================================================
  let linkModalOpen = $state(false);
  let linkFilesLoading = $state(false);
  let linkFilesError = $state<string | null>(null);
  // Untracked provider files available for linking, keyed by adapter.
  let linkProviderFiles = $state<Array<{ providerAdapterId: string; providerAssetId: string; title: string | null; filename: string | null; status: string }>>([]);
  let linkSelectedFile = $state<{ providerAdapterId: string; providerAssetId: string; title: string | null; filename: string | null } | null>(null);
  let linkSearchQuery = $state('');
  let linkSearchLoading = $state(false);
  let linkSearchResults = $state<Array<{ id: string; title: string; content_type: string; year: number | null; tmdb_id: string; canonical_key: string }>>([]);
  let linkSelectedMediaItemId = $state<string | null>(null);
  let linkSearchDebounce: ReturnType<typeof setTimeout> | null = null;
  // providerSourceId for the selected provider file (resolved during load).
  let linkSourceIdByAdapter = $state<Record<string, string>>({});

  async function startLinkExistingFlow() {
    linkModalOpen = true;
    linkSelectedFile = null;
    linkSearchQuery = '';
    linkSearchResults = [];
    linkSelectedMediaItemId = null;
    linkFilesError = null;
    await loadProviderFilesForLink();
    // Trigger an initial empty search to show some items.
    void searchMediaItems('');
  }

  async function loadProviderFilesForLink() {
    linkFilesLoading = true;
    linkFilesError = null;
    linkProviderFiles = [];
    try {
      // Resolve the provider sources (for providerSourceId) via the
      // canonical resolver-backed sources already loaded by the page —
      // fall back to the hosting providers API.
      const files: typeof linkProviderFiles = [];
      const sourceMap: Record<string, string> = {};
      for (const p of providers) {
        try {
          const res = await fetch(`/api/admin/hosting/providers/${encodeURIComponent(p.adapterId)}/files`);
          const data = await res.json();
          if (data.ok && Array.isArray(data.files)) {
            for (const f of data.files) {
              files.push({
                providerAdapterId: p.adapterId,
                providerAssetId: f.providerAssetId,
                title: f.title ?? null,
                filename: f.filename ?? null,
                status: f.status,
              });
            }
          }
        } catch {
          // Per-provider failure is non-fatal — other providers still load.
        }
      }
      // providerSourceId per adapter comes from the page's hostingSources
      // (passed as `providers` — we need the source ids though). We fetch
      // them from the providers overview endpoint, which includes sourceId.
      try {
        const res = await fetch('/api/admin/hosting/providers?skipHealth=1');
        const data = await res.json();
        if (data.ok && Array.isArray(data.providers)) {
          for (const p of data.providers) {
            if (p.adapterId && p.sourceId) sourceMap[p.adapterId] = p.sourceId;
          }
        }
      } catch {
        // Non-fatal — confirmLink validates and surfaces a precise error.
      }
      linkSourceIdByAdapter = sourceMap;
      linkProviderFiles = files;
      if (files.length === 0) {
        linkFilesError = 'No untracked provider files found. Run a provider sync (Hosting Control → Sync) to discover files uploaded outside Mavero.';
      }
    } catch (err) {
      linkFilesError = err instanceof Error ? err.message : 'Failed to load provider files.';
    } finally {
      linkFilesLoading = false;
    }
  }

  function closeLinkModal() {
    linkModalOpen = false;
    linkSelectedFile = null;
    linkSearchQuery = '';
    linkSearchResults = [];
    linkSelectedMediaItemId = null;
    if (linkSearchDebounce) { clearTimeout(linkSearchDebounce); linkSearchDebounce = null; }
  }

  function onLinkSearchInput() {
    if (linkSearchDebounce) clearTimeout(linkSearchDebounce);
    linkSearchDebounce = setTimeout(() => {
      void searchMediaItems(linkSearchQuery);
    }, 300);
  }

  async function searchMediaItems(q: string) {
    linkSearchLoading = true;
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      params.set('limit', '20');
      const res = await fetch(`/api/admin/media/library?${params.toString()}`);
      const json = await res.json();
      if (json.ok) {
        linkSearchResults = (json.items ?? []).map((item: any) => ({
          id: item.id,
          title: item.title,
          content_type: item.content_type,
          year: item.year,
          tmdb_id: item.tmdb_id,
          canonical_key: item.canonical_key,
        }));
      } else {
        linkSearchResults = [];
      }
    } catch {
      linkSearchResults = [];
    } finally {
      linkSearchLoading = false;
    }
  }

  async function confirmLink() {
    if (!linkSelectedFile || !linkSelectedMediaItemId) return;
    const file = linkSelectedFile;
    const providerSourceId = linkSourceIdByAdapter[file.providerAdapterId];
    if (!providerSourceId) {
      linkFilesError = `Could not resolve the Mavero source for provider "${file.providerAdapterId}". Check the provider configuration and retry.`;
      return;
    }
    actionInProgress = 'link';
    actionError = null;
    actionSuccess = null;
    try {
      const res = await fetch('/api/admin/media/assets/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaItemId: linkSelectedMediaItemId,
          providerSourceId,
          providerAssetId: file.providerAssetId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        actionSuccess = `Provider file ${file.providerAssetId} linked to the selected media item.`;
        closeLinkModal();
        await loadAssets();
        const sel = selectedAsset;
        if (sel) {
          const updated = items.find((i) => i.id === sel.id);
          if (updated) selectedAsset = updated;
        }
        syncUrl();
      } else {
        linkFilesError = data.error?.message ?? 'Link failed.';
      }
    } catch (err) {
      linkFilesError = err instanceof Error ? `Network error: ${err.message}` : 'Network error during link.';
    } finally {
      actionInProgress = null;
    }
  }
</script>

<section class="a2-hosting-assets" aria-label="Assets">
  <!-- Filter bar -->
  <div class="a2-assets-filters">
    <div class="a2-assets-search">
      <Search size={14} style="position: absolute; left: var(--a2-space-3); color: var(--a2-text-dim); pointer-events: none;" />
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

    <!-- Media-item deep-link chip (Jobs / Activity / Attention → "Open media") -->
    {#if filters.mediaItemId}
      <div class="a2-assets-deeplink" role="status">
        <FileVideo size={12} />
        <span class="a2-assets-deeplink-label">
          Showing files of {deepLinkMediaTitle ?? 'one media item'}
        </span>
        <button type="button" class="a2-assets-deeplink-clear" onclick={clearMediaItemFilter} aria-label="Clear media filter">
          <X size={11} />
        </button>
      </div>
    {/if}

    <!-- Content-type filter chips — FILE counts derived from the SAME
         inventory dataset (facet semantics: counts update when the other
         filters change; deleted files never contribute to the default). -->
    <div class="a2-assets-chip-row" role="group" aria-label="Filter by content type">
      <span class="a2-assets-chip-row-label">Type · files</span>
      <button
        type="button"
        class="a2-assets-chip"
        class:active={filters.contentType === 'all'}
        aria-pressed={filters.contentType === 'all'}
        onclick={() => { filters.contentType = 'all'; }}
      >All {counts?.contentType.all ?? ''}</button>
      <button
        type="button"
        class="a2-assets-chip"
        class:active={filters.contentType === 'movie'}
        aria-pressed={filters.contentType === 'movie'}
        onclick={() => { filters.contentType = 'movie'; }}
      >Movie {counts?.contentType.movie ?? ''}</button>
      <button
        type="button"
        class="a2-assets-chip"
        class:active={filters.contentType === 'series'}
        aria-pressed={filters.contentType === 'series'}
        onclick={() => { filters.contentType = 'series'; }}
      >Series {counts?.contentType.series ?? ''}</button>
      <button
        type="button"
        class="a2-assets-chip"
        class:active={filters.contentType === 'anime'}
        aria-pressed={filters.contentType === 'anime'}
        onclick={() => { filters.contentType = 'anime'; }}
      >Anime {counts?.contentType.anime ?? ''}</button>
    </div>

    <!-- Provider filter chips — FILE counts from the same dataset (the
         provider facet scope). Clicking Vidara here is exactly what the
         Hosting Control "Open assets" deep-link initializes. -->
    <div class="a2-assets-chip-row" role="group" aria-label="Filter by provider">
      <span class="a2-assets-chip-row-label">Provider · files</span>
      <button
        type="button"
        class="a2-assets-chip"
        class:active={filters.provider === 'all'}
        aria-pressed={filters.provider === 'all'}
        onclick={() => { filters.provider = 'all'; }}
      >All {counts?.provider.all ?? ''}</button>
      {#each providers as p (p.adapterId)}
        <button
          type="button"
          class="a2-assets-chip"
          class:active={filters.provider === p.adapterId}
          aria-pressed={filters.provider === p.adapterId}
          onclick={() => { filters.provider = p.adapterId; }}
        >{p.name} {counts?.provider[p.adapterId] ?? ''}</button>
      {/each}
    </div>

    <div class="a2-assets-filter-row">
      <label class="a2-assets-filter">
        <span class="a2-assets-filter-label">Link state</span>
        <select bind:value={filters.linked} class="a2-assets-select">
          <option value="all">All</option>
          <option value="linked">Linked</option>
          <option value="detached">Detached</option>
        </select>
      </label>
      <label class="a2-assets-filter">
        <span class="a2-assets-filter-label">Status</span>
        <select bind:value={filters.status} class="a2-assets-select">
          <option value="active">Active (default)</option>
          <option value="ready">Ready</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
          <option value="deleted">Deleted (terminal)</option>
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
      <!-- Link Existing File — for provider-side files NOT yet tracked in
           media_assets (out-of-band uploads discovered by sync). -->
      <button type="button" class="a2-assets-link-existing" onclick={startLinkExistingFlow} disabled={actionInProgress !== null}>
        <Link2 size={12} /> Link Existing File
      </button>
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
    <!-- Phase 2 mobile: card list (visible <768px). Mirrors the table data
         in a stacked card layout. Tapping a card opens the same drawer. -->
    <ul class="a2-assets-card-list" role="list">
      {#each items as asset (asset.id)}
        <li>
          <button type="button" class="a2-assets-card" class:is-detached={isDetached(asset)} onclick={() => openDetail(asset)}>
            <div class="a2-assets-card-head">
              <span class="a2-assets-provider-badge" data-adapter={asset.providerAdapterId ?? ''}>{asset.providerAdapterId ?? '—'}</span>
              <AdminStatus label={statusLabel(asset.status)} tone={statusTone(asset.status)} />
              {#if isDetached(asset)}<span class="a2-assets-detached-badge">DETACHED</span>{/if}
            </div>
            <div class="a2-assets-card-file" title={asset.filename ?? asset.title ?? '—'}>
              {asset.filename ?? asset.title ?? '—'}
            </div>
            {#if asset.providerAssetId}<div class="a2-assets-card-id mono">{asset.providerAssetId}</div>{/if}
            {#if asset.mediaItem}
              <div class="a2-assets-card-media">
                {#if asset.mediaItem.contentType === 'movie'}<Film size={10} />{:else if asset.mediaItem.contentType === 'anime'}<Sparkles size={10} />{:else}<Tv size={10} />{/if}
                {asset.mediaItem.title}
                {#if asset.mediaItem.season != null && asset.mediaItem.episode != null}
                  · S{String(asset.mediaItem.season).padStart(2, '0')}E{String(asset.mediaItem.episode).padStart(2, '0')}
                {/if}
              </div>
            {/if}
            <div class="a2-assets-card-chips">
              <span class="a2-assets-chip mono">{formatQuality(asset)}</span>
              <span class="a2-assets-chip" title={asset.audioLanguages.join(', ') || '—'}>Audio: {formatAudio(asset)}</span>
              <span class="a2-assets-chip">{#if asset.hasSubtitles}Subs: ✓{:else}Subs: —{/if}</span>
              <span class="a2-assets-chip mono">Updated {formatDate(asset.updatedAt)}</span>
            </div>
          </button>
        </li>
      {/each}
    </ul>
    <!-- Desktop table (hidden <768px) -->
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
            <tr onclick={() => openDetail(asset)} class="a2-assets-row" class:is-detached={isDetached(asset)}>
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
                {#if isDetached(asset)}
                  <span class="a2-assets-detached-badge">DETACHED</span>
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

  <!-- Mobile filter sheet — Mavero-native chip-based filter UI (no native
       browser <select> on mobile; single-select chips per dimension,
       grouped sections, Apply/Clear, focus trap, safe-area). -->
  <AdminFilterSheet
    open={mobileFiltersOpen}
    title="Filters"
    sections={[
      {
        dimension: 'provider',
        heading: 'Provider · files',
        options: [
          { value: 'all', label: 'All', count: counts?.contentType.all },
          ...providers.map((p) => ({ value: p.adapterId, label: p.name, count: counts?.provider[p.adapterId] })),
        ],
      },
      {
        dimension: 'contentType',
        heading: 'Type · files',
        options: [
          { value: 'all', label: 'All', count: counts?.contentType.all },
          { value: 'movie', label: 'Movie', count: counts?.contentType.movie },
          { value: 'series', label: 'Series', count: counts?.contentType.series },
          { value: 'anime', label: 'Anime', count: counts?.contentType.anime },
        ],
      },
      {
        dimension: 'linked',
        heading: 'Link state',
        options: [
          { value: 'all', label: 'All' },
          { value: 'linked', label: 'Linked' },
          { value: 'detached', label: 'Detached' },
        ],
      },
      {
        dimension: 'status',
        heading: 'Status',
        options: [
          { value: 'active', label: 'Active (default)' },
          { value: 'ready', label: 'Ready' },
          { value: 'processing', label: 'Processing' },
          { value: 'failed', label: 'Failed' },
          { value: 'deleted', label: 'Deleted (terminal)' },
        ],
      },
      {
        dimension: 'sort',
        heading: 'Sort',
        options: [
          { value: 'recently_updated', label: 'Recently updated' },
          { value: 'recently_added', label: 'Recently added' },
          { value: 'status', label: 'Status' },
          { value: 'provider', label: 'Provider' },
        ],
      },
    ]}
    selected={{
      provider: filters.provider ?? 'all',
      contentType: filters.contentType ?? 'all',
      linked: filters.linked ?? 'all',
      status: filters.status ?? 'active',
      sort: filters.sort ?? 'recently_updated',
    }}
    onApply={(applied) => {
      filters.provider = (applied.provider as HostingAssetQuery['provider']) ?? 'all';
      filters.contentType = (applied.contentType as HostingAssetQuery['contentType']) ?? 'all';
      filters.linked = (applied.linked as HostingAssetQuery['linked']) ?? 'all';
      filters.status = (applied.status as HostingAssetQuery['status']) ?? 'active';
      filters.sort = (applied.sort as HostingAssetQuery['sort']) ?? 'recently_updated';
    }}
    onClear={clearFilters}
    onClose={() => { mobileFiltersOpen = false; }}
  />

  <!-- Detail drawer -->
  {#if drawerOpen && selectedAsset}
    {@const caps = capsForAdapter(selectedAsset.providerAdapterId)}
    <div class="a2-asset-drawer-overlay" onclick={() => { drawerOpen = false; }} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="a2-asset-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="a2-asset-drawer-title"
        tabindex="-1"
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
          {#if actionInProgress}
            <div class="a2-asset-action-loading" role="status" aria-live="polite">
              <Loader2 size={14} style="animation: a2-spin 1s linear infinite;" />
              <span>{actionInProgress.charAt(0).toUpperCase() + actionInProgress.slice(1)} in progress…</span>
            </div>
          {/if}
          {#if actionSuccess}
            <p class="a2-asset-action-success" role="status"><Check size={12} /> {actionSuccess}</p>
          {/if}
          {#if actionError}
            <div class="a2-asset-action-error-box" role="alert">
              <AlertCircle size={14} />
              <div>
                <strong>Action failed.</strong>
                <p>{actionError}</p>
                {#if actionError.includes('Network error')}
                  <p class="a2-asset-action-error-hint">Check your network connection and try again.</p>
                {:else}
                  <p class="a2-asset-action-error-hint">The provider rejected the request. The asset was NOT deleted and is still available for retry. Check the operation history for details.</p>
                {/if}
              </div>
            </div>
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
            {#if selectedAsset.status === 'deleted'}
              <div class="a2-asset-drawer-unlinked">
                <Trash2 size={16} />
                <div>
                  <p class="a2-asset-drawer-unlinked-title">DELETED FILE — TERMINAL</p>
                  <p class="a2-asset-drawer-unlinked-desc">
                    This provider file was permanently deleted. The canonical media item is
                    preserved (Missing Media / demand tracking), and the historical delete
                    operation remains in Hosting Control → Activity.
                  </p>
                </div>
              </div>
            {:else if isDetached(selectedAsset)}
              <div class="a2-asset-drawer-unlinked">
                <Unlink size={16} />
                <div>
                  <p class="a2-asset-drawer-unlinked-title">DETACHED — NOT SERVED FOR PLAYBACK</p>
                  <p class="a2-asset-drawer-unlinked-desc">
                    {#if selectedAsset.mediaItem}
                      An admin detached this asset from {selectedAsset.mediaItem.title} — the
                      row still belongs to that canonical media item, and the provider file
                      may still exist. Reactivate to restore playback.
                    {:else}
                      This asset has no media link — impossible under the current schema.
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

            {#if selectedAsset.status === 'deleted'}
              <!-- DELETED state: terminal — no actions available.
                   The provider file has been permanently deleted.
                   Historical details remain in Operations Activity. -->
              <div class="a2-asset-deleted-notice" role="status">
                <Trash2 size={14} />
                <span>This provider file has been permanently deleted. No actions are available.</span>
              </div>
            {:else}
            <div class="a2-asset-drawer-actions">
              <!-- Reconcile: available for any non-deleted asset with a provider_asset_id -->
              <button type="button" class="a2-asset-action" onclick={() => reconcile(selectedAsset!)} disabled={actionInProgress !== null || !selectedAsset.providerAssetId}>
                {#if actionInProgress === 'reconcile'}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<RefreshCw size={12} />{/if}
                {actionInProgress === 'reconcile' ? 'Reconciling…' : 'Reconcile'}
              </button>

              <!-- Reactivate: shown ONLY for DETACHED assets (mavero_status='missing'
                   AND status != 'deleted'). A deleted asset has no remote file —
                   reactivating it would create a phantom. The backend also enforces
                   this (ASSET_DELETED error). -->
              {#if selectedAsset.maveroStatus === 'missing'}
                <button type="button" class="a2-asset-action a2-asset-action-success" onclick={() => reactivate(selectedAsset!)} disabled={actionInProgress !== null}>
                  {#if actionInProgress === 'reactivate'}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<Zap size={12} />{/if}
                  {actionInProgress === 'reactivate' ? 'Reactivating…' : 'Reactivate'}
                </button>
              {/if}

              <!-- (The old drawer-level "Link Existing" button — gated on
                   mediaItem===null, an impossible state under the NOT NULL
                   media_item_id constraint — was removed. The legitimate
                   Link Existing File flow for untracked provider files is
                   the header action above.) -->

              <!-- Rename: provider capability gate -->
              <button type="button" class="a2-asset-action" onclick={() => startRename(selectedAsset!)} disabled={actionInProgress !== null || !caps?.rename || !selectedAsset.providerAssetId}>
                {#if actionInProgress === 'rename'}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<Pencil size={12} />{/if}
                {actionInProgress === 'rename' ? 'Renaming…' : 'Rename'}
                {#if !caps?.rename}<span class="a2-asset-action-unsupported">unsupported</span>{/if}
              </button>
              <!-- Move: provider capability gate -->
              <button type="button" class="a2-asset-action" onclick={() => startMove(selectedAsset!)} disabled={actionInProgress !== null || !caps?.folderManagement || !selectedAsset.providerAssetId}>
                {#if actionInProgress === 'move'}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<FolderInput size={12} />{/if}
                {actionInProgress === 'move' ? 'Moving…' : 'Move'}
                {#if !caps?.folderManagement}<span class="a2-asset-action-unsupported">unsupported</span>{/if}
              </button>
              <!-- Detach: Mavero lifecycle operation (no provider capability gate).
                   Only meaningful for LINKED assets (has mediaItem). -->
              {#if selectedAsset.mediaItem}
                <button type="button" class="a2-asset-action a2-asset-action-warn" onclick={() => startDetach(selectedAsset!)} disabled={actionInProgress !== null}>
                  {#if actionInProgress === 'detach'}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<Unlink size={12} />{/if}
                  {actionInProgress === 'detach' ? 'Detaching…' : 'Detach'}
                </button>
              {/if}
              <!-- Delete: provider capability gate -->
              <button type="button" class="a2-asset-action a2-asset-action-danger" onclick={() => startDelete(selectedAsset!)} disabled={actionInProgress !== null || !caps?.delete || !selectedAsset.providerAssetId}>
                {#if actionInProgress === 'delete'}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<Trash2 size={12} />{/if}
                {actionInProgress === 'delete' ? 'Deleting…' : 'Delete'}
                {#if !caps?.delete}<span class="a2-asset-action-unsupported">unsupported</span>{/if}
              </button>
            </div>
            {/if}
          </section>
        </div>
      </div>
    </div>
  {/if}

  <!-- Rename modal -->
  {#if renameOpen && selectedAsset}
    <div class="a2-asset-modal-overlay" onclick={() => { renameOpen = false; }} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="a2-asset-modal" role="dialog" aria-modal="true" aria-labelledby="a2-asset-rename-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
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
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="a2-asset-modal" role="dialog" aria-modal="true" aria-labelledby="a2-asset-move-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
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
      : 'This detaches the asset from playback: the resolver will no longer serve it. The row stays linked to its canonical media item and the provider file is NOT deleted — Reactivate can restore it later.'}
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

  <!-- Link Existing File modal — pick an UNTRACKED provider-side file (no
       media_assets row; discovered via the provider files API) and a
       canonical media_item, then link them via
       POST /api/admin/media/assets/link (which INSERTs the row). -->
  {#if linkModalOpen}
    <div class="a2-asset-modal-overlay" onclick={() => closeLinkModal()} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="a2-asset-modal a2-asset-modal-wide" role="dialog" aria-modal="true" aria-labelledby="a2-asset-link-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        <h2 id="a2-asset-link-title" class="a2-asset-modal-title"><Link2 size={16} /> Link existing provider file</h2>
        <p class="a2-asset-modal-desc">
          Link a provider-side file that is NOT yet tracked by Mavero (uploaded out-of-band,
          discovered via provider sync) to a canonical media item. This creates the
          media_assets link and resolves any open demand.
        </p>

        {#if linkFilesLoading}
          <div class="a2-asset-link-search" role="status">
            <Loader2 size={14} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" />
            <span>Loading provider files…</span>
          </div>
        {:else}
          {#if linkFilesError}
            <div class="a2-asset-action-error-box" role="alert" style="margin-bottom: 10px;">
              <AlertCircle size={14} />
              <div><p>{linkFilesError}</p></div>
            </div>
          {/if}

          <h3 class="a2-asset-modal-step">1. Provider file</h3>
          <div class="a2-asset-link-results" style="max-height: 180px;">
            {#if linkProviderFiles.length === 0 && !linkFilesLoading}
              <div class="a2-asset-link-empty">No untracked provider files available.</div>
            {/if}
            {#each linkProviderFiles as file (file.providerAdapterId + ':' + file.providerAssetId)}
              <button
                type="button"
                class="a2-asset-link-result"
                class:selected={linkSelectedFile?.providerAssetId === file.providerAssetId && linkSelectedFile?.providerAdapterId === file.providerAdapterId}
                onclick={() => { linkSelectedFile = file; }}
              >
                <div class="a2-asset-link-result-icon">
                  <FileVideo size={14} />
                </div>
                <div class="a2-asset-link-result-info">
                  <div class="a2-asset-link-result-title">{file.filename ?? file.title ?? file.providerAssetId}</div>
                  <div class="a2-asset-link-result-meta">
                    <span>{file.providerAdapterId}</span>
                    <span>· {file.providerAssetId}</span>
                    <span>· {file.status}</span>
                  </div>
                </div>
                {#if linkSelectedFile?.providerAssetId === file.providerAssetId && linkSelectedFile?.providerAdapterId === file.providerAdapterId}
                  <span class="a2-asset-link-result-check"><Check size={14} /></span>
                {/if}
              </button>
            {/each}
          </div>

          <h3 class="a2-asset-modal-step">2. Media item</h3>
          <div class="a2-asset-link-search">
            <input
              type="text"
              class="a2-asset-modal-input"
              placeholder="Search by title, TMDB ID, IMDb ID, or canonical key…"
              bind:value={linkSearchQuery}
              oninput={onLinkSearchInput}
              autocomplete="off"
            />
            {#if linkSearchLoading}
              <Loader2 size={14} style="animation: a2-spin 1s linear infinite; color: var(--a2-text-dim);" />
            {/if}
          </div>
          <div class="a2-asset-link-results">
            {#if linkSearchResults.length === 0 && !linkSearchLoading}
              <div class="a2-asset-link-empty">
                {#if linkSearchQuery.trim()}
                  No media items match "{linkSearchQuery}".
                {:else}
                  Start typing to search, or browse the list below.
                {/if}
              </div>
            {/if}
            {#each linkSearchResults as item (item.id)}
              <button
                type="button"
                class="a2-asset-link-result"
                class:selected={linkSelectedMediaItemId === item.id}
                onclick={() => { linkSelectedMediaItemId = item.id; }}
              >
                <div class="a2-asset-link-result-icon">
                  {#if item.content_type === 'movie'}<Film size={14} />{:else if item.content_type === 'anime'}<Sparkles size={14} />{:else}<Tv size={14} />{/if}
                </div>
                <div class="a2-asset-link-result-info">
                  <div class="a2-asset-link-result-title">{item.title}</div>
                  <div class="a2-asset-link-result-meta">
                    <span>{item.content_type}</span>
                    {#if item.year}<span>· {item.year}</span>{/if}
                    <span>· TMDB {item.tmdb_id}</span>
                  </div>
                </div>
                {#if linkSelectedMediaItemId === item.id}
                  <span class="a2-asset-link-result-check"><Check size={14} /></span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
        <footer class="a2-asset-modal-actions">
          <button type="button" class="a2-asset-modal-btn a2-asset-modal-cancel" onclick={closeLinkModal}>Cancel</button>
          <button type="button" class="a2-asset-modal-btn a2-asset-modal-confirm" onclick={confirmLink} disabled={!linkSelectedFile || !linkSelectedMediaItemId || actionInProgress !== null}>
            {#if actionInProgress === 'link'}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" /> Linking…{:else}<Link2 size={12} /> Link file to media item{/if}
          </button>
        </footer>
      </div>
    </div>
  {/if}
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
  .a2-assets-table tbody tr.is-detached { background: var(--a2-amber-soft); }
  .a2-assets-table tbody tr.is-detached:hover { background: var(--a2-surface-3); }
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

  .a2-assets-detached-badge {
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

  /* ---- Facet chip filters (content type + provider, file counts) ---- */
  .a2-assets-chip-row {
    display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  }
  .a2-assets-chip-row-label {
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    color: var(--a2-text-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-right: 2px;
  }
  .a2-assets-chip {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 10px;
    border: 1px solid var(--a2-cyan-border);
    border-radius: 999px;
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out),
                color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-assets-chip:hover { border-color: var(--a2-cyan); color: var(--a2-text-bright); }
  .a2-assets-chip.active {
    border-color: var(--a2-cyan);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }

  /* ---- Media-item deep-link chip ---- */
  .a2-assets-deeplink {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 8px;
    background: var(--a2-cyan-soft);
    border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-cyan);
    font-size: var(--a2-text-xs);
    font-weight: 600;
  }
  .a2-assets-deeplink-clear {
    display: inline-grid; place-items: center;
    width: 16px; height: 16px;
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-muted);
    border-radius: 50%;
  }
  .a2-assets-deeplink-clear:hover { color: var(--a2-red); }

  /* ---- Link Existing File header action ---- */
  .a2-assets-link-existing {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-4);
    border: 1px solid var(--a2-green-border, var(--a2-cyan-border));
    border-radius: var(--a2-radius-sm);
    background: var(--a2-green-soft, var(--a2-surface-2));
    color: var(--a2-green, var(--a2-cyan));
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-assets-link-existing:hover { border-color: var(--a2-green, var(--a2-cyan)); }
  .a2-assets-link-existing:disabled { opacity: 0.5; cursor: not-allowed; }

  .a2-asset-modal-step {
    margin: 14px 0 6px;
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xs);
    font-weight: 700;
    color: var(--a2-text-dim);
    letter-spacing: 0.05em;
    text-transform: uppercase;
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

  .col-actions { width: 44px; text-align: right; }
  .a2-assets-row-action {
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-muted); padding: 8px; min-width: 44px; min-height: 44px; border-radius: var(--a2-radius-xs);
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
    padding: 8px 12px;
    min-height: 44px;
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
    padding-top: env(safe-area-inset-top, 0px);
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
    min-width: 44px;
    min-height: 44px;
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

  .a2-asset-action-success {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0 0 var(--a2-space-3) 0; padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-green-soft); border: 1px solid var(--a2-green-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-green); font-size: var(--a2-text-2xs);
  }
  .a2-asset-action-loading {
    display: flex; align-items: center; gap: var(--a2-space-2);
    margin: 0 0 var(--a2-space-3) 0; padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-cyan-soft); border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-cyan); font-size: var(--a2-text-2xs); font-weight: 600;
  }
  .a2-asset-action-error-box {
    display: flex; align-items: flex-start; gap: var(--a2-space-2);
    margin: 0 0 var(--a2-space-3) 0; padding: var(--a2-space-3);
    background: var(--a2-red-soft); border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-red); font-size: var(--a2-text-2xs); line-height: 1.5;
  }
  .a2-asset-action-error-box strong { display: block; font-weight: 700; margin-bottom: 2px; }
  .a2-asset-action-error-box p { margin: 0; }
  .a2-asset-action-error-hint { margin-top: 4px !important; opacity: 0.85; font-style: italic; }

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
  .a2-asset-deleted-notice { display: flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
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

  /* Link Existing modal — wider to fit the search + results list */
  .a2-asset-modal-wide { max-width: 560px; }
  .a2-asset-link-search { display: flex; align-items: center; gap: var(--a2-space-2); margin-bottom: var(--a2-space-2); }
  .a2-asset-link-search .a2-asset-modal-input { flex: 1; }
  .a2-asset-link-results { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--a2-space-3); }
  .a2-asset-link-empty { padding: var(--a2-space-4); text-align: center; color: var(--a2-text-dim); font-size: var(--a2-text-sm); }
  .a2-asset-link-result { display: flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); cursor: pointer; text-align: left; transition: border-color var(--a2-motion-micro) var(--a2-ease-out); }
  .a2-asset-link-result:hover { border-color: var(--a2-cyan-border); }
  .a2-asset-link-result.selected { border-color: var(--a2-cyan); background: var(--a2-cyan-soft); }
  .a2-asset-link-result-icon { display: flex; align-items: center; color: var(--a2-text-dim); flex-shrink: 0; }
  .a2-asset-link-result-info { flex: 1; min-width: 0; }
  .a2-asset-link-result-title { font-size: var(--a2-text-sm); color: var(--a2-text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .a2-asset-link-result-meta { display: flex; gap: 4px; font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
  .a2-asset-link-result-check { color: var(--a2-cyan); flex-shrink: 0; }

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
  /* Phase 2 mobile card list — visible only below 768px. */
  .a2-assets-card-list { display: none; list-style: none; margin: 0; padding: 0; gap: var(--a2-space-2); flex-direction: column; }
  .a2-assets-card { display: flex; flex-direction: column; gap: var(--a2-space-2); width: 100%; padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); color: inherit; text-align: left; cursor: pointer; transition: border-color var(--a2-motion-micro) var(--a2-ease-out), background var(--a2-motion-micro) var(--a2-ease-out); }
  .a2-assets-card:hover { background: var(--a2-surface-3); border-color: var(--a2-cyan-border); }
  .a2-assets-card.is-detached { border-color: var(--a2-amber-border); }
  .a2-assets-card-head { display: flex; align-items: center; gap: var(--a2-space-2); flex-wrap: wrap; }
  .a2-assets-card-file { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); word-break: break-word; }
  .a2-assets-card-id { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }
  .a2-assets-card-media { display: flex; align-items: center; gap: 4px; font-size: var(--a2-text-xs); color: var(--a2-text-muted); flex-wrap: wrap; }
  .a2-assets-card-chips { display: flex; gap: 4px; flex-wrap: wrap; padding-top: var(--a2-space-1); border-top: 1px solid var(--a2-border); }
  .a2-assets-chip { display: inline-flex; align-items: center; padding: 2px 6px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }

  @media (max-width: 768px) {
    .a2-assets-card-list { display: flex; }
    .a2-assets-table-wrap { display: none; }
    .a2-assets-filters { display: none; }
    .a2-assets-mobile-filter-toggle { display: inline-flex; }
    .a2-asset-drawer { max-width: 100%; }
    .a2-asset-drawer-dl { grid-template-columns: 1fr; }
    .a2-asset-modal-actions { flex-direction: column-reverse; }
    .a2-asset-modal-btn { width: 100%; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-asset-drawer, .a2-asset-drawer-overlay, .a2-asset-action,
    .a2-assets-select, .a2-assets-search-input, .a2-assets-chip,
    .a2-assets-table tbody tr { animation: none; transition: none; }
  }
</style>
