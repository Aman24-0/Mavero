<script lang="ts">
  /**
   * Admin 2.0 — Phase C — Media Library workspace.
   *
   * Central content-management workspace. Layout:
   *
   *   Desktop (≥1024px):
   *     ┌─────────────────────┬───────────────────────────────────┐
   *     │ Content Navigator   │ Search · Filters · Sort           │
   *     │ (AdminMediaTree)    │ ───────────────────────────────── │
   *     │                     │ Media Results (AdminMediaTable)  │
   *     │                     │                                   │
   *     │                     │ [Detail drawer slides in on click]│
   *     └─────────────────────┴───────────────────────────────────┘
   *
   *   Mobile (<1024px):
   *     Top header
   *     Breadcrumb
   *     Search bar
   *     Filter button (opens bottom sheet)
   *     Media Card list (AdminMediaCard)
   *     Tap card → full-screen detail sheet (AdminMediaDetailDrawer)
   *
   * URL state:
   *   ?q=&type=&year=&provider=&status=&sort=&page=&selected=
   *
   * Server-side: page 1 + folder summary + hosting sources are
   * preloaded by +page.server.ts. Subsequent pages and detail
   * fetches are client-side via /api/admin/media/library endpoints.
   *
   * Resilience contract:
   *   - If folder summary fails, tree shows an error but the table
   *     still renders.
   *   - If a detail fetch fails, the drawer shows an inline error
   *     but the table selection is preserved.
   *   - If the list fetch fails (page 2+), the pagination footer
   *     shows an error.
   */
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Upload, SlidersHorizontal, ChevronLeft, ChevronRight, X, Film, AlertCircle, Server, ListTree } from 'lucide-svelte';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminMediaTree, { type FolderSummary } from '$lib/components/admin2/AdminMediaTree.svelte';
  import AdminMediaTable from '$lib/components/admin2/AdminMediaTable.svelte';
  import AdminMediaCard from '$lib/components/admin2/AdminMediaCard.svelte';
  import AdminMediaDetailDrawer from '$lib/components/admin2/AdminMediaDetailDrawer.svelte';
  import AdminMediaFilters, { type FilterState } from '$lib/components/admin2/AdminMediaFilters.svelte';
  import AdminHostingAssets from '$lib/components/admin2/AdminHostingAssets.svelte';
  import type { LibraryMediaItem, LibraryOperationSummary } from '$lib/server/hosting/library/service';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // ============================================================
  // View toggle: 'media' (media_items) vs 'files' (provider assets).
  // The 'files' view shows ALL media_assets including unlinked ones
  // (media_item_id IS NULL). This consolidates the old Hosting Assets
  // tab into Media Library — one canonical workspace for both media
  // items and provider files.
  // URL-driven via ?view=media|files (default: media).
  // ============================================================
  let currentView = $state<'media' | 'files'>(
    page.url.searchParams.get('view') === 'files' ? 'files' : 'media'
  );

  $effect(() => {
    const urlView = page.url.searchParams.get('view');
    currentView = urlView === 'files' ? 'files' : 'media';
  });

  function switchView(view: 'media' | 'files') {
    if (view === currentView) return;
    currentView = view;
    const params = new URLSearchParams(page.url.searchParams);
    if (view === 'files') {
      params.set('view', 'files');
    } else {
      params.delete('view');
    }
    // Clear media-specific filters when switching to files view.
    if (view === 'files') {
      params.delete('selected');
      params.delete('series');
      params.delete('year');
    }
    goto(`${page.url.pathname}?${params.toString()}`, { replaceState: true, noScroll: true, invalidateAll: false });
  }

  const viewTabs = $derived([
    { id: 'media', label: 'Media', active: currentView === 'media', onclick: () => switchView('media') },
    { id: 'files', label: 'Provider Files', active: currentView === 'files', onclick: () => switchView('files') },
  ]);

  // ============================================================
  // State
  // Initial server-rendered data is captured once at component init
  // by reading `data` directly. Subsequent updates happen via client-
  // side fetches. The "captures initial value" warning is intentional
  // here — `data` only flows in once from the server loader.
  // ============================================================
  // svelte-ignore state_referenced_locally
  const initial = $state.snapshot(data);  // svelte-ignore — initial capture only
  let items = $state<LibraryMediaItem[]>(initial.initialList.items);
  let total = $state<number>(initial.initialList.total);
  let page_ = $state<number>(initial.initialList.page);
  let limit = $state<number>(initial.initialList.limit);
  let hasMore = $state<boolean>(initial.initialList.has_more);
  let loading = $state<boolean>(false);
  let listError = $state<string | null>(null);

  let folders = $state<FolderSummary | null>(initial.initialFolders);
  let foldersError = $state<string | null>(initial.initialFoldersError);
  let foldersLoading = $state<boolean>(false);

  let hostingSources = $state(initial.hostingSources);
  // FINDING-005 fix: surface the hostingSourcesError from the server
  // load. Previously this error was set in the server but never
  // rendered — if the streaming_providers/streaming_sources query
  // failed, every asset's adapterId degraded to null and the UI
  // showed false "Not linked" states with no error indication.
  let hostingSourcesError = $state<string | null>(initial.hostingSourcesError ?? null);

  let filters = $state<FilterState>({
    q: initial.initialFilters.q ?? '',
    type: (initial.initialFilters.type as FilterState['type']) ?? 'all',
    status: (initial.initialFilters.status as FilterState['status']) ?? 'all',
    provider: (initial.initialFilters.provider as FilterState['provider']) ?? 'all',
    sort: (initial.initialFilters.sort as FilterState['sort']) ?? 'recently_updated',
  });
  let yearFilter = $state<number | null>(initial.initialFilters.year ?? null);
  // Phase 5: seriesTmdbFilter is now wired to the server — tree selection
  // actually filters the list. Initialized from the URL ?series= param so
  // deep links + browser refresh preserve the selection.
  let seriesTmdbFilter = $state<string | null>(initial.initialFilters.series ?? null);

  // Tree selection state — initialized from `initial`, kept in sync via handleTreeSelect
  const treeInitialType = initial.initialFilters.type === 'all' ? 'all' : initial.initialFilters.type;
  let treeSelectedType = $state(treeInitialType);
  let treeSelectedYear = $state<number | null>(initial.initialFilters.year ?? null);
  let treeSelectedSeriesTmdb = $state<string | null>(initial.initialFilters.series ?? null);
  let treeSelectionLabel = $state<string | null>(null);

  // Detail drawer state
  let drawerOpen = $state<boolean>(false);
  let drawerItem = $state<LibraryMediaItem | null>(null);
  let drawerOperations = $state<LibraryOperationSummary[]>([]);
  let drawerLoading = $state<boolean>(false);
  let drawerError = $state<string | null>(null);

  // Mobile filter sheet state
  let mobileFiltersOpen = $state<boolean>(false);
  // Phase 3: mobile content-hierarchy sheet state (replaces the hidden tree on <1024px)
  let mobileHierarchyOpen = $state<boolean>(false);

  let selectedId = $state<string | null>(initial.initialFilters.selectedId ?? null);

  // ============================================================
  // URL state sync — keep query params in sync with state
  // ============================================================
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let pageChangeDebounce: ReturnType<typeof setTimeout> | null = null;

  function syncUrl() {
    if (pageChangeDebounce) clearTimeout(pageChangeDebounce);
    pageChangeDebounce = setTimeout(() => {
      const params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.type !== 'all') params.set('type', filters.type);
      if (yearFilter != null) params.set('year', String(yearFilter));
      // Phase 5: persist series tree selection to URL so it survives refresh + is shareable.
      if (seriesTmdbFilter) params.set('series', seriesTmdbFilter);
      if (filters.provider !== 'all') params.set('provider', filters.provider);
      if (filters.status !== 'all') params.set('status', filters.status);
      if (filters.sort !== 'recently_updated') params.set('sort', filters.sort);
      if (page_ > 1) params.set('page', String(page_));
      if (selectedId) params.set('selected', selectedId);
      const qs = params.toString();
      const url = qs ? `/admin/media/library?${qs}` : '/admin/media/library';
      // Use replaceState to avoid spamming browser history on every filter keystroke.
      goto(url, { replaceState: true, noScroll: true, keepFocus: true });
    }, 80);
  }

  // ============================================================
  // Fetch list — debounced when triggered by search input,
  // immediate when triggered by filter / sort / page change.
  // ============================================================
  async function fetchList() {
    loading = true;
    listError = null;
    try {
      const params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.type !== 'all') params.set('type', filters.type);
      if (yearFilter != null) params.set('year', String(yearFilter));
      // Phase 5: send series filter to the API so the list actually filters by series.
      if (seriesTmdbFilter) params.set('series', seriesTmdbFilter);
      // Provider filter maps to the source-id query param.
      if (filters.provider !== 'all') {
        if (filters.provider === 'vidara' || filters.provider === 'abyss') {
          const source = hostingSources.find(s => s.adapterId === filters.provider);
          if (source) params.set('provider', source.id);
        }
        // 'unlinked' filter requires client-side post-filter — see plan §26.
        // For now, the unlinked filter is handled by not setting a provider param
        // and letting the table show "Not linked" rows; admin can visually scan.
      }
      if (filters.status !== 'all') params.set('status', filters.status);
      params.set('sort', filters.sort);
      params.set('page', String(page_));
      params.set('limit', String(limit));

      const res = await fetch(`/api/admin/media/library?${params.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      items = json.items as LibraryMediaItem[];
      total = json.total;
      hasMore = json.has_more;
    } catch (err) {
      listError = err instanceof Error ? err.message : 'Failed to fetch media library.';
      items = [];
    } finally {
      loading = false;
    }
  }

  function applyFilters(next: FilterState) {
    filters = next;
    page_ = 1;
    if (!next.q && filters.q) {
      // Cleared search.
    }
    syncUrl();
    void fetchList();
  }

  function handleSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    filters = { ...filters, q: value };
    page_ = 1;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      syncUrl();
      void fetchList();
    }, 250);
  }

  // ============================================================
  // Tree selection
  // ============================================================
  function handleTreeSelect(selection: {
    type?: 'movie' | 'series' | 'anime' | 'all';
    year?: number | null;
    seriesTmdb?: string | null;
    label?: string;
  }) {
    treeSelectedType = selection.type ?? 'all';
    treeSelectedYear = selection.year ?? null;
    treeSelectedSeriesTmdb = selection.seriesTmdb ?? null;
    treeSelectionLabel = selection.label ?? null;

    // Sync filters with tree selection.
    filters = {
      ...filters,
      type: (selection.type ?? 'all') as FilterState['type'],
    };
    yearFilter = selection.year ?? null;
    seriesTmdbFilter = selection.seriesTmdb ?? null;
    page_ = 1;
    syncUrl();
    void fetchList();
  }

  // ============================================================
  // Pagination
  // ============================================================
  function goToPage(p: number) {
    if (p < 1 || p > totalPages) return;
    page_ = p;
    syncUrl();
    void fetchList();
  }
  const totalPages = $derived(Math.max(1, Math.ceil(total / limit)));

  // ============================================================
  // Detail drawer
  // ============================================================
  async function openDetail(item: LibraryMediaItem) {
    selectedId = item.id;
    drawerItem = item;
    drawerOperations = [];
    drawerError = null;
    drawerOpen = true;
    syncUrl();
    // Optimistic: render the list-item data immediately. Fetch the
    // full detail (with operations) in the background.
    drawerLoading = true;
    try {
      const res = await fetch(`/api/admin/media/library/${item.id}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      drawerItem = json.item as LibraryMediaItem;
      drawerOperations = json.recent_operations as LibraryOperationSummary[];
    } catch (err) {
      // Partial failure: keep the optimistic data but show the error
      // in the drawer. The list view is unaffected.
      drawerError = err instanceof Error ? err.message : 'Failed to load detail.';
    } finally {
      drawerLoading = false;
    }
  }

  function closeDetail() {
    drawerOpen = false;
    selectedId = null;
    syncUrl();
  }

  function openUploadForItem(item: LibraryMediaItem) {
    // Defer to the existing upload wizard with prefilled params.
    const params = new URLSearchParams({
      tmdbId: item.tmdb_id,
      contentType: item.content_type,
    });
    if (item.season != null) params.set('season', String(item.season));
    if (item.episode != null) params.set('episode', String(item.episode));
    void goto(`/admin/media/upload?${params.toString()}`);
  }

  // ============================================================
  // Initial deep-link: if ?selected=<id> is set, fetch and open the drawer.
  // ============================================================
  onMount(() => {
    if (initial.initialFilters.selectedId) {
      // Find the item in the initial page; if not found, fetch it.
      const found = items.find(i => i.id === initial.initialFilters.selectedId);
      if (found) {
        void openDetail(found);
      } else {
        void (async () => {
          drawerOpen = true;
          drawerLoading = true;
          try {
            const res = await fetch(`/api/admin/media/library/${initial.initialFilters.selectedId}`);
            const json = await res.json();
            if (res.ok && json.ok) {
              drawerItem = json.item;
              drawerOperations = json.recent_operations;
            } else {
              drawerError = json?.error?.message ?? 'Not found';
            }
          } catch (err) {
            drawerError = err instanceof Error ? err.message : 'Failed to load detail.';
          } finally {
            drawerLoading = false;
          }
        })();
      }
    }
  });

  onDestroy(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
    if (pageChangeDebounce) clearTimeout(pageChangeDebounce);
  });
