<script lang="ts">
  import { SlidersHorizontal } from 'lucide-svelte';
  import type { FilterState } from '$components/filter-types';
  import Dropdown from '$components/Dropdown.svelte';

  export let value: FilterState = { genre: 'All', sort: 'For you', year: 'All' };
  export let genres: string[] = [];
  export let onChange: (next: FilterState) => void = () => undefined;

  const currentYear = new Date().getFullYear();
  // current year → 1960, newest first
  const years = Array.from({ length: currentYear - 1959 }, (_, i) => String(currentYear - i));

  const genreOptions = [{ value: 'All', label: 'All' }, ...genres.map((g) => ({ value: g, label: g }))];
  const yearOptions = [{ value: 'All', label: 'All' }, ...years.map((y) => ({ value: y, label: y }))];
  const sortOptions = [
    { value: 'For you', label: 'For you' },
    { value: 'Top rated', label: 'Top rated' },
    { value: 'Newest', label: 'Newest' }
  ];

  function setGenre(next: string) { onChange({ ...value, genre: next }); }
  function setYear(next: string) { onChange({ ...value, year: next }); }
  function setSort(next: string) { onChange({ ...value, sort: next }); }
</script>

<div class="filter-bar" aria-label="Collection filters">
  <div class="filter-label" aria-hidden="true"><SlidersHorizontal size={15} /></div>
  <Dropdown id="filter-genre" label="Genre" value={value.genre} options={genreOptions} onChange={setGenre} />
  <Dropdown id="filter-year" label="Year" value={value.year} options={yearOptions} onChange={setYear} />
  <Dropdown id="filter-sort" label="Sort" value={value.sort} options={sortOptions} onChange={setSort} />
</div>

<style>
  .filter-bar {
    display: grid; grid-template-columns: 28px repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 7px;
    width: 100%; padding: 7px; border: 1px solid rgba(255,255,255,.08); border-radius: 10px;
    background: rgba(10,10,10,.85);
  }
  .filter-label { display: grid; place-items: center; min-width: 0; color: #77777f; }
  @media (max-width: 640px) {
    .filter-bar { grid-template-columns: 24px repeat(3, minmax(0, 1fr)); gap: 5px; padding: 6px; }
  }
</style>
