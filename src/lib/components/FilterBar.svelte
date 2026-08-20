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
  <div class="filter-label"><SlidersHorizontal size={14} /> Refine</div>
  <label><span>Genre</span><select name="genre" value={value.genre} onchange={selectValue}><option>All</option>{#each genres as genre}<option>{genre}</option>{/each}</select></label>
  <label><span>Year</span><select name="year" value={value.year} onchange={selectValue}><option>All</option><option>2025</option><option>2024</option><option>2023</option><option>2022</option></select></label>
  <label><span>Sort</span><select name="sort" value={value.sort} onchange={selectValue}><option>For you</option><option>Top rated</option><option>Newest</option></select></label>
</div>

<style>
  .filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: 14px; background: rgba(16,18,22,.76); }
  .filter-label { display: inline-flex; align-items: center; gap: 7px; padding: 0 7px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .59rem; text-transform: uppercase; }
  label { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); background: rgba(255,255,255,.025); font-size: .68rem; }
  label span { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; text-transform: uppercase; }
  select { border: 0; outline: 0; color: var(--ink); background: transparent; font-size: .68rem; font-weight: 800; }
  option { color: #101216; }
  @media (max-width: 640px) { .filter-bar { align-items: stretch; } .filter-label { width: 100%; padding-bottom: 3px; } label { flex: 1; justify-content: space-between; } }
</style>