</script>

<svelte:head>
  <title>Media Library — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Content" title="Media Library" accent="cyan" tabs={viewTabs}>
    {#snippet description()}
      <p>
        Browse, search, filter, and inspect every canonical media identity in Mavero —
        with per-item provider availability across Vidara and Abyss.
        Switch to <strong>Provider Files</strong> to manage unlinked provider assets.
      </p>
    {/snippet}

    {#snippet actions()}
      <a class="library-action" href="/admin/media/upload">
        <Upload size={13} /> Upload / Import
      </a>
    {/snippet}

    {#if currentView === 'files'}
      <!-- Provider Files view: delegates to AdminHostingAssets, which
           shows ALL media_assets (including media_item_id IS NULL).
           This consolidates the old Hosting Control → Assets tab into
           the Media Library. The component handles its own filters,
           pagination, drawer, and management actions. -->
      <AdminHostingAssets providers={hostingSources.filter((s: any) => s.adapterId && s.capabilities).map((s: any) => ({ adapterId: s.adapterId, name: s.providerName ?? s.name, capabilities: s.capabilities }))} />
    {:else}
      {#if hostingSourcesError}
        <!-- FINDING-005 fix: surface hosting sources query failures. -->
        <div class="library-hosting-error" role="alert">
          <strong>Provider data could not be loaded:</strong> {hostingSourcesError}
          <br />
          Assets may show as "Not linked" or "Unresolved" until this is resolved.
          Check the database connection and RLS policies for streaming_providers / streaming_sources.
        </div>
      {/if}

    {#snippet toolbar()}
      <!-- Desktop inline filters -->
      <div class="library-toolbar-desktop">
        <AdminMediaFilters
          {filters}
          {hostingSources}
          onchange={applyFilters}
          bind:mobileOpen={mobileFiltersOpen}
        />

        <button
          type="button"
          class="library-filters-mobile-btn"
          onclick={() => (mobileFiltersOpen = true)}
          aria-label="Open filters"
        >
          <SlidersHorizontal size={14} /> Filters
        </button>

        <!-- Phase 3: mobile content-hierarchy trigger (hidden on desktop, shown <1024px).
             Replaces the desktop tree sidebar which is display:none on mobile. -->
        <button
          type="button"
          class="library-hierarchy-mobile-btn"
          onclick={() => (mobileHierarchyOpen = true)}
          aria-label="Open content hierarchy"
        >
          <ListTree size={14} /> Hierarchy
        </button>
      </div>

      {#if treeSelectionLabel}
        <div class="library-tree-label">
          <span class="library-tree-label-text">{treeSelectionLabel}</span>
          <button type="button" class="library-tree-label-clear" onclick={() => handleTreeSelect({ type: 'all', year: null, seriesTmdb: null, label: 'All Media' })}>
            <X size={11} />
          </button>
        </div>
      {/if}
    {/snippet}

    <!-- ============================================================
         WORKSPACE — split layout (desktop) / stacked (mobile)
         ============================================================ -->
    <div class="library-workspace">
      <div class="library-tree-wrap">
        <AdminMediaTree
          folders={folders}
          loading={foldersLoading}
          error={foldersError}
          selectedType={treeSelectedType}
          selectedYear={treeSelectedYear}
          selectedSeriesTmdb={treeSelectedSeriesTmdb}
          onselect={handleTreeSelect}
        />
      </div>

      <div class="library-main">
        {#if listError}
          <div class="library-error-block">
            <div class="library-error-icon"><AlertCircle size={20} /></div>
            <div class="library-error-title">Library load failed</div>
            <div class="library-error-desc">{listError}</div>
            <button class="library-error-retry" type="button" onclick={() => fetchList()}>Retry</button>
          </div>
        {:else}
          <!-- Desktop table -->
          <div class="library-table-wrap">
            <AdminMediaTable
              {items}
              {loading}
              {selectedId}
              {hostingSources}
              onselect={openDetail}
            />
          </div>

          <!-- Mobile card list -->
          <div class="library-card-wrap">
            <AdminMediaCard
              {items}
              {loading}
              {selectedId}
              {hostingSources}
              onselect={openDetail}
            />
          </div>
        {/if}

        <!-- Pagination footer -->
        {#if total > limit}
          <div class="library-pagination">
            <button
              type="button"
              class="page-btn"
              disabled={page_ <= 1 || loading}
              onclick={() => goToPage(page_ - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span class="page-info">
              Page <strong>{page_}</strong> of <strong>{totalPages}</strong>
              <span class="page-total">· {total} items</span>
            </span>
            <button
              type="button"
              class="page-btn"
              disabled={!hasMore || loading}
              onclick={() => goToPage(page_ + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        {/if}
      </div>
    </div>
    {/if}
  </AdminPage>

  <!-- Detail drawer (renders above everything when open) -->
  <AdminMediaDetailDrawer
    bind:open={drawerOpen}
    item={drawerItem}
    operations={drawerOperations}
    loading={drawerLoading}
    error={drawerError}
    {hostingSources}
    onclose={closeDetail}
    onupload={openUploadForItem}
  />

  <!-- ============================================================
       Phase 3: Mobile content-hierarchy sheet (<1024px only).
       Reuses the same <AdminMediaTree> component as the desktop sidebar,
       with the same props + onselect callback. Auto-closes on selection.
       Same folders ref — zero data duplication.
       ============================================================ -->
  {#if mobileHierarchyOpen}
    <div
      class="library-hierarchy-sheet-overlay"
      onclick={() => (mobileHierarchyOpen = false)}
      role="presentation"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="library-hierarchy-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-hierarchy-sheet-title"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <header class="library-hierarchy-sheet-head">
          <h2 id="library-hierarchy-sheet-title"><ListTree size={14} /> Content Hierarchy</h2>
          <button
            type="button"
            class="library-hierarchy-sheet-close"
            onclick={() => (mobileHierarchyOpen = false)}
            aria-label="Close hierarchy"
          >
            <X size={16} />
          </button>
        </header>
        <div class="library-hierarchy-sheet-body">
          <AdminMediaTree
            {folders}
            loading={foldersLoading}
            error={foldersError}
            selectedType={treeSelectedType}
            selectedYear={treeSelectedYear}
            selectedSeriesTmdb={treeSelectedSeriesTmdb}
            onselect={(sel) => { handleTreeSelect(sel); mobileHierarchyOpen = false; }}
          />
        </div>
        <footer class="library-hierarchy-sheet-actions">
          <button
            type="button"
            class="library-hierarchy-sheet-done"
            onclick={() => (mobileHierarchyOpen = false)}
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  {/if}
</AdminAppShell>

<style>
  .library-hosting-error {
    padding: var(--a2-space-3) var(--a2-space-4);
    margin-bottom: var(--a2-space-3);
    background: var(--a2-red-soft);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-red);
    font-size: var(--a2-text-sm);
    line-height: 1.5;
  }
  .library-hosting-error strong { font-weight: 700; }
  .library-action {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-4);
    border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    text-decoration: none;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .library-action:hover {
    background: var(--a2-surface-3);
    border-color: var(--a2-cyan);
  }

  .library-toolbar-desktop {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    width: 100%;
  }
  .library-filters-mobile-btn {
    display: none;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    cursor: pointer;
  }

  /* Phase 3: mobile hierarchy trigger — mirrors .library-filters-mobile-btn */
  .library-hierarchy-mobile-btn {
    display: none;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    cursor: pointer;
  }

  /* Phase 3: mobile hierarchy sheet (Pattern B — matches AdminOpsJobs/AdminHostingAssets filter sheets) */
  .library-hierarchy-sheet-overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: rgba(0, 0, 0, .55);
    display: flex;
    align-items: flex-end;
  }
  .library-hierarchy-sheet {
    width: 100%;
    background: var(--a2-surface-1);
    border-top-left-radius: var(--a2-radius-lg);
    border-top-right-radius: var(--a2-radius-lg);
    border-top: 1px solid var(--a2-border-strong);
    display: flex;
    flex-direction: column;
    max-height: 80vh;
    animation: a2-sheet-up var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-sheet-up {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  .library-hierarchy-sheet-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--a2-space-4);
    border-bottom: 1px solid var(--a2-border);
  }
  .library-hierarchy-sheet-head h2 {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    font-size: var(--a2-text-base);
    font-weight: 700;
    color: var(--a2-text-bright);
  }
  .library-hierarchy-sheet-close {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--a2-text-muted);
    padding: 8px;
    min-width: 44px;
    min-height: 44px;
    border-radius: var(--a2-radius-xs);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .library-hierarchy-sheet-close:hover { color: var(--a2-cyan); background: var(--a2-surface-3); }
  .library-hierarchy-sheet-body {
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex: 1;
  }
  /* Override the tree's sidebar-specific CSS when rendered inside the sheet */
  .library-hierarchy-sheet-body :global(.a2-media-tree) {
    border-right: 0;
    height: auto;
    width: 100%;
  }
  .library-hierarchy-sheet-actions {
    padding: var(--a2-space-3) var(--a2-space-4);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    border-top: 1px solid var(--a2-border);
    display: flex;
    gap: var(--a2-space-2);
  }
  .library-hierarchy-sheet-done {
    flex: 1;
    padding: var(--a2-space-2) var(--a2-space-4);
    min-height: 44px;
    background: var(--a2-cyan);
    color: var(--a2-surface-1);
    border: none;
    border-radius: var(--a2-radius-sm);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .library-tree-label {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-1) var(--a2-space-2) var(--a2-space-1) var(--a2-space-3);
    margin-top: var(--a2-space-2);
    border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-xs);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
    font-size: var(--a2-text-2xs);
    font-weight: 600;
  }
  .library-tree-label-clear {
    display: inline-grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--a2-cyan);
    cursor: pointer;
  }
  .library-tree-label-clear:hover { background: var(--a2-surface-3); }

  .library-workspace {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: var(--a2-space-4);
    min-height: 0;
  }

  .library-tree-wrap {
    height: calc(100dvh - 280px);
    min-height: 400px;
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-1);
    overflow: hidden;
  }

  .library-main {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-3);
    min-width: 0;
  }

  .library-table-wrap {
    display: block;
  }
  .library-card-wrap {
    display: none;
  }

  .library-pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-3);
    border-top: 1px solid var(--a2-border);
  }
  .page-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .page-btn:hover:not(:disabled) {
    background: var(--a2-surface-3);
    color: var(--a2-cyan);
  }
  .page-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .page-info {
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    color: var(--a2-text-muted);
  }
  .page-info strong {
    color: var(--a2-text);
    font-weight: 700;
  }
  .page-total {
    color: var(--a2-text-dim);
    font-size: var(--a2-text-xs);
    margin-left: var(--a2-space-1);
  }

  .library-error-block {
    padding: var(--a2-space-10) var(--a2-space-4);
    text-align: center;
  }
  .library-error-icon {
    display: inline-grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: var(--a2-space-3);
    border-radius: var(--a2-radius-md);
    background: var(--a2-red-soft);
    color: var(--a2-red);
  }
  .library-error-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }
  .library-error-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
    max-width: 480px;
    margin-left: auto;
    margin-right: auto;
    line-height: 1.5;
  }
  .library-error-retry {
    margin-top: var(--a2-space-3);
    padding: var(--a2-space-2) var(--a2-space-4);
    border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    cursor: pointer;
  }

  /* ============================================================
     RESPONSIVE — switch to mobile composition
     ============================================================ */
  @media (max-width: 1023px) {
    .library-workspace {
      grid-template-columns: 1fr;
    }
    .library-tree-wrap {
      display: none;
    }
    .library-table-wrap {
      display: none;
    }
    .library-card-wrap {
      display: block;
    }
    .library-filters-mobile-btn {
      display: inline-flex;
    }
    /* Phase 3: show the hierarchy trigger on mobile */
    .library-hierarchy-mobile-btn {
      display: inline-flex;
    }
    /* Hide the desktop filter bar's inline selects on mobile — they'd be cramped */
    .library-toolbar-desktop :global(.media-filters-desktop .filter-select),
    .library-toolbar-desktop :global(.media-filters-desktop .filter-search) {
      display: none;
    }
    .library-toolbar-desktop :global(.media-filters-desktop) {
      flex: 0 0 auto;
    }
  }

  @media (max-width: 640px) {
    .library-toolbar-desktop :global(.filter-clear) {
      display: none;
    }
    .library-pagination {
      padding: var(--a2-space-2);
    }
    .page-info {
      font-size: var(--a2-text-xs);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .library-action,
    .page-btn,
    .library-error-retry { transition: none; }
    .library-hierarchy-sheet { animation: none; }
  }
</style>
