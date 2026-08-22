<script lang="ts">
  import { onDestroy } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { Search, LoaderCircle, ChevronDown, X } from 'lucide-svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
  import type { PageData } from './$types';
  import type { ContentType, SearchFilters, SearchSort } from '$lib/server/content/types';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import { ottProviders } from '$lib/shared/ott';

  export let data: PageData;

  type SearchSelectionOption = { key: string; label: string; icon?: string; image?: string; description?: string };

  let query = data.query;
  let type: 'All' | 'Movies' | 'Series' | 'Anime' = data.type === 'movie' ? 'Movies' : data.type === 'series' ? 'Series' : data.type === 'anime' ? 'Anime' : 'All';
  let ott = data.filters?.ott ?? '';
  let genre = data.filters?.genre ?? '';
  let sort: SearchSort | '' = data.filters?.sort ?? '';
  let results: MediaItem[] = data.items;
  let loading = false;
  let errorMessage = data.errorMessage ?? '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestController: AbortController | undefined;
  let requestSequence = 0;
  let routeActive = true;
  let activeSheet: 'ott' | 'genre' | 'sort' | null = null;

  const types = [
    { label: 'Movies', value: 'Movies' },
    { label: 'Shows', value: 'Series' },
    { label: 'Anime', value: 'Anime' }
  ] as const;

  const ottOptions = ottProviders.map((provider) => ({ key: provider.key, label: provider.label, icon: provider.icon, image: provider.logoUrl, logoUrl: provider.logoUrl }));

  const genreOptions = [
    { key: '28', label: 'Action' },
    { key: '12', label: 'Adventure' },
    { key: '35', label: 'Comedy' },
    { key: '80', label: 'Crime' },
    { key: '99', label: 'Documentary' },
    { key: '18', label: 'Drama' },
    { key: '14', label: 'Fantasy' },
    { key: '27', label: 'Horror' },
    { key: '9648', label: 'Mystery' },
    { key: '878', label: 'Sci-Fi' }
  ];

  function typeParam(value: typeof type): ContentType | undefined {
    return value === 'Movies' ? 'movie' : value === 'Series' ? 'series' : value === 'Anime' ? 'anime' : undefined;
  }

  function filterParams() {
    return { ott: ott || undefined, genre: genre || undefined, sort: sort || undefined } satisfies SearchFilters;
  }

  function isSearchRouteActive() {
    return routeActive && page.url.pathname === '/search';
  }

  function syncUrl() {
    if (!isSearchRouteActive()) return;
    const urlParams = new URLSearchParams(page.url.searchParams);
    const normalized = query.trim();
    if (normalized) urlParams.set('q', normalized); else urlParams.delete('q');
    const selectedType = typeParam(type);
    if (selectedType) urlParams.set('type', selectedType); else urlParams.delete('type');
    if (ott) urlParams.set('ott', ott); else urlParams.delete('ott');
    if (genre) urlParams.set('genre', genre); else urlParams.delete('genre');
    if (sort) urlParams.set('sort', sort); else urlParams.delete('sort');
    replaceState(`${page.url.pathname}${urlParams.toString() ? `?${urlParams.toString()}` : ''}`, {});
  }

  function scheduleSearch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runSearch, 340);
  }

  async function runSearch() {
    if (!isSearchRouteActive()) return;
    const normalized = query.trim();
    syncUrl();
    if (!normalized || !isSearchRouteActive()) {
      if (!isSearchRouteActive()) return;
      results = [];
      errorMessage = '';
      return;
    }

    const requestId = ++requestSequence;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    loading = true;
    errorMessage = '';
    try {
      const params = new URLSearchParams({ q: normalized });
      const selectedType = typeParam(type);
      if (selectedType) params.set('type', selectedType);
      const filters = filterParams();
      Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, String(value)); });
      const response = await fetch(`/api/content/search?${params.toString()}`, { signal: controller.signal });
      if (requestId !== requestSequence || controller.signal.aborted || !isSearchRouteActive()) return;
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message || 'Search is temporarily unavailable.');
      if (requestId !== requestSequence || !isSearchRouteActive()) return;
      results = payload.items as MediaItem[];
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestSequence || !isSearchRouteActive()) return;
      errorMessage = error instanceof Error ? error.message : 'Search is temporarily unavailable.';
      results = [];
    } finally {
      if (requestId === requestSequence) {
        loading = false;
        requestController = undefined;
      }
    }
  }

  onDestroy(() => {
    routeActive = false;
    requestSequence += 1;
    if (timer) clearTimeout(timer);
    timer = undefined;
    requestController?.abort();
    requestController = undefined;
  });

  function selectType(value: 'Movies' | 'Series' | 'Anime') {
    type = type === value ? 'All' : value;
    syncUrl();
    if (query.trim()) void runSearch(); else results = [];
  }

  function selectFilter(key: 'ott' | 'genre' | 'sort', value: string) {
    if (key === 'ott') ott = ott === value ? '' : value;
    if (key === 'genre') genre = genre === value ? '' : value;
    if (key === 'sort') sort = sort === value ? '' : value as SearchSort;
    activeSheet = null;
    syncUrl();
    if (query.trim()) void runSearch();
  }

  function openSheet(kind: 'ott' | 'genre' | 'sort') {
    activeSheet = kind;
  }

  function sheetSelection(value: string) {
    if (!activeSheet) return;
    selectFilter(activeSheet, value);
  }

  $: visibleResults = results.filter((item) => type === 'All' || item.type === (type === 'Movies' ? 'movie' : type === 'Series' ? 'series' : 'anime'));
  $: selectedOtt = ottOptions.find((option) => option.key === ott);
  $: selectedGenre = genreOptions.find((option) => option.key === genre);
  $: selectedSort = sort === 'release-asc' ? 'Old to new' : sort === 'release-desc' ? 'New to old' : 'Release date';
  $: sheetTitle = activeSheet === 'ott' ? 'Streaming service' : activeSheet === 'genre' ? 'Genre' : 'Release date';
  $: sheetOptions = activeSheet === 'ott'
    ? [{ key: '', label: 'All OTT' }, ...ottOptions]
    : activeSheet === 'genre'
      ? [{ key: '', label: 'All genres' }, ...genreOptions]
      : [{ key: '', label: 'Release date' }, { key: 'release-asc', label: 'Old to new', description: 'Earliest releases first' }, { key: 'release-desc', label: 'New to old', description: 'Newest releases first' }] as SearchSelectionOption[];
  $: sheetSelected = activeSheet === 'ott' ? ott : activeSheet === 'genre' ? genre : sort;
