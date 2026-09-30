<script lang="ts">
  /**
   * Admin 2.0 — Phase C — AdminMediaFilters
   *
   * Filter bar for the Media Library. Supports the primary filters
   * exposed in the toolbar:
   *   - search input (debounced externally)
   *   - content type (all / movie / series / anime)
   *   - status (all / ready / missing / failed / processing)
   *   - provider (all / vidara / abyss / unlinked)
   *   - sort (recently_updated / recently_added / title / year / status)
   *
   * Mobile: the toolbar renders a "Filters" button that opens this
   * component as a bottom sheet. Desktop: renders inline in the
   * toolbar.
   */
  import { X, SlidersHorizontal, Search } from 'lucide-svelte';

  export type FilterState = {
    q: string;
    type: 'all' | 'movie' | 'series' | 'anime';
    status: 'all' | 'ready' | 'missing' | 'failed' | 'processing' | 'available';
    provider: 'all' | 'vidara' | 'abyss' | 'unlinked';
    sort: 'recently_updated' | 'recently_added' | 'title' | 'year' | 'status';
  };

  let {
    filters = {
      q: '', type: 'all', status: 'all', provider: 'all', sort: 'recently_updated'
    } as FilterState,
    hostingSources = [] as Array<{ id: string; name: string; adapterId: string | null }>,
    onchange = (() => {}) as (next: FilterState) => void,
    mobileOpen = $bindable(false) as boolean,
  }: {
    filters?: FilterState;
    hostingSources?: Array<{ id: string; name: string; adapterId: string | null }>;
    onchange?: (next: FilterState) => void;
    mobileOpen?: boolean;
  } = $props();

  function update(patch: Partial<FilterState>) {
    onchange({ ...filters, ...patch });
  }

  function clearAll() {
    onchange({
      q: '', type: 'all', status: 'all', provider: 'all', sort: 'recently_updated'
    });
  }

  const hasActiveFilters = $derived(
    filters.q !== '' || filters.type !== 'all' || filters.status !== 'all' ||
    filters.provider !== 'all' || filters.sort !== 'recently_updated'
  );
</script>

