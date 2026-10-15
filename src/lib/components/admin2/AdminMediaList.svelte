<script lang="ts" module>
  // MAV-FOCUSED — Compact Media Library list with filters, grid/list, pagination (2026-10).
  //
  // Replaces the old AdminHostingAssets (2262 lines) with a simple list:
  //   * Grid/List view toggle with poster display.
  //   * Search by title, filter by content type / provider / status.
  //   * 20-item incremental pagination with infinite scroll.
  //   * Three-dot menu: Delete (Mavero-side only) + Update link.
  //
  // Uses the /api/admin/media/manual-link endpoint for create/update/delete.
  // Uses the /api/admin/media/search endpoint for TMDB search (via the wizard).
  // Uses the /api/admin/media/library endpoint for the list.

  export type MediaRow = {
    id: string;
    title: string;
    contentType: string;
    tmdbId: string;
    providerAssetId: string;
    providerSourceId: string;
    providerName: string;
    status: string;
    maveroStatus: string;
    mediaAssetId: string;
    posterPath?: string | null;
  };
</script>

<script lang="ts">
  import { Plus, MoreVertical, Trash2, Link2, Loader2, Film, Tv, Sparkles, AlertCircle, Search, LayoutGrid, List as ListIcon, SlidersHorizontal, X } from 'lucide-svelte';
  import AdminAddFileWizard from './AdminAddFileWizard.svelte';
  import type { UpdateTarget } from './AdminAddFileWizard.svelte';

  // --- Props ---
  let {
    providers = [] as Array<{ adapterId: string; name: string; sourceId: string }>,
    registerAddFile = undefined as ((fn: (() => void) | null) => void) | undefined,
  }: {
    providers?: Array<{ adapterId: string; name: string; sourceId: string }>;
    registerAddFile?: ((fn: (() => void) | null) => void) | undefined;
  } = $props();

  // --- State ---
  let items = $state<MediaRow[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let hasMore = $state(false);
  let currentPage = $state(1);
  const PAGE_SIZE = 20;

  // --- Filters ---
  // Deep-audit Section 7: the four filter dropdowns NO LONGER stack as
  // separate toolbar rows — they live in a filter SHEET. The toolbar is
  // ONE compact row: search (flex) + view toggle + Filter button. The
  // sheet drafts locally and Apply commits (predictable close, applied
  // filters preserved, active-count badge on the button).
  let searchQuery = $state('');
  let filterType = $state<string>('all');
  let filterProvider = $state<string>('all');
  let filterStatus = $state<string>('all');
  let sortBy = $state<string>('recently_updated');
  let viewMode = $state<'grid' | 'list'>('list');

  // --- Filter sheet state ---
  let filterSheetOpen = $state(false);
  let draftType = $state<string>('all');
  let draftProvider = $state<string>('all');
  let draftStatus = $state<string>('all');
  let draftSort = $state<string>('recently_updated');

  function activeFilterCount(): number {
    return (filterType !== 'all' ? 1 : 0)
      + (filterProvider !== 'all' ? 1 : 0)
      + (filterStatus !== 'all' ? 1 : 0)
      + (sortBy !== 'recently_updated' ? 1 : 0);
  }

  function openFilterSheet() {
    draftType = filterType;
    draftProvider = filterProvider;
    draftStatus = filterStatus;
    draftSort = sortBy;
    filterSheetOpen = true;
  }

  function closeFilterSheet() {
    filterSheetOpen = false;
  }

  function applyFilters() {
    filterType = draftType;
    filterProvider = draftProvider;
    filterStatus = draftStatus;
    sortBy = draftSort;
    filterSheetOpen = false;
    void loadList(true);
  }

  function clearFilters() {
    draftType = 'all';
    draftProvider = 'all';
    draftStatus = 'all';
    draftSort = 'recently_updated';
    filterType = 'all';
    filterProvider = 'all';
    filterStatus = 'all';
    sortBy = 'recently_updated';
    filterSheetOpen = false;
    void loadList(true);
  }

  function onFilterKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && filterSheetOpen) {
      event.stopPropagation();
      closeFilterSheet();
    }
  }

  // --- Wizard + delete state ---
  let wizardOpen = $state(false);
  let wizardUpdateTarget = $state<UpdateTarget | null>(null);
  let deleteTarget = $state<MediaRow | null>(null);
  let deleting = $state(false);

  // Task 3 (2026-10-15) — PORTAL ACTION MENU.
  //
  // The old dropdowns were absolutely positioned INSIDE the card/row
  // subtree: in grid mode `.grid-card{overflow:hidden}` clipped the menu
  // on every side, and in list mode the `.media-list{overflow-y:auto}`
  // scroll container clipped it near the bottom of the scroll area. Both
  // defects are ancestor-overflow clipping — unfixable from inside the
  // subtree with any z-index.
  //
  // The menu is now a SINGLE floating element portaled to document.body
  // and positioned with `position:fixed` from the trigger's bounding
  // rect: below-right of the trigger by default, flipped above when the
  // viewport bottom is too close, and clamped to an 8px viewport margin
  // on every edge (bottom/right edges and narrow mobile widths included).
  // Scrolling repositions (and closes when the trigger leaves the
  // viewport), outside pointerdown + Escape close it, focus returns to
  // the trigger, and because the menu lives OUTSIDE the card subtree a
  // menu click can never bubble into the card/row handlers.
  let openMenuId = $state<string | null>(null);
  let openMenuRow = $derived<MediaRow | null>(openMenuId ? items.find((r) => r.id === openMenuId) ?? null : null);
  let menuTriggerEl: HTMLElement | null = null;
  let menuEl = $state<HTMLElement | null>(null);
  let menuPos = $state<{ top: number; left: number }>({ top: 0, left: 0 });
  const MENU_VIEWPORT_MARGIN = 8;
  const MENU_GAP = 6;
  const MENU_ESTIMATED_SIZE = { width: 176, height: 88 };

  function portal(node: HTMLElement): { destroy(): void } {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  function clampMenuPosition(top: number, left: number, width: number, height: number): { top: number; left: number } {
    const maxLeft = Math.max(MENU_VIEWPORT_MARGIN, window.innerWidth - width - MENU_VIEWPORT_MARGIN);
    const maxTop = Math.max(MENU_VIEWPORT_MARGIN, window.innerHeight - height - MENU_VIEWPORT_MARGIN);
    return { top: Math.min(Math.max(top, MENU_VIEWPORT_MARGIN), maxTop), left: Math.min(Math.max(left, MENU_VIEWPORT_MARGIN), maxLeft) };
  }

  function positionMenu(): void {
    if (!menuTriggerEl || typeof window === 'undefined') return;
    const rect = menuTriggerEl.getBoundingClientRect();
    // The trigger scrolled out of the viewport while the menu was open —
    // an invisible anchor is a stale menu: close it (never float an
    // orphaned menu mid-viewport).
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth || rect.right < 0) {
      closeMenu(false);
      return;
    }
    const size = menuEl
      ? { width: menuEl.offsetWidth, height: menuEl.offsetHeight }
      : MENU_ESTIMATED_SIZE;
    // Prefer below-right of the trigger (the historical anchor corner);
    // flip above when the bottom edge would clip. Both axes clamp.
    let top = rect.bottom + MENU_GAP;
    if (rect.bottom + MENU_GAP + size.height > window.innerHeight - MENU_VIEWPORT_MARGIN && rect.top - MENU_GAP - size.height >= MENU_VIEWPORT_MARGIN) {
      top = rect.top - MENU_GAP - size.height;
    }
    let left = rect.right - size.width;
    const clamped = clampMenuPosition(top, left, size.width, size.height);
    menuPos = clamped;
  }

  function openMenu(row: MediaRow, trigger: HTMLElement): void {
    openMenuId = row.id;
    menuTriggerEl = trigger;
    // Position SYNCHRONOUSLY from the estimate so the very first paint is
    // already anchored (a (0,0) first frame would flash the menu at the
    // viewport corner). The rAF correction below then refines with the
    // real rendered size.
    positionMenu();
    requestAnimationFrame(() => positionMenu());
  }

  function toggleMenu(row: MediaRow, event: Event): void {
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement | null;
    if (openMenuId === row.id) { closeMenu(); return; }
    if (!trigger) return;
    openMenu(row, trigger);
  }

  function closeMenu(refocus = true): void {
    if (openMenuId === null) return;
    openMenuId = null;
    const trigger = menuTriggerEl;
    menuTriggerEl = null;
    if (refocus && trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeMenu();
      return;
    }
    // Arrow navigation between the two actions.
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && menuEl) {
      event.preventDefault();
      const focusables = Array.from(menuEl.querySelectorAll<HTMLElement>('button[role="menuitem"]'));
      if (focusables.length === 0) return;
      const index = focusables.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'ArrowDown' ? (index + 1 + focusables.length) % focusables.length : (index - 1 + focusables.length) % focusables.length;
      focusables[next].focus();
    }
  }

  // Global listeners live exactly as long as the menu is open.
  $effect(() => {
    if (openMenuId === null || typeof document === 'undefined') return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuEl?.contains(target)) return;          // clicks inside the menu are actions
      if (menuTriggerEl?.contains(target)) return;   // the trigger handles its own toggle
      closeMenu(false);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    const onReposition = () => positionMenu();
    // Capture-phase scroll: scroll events do not bubble, and the list/grid
    // containers scroll independently of the window.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('scroll', onReposition, { capture: true, passive: true });
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('scroll', onReposition, { capture: true });
      window.removeEventListener('resize', onReposition);
    };
  });

  // --- Debounce for search ---
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let searchToken = 0;

  // --- TMDB image helper ---
  const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
  function posterUrl(path?: string | null): string | null {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    return `${TMDB_IMAGE_BASE}${path}`;
  }

  // --- Lifecycle ---
  let prevOpen = false;

  $effect(() => {
    if (!prevOpen) {
      loadList(true);
    }
    prevOpen = true;
  });

  $effect(() => {
    if (registerAddFile) {
      registerAddFile(() => { openAddWizard(); });
    }
  });

  // (The legacy close-on-window-click effect was removed with Task 3 —
  // the portaled menu owns its lifecycle via the capture-phase
  // pointerdown + Escape + scroll listeners declared below.)

  // --- Load list with filters + pagination ---
  async function loadList(reset: boolean = false) {
    if (reset) {
      currentPage = 1;
      items = [];
      loading = true;
      error = null;
      // Task 3: the list is about to change — an open menu would anchor to
      // an unmounted trigger (the derived row lookup would clear it, but
      // close it eagerly for deterministic focus handling).
      closeMenu(false);
    } else {
      loadingMore = true;
    }

    const token = ++searchToken;

    const params = new URLSearchParams({
      status: filterStatus,
      sort: sortBy,
      limit: String(PAGE_SIZE),
      page: String(currentPage),
    });
    if (searchQuery.trim()) params.set('q', searchQuery.trim());
    if (filterType !== 'all') params.set('type', filterType);
    // Provider filter uses source_id — we need to find it from the providers list.
    if (filterProvider !== 'all') {
      const prov = providers.find(p => p.adapterId === filterProvider);
      if (prov) params.set('provider', prov.sourceId);
    }

    try {
      const res = await fetch(`/api/admin/media/library?${params.toString()}`);
      const json = await res.json();
      if (token !== searchToken) return; // stale response

      if (json.ok) {
        const newItems = (json.items ?? []).map(mapLibraryItem).filter((i: MediaRow) => i.mediaAssetId);
        if (reset) {
          items = newItems;
        } else {
          // Deduplicate by mediaAssetId.
          const existingIds = new Set(items.map(i => i.mediaAssetId));
          const filtered = newItems.filter((i: MediaRow) => !existingIds.has(i.mediaAssetId));
          items = [...items, ...filtered];
        }
        hasMore = json.has_more ?? false;
      } else {
        error = json.error?.message ?? 'Failed to load media library.';
        if (reset) items = [];
      }
    } catch (err) {
      if (token !== searchToken) return;
      error = err instanceof Error ? err.message : 'Failed to load media library.';
      if (reset) items = [];
    } finally {
      if (token === searchToken) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  // --- Filter change handler ---
  function onFilterChange() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { void loadList(true); }, 300);
  }

  // --- Infinite scroll ---
  function onScroll(event: Event) {
    const target = event.target as HTMLElement;
    if (!target) return;
    const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 200;
    if (nearBottom && !loadingMore && !loading && hasMore) {
      currentPage++;
      void loadList(false);
    }
  }

  function mapLibraryItem(item: any): MediaRow {
    const asset = (item.assets ?? []).find((a: any) => a.status !== 'deleted') ?? item.assets?.[0];
    const providerName = asset ? providerNameForSource(asset.provider_source_id) : 'Unknown';
    return {
      id: item.id,
      title: item.title + (item.episode_title ? ` — ${item.episode_title}` : ''),
      contentType: item.content_type,
      tmdbId: item.tmdb_id,
      providerAssetId: asset?.provider_asset_id ?? '',
      providerSourceId: asset?.provider_source_id ?? '',
      providerName,
      status: asset?.status ?? 'unknown',
      maveroStatus: asset?.mavero_status ?? 'unknown',
      mediaAssetId: asset?.id ?? '',
      posterPath: item.poster_path ?? null,
    };
  }

  function providerNameForSource(sourceId: string): string {
    const p = providers.find((p) => p.sourceId === sourceId);
    return p?.name ?? p?.adapterId ?? 'Unknown';
  }

  // --- Delete ---
  async function confirmDelete() {
    if (!deleteTarget) return;
    deleting = true;
    try {
      const res = await fetch('/api/admin/media/manual-link', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaAssetId: deleteTarget.mediaAssetId }),
      });
      const json = await res.json();
      if (json.ok) {
        deleteTarget = null;
        await loadList(true);
      } else {
        error = json.error?.message ?? 'Delete failed.';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Network error during delete.';
    } finally {
      deleting = false;
    }
  }

  // --- Wizard control ---
  function openAddWizard() {
    wizardUpdateTarget = null;
    wizardOpen = true;
  }

  function openUpdateWizard(row: MediaRow) {
    wizardUpdateTarget = {
      mediaAssetId: row.mediaAssetId,
      title: row.title,
      contentType: row.contentType,
      tmdbId: row.tmdbId,
      providerName: row.providerName,
      providerAssetId: row.providerAssetId,
    };
    wizardOpen = true;
  }

  // --- Helpers ---
  function contentTypeLabel(type: string): string {
    return type === 'movie' ? 'Movie' : type === 'series' ? 'TV Series' : type === 'anime' ? 'Anime' : type;
  }

  function providerLabel(row: MediaRow): string {
    return row.providerName === 'vidara' || row.providerName.toLowerCase().includes('vidara') ? 'Vidara'
      : row.providerName === 'abyss' || row.providerName.toLowerCase().includes('abyss') ? 'Abyss'
      : row.providerName;
  }

  function providerShort(row: MediaRow): string {
    const label = providerLabel(row);
    return label === 'Vidara' ? 'Vid' : label === 'Abyss' ? 'Ab' : label.slice(0, 3);
  }

  // Load view mode from localStorage.
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('mav-library-view') : null;
    if (saved === 'grid' || saved === 'list') viewMode = saved;
  } catch { /* ignore */ }

  function toggleView(mode: 'grid' | 'list') {
    viewMode = mode;
    // Task 3: the trigger is unmounted by the view switch — close the
    // floating menu instead of leaving it anchored to a removed element.
    closeMenu(false);
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('mav-library-view', mode); } catch { /* ignore */ }
  }
