<script lang="ts">
  import { SlidersHorizontal } from 'lucide-svelte';
  import type { FilterState } from '$components/filter-types';

  export let value: FilterState = { genre: 'All', sort: 'For you', year: 'All' };
  export let genres: string[] = [];
  export let onChange: (next: FilterState) => void = () => undefined;

  function selectValue(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    onChange({ ...value, [target.name]: target.value });
  }
</script>

<div class="filter-bar" aria-label="Collection filters">
  <div class="filter-label"><SlidersHorizontal size={13} /><span>Filter</span></div>
  <label><span>Genre</span><select name="genre" value={value.genre} onchange={selectValue}><option>All</option>{#each genres as genre}<option>{genre}</option>{/each}</select></label>
  <label><span>Year</span><select name="year" value={value.year} onchange={selectValue}><option>All</option><option>2026</option><option>2025</option><option>2024</option><option>2023</option><option>2022</option><option>2021</option><option>2020</option></select></label>
  <label><span>Sort</span><select name="sort" value={value.sort} onchange={selectValue}><option>For you</option><option>Top rated</option><option>Newest</option></select></label>
</div>

<style>
  .filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 7px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgba(16,22,25,.78); box-shadow: inset 0 1px 0 rgba(243,240,233,.025); }
  .filter-label { display: inline-flex; align-items: center; gap: 6px; padding: 0 7px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .55rem; letter-spacing: .08em; text-transform: uppercase; }
  label { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: rgba(228,235,232,.035); font-size: .62rem; }
  label:focus-within { border-color: rgba(167,139,250,.56); }
  label span { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .5rem; text-transform: uppercase; }
  select { max-width: 115px; border: 0; outline: 0; color: var(--ink); background: transparent; font-size: .62rem; font-weight: 800; }
  option { color: #11171a; }
  @media (max-width: 640px) { .filter-bar { width: 100%; flex-wrap: nowrap; overflow-x: auto; padding: 6px; scrollbar-width: none; } .filter-bar::-webkit-scrollbar { display: none; } .filter-label, label { flex: 0 0 auto; } label { justify-content: space-between; min-width: 128px; } select { max-width: 86px; } }
</style>
