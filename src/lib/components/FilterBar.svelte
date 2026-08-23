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
  .filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgba(16,16,24,.7); }
  .filter-label { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; color: var(--muted); font-size: .66rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  label { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: rgba(245,246,250,.03); font-size: .7rem; transition: border-color var(--motion-fast) var(--ease-out); }
  label:focus-within { border-color: rgba(255,90,122,.5); }
  label span { color: var(--muted-deep); font-size: .6rem; font-weight: 700; text-transform: uppercase; }
  select { max-width: 115px; border: 0; outline: 0; color: var(--ink); background: transparent; font-size: .72rem; font-weight: 700; }
  option { color: #f5f6fa; background: #12121a; }
  @media (max-width: 640px) { .filter-bar { width: 100%; } .filter-label { flex: 0 0 auto; } label { flex: 1; justify-content: space-between; min-width: 0; } select { max-width: 74px; } }
</style>
