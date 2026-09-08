<script lang="ts">
  import { SlidersHorizontal } from 'lucide-svelte';
  import type { FilterState } from '$components/filter-types';
  import Dropdown from '$components/Dropdown.svelte';

  interface Props {
    value?: FilterState;
    genres?: string[];
    onChange?: (next: FilterState) => void;
  }

  let { value = { genre: 'All', sort: 'For you', year: 'All' }, genres = [], onChange = () => undefined }: Props = $props();

  const currentYear = new Date().getFullYear();
  // current year → 1960, newest first
  const years = Array.from({ length: currentYear - 1959 }, (_, i) => String(currentYear - i));

  const genreOptions = $derived([{ value: 'All', label: 'All' }, ...genres.map((g) => ({ value: g, label: g }))]);
  const yearOptions = [{ value: 'All', label: 'All' }, ...years.map((y) => ({ value: y, label: y }))];
  const sortOptions = [
    { value: 'For you', label: 'For you' },
    { value: 'Top rated', label: 'Top rated' },
    { value: 'Newest', label: 'Newest' }
  ];

  function setGenre(next: string) { onChange({ ...value, genre: next }); }
  function setYear(next: string) { onChange({ ...value, year: next }); }
  function setSort(next: string) { onChange({ ...value, sort: next }); }

  // ============================================================
  // Compact mobile filter surface (<= 640px)
  //
  // The three labelled dropdowns cost too much horizontal room on a
  // 390px phone, so mobile gets a compact discovery control instead:
  //
  //   [ ≡ Filters ]                    [ <sort value> ▾ ]
  //
  // "Filters" toggles a small collapsible surface holding Genre + Year
  // (the two dropdowns that need the most width), while Sort stays
  // directly available on the primary row. The surface reuses the
  // existing Dropdown listbox component — no new modal system.
  //
  // Desktop (> 640px) keeps the full labelled bar — it renders a
  // separate, CSS-toggled DOM instance (the same dual-instance pattern
  // AdultDiscoverSection uses for its labelled/compact dropdowns), so
  // each breakpoint gets exactly the markup it needs and element ids
  // stay unique.
  // ============================================================
  let panelOpen = $state(false);
  let filtersToggle: HTMLButtonElement | undefined;

  let activeFilterCount = $derived(
    (value.genre !== 'All' ? 1 : 0) + (value.year !== 'All' ? 1 : 0) + (value.sort !== 'For you' ? 1 : 0)
  );

  function togglePanel() {
    panelOpen = !panelOpen;
    if (!panelOpen) filtersToggle?.focus();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    // Escape closes the open filter surface and returns focus to the
    // Filters toggle. If a nested Dropdown listbox already consumed this
    // Escape (it calls preventDefault to close just the listbox), let it
    // win — the surface stays open so the user can keep adjusting.
    if (!panelOpen || event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    panelOpen = false;
    filtersToggle?.focus();
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="filter-bar" aria-label="Collection filters">
  <!-- Desktop: full labelled bar (unchanged presentation). -->
  <div class="filter-row filter-row-desktop">
    <div class="filter-label" aria-hidden="true"><SlidersHorizontal size={15} /></div>
    <Dropdown id="filter-genre" label="Genre" value={value.genre} options={genreOptions} onChange={setGenre} />
    <Dropdown id="filter-year" label="Year" value={value.year} options={yearOptions} onChange={setYear} />
    <Dropdown id="filter-sort" label="Sort" value={value.sort} options={sortOptions} onChange={setSort} />
  </div>

  <!-- Mobile: compact primary row — Filters toggle + direct Sort. -->
  <div class="filter-row filter-row-mobile">
    <button
      class="filters-toggle"
      type="button"
      bind:this={filtersToggle}
      aria-expanded={panelOpen}
      aria-controls="collection-filter-panel"
      aria-label={activeFilterCount > 0 ? `Filters, ${activeFilterCount} active` : 'Filters'}
      onclick={togglePanel}
    >
      <SlidersHorizontal size={14} aria-hidden="true" />
      <span class="filters-toggle-label">Filters</span>
      {#if activeFilterCount > 0}<span class="filters-count" aria-hidden="true">{activeFilterCount}</span>{/if}
    </button>
    <div class="filter-sort-mobile">
      <Dropdown id="filter-sort-mobile" label="Sort" hideLabel value={value.sort} options={sortOptions} onChange={setSort} />
    </div>
  </div>

  <!-- Mobile collapsible surface: Genre + Year. -->
  <div class="filter-panel" id="collection-filter-panel" hidden={!panelOpen}>
    <Dropdown id="filter-genre-mobile" label="Genre" value={value.genre} options={genreOptions} onChange={setGenre} />
    <Dropdown id="filter-year-mobile" label="Year" value={value.year} options={yearOptions} onChange={setYear} />
  </div>
</div>

<style>
  .filter-bar {
    width: 100%; padding: 7px;
    border: 1px solid rgba(255,255,255,.08); border-radius: 10px;
    background: rgba(10,10,10,.85);
  }
  .filter-row-desktop {
    display: grid; grid-template-columns: 28px repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 7px;
  }
  .filter-label { display: grid; place-items: center; min-width: 0; color: #77777f; }

  /* Compact mobile filter control + collapsible Genre/Year surface.
     Hidden on desktop; the labelled bar is hidden on mobile. */
  .filter-row-mobile, .filter-panel { display: none; }

  @media (max-width: 640px) {
    .filter-bar { padding: 6px; }
    .filter-row-desktop { display: none; }
    .filter-row-mobile { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 118px); align-items: stretch; gap: 6px; }
    .filters-toggle {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      min-height: 38px; padding: 0 12px;
      border: 1px solid rgba(255,255,255,.08); border-radius: 8px;
      background: rgba(255,255,255,.04); color: #f5f5f5;
      font-size: .72rem; font-weight: 700; cursor: pointer;
      transition: border-color 200ms cubic-bezier(.22,1,.36,1), background 200ms cubic-bezier(.22,1,.36,1);
    }
    .filters-toggle:hover, .filters-toggle:focus-visible {
      border-color: rgba(255,255,255,.18); background: rgba(255,255,255,.07); outline: none;
    }
    .filters-toggle[aria-expanded="true"] { border-color: rgba(255,255,255,.22); background: rgba(255,255,255,.08); }
    .filters-count {
      display: grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px;
      border-radius: 999px; background: #f5f5f5; color: #000;
      font-size: .58rem; font-weight: 800;
    }
    .filter-panel {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px;
      margin-top: 6px; padding-top: 6px;
      border-top: 1px solid rgba(255,255,255,.06);
    }
    .filter-panel[hidden] { display: none; }
  }
  @media (min-width: 641px) {
    .filters-toggle, .filter-row-mobile { display: none; }
    .filter-panel { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .filters-toggle { transition: none; }
  }
</style>