</script>

<svelte:head>
  <title>Search — Mavero</title>
  <meta name="description" content="Search movies, series, and anime across the MAVERO catalog." />
  <link rel="canonical" href={`${page.url.origin}${page.url.pathname}`} />
  <meta property="og:title" content="Search — Mavero" />
  <meta property="og:description" content="Search movies, series, and anime across the MAVERO catalog." />
  <meta property="og:url" content={`${page.url.origin}${page.url.pathname}`} />
  <meta name="robots" content="noindex,follow" />
</svelte:head>

<div class="container-wide search-page">
  <header class="search-intro"><div class="eyebrow">MAVERO / Find your next story</div><h1>Search the catalogue<span>.</span></h1><p>Search across movies, series, and anime, then narrow the shelf when you know what you want.</p></header>
  <section class="search-panel" aria-label="Search MAVERO">
    <div class="search-band search-large" role="search"><span class="search-leading" aria-hidden="true"><Search size={18} /></span><label class="sr-only" for="catalog-search">Search titles</label><input id="catalog-search" bind:value={query} oninput={scheduleSearch} aria-label="Search titles" placeholder="Search movies, shows, or anime" />{#if query}<button class="clear-search" type="button" aria-label="Clear search" onclick={() => { query = ''; scheduleSearch(); }}><X size={15} /></button>{/if}</div>
    <div class="filter-chips" role="group" aria-label="Filter search by type">
      {#each types as item}<button class:active={type === item.value} class="filter-chip" aria-pressed={type === item.value} onclick={() => selectType(item.value)}>{item.label}</button>{/each}
    </div>
    <div class="filter-selects" aria-label="Additional search filters">
      <button class="filter-trigger" class:active={Boolean(ott)} type="button" aria-label="Choose OTT service" aria-haspopup="dialog" aria-expanded={activeSheet === 'ott'} onclick={() => openSheet('ott')}><span class="select-label">OTT</span><span class="trigger-value">{#if selectedOtt?.logoUrl}<span class="select-icon"><img src={selectedOtt.logoUrl} alt="" loading="lazy" onerror={(event) => { (event.currentTarget as HTMLImageElement).hidden = true; }} /></span>{/if}<span>{selectedOtt?.label ?? 'All OTT'}</span><ChevronDown size={14} /></span></button>
      <button class="filter-trigger" class:active={Boolean(genre)} type="button" aria-label="Choose genre" aria-haspopup="dialog" aria-expanded={activeSheet === 'genre'} onclick={() => openSheet('genre')}><span class="select-label">Genre</span><span class="trigger-value"><span>{selectedGenre?.label ?? 'All genres'}</span><ChevronDown size={14} /></span></button>
      <button class="filter-trigger" class:active={Boolean(sort)} type="button" aria-label="Choose release sorting" aria-haspopup="dialog" aria-expanded={activeSheet === 'sort'} onclick={() => openSheet('sort')}><span class="select-label">Sort</span><span class="trigger-value"><span>{selectedSort}</span><ChevronDown size={14} /></span></button>
    </div>
  </section>

  {#if errorMessage}<div class="search-error" role="alert">{errorMessage}</div>{/if}
  {#if loading}<div class="search-loading" aria-live="polite"><LoaderCircle size={15} /> Searching…</div>{/if}

  {#if visibleResults.length}
    <section class="results-section" aria-live="polite">
      <div class="result-summary"><span>{visibleResults.length} titles</span>{#if query}<strong>Results for “{query}”</strong>{/if}</div>
      <div class="results-grid">{#each visibleResults as item}<MediaCard {item} compact />{/each}</div>
    </section>
  {:else if query.trim() && !loading}
    <section class="empty-search" aria-live="polite"><div class="empty-mark">/</div><h2>No matching stories.</h2><p>Try another title or adjust the filters.</p></section>
  {:else if !loading}
    <section class="search-prompt" aria-live="polite"><span>Search the MAVERO catalog</span><small>Choose a title, then refine it by service, genre, or release date.</small></section>
  {/if}
</div>

<SelectionSheet open={activeSheet !== null} title={sheetTitle} options={sheetOptions} selected={sheetSelected} onClose={() => activeSheet = null} onSelect={sheetSelection} />

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .search-page { min-height: calc(100dvh - 76px); padding-top: 34px; padding-bottom: 76px; }
  .search-intro { width: min(920px, 100%); margin: 0 auto 20px; }
  .search-intro h1 { margin: 8px 0 7px; font-family: 'Space Grotesk', sans-serif; font-size: clamp(2rem, 4vw, 3.5rem); letter-spacing: -.07em; line-height: 1; }
  .search-intro h1 span { color: var(--accent-strong); }
  .search-intro p { max-width: 570px; margin: 0; color: var(--muted); font-size: .8rem; line-height: 1.65; }
  .search-panel { width: min(920px, 100%); margin-inline: auto; }
  .search-large { position: relative; min-height: 64px; margin: 0; padding: 0 14px; border-color: rgba(212,168,106,.28); border-radius: 18px; background: linear-gradient(110deg, rgba(20,20,27,.94), rgba(13,14,19,.9)); box-shadow: inset 0 1px 0 rgba(255,255,255,.045), 0 14px 34px rgba(0,0,0,.12); transition: border-color 180ms ease-out, box-shadow 180ms ease-out, background 180ms ease-out; }
  .search-large:focus-within { border-color: rgba(212,168,106,.62); background: linear-gradient(110deg, rgba(35,31,25,.96), rgba(13,14,19,.94)); box-shadow: inset 0 1px 0 rgba(255,255,255,.05), 0 0 0 4px rgba(212,168,106,.08), 0 18px 40px rgba(0,0,0,.18); }
  .search-leading { display: grid; flex: 0 0 32px; place-items: center; width: 32px; height: 32px; border: 1px solid rgba(212,168,106,.26); border-radius: 10px; color: var(--accent); background: rgba(212,168,106,.1); }
  .search-large input { flex: 1; min-width: 0; height: 62px; padding: 0; color: var(--ink); font-family: Manrope, sans-serif; font-size: .9rem; font-weight: 650; letter-spacing: -.015em; }
  .search-large input::placeholder { color: var(--muted-deep); font-weight: 550; }
  .clear-search { display: grid; flex: 0 0 30px; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); border-radius: 50%; color: var(--muted); background: rgba(255,255,255,.04); cursor: pointer; transition: color 160ms ease-out, background 160ms ease-out, transform 160ms ease-out; }
  .clear-search:hover { color: var(--ink); background: rgba(255,255,255,.09); }
  .clear-search:active { transform: scale(.94); }
  .filter-chips { display: flex; justify-content: flex-start; gap: 7px; margin-top: 10px; }
  .filter-chip { min-height: 34px; border: 1px solid var(--line); border-radius: 999px; padding: 0 17px; color: var(--muted); background: transparent; cursor: pointer; font-size: .67rem; font-weight: 800; transition: color 160ms ease-out, border-color 160ms ease-out, background 160ms ease-out, transform 160ms ease-out; }
  .filter-chip:hover, .filter-chip.active { color: var(--ink); border-color: rgba(212,168,106,.6); background: var(--accent-soft); }
  .filter-chip:active { transform: scale(.97); }
  .filter-selects { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--line); }
  .filter-trigger { display: grid; gap: 6px; min-width: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); background: rgba(255,255,255,.025); text-align: left; cursor: pointer; transition: color 160ms ease-out, border-color 160ms ease-out, background 160ms ease-out, transform 160ms ease-out; }
  .filter-trigger:hover, .filter-trigger:focus-visible { color: var(--ink); border-color: rgba(212,168,106,.6); outline: 0; box-shadow: 0 0 0 3px rgba(212,168,106,.09); }
  .filter-trigger:active { transform: scale(.98); }
  .filter-trigger.active { border-color: rgba(212,168,106,.68); background: rgba(212,168,106,.1); box-shadow: inset 0 0 0 1px rgba(212,168,106,.12); }
  .select-label { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .52rem; letter-spacing: .08em; text-transform: uppercase; }
  .trigger-value { display: flex; align-items: center; min-width: 0; gap: 7px; color: var(--ink); font-size: .67rem; }
  .trigger-value > span:not(.select-icon) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trigger-value :global(svg) { flex: 0 0 auto; margin-left: auto; color: var(--muted-deep); }
  .select-icon { display: grid; flex: 0 0 21px; place-items: center; width: 21px; height: 21px; overflow: hidden; border-radius: 6px; color: var(--ink); background: var(--accent-soft); font-family: 'DM Mono', monospace; font-size: .48rem; font-weight: 800; }
  .select-icon img { grid-area: 1 / 1; }
  .select-icon img { width: 15px; height: 15px; object-fit: contain; border-radius: 3px; }
  .search-loading, .search-error { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 22px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .62rem; }
  .search-loading :global(svg) { animation: spin 1s linear infinite; }
  .search-error { color: #d4b27c; }
  .results-section { margin-top: 32px; }
  .result-summary { display: flex; align-items: baseline; gap: 10px; margin-bottom: 13px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; text-transform: uppercase; }
  .result-summary strong { color: var(--ink); font-family: Manrope, sans-serif; font-size: .88rem; letter-spacing: -.02em; text-transform: none; }
  .results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 172px)); justify-content: start; gap: 25px 15px; }
  .search-prompt, .empty-search { display: grid; place-items: center; gap: 6px; min-height: 210px; margin-top: 34px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); color: var(--muted); text-align: center; }
  .search-prompt span { color: var(--ink); font-size: .9rem; font-weight: 800; }
  .search-prompt small, .empty-search p { margin: 0; color: var(--muted-deep); font-size: .72rem; }
  .empty-mark { color: var(--accent); font-family: 'DM Mono', monospace; font-size: 1.4rem; }
  .empty-search h2 { margin: 0; color: var(--ink); font-size: 1rem; letter-spacing: -.03em; }
  .empty-search p { max-width: 280px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 1000px) { .results-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 172px)); } }
  @media (max-width: 640px) { .search-page { padding-top: calc(68px + env(safe-area-inset-top) + 22px); } .search-intro h1 { font-size: 2.3rem; } .filter-chips { justify-content: flex-start; } .filter-chip { flex: 1; padding: 0 8px; } .filter-selects { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; } .filter-trigger { padding: 8px 7px; } .trigger-value { font-size: .58rem; } .select-icon { flex-basis: 18px; width: 18px; height: 18px; font-size: .42rem; } .results-section { margin-top: 26px; } .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 10px; } }
  @media (prefers-reduced-motion: reduce) { .search-large, .filter-chip, .clear-search, .search-loading :global(svg) { transition: none; animation: none; } }
</style>
