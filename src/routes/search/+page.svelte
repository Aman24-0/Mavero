<script lang="ts">
  import { onDestroy } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { Search, LoaderCircle, X, Clapperboard, Compass } from 'lucide-svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
  import Dropdown from '$components/Dropdown.svelte';
  import MediaCard from '$components/MediaCard.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import type { PageData } from './$types';
  import type { ContentType, SearchFilters, SearchSort } from '$lib/server/content/types';
  import type { MediaItem } from '$data/content';
  import { ottProviders } from '$lib/shared/ott';

  let { data }: { data: PageData } = $props();

  type SearchSelectionOption = { key: string; label: string; icon?: string; image?: string; description?: string };

  let query = $state(data.query);
  let type = $state<'All' | 'Movies' | 'Series' | 'Anime'>(data.type === 'movie' ? 'Movies' : data.type === 'series' ? 'Series' : data.type === 'anime' ? 'Anime' : 'All');
  let ott = $state(data.filters?.ott ?? '');
  let genre = $state(data.filters?.genre ?? '');
  let sort = $state<SearchSort | ''>(data.filters?.sort ?? '');
  let results = $state<MediaItem[]>(data.items);
  let loading = $state(false);
  let errorMessage = $state(data.errorMessage ?? '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestController: AbortController | undefined;
  let requestSequence = 0;
  let routeActive = true;
  let activeSheet = $state<'ott' | null>(null);
  let searchInputEl: HTMLInputElement | undefined;

  const typeOptions = [
    { value: 'All', label: 'All' },
    { value: 'Movies', label: 'Movies' },
    { value: 'Series', label: 'TV Shows' },
    { value: 'Anime', label: 'Anime' }
  ];

  const ottOptions = ottProviders.map((provider) => ({ key: provider.key, label: provider.label, icon: provider.icon, image: provider.logoUrl, logoUrl: provider.logoUrl }));

  const genreDropdownOptions = [
    { value: '', label: 'All genres' },
    { key: '28', value: '28', label: 'Action' },
    { key: '12', value: '12', label: 'Adventure' },
    { key: '35', value: '35', label: 'Comedy' },
    { key: '80', value: '80', label: 'Crime' },
    { key: '99', value: '99', label: 'Documentary' },
    { key: '18', value: '18', label: 'Drama' },
    { key: '14', value: '14', label: 'Fantasy' },
    { key: '27', value: '27', label: 'Horror' },
    { key: '9648', value: '9648', label: 'Mystery' },
    { key: '878', value: '878', label: 'Sci-Fi' }
  ];
  const genreLabel = (value: string) => genreDropdownOptions.find((option) => option.value === value)?.label ?? 'All genres';

  const sortDropdownOptions = [
    { value: '', label: 'Release date' },
    { value: 'release-asc', label: 'Old to new' },
    { value: 'release-desc', label: 'New to old' }
  ];
  const sortLabel = (value: string) => sortDropdownOptions.find((option) => option.value === value)?.label ?? 'Release date';

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

  function selectType(value: string) {
    type = value as typeof type;
    syncUrl();
    if (query.trim()) void runSearch(); else results = [];
  }

  function setGenre(next: string) {
    genre = next;
    syncUrl();
    if (query.trim()) void runSearch();
  }
  function setSort(next: string) {
    sort = (next || '') as SearchSort | '';
    syncUrl();
    if (query.trim()) void runSearch();
  }
  function selectFilter(key: 'ott', value: string) {
    if (key === 'ott') ott = ott === value ? '' : value;
    activeSheet = null;
    syncUrl();
    if (query.trim()) void runSearch();
  }
  function openSheet(kind: 'ott') { activeSheet = kind; }
  function sheetSelection(value: string) {
    if (!activeSheet) return;
    selectFilter(activeSheet, value);
  }

  function clearAll() {
    query = '';
    type = 'All';
    ott = '';
    genre = '';
    sort = '';
    results = [];
    errorMessage = '';
    syncUrl();
    searchInputEl?.focus();
  }

  let visibleResults = $derived(results.filter((item) => type === 'All' || item.type === (type === 'Movies' ? 'movie' : type === 'Series' ? 'series' : 'anime')));
  let selectedOtt = $derived(ottOptions.find((option) => option.key === ott));
  const sheetTitle = 'Streaming service';
  const sheetOptions: SearchSelectionOption[] = [{ key: '', label: 'All OTT' }, ...ottOptions];
  let sheetSelected = $derived(ott);
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

<div class="search-page">
  <!-- Search hero -->
  <section class="search-hero" aria-label="Search MAVERO">
    <div class="search-hero-inner">
      <div class="hero-eyebrow"><Search size={13} /> MAVERO / Search</div>
      <h1 class="hero-title">Find your next story.</h1>
      <p class="hero-sub">Search across movies, TV shows, and anime. Refine by service, genre, or release date.</p>

      <div class="search-field" role="search">
        <span class="search-leading" aria-hidden="true"><Search size={18} /></span>
        <label class="sr-only" for="catalog-search">Search titles</label>
        <input
          id="catalog-search"
          bind:this={searchInputEl}
          bind:value={query}
          oninput={scheduleSearch}
          aria-label="Search titles"
          placeholder="Search movies, shows, or anime"
          autocomplete="off"
          spellcheck="false"
        />
        {#if query}
          <button class="clear-btn" type="button" aria-label="Clear search" onclick={() => { query = ''; scheduleSearch(); searchInputEl?.focus(); }}>
            <X size={16} />
          </button>
        {/if}
      </div>

      <!-- Type segmented control -->
      <div class="filter-row">
        <div class="type-segmented" role="tablist" aria-label="Filter search by type">
          {#each typeOptions as option}
            <button
              type="button"
              class="type-seg"
              class:active={type === option.value}
              role="tab"
              aria-selected={type === option.value}
              onclick={() => selectType(option.value)}
            >{option.label}</button>
          {/each}
        </div>
      </div>

      <!-- Secondary filters -->
      <div class="filter-row secondary-filters">
        <button
          class="filter-pill"
          class:active={Boolean(ott)}
          type="button"
          aria-label="Choose streaming service"
          aria-haspopup="dialog"
          aria-expanded={activeSheet === 'ott'}
          onclick={() => openSheet('ott')}
        >
          {#if selectedOtt?.logoUrl}
            <span class="pill-icon"><img src={selectedOtt.logoUrl} alt="" loading="lazy" onerror={(event) => { (event.currentTarget as HTMLImageElement).hidden = true; }} /></span>
          {:else}
            <span class="pill-icon-fallback"><Clapperboard size={12} /></span>
          {/if}
          <span class="pill-text">{selectedOtt?.label ?? 'All services'}</span>
        </button>

        <div class="dropdown-wrap">
          <Dropdown id="search-genre" label="Genre" value={genre} options={genreDropdownOptions} onChange={setGenre} />
        </div>
        <div class="dropdown-wrap">
          <Dropdown id="search-sort" label="Sort" value={sort} options={sortDropdownOptions} onChange={setSort} />
        </div>

        {#if query || ott || genre || sort}
          <button class="clear-all" type="button" onclick={clearAll} aria-label="Clear all filters">Clear all</button>
        {/if}
      </div>
    </div>
  </section>

  <!-- Status / messages -->
  {#if errorMessage}
    <div class="search-message error" role="alert">{errorMessage}</div>
  {/if}
  {#if loading}
    <div class="search-message loading" aria-live="polite"><LoaderCircle size={15} /> Searching…</div>
  {/if}

  <!-- Result / discovery body -->
  <div class="search-body">
    {#if visibleResults.length}
      <section class="results-section" aria-live="polite">
        <div class="result-summary">
          <span class="result-count">{visibleResults.length} {visibleResults.length === 1 ? 'title' : 'titles'}</span>
          {#if query}<strong class="result-query">Results for “{query}”</strong>{/if}
        </div>
        <div class="results-grid">
          {#each visibleResults as item (item.type + ':' + item.id)}
            <MediaCard {item} compact />
          {/each}
        </div>
      </section>
    {:else if query.trim() && !loading}
      <section class="empty-search" aria-live="polite">
        <div class="empty-mark" aria-hidden="true"><Search size={22} /></div>
        <h2>No matching stories.</h2>
        <p>Try another title, switch the type filter, or clear your filters.</p>
        <button class="empty-action" type="button" onclick={clearAll}>Clear search</button>
      </section>
    {:else if !loading}
      <!-- No query: Search has one purpose — find something. Discovery
           lives on /discover. Show a focused empty-search state instead
           of duplicating discovery rails here. -->
      <section class="empty-search primary-empty" aria-live="polite">
        <div class="empty-mark" aria-hidden="true"><Compass size={24} /></div>
        <h2>Find your next story.</h2>
        <p>Search by title above. Filter by service, genre, or release date to narrow the results.</p>
        <a class="empty-action" href="/discover">Browse Discover</a>
      </section>
    {/if}
  </div>
</div>

<ScrollToTop />

<SelectionSheet open={activeSheet !== null} title={sheetTitle} options={sheetOptions} selected={sheetSelected} onClose={() => activeSheet = null} onSelect={sheetSelection} />

<style>
  .search-page {
    --s-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    padding-bottom: 110px;
  }

  .search-hero {
    position: relative;
    /* The shell already adds the topbar offset via --shell-content-top.
       We only add a deliberate per-page breathing room here. */
    padding: 26px var(--s-gutter) 26px;
    border-bottom: 1px solid rgba(255,255,255,.05);
    background:
      radial-gradient(circle at 80% -30%, rgba(255,255,255,.04), transparent 50%),
      #000;
  }
  .search-hero-inner {
    width: min(920px, 100%);
    margin-inline: auto;
  }
  .hero-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    color: #77777f; font-size: .6rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .hero-title {
    margin: 8px 0 6px;
    color: #f5f5f5;
    font-size: clamp(1.6rem, 4.5vw, 2.4rem);
    font-weight: 800;
    letter-spacing: -.025em;
    line-height: 1.05;
    text-wrap: balance;
  }
  .hero-sub {
    margin: 0 0 18px;
    color: #b7b7bd;
    font-size: .82rem;
    line-height: 1.55;
    max-width: 540px;
  }

  /* Search field */
  .search-field {
    display: flex; align-items: center; gap: 12px;
    height: 56px;
    padding: 0 12px 0 16px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 14px;
    background: rgba(20,20,24,.85);
    transition: border-color 200ms cubic-bezier(.22,1,.36,1), background 200ms cubic-bezier(.22,1,.36,1);
  }
  .search-field:focus-within {
    border-color: rgba(255,255,255,.28);
    background: rgba(28,28,34,.95);
  }
  .search-leading {
    display: grid; place-items: center;
    width: 28px; height: 28px;
    color: #77777f;
    flex: 0 0 auto;
  }
  .search-field input {
    flex: 1; min-width: 0;
    border: 0; outline: 0;
    color: #f5f5f5;
    background: transparent;
    font: inherit;
    font-size: .95rem;
    font-weight: 500;
    letter-spacing: -.005em;
  }
  .search-field input::placeholder { color: #55555d; font-weight: 400; }
  .clear-btn {
    display: grid; place-items: center;
    width: 32px; height: 32px;
    border: 0; border-radius: 50%;
    color: #b7b7bd;
    background: rgba(255,255,255,.06);
    cursor: pointer;
    flex: 0 0 auto;
    transition: background 160ms ease, color 160ms ease;
  }
  .clear-btn:hover { background: rgba(255,255,255,.12); color: #f5f5f5; }
  .clear-btn:active { transform: scale(.94); }

  /* Filter rows */
  .filter-row { margin-top: 14px; }
  .type-segmented {
    display: inline-flex; gap: 4px;
    padding: 4px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px;
    background: rgba(255,255,255,.025);
    overflow-x: auto;
    scrollbar-width: none;
    max-width: 100%;
  }
  .type-segmented::-webkit-scrollbar { display: none; }
  .type-seg {
    min-height: 36px;
    padding: 0 14px;
    border: 0; border-radius: 8px;
    color: #b7b7bd;
    background: transparent;
    font: inherit;
    font-size: .74rem; font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    transition: color 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1);
  }
  .type-seg:hover { color: #f5f5f5; }
  .type-seg:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }
  .type-seg.active { color: #000; background: #f5f5f5; }

  .secondary-filters {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    margin-top: 12px;
  }
  .filter-pill {
    display: inline-flex; align-items: center; gap: 8px;
    min-height: 40px;
    padding: 0 14px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 10px;
    color: #b7b7bd;
    background: rgba(255,255,255,.04);
    font: inherit;
    font-size: .72rem; font-weight: 700;
    cursor: pointer;
    transition: border-color 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1), color 180ms cubic-bezier(.22,1,.36,1);
  }
  .filter-pill:hover { border-color: rgba(255,255,255,.22); color: #f5f5f5; background: rgba(255,255,255,.07); }
  .filter-pill.active { border-color: rgba(255,255,255,.3); color: #f5f5f5; background: rgba(255,255,255,.1); }
  .pill-icon { display: grid; place-items: center; width: 18px; height: 18px; flex: 0 0 auto; }
  .pill-icon img { width: 18px; height: 18px; object-fit: contain; border-radius: 3px; }
  .pill-icon-fallback { display: grid; place-items: center; color: #77777f; }
  .pill-text { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .dropdown-wrap { min-width: 130px; }

  /* The standalone GENRE / SORT micro-labels above the two dropdowns pushed
     their triggers below the neighboring "All services" pill. They are
     visually hidden (sr-only) so the three controls align on one baseline
     row; the label elements remain rendered for aria-labelledby, so the
     controls keep accessible names and genre/sort logic is untouched. */
  .secondary-filters :global(.dropdown-label) {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .clear-all {
    margin-left: auto;
    background: transparent; border: 0;
    color: #77777f;
    font: inherit; font-size: .7rem; font-weight: 700;
    cursor: pointer;
    text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(255,255,255,.3);
    padding: 6px 4px;
  }
  .clear-all:hover { color: #f5f5f5; text-decoration-color: #f5f5f5; }

  /* Messages */
  .search-message {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin: 18px var(--s-gutter) 0;
    color: #77777f;
    font-size: .72rem;
  }
  .search-message.loading :global(svg) { animation: spin 1s linear infinite; }
  .search-message.error { color: #ffb020; }

  /* Body */
  .search-body { padding: 0 var(--s-gutter); }

  /* Results */
  .results-section { margin-top: 26px; }
  .result-summary {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .result-count {
    color: #77777f;
    font-size: .62rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .result-query {
    color: #f5f5f5;
    font-size: .92rem; font-weight: 700;
    letter-spacing: -.01em;
  }
  .results-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 182px));
    justify-content: start;
    gap: 26px 14px;
  }

  /* Empty state */
  .empty-search {
    display: grid; place-items: center; gap: 8px;
    min-height: 240px;
    margin-top: 28px;
    padding: 40px 20px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 14px;
    background: rgba(255,255,255,.015);
    text-align: center;
  }
  .empty-mark {
    display: grid; place-items: center;
    width: 56px; height: 56px;
    margin-bottom: 4px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 50%;
    color: #b7b7bd;
    background: rgba(255,255,255,.03);
  }
  .empty-search h2 {
    margin: 0;
    color: #f5f5f5;
    font-size: 1.15rem; font-weight: 800;
    letter-spacing: -.015em;
  }
  .empty-search p {
    margin: 0; max-width: 320px;
    color: #77777f;
    font-size: .8rem; line-height: 1.55;
  }
  .empty-action {
    margin-top: 10px;
    padding: 9px 18px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.06);
    font: inherit;
    font-size: .76rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .empty-action:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.24); }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .search-hero { padding-top: 22px; padding-bottom: 18px; }
    .hero-title { font-size: clamp(1.4rem, 6vw, 2rem); }
    .hero-sub { font-size: .78rem; }
    .search-field { height: 52px; }
    .search-field input { font-size: .88rem; }
    .type-segmented { display: flex; width: 100%; }
    .type-seg { flex: 1 1 0; min-width: 0; padding: 0 8px; justify-content: center; }
    .secondary-filters { gap: 5px; }
    .filter-pill { min-height: 38px; padding: 0 9px; font-size: .68rem; min-width: 0; }
    .pill-text { max-width: 96px; }
    /* All services / genre / sort stay on one row: dropdowns share the
       remaining width equally and ellipsize instead of overflowing. */
    .dropdown-wrap { min-width: 0; flex: 1 1 0; }
    .clear-all { margin-left: 0; flex-basis: 100%; text-align: left; padding-left: 0; }
    .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 11px; }
    .empty-search { padding: 32px 16px; }
  }

  @media (min-width: 900px) {
    .search-hero { padding-top: 44px; padding-bottom: 36px; }
    .hero-title { font-size: clamp(2rem, 3.4vw, 2.8rem); }
    .search-field { height: 62px; }
    .search-field input { font-size: 1rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .search-field, .type-seg, .filter-pill, .clear-btn, .search-message.loading :global(svg) { transition: none; animation: none; }
  }
</style>
