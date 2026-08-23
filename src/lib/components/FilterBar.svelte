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
  <div class="filter-label" aria-label="Filters"><SlidersHorizontal size={15} /></div>
  <label><span>Genre</span><select name="genre" value={value.genre} onchange={selectValue}><option>All</option>{#each genres as genre}<option>{genre}</option>{/each}</select></label>
  <label><span>Year</span><select name="year" value={value.year} onchange={selectValue}><option>All</option><option>2026</option><option>2025</option><option>2024</option><option>2023</option><option>2022</option><option>2021</option><option>2020</option></select></label>
  <label><span>Sort</span><select name="sort" value={value.sort} onchange={selectValue}><option>For you</option><option>Top rated</option><option>Newest</option></select></label>
</div>

<style>
  .filter-bar { display: grid; grid-template-columns: 28px repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 7px; width: 100%; padding: 7px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgba(16,16,24,.7); }
  .filter-label { display: grid; place-items: center; min-width: 0; color: var(--muted); }
  label { display: grid; align-content: center; gap: 2px; min-width: 0; min-height: 40px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: rgba(245,246,250,.03); font-size: .7rem; transition: border-color var(--motion-fast) var(--ease-out); }
  label:focus-within { border-color: rgba(255,90,122,.5); }
  label span { overflow: hidden; color: var(--muted-deep); font-size: .55rem; font-weight: 700; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
  select { width: 100%; min-width: 0; border: 0; outline: 0; overflow: hidden; color: var(--ink); background: transparent; font-size: .7rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
  option { color: #f5f6fa; background: #12121a; }
  @media (max-width: 640px) { .filter-bar { grid-template-columns: 25px repeat(3, minmax(0, 1fr)); gap: 5px; } label { min-height: 39px; padding: 5px 6px; } label span { font-size: .49rem; } select { font-size: .6rem; } }
</style>