<!-- Desktop inline toolbar -->
<div class="media-filters-desktop">
  <div class="filter-search">
    <span class="filter-search-icon"><Search size={14} /></span>
    <input
      type="text"
      class="filter-input"
      placeholder="Search title, TMDB ID, IMDb ID, canonical key…"
      value={filters.q}
      oninput={(e) => update({ q: (e.target as HTMLInputElement).value })}
      aria-label="Search media"
    />
  </div>

  <select class="filter-select" value={filters.type} onchange={(e) => update({ type: (e.target as HTMLSelectElement).value as FilterState['type'] })} aria-label="Filter by type">
    <option value="all">All Types</option>
    <option value="movie">Movies</option>
    <option value="series">Series</option>
    <option value="anime">Anime</option>
  </select>

  <select class="filter-select" value={filters.status} onchange={(e) => update({ status: (e.target as HTMLSelectElement).value as FilterState['status'] })} aria-label="Filter by status">
    <option value="all">All Status</option>
    <option value="ready">Ready</option>
    <option value="available">Available</option>
    <option value="missing">Missing</option>
    <option value="failed">Failed</option>
    <option value="processing">Processing</option>
  </select>

  <select class="filter-select" value={filters.provider} onchange={(e) => update({ provider: (e.target as HTMLSelectElement).value as FilterState['provider'] })} aria-label="Filter by provider">
    <option value="all">All Providers</option>
    <option value="vidara">Vidara</option>
    <option value="abyss">Abyss</option>
    <option value="unlinked">Unlinked Only</option>
  </select>

  <select class="filter-select" value={filters.sort} onchange={(e) => update({ sort: (e.target as HTMLSelectElement).value as FilterState['sort'] })} aria-label="Sort by">
    <option value="recently_updated">Recently Updated</option>
    <option value="recently_added">Recently Added</option>
    <option value="title">Title (A–Z)</option>
    <option value="year">Year (newest)</option>
    <option value="status">Status</option>
  </select>

  {#if hasActiveFilters}
    <button class="filter-clear" type="button" onclick={clearAll}>Clear</button>
  {/if}
</div>

<!-- Mobile filter sheet -->
{#if mobileOpen}
  <div class="filter-overlay" onclick={() => (mobileOpen = false)} aria-hidden="true"></div>
  <div class="filter-sheet a2-scroll" role="dialog" aria-modal="true" aria-label="Filters">
    <div class="filter-sheet-head">
      <span class="filter-sheet-title"><SlidersHorizontal size={14} /> Filters</span>
      <button class="filter-sheet-close" type="button" onclick={() => (mobileOpen = false)} aria-label="Close filters">
        <X size={16} />
      </button>
    </div>
    <div class="filter-sheet-body">
      <label class="filter-field">
        <span class="filter-field-label">Search</span>
        <input
          type="text"
          class="filter-input"
          placeholder="Title, TMDB ID, IMDb ID…"
          value={filters.q}
          oninput={(e) => update({ q: (e.target as HTMLInputElement).value })}
        />
      </label>

      <label class="filter-field">
        <span class="filter-field-label">Type</span>
        <select class="filter-select" value={filters.type} onchange={(e) => update({ type: (e.target as HTMLSelectElement).value as FilterState['type'] })}>
          <option value="all">All Types</option>
          <option value="movie">Movies</option>
          <option value="series">Series</option>
          <option value="anime">Anime</option>
        </select>
      </label>

      <label class="filter-field">
        <span class="filter-field-label">Status</span>
        <select class="filter-select" value={filters.status} onchange={(e) => update({ status: (e.target as HTMLSelectElement).value as FilterState['status'] })}>
          <option value="all">All Status</option>
          <option value="ready">Ready</option>
          <option value="available">Available</option>
          <option value="missing">Missing</option>
          <option value="failed">Failed</option>
          <option value="processing">Processing</option>
        </select>
      </label>

      <label class="filter-field">
        <span class="filter-field-label">Provider</span>
        <select class="filter-select" value={filters.provider} onchange={(e) => update({ provider: (e.target as HTMLSelectElement).value as FilterState['provider'] })}>
          <option value="all">All Providers</option>
          <option value="vidara">Vidara</option>
          <option value="abyss">Abyss</option>
          <option value="unlinked">Unlinked Only</option>
        </select>
      </label>

      <label class="filter-field">
        <span class="filter-field-label">Sort</span>
        <select class="filter-select" value={filters.sort} onchange={(e) => update({ sort: (e.target as HTMLSelectElement).value as FilterState['sort'] })}>
          <option value="recently_updated">Recently Updated</option>
          <option value="recently_added">Recently Added</option>
          <option value="title">Title (A–Z)</option>
          <option value="year">Year (newest)</option>
          <option value="status">Status</option>
        </select>
      </label>

      {#if hasActiveFilters}
        <button class="filter-clear-full" type="button" onclick={clearAll}>Clear All Filters</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .media-filters-desktop {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    flex: 1;
    flex-wrap: wrap;
  }

  .filter-search {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    flex: 1;
    min-width: 200px;
    max-width: 360px;
    padding: var(--a2-space-1) var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .filter-search:focus-within {
    border-color: var(--a2-cyan-border);
  }
  .filter-search-icon {
    display: grid;
    place-items: center;
    color: var(--a2-text-dim);
  }
  .filter-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    outline: none;
  }
  .filter-input::placeholder {
    color: var(--a2-text-dim);
  }

  .filter-select {
    padding: var(--a2-space-1) var(--a2-space-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xs);
    cursor: pointer;
    outline: none;
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .filter-select:hover, .filter-select:focus-visible {
    border-color: var(--a2-cyan-border);
  }

  .filter-clear {
    padding: var(--a2-space-1) var(--a2-space-3);
    border: none;
    background: transparent;
    color: var(--a2-text-dim);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    cursor: pointer;
    transition: color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .filter-clear:hover { color: var(--a2-red); }

  /* Mobile sheet */
  .filter-overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    animation: a2-filter-fade var(--a2-motion-fast) var(--a2-ease-out);
  }
  .filter-sheet {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 91;
    max-height: 80dvh;
    overflow-y: auto;
    background: var(--a2-surface-2);
    border-top: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-xl) var(--a2-radius-xl) 0 0;
    padding: var(--a2-space-5) var(--a2-space-4) var(--a2-space-8);
    animation: a2-filter-slide var(--a2-motion-slow) var(--a2-ease-out);
  }
  @keyframes a2-filter-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes a2-filter-slide {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }

  .filter-sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--a2-space-5);
  }
  .filter-sheet-title {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    font-family: var(--a2-font-sans);
    font-weight: 700;
    font-size: var(--a2-text-lg);
    color: var(--a2-text-bright);
  }
  .filter-sheet-close {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    cursor: pointer;
  }

  .filter-sheet-body {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-4);
  }
  .filter-field {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
  }
  .filter-field-label {
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
  }
  .filter-sheet .filter-input,
  .filter-sheet .filter-select {
    padding: var(--a2-space-3) var(--a2-space-4);
    font-size: var(--a2-text-base);
    width: 100%;
  }

  .filter-clear-full {
    padding: var(--a2-space-3) var(--a2-space-4);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-red-soft);
    color: var(--a2-red);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    cursor: pointer;
    margin-top: var(--a2-space-2);
  }

  @media (max-width: 768px) {
    .media-filters-desktop { display: none; }
    .filter-sheet-close { min-width: 44px; min-height: 44px; }
    .filter-sheet { padding-bottom: env(safe-area-inset-bottom, 0px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .filter-overlay, .filter-sheet { animation: none; }
    .filter-search, .filter-select { transition: none; }
  }
</style>
