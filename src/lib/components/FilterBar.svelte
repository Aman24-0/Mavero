<script lang="ts">
  import { SlidersHorizontal } from 'lucide-svelte';
  import type { FilterState } from '$components/filter-types';

  export let value: FilterState = { genre: 'All', sort: 'For you', year: 'All' };
  export let genres: string[] = [];
  export let onChange: (next: FilterState) => void = () => undefined;

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - 1959 }, (_, i) => String(currentYear - i));

  function selectValue(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    onChange({ ...value, [target.name]: target.value });
  }
</script>

<div class="filter-bar" aria-label="Collection filters">
  <div class="filter-label" aria-label="Filters"><SlidersHorizontal size={15} /></div>
  <label><span>Genre</span>
    <div class="select-wrap">
      <select name="genre" value={value.genre} onchange={selectValue}><option>All</option>{#each genres as genre}<option>{genre}</option>{/each}</select>
    </div>
  </label>
  <label><span>Year</span>
    <div class="select-wrap">
      <select name="year" value={value.year} onchange={selectValue}><option>All</option>{#each years as yr}<option>{yr}</option>{/each}</select>
    </div>
  </label>
  <label><span>Sort</span>
    <div class="select-wrap">
      <select name="sort" value={value.sort} onchange={selectValue}><option>For you</option><option>Top rated</option><option>Newest</option></select>
    </div>
  </label>
</div>

<style>
  .filter-bar {
    display: grid; grid-template-columns: 28px repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 7px;
    width: 100%; padding: 7px; border: 1px solid rgba(255,255,255,.08); border-radius: 10px;
    background: rgba(10,10,10,.8);
  }
  .filter-label { display: grid; place-items: center; min-width: 0; color: #77777f; }
  label {
    display: grid; align-content: center; gap: 2px; min-width: 0; min-height: 40px;
    padding: 5px 9px; border: 1px solid rgba(255,255,255,.06); border-radius: 8px;
    color: #77777f; background: rgba(255,255,255,.03); font-size: .7rem;
    transition: border-color 200ms cubic-bezier(.22,1,.36,1);
  }
  label:focus-within { border-color: rgba(255,255,255,.14); }
  label span { overflow: hidden; color: #77777f; font-size: .55rem; font-weight: 700; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
  .select-wrap { position: relative; }
  .select-wrap::after {
    content: ''; position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    width: 0; height: 0; border-left: 3px solid transparent; border-right: 3px solid transparent;
    border-top: 4px solid #77777f; pointer-events: none;
  }
  select {
    width: 100%; min-width: 0; border: 0; outline: 0; overflow: hidden;
    color: #f5f5f5; background: transparent; font-size: .7rem; font-weight: 700;
    text-overflow: ellipsis; white-space: nowrap; appearance: none; -webkit-appearance: none;
    padding-right: 16px; cursor: pointer;
  }
  option { color: #f5f5f5; background: #111111; }
  @media (max-width: 640px) {
    .filter-bar { grid-template-columns: 25px repeat(3, minmax(0, 1fr)); gap: 5px; }
    label { min-height: 39px; padding: 5px 6px; }
    label span { font-size: .49rem; }
    select { font-size: .6rem; }
  }
</style>