</script>

<svelte:window onkeydown={onFilterKeydown} />

<section class="media-library" aria-label="Media Library">
  <!-- Compact toolbar: ONE horizontal row on every viewport — search
       input (flex) + view toggle + Filter button. Filters open in a
       sheet; they never stack as toolbar rows. -->
  <div class="toolbar">
    <div class="search-input-wrap">
      <Search size={14} class="search-icon" />
      <input type="text" class="search-input" placeholder="Search by title or TMDB ID…" bind:value={searchQuery} oninput={onFilterChange} autocomplete="off" aria-label="Search media library" />
    </div>
    <div class="view-toggle" role="group" aria-label="View mode">
      <button type="button" class:active={viewMode === 'list'} onclick={() => toggleView('list')} aria-label="List view" aria-pressed={viewMode === 'list'}><ListIcon size={15} /></button>
      <button type="button" class:active={viewMode === 'grid'} onclick={() => toggleView('grid')} aria-label="Grid view" aria-pressed={viewMode === 'grid'}><LayoutGrid size={15} /></button>
    </div>
    <button type="button" class="filter-btn" class:filters-active={activeFilterCount() > 0} onclick={openFilterSheet} aria-haspopup="dialog" aria-expanded={filterSheetOpen}>
      <SlidersHorizontal size={14} />
      <span>Filter</span>
      {#if activeFilterCount() > 0}<span class="filter-count" aria-label="{activeFilterCount()} active filters">{activeFilterCount()}</span>{/if}
    </button>
  </div>

  <!-- Loading / Error / Empty / List -->
  {#if loading}
    <div class="state-msg"><Loader2 size={20} class="spinner" /> Loading media library…</div>
  {:else if error}
    <div class="state-msg state-error"><AlertCircle size={20} /> {error}<button class="retry-btn" onclick={() => loadList(true)}>Retry</button></div>
  {:else if items.length === 0}
    <div class="state-msg state-empty"><Film size={32} /><p>No media linked yet. Click "Add file" to link your first video.</p></div>
  {:else if viewMode === 'grid'}
    <div class="media-grid" onscroll={onScroll}>
      {#each items as row (row.id)}
        <div class="grid-card" data-status={row.maveroStatus}>
          <div class="grid-poster">
            {#if posterUrl(row.posterPath)}
              <img src={posterUrl(row.posterPath)} alt={row.title} loading="lazy" />
            {:else}
              <div class="grid-poster-fallback">{#if row.contentType === 'movie'}<Film size={24} />{:else if row.contentType === 'anime'}<Sparkles size={24} />{:else}<Tv size={24} />{/if}</div>
            {/if}
            <button type="button" class="grid-menu-btn" onclick={(e) => toggleMenu(row, e)} aria-label="Actions" aria-haspopup="menu" aria-expanded={openMenuId === row.id}>
              <MoreVertical size={14} />
            </button>
          </div>
          <div class="grid-info">
            <div class="grid-title">{row.title}</div>
            <div class="grid-meta">
              <span class="badge-type">{contentTypeLabel(row.contentType)}</span>
              <span class="badge-provider" data-provider={providerLabel(row).toLowerCase()}>{providerLabel(row)}</span>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="media-list" onscroll={onScroll}>
      {#each items as row (row.id)}
        <div class="media-row" data-status={row.maveroStatus}>
          <div class="media-poster">
            {#if posterUrl(row.posterPath)}
              <img src={posterUrl(row.posterPath)} alt={row.title} loading="lazy" />
            {:else}
              {#if row.contentType === 'movie'}<Film size={18} />{:else if row.contentType === 'anime'}<Sparkles size={18} />{:else}<Tv size={18} />{/if}
            {/if}
          </div>
          <div class="media-info">
            <div class="media-title">{row.title}</div>
            <div class="media-meta">
              <span class="badge-type">{contentTypeLabel(row.contentType)}</span>
              <span class="badge-provider" data-provider={providerLabel(row).toLowerCase()}>{providerLabel(row)}</span>
              <span class="tmdb-id">TMDB: {row.tmdbId}</span>
            </div>
          </div>
          <div class="media-actions">
            <button type="button" class="menu-trigger" onclick={(e) => toggleMenu(row, e)} aria-label="Actions" aria-haspopup="menu" aria-expanded={openMenuId === row.id}><MoreVertical size={16} /></button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Loading more indicator -->
  {#if loadingMore}
    <div class="loading-more"><Loader2 size={16} class="spinner" /> Loading more…</div>
  {/if}
  {#if !loading && !loadingMore && !hasMore && items.length > 0}
    <div class="end-of-list">End of list</div>
  {/if}

  <!-- Task 3 — PORTAL action menu (grid + list share ONE instance).
       Portaled to document.body so NO ancestor overflow (the grid
       card's overflow:hidden, the list scroll container) can clip it;
       position:fixed + viewport clamping keep it fully visible near the
       bottom/right edges and on narrow mobile widths. -->
  {#if openMenuRow}
    <div
      bind:this={menuEl}
      use:portal
      class="menu-dropdown floating"
      role="menu"
      tabindex="-1"
      aria-label="Actions for {openMenuRow.title}"
      style="top:{menuPos.top}px;left:{menuPos.left}px"
      onkeydown={onMenuKeydown}
    >
      <button type="button" class="menu-item" role="menuitem" onclick={() => { const row = openMenuRow; closeMenu(false); if (row) openUpdateWizard(row); }}><Link2 size={14} /> Update link</button>
      <button type="button" class="menu-item menu-item-danger" role="menuitem" onclick={() => { const row = openMenuRow; closeMenu(false); if (row) deleteTarget = row; }}><Trash2 size={14} /> Delete</button>
    </div>
  {/if}
</section>

<!-- Shared Add File / Update Link Wizard -->
<AdminAddFileWizard
  bind:open={wizardOpen}
  {providers}
  updateTarget={wizardUpdateTarget}
  onsaved={() => { void loadList(true); }}
/>

<!-- Filter sheet: ALL filters in ONE modal — never stacked toolbar rows.
     Draft values commit on Apply; Clear resets everything. Escape and
     the overlay close predictably (drafts discarded, applied filters
     preserved). -->
{#if filterSheetOpen}
  <div class="wizard-overlay" onclick={closeFilterSheet} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="filter-sheet" role="dialog" aria-modal="true" aria-labelledby="filter-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <div class="filter-head">
        <h3 id="filter-title"><SlidersHorizontal size={14} /> Filters</h3>
        <button type="button" class="wizard-close" onclick={closeFilterSheet} aria-label="Close filters"><X size={16} /></button>
      </div>
      <div class="filter-body">
        <div class="field-group">
          <label class="field-label" for="filter-type">Content type</label>
          <select id="filter-type" class="ref-input" bind:value={draftType}>
            <option value="all">All</option>
            <option value="movie">Movie</option>
            <option value="series">TV Series</option>
            <option value="anime">Anime</option>
          </select>
        </div>
        <div class="field-group">
          <label class="field-label" for="filter-provider">Provider</label>
          <select id="filter-provider" class="ref-input" bind:value={draftProvider}>
            <option value="all">All</option>
            <option value="vidara">Vidara</option>
            <option value="abyss">Abyss</option>
          </select>
        </div>
        <div class="field-group">
          <label class="field-label" for="filter-status">Status</label>
          <select id="filter-status" class="ref-input" bind:value={draftStatus}>
            <option value="all">All</option>
            <option value="available">Available</option>
            <option value="missing">Missing</option>
            <option value="ready">Ready</option>
          </select>
        </div>
        <div class="field-group">
          <label class="field-label" for="filter-sort">Sort</label>
          <select id="filter-sort" class="ref-input" bind:value={draftSort}>
            <option value="recently_updated">Recently Updated</option>
            <option value="recently_added">Recently Added</option>
            <option value="title">Title A-Z</option>
          </select>
        </div>
      </div>
      <div class="filter-actions">
        <button type="button" class="btn btn-cancel" onclick={clearFilters}>Clear</button>
        <button type="button" class="btn btn-apply" onclick={applyFilters}>Apply</button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete Confirmation -->
{#if deleteTarget}
  <div class="wizard-overlay" onclick={() => { if (!deleting) deleteTarget = null; }} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <h3 id="delete-title"><Trash2 size={16} /> Delete media link?</h3>
      <p class="confirm-desc">This will remove <strong>{deleteTarget.title}</strong> from the Media Library.</p>
      <p class="confirm-note"><strong>The hosted file on {providerLabel(deleteTarget)} will NOT be deleted.</strong> It remains on the provider and can be re-linked later.</p>
      <div class="confirm-actions">
        <button type="button" class="btn btn-cancel" onclick={() => { deleteTarget = null; }} disabled={deleting}>Cancel</button>
        <button type="button" class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
          {#if deleting}<Loader2 size={12} class="spinner" /> Deleting…{:else}<Trash2 size={12} /> Delete{/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .media-library { display: flex; flex-direction: column; gap: var(--a2-space-3); }

  /* Compact toolbar — ONE row on every viewport (deep-audit Section 7):
     search takes the available width, the view toggle + Filter button
     stay compact and adjacent. Filters live in the sheet, not here. */
  .toolbar { display: flex; gap: var(--a2-space-2); align-items: center; }
  .search-input-wrap { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 36px; background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); flex: 1; min-width: 0; }
  .search-input-wrap:focus-within { border-color: var(--a2-cyan); }
  .search-input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--a2-text); font-size: var(--a2-text-sm); }
  .search-input::placeholder { color: var(--a2-text-dim); }
  .search-icon { color: var(--a2-text-dim); flex-shrink: 0; }
  .view-toggle { display: inline-flex; gap: 2px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); overflow: hidden; flex-shrink: 0; }
  .view-toggle button { padding: 7px 10px; border: 0; background: transparent; color: var(--a2-text-muted); cursor: pointer; display: grid; place-items: center; }
  .view-toggle button.active { background: rgba(0,200,200,0.12); color: var(--a2-cyan); }
  .filter-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 12px; flex-shrink: 0; min-width: 76px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; }
  .filter-btn:hover { border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .filter-btn.filters-active { border-color: var(--a2-cyan); color: var(--a2-cyan); background: rgba(0,200,200,0.08); }
  .filter-count { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--a2-cyan); color: #001418; font-size: 0.6rem; font-weight: 800; }

  /* Filter sheet */
  .filter-sheet { position: relative; z-index: 91; width: min(400px, calc(100vw - 32px)); max-height: calc(100dvh - 64px); display: flex; flex-direction: column; background: var(--a2-surface-2, #1a1a1a); border: 1px solid var(--a2-border-strong, #333); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; }
  .filter-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--a2-border, #222); }
  .filter-head h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 0.9rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); }
  .wizard-close { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--a2-text-muted, #888); cursor: pointer; }
  .wizard-close:hover { background: var(--a2-surface-3, #222); color: var(--a2-text, #ddd); }
  .filter-body { padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .field-group { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--a2-text-muted, #888); }
  .ref-input { height: 38px; padding: 0 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; color: var(--a2-text, #ddd); font-size: 0.82rem; outline: 0; }
  .ref-input:focus { border-color: var(--a2-cyan, #0ff); }
  .filter-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--a2-border, #222); }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font-size: 0.78rem; font-weight: 700; cursor: pointer; }
  .btn-cancel { background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .btn-apply { background: rgba(0,200,200,0.12); border-color: rgba(0,200,200,0.3); color: var(--a2-cyan, #0ff); }
  .btn-apply:hover { background: rgba(0,200,200,0.2); }

  .state-msg { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); color: var(--a2-text-muted); font-size: var(--a2-text-sm); }
  .state-error { color: var(--a2-red); }
  .state-empty p { margin: 0; text-align: center; max-width: 420px; }
  .retry-btn { padding: 6px 14px; border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; }
  .retry-btn:hover { border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .loading-more { display: flex; align-items: center; justify-content: center; gap: 8px; padding: var(--a2-space-3); color: var(--a2-text-muted); font-size: var(--a2-text-xs); }
  .end-of-list { text-align: center; padding: var(--a2-space-2); color: var(--a2-text-dim); font-size: var(--a2-text-2xs); }

  /* List view */
  .media-list { display: flex; flex-direction: column; gap: 2px; max-height: calc(100dvh - 280px); overflow-y: auto; }
  .media-row { display: flex; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); transition: border-color 140ms ease; }
  .media-row:hover { border-color: var(--a2-border-strong); }
  .media-row[data-status="missing"] { opacity: 0.6; }
  .media-poster { display: grid; place-items: center; width: 40px; height: 60px; flex-shrink: 0; border-radius: var(--a2-radius-sm); background: var(--a2-surface-4); color: var(--a2-text-dim); overflow: hidden; }
  .media-poster img { width: 100%; height: 100%; object-fit: cover; }
  .media-info { flex: 1; min-width: 0; }
  .media-title { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .media-meta { display: flex; gap: var(--a2-space-2); align-items: center; margin-top: 3px; }
  .badge-type { padding: 1px 6px; border-radius: var(--a2-radius-xs); background: var(--a2-surface-4); font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; color: var(--a2-cyan); letter-spacing: 0.04em; }
  .badge-provider { padding: 1px 6px; border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge-provider[data-provider="vidara"] { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
  .badge-provider[data-provider="abyss"] { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
  .tmdb-id { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }

  /* Grid view */
  .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: var(--a2-space-3); max-height: calc(100dvh - 280px); overflow-y: auto; }
  .grid-card { display: flex; flex-direction: column; background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); overflow: hidden; transition: border-color 140ms ease; }
  .grid-card:hover { border-color: var(--a2-border-strong); }
  .grid-card[data-status="missing"] { opacity: 0.6; }
  .grid-poster { position: relative; width: 100%; aspect-ratio: 2/3; background: var(--a2-surface-4); display: grid; place-items: center; }
  .grid-poster img { width: 100%; height: 100%; object-fit: cover; }
  .grid-poster-fallback { color: var(--a2-text-dim); }
  .grid-menu-btn { position: absolute; top: 4px; right: 4px; width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--a2-radius-xs); background: rgba(0,0,0,0.6); color: var(--a2-text); cursor: pointer; opacity: 0; transition: opacity 140ms ease; }
  .grid-card:hover .grid-menu-btn, .grid-menu-btn:focus-visible, .grid-menu-btn[aria-expanded="true"] { opacity: 1; }
  .grid-menu-btn:focus-visible { outline: 2px solid var(--a2-accent, #9b87f5); outline-offset: 1px; }
  .grid-info { padding: 8px; }
  .grid-title { font-size: var(--a2-text-xs); font-weight: 600; color: var(--a2-text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grid-meta { display: flex; gap: 4px; align-items: center; margin-top: 4px; flex-wrap: wrap; }

  /* Menu */
  /* Task 3: the dropdown is PORTALED to document.body (see the script
     block). The legacy absolute rules below are kept for the `.floating`
     surface reuse; the floating variant overrides the anchoring with
     position:fixed + inline top/left and lifts the z-index above the
     wizard/confirm overlays (90/91) so an open menu is never buried. */
  .media-actions { position: relative; flex-shrink: 0; }
  .menu-trigger { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: var(--a2-radius-sm); background: transparent; color: var(--a2-text-muted); cursor: pointer; }
  .menu-trigger:hover { background: var(--a2-surface-3); color: var(--a2-text); }
  .menu-dropdown { position: absolute; right: 0; top: 100%; z-index: 10; min-width: 160px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); box-shadow: 0 8px 24px rgba(0,0,0,0.3); overflow: hidden; }
  .menu-dropdown.floating { position: fixed; right: auto; top: 0; left: 0; z-index: 1000; min-width: 176px; padding: 4px 0; }
  .menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: 0; background: transparent; color: var(--a2-text); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; text-align: left; }
  .menu-item:focus-visible { outline: 2px solid var(--a2-accent, #9b87f5); outline-offset: -2px; }
  .menu-item:hover { background: var(--a2-surface-4); }
  .menu-item-danger { color: var(--a2-red); }
  .menu-item-danger:hover { background: var(--a2-red-soft); }

  /* Delete confirmation */
  .wizard-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; }
  .confirm-dialog { position: relative; z-index: 91; width: min(420px, calc(100vw - 32px)); background: var(--a2-surface-2, #1a1a1a); border: 1px solid var(--a2-border-strong, #333); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; padding: 20px; }
  .confirm-dialog h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 0.9rem; color: var(--a2-text-bright, #f0f0f0); }
  .confirm-desc { margin: 0 0 8px; font-size: 0.8rem; color: var(--a2-text, #ddd); }
  .confirm-note { margin: 0 0 16px; font-size: 0.7rem; color: var(--a2-text-muted, #888); }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font-size: 0.78rem; font-weight: 700; cursor: pointer; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-cancel { background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .btn-danger { background: rgba(220,60,60,0.12); border-color: rgba(220,60,60,0.3); color: #c44; }
  .btn-danger:hover { background: rgba(220,60,60,0.2); }
  .spinner { animation: spin 1s linear infinite; }

  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    /* The toolbar REMAINS one compact row on mobile — search flexes, the
       Filter button stays a compact fixed-width control. Filters open in
       the sheet (no stacked dropdown rows). */
    .toolbar { gap: 6px; }
    .filter-btn { min-width: 44px; padding: 0 10px; }
    .filter-btn span:not(.filter-count) { display: none; }
    .media-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
    .media-poster { width: 32px; height: 48px; }
    .media-title { font-size: var(--a2-text-xs); }
    .media-meta { flex-wrap: wrap; gap: 4px; }
  }
</style>
