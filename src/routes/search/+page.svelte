<script lang="ts">
  import { onDestroy } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { Search, LoaderCircle, X, Compass } from 'lucide-svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';

  // BUG 3 FIX: MediaCard is lazily imported only when results exist.
  // The initial empty Search state (no query, no results) does NOT need
  // MediaCard's dependency tree (lucide icons, IntersectionObserver,
  // navigation helpers). By deferring the import, the Search route chunk
  // is smaller and the empty Search page becomes interactive faster.
  // The import fires on first render where visibleResults.length > 0.
  let MediaCardComponent = $state<any>(null);
  async function loadMediaCard() {
    if (MediaCardComponent) return;
    const mod = await import('$components/MediaCard.svelte');
    MediaCardComponent = mod.default;
  }

  let { data }: { data: PageData } = $props();

  // The Search page exposes only three content filters: All / Movie / TV Show.
  // Anime is no longer a separate filter — TMDB-tagged anime movies flow
  // through the Movie filter (item.type === 'movie') and TMDB-tagged anime
  // series flow through the TV Show filter (item.type === 'series'). Legacy
  // ?type=anime URLs gracefully fall back to 'All' so old bookmarks don't
  // mis-route.
  type TypeFilter = 'All' | 'Movie' | 'TV Show';

  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the search effect re-syncs on every navigation
  let query = $state(data.query);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the search effect re-syncs on every navigation
  let type = $state<TypeFilter>(
    data.type === 'movie' ? 'Movie' : data.type === 'series' ? 'TV Show' : 'All'
  );
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the search effect re-syncs on every navigation
  let results = $state<MediaItem[]>(data.items);
  let loading = $state(false);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the search effect re-syncs on every navigation
  let errorMessage = $state(data.errorMessage ?? '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestController: AbortController | undefined;
  let requestSequence = 0;
  let routeActive = true;
  let searchInputEl: HTMLInputElement | undefined;

  // Page snapshot — preserves the user's in-progress search across
  // back/forward navigation. When the user opens a result card and then
  // presses Back (browser Back OR DetailPage back-arrow icon, which now
  // uses `history.back()`), SvelteKit captures this snapshot before
  // navigating away and restores it when the user returns — so the
  // search query, selected type, complete result list, and any error
  // message are all preserved without re-typing.
  //
  // Only JSON-serializable, user-visible state is snapshotted. The
  // request/race-protection primitives (requestController, requestSequence,
  // routeActive, timer) are intentionally NOT snapshotted — they are
  // runtime-only and would either fail to serialize or recreate stale
  // fetch handles. `loading` is also intentionally omitted: a snapshot
  // restore never happens mid-flight, and forcing `loading=true` on
  // restore would leave the UI stuck on the spinner if the restored
  // results are already present.
  //
  // The X clear button (clearQuery) resets query/results/errorMessage
  // and updates the URL — after a clear, a fresh search starts cleanly
  // because the next navigation captures an empty snapshot.
  export const snapshot = {
    capture: (): {
      query: string;
      type: TypeFilter;
      results: MediaItem[];
      errorMessage: string;
    } => ({
      query,
      type,
      results,
      errorMessage
    }),
    restore: (value: {
      query: string;
      type: TypeFilter;
      results: MediaItem[];
      errorMessage: string;
    }) => {
      if (!value || typeof value !== 'object') return;
      query = typeof value.query === 'string' ? value.query : '';
      type = value.type === 'Movie' || value.type === 'TV Show' ? value.type : 'All';
      results = Array.isArray(value.results) ? value.results : [];
      errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage : '';
    }
  };

  const typeOptions: { value: TypeFilter; label: string }[] = [
    { value: 'All', label: 'All' },
    { value: 'Movie', label: 'Movie' },
    { value: 'TV Show', label: 'TV Show' }
  ];

  function typeParam(value: TypeFilter): 'movie' | 'series' | undefined {
    return value === 'Movie' ? 'movie' : value === 'TV Show' ? 'series' : undefined;
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

  function selectType(value: TypeFilter) {
    type = value;
    syncUrl();
    if (query.trim()) void runSearch(); else results = [];
  }

  // X button inside the search input — clears the query only (the search
  // page no longer has separate service/genre/sort filters to reset).
  function clearQuery() {
    query = '';
    results = [];
    errorMessage = '';
    syncUrl();
    searchInputEl?.focus();
  }

  // TMDB-tagged anime content carries isAnime === true but its `type` is
  // 'movie' or 'series', so it naturally falls under the Movie / TV Show
  // filter. Legacy fixture items with type === 'anime' surface only under
  // 'All' — fixtures are a last-resort fallback and rarely visible.
  let visibleResults = $derived(
    results.filter((item) =>
      type === 'All' ? true : item.type === (type === 'Movie' ? 'movie' : 'series')
    )
  );

  // Trigger lazy MediaCard import when results first appear.
  $effect(() => {
    if (visibleResults.length > 0) void loadMediaCard();
  });
</script>

<svelte:head>
  <title>Search — Mavero</title>
  <meta name="description" content="Search movies and series across the Mavero catalog." />
  <link rel="canonical" href={`${page.url.origin}${page.url.pathname}`} />
  <meta property="og:title" content="Search — Mavero" />
  <meta property="og:description" content="Search movies and series across the Mavero catalog." />
  <meta property="og:url" content={`${page.url.origin}${page.url.pathname}`} />
  <meta name="robots" content="noindex,follow" />
</svelte:head>

<div class="search-page">
  <!-- Search hero — single prominent heading + search input + three filters -->
  <section class="search-hero" aria-label="Search MAVERO">
    <div class="search-hero-inner">
      <h1 class="search-heading">
        <span class="heading-icon" aria-hidden="true"><Search size={18} /></span>
        <span class="heading-brand">MAVERO</span>
        <span class="heading-sep" aria-hidden="true">/</span>
        <span class="heading-page">Search</span>
      </h1>

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
          <button class="clear-btn" type="button" aria-label="Clear search" onclick={() => { clearQuery(); }}>
            <X size={16} />
          </button>
        {/if}
      </div>

      <!-- Three-filter segmented control. Anime is intentionally NOT a
           separate filter — anime movies appear under Movie, anime series
           under TV Show. -->
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
            {#if MediaCardComponent}
              <MediaCardComponent {item} compact />
            {/if}
          {/each}
        </div>
      </section>
    {:else if query.trim() && !loading}
      <section class="empty-search" aria-live="polite">
        <div class="empty-mark" aria-hidden="true"><Search size={22} /></div>
        <h2>No matching stories.</h2>
        <p>Try another title or switch the type filter.</p>
        <button class="empty-action" type="button" onclick={clearQuery}>Clear search</button>
      </section>
    {:else if !loading}
      <!-- No query: Search has one purpose — find something. Discovery
           lives on /discover. Show a focused empty-search state instead
           of duplicating discovery rails here. -->
      <section class="empty-search primary-empty" aria-live="polite">
        <div class="empty-mark" aria-hidden="true"><Compass size={24} /></div>
        <h2>Find your next story.</h2>
        <p>Search by title above.</p>
        <a class="empty-action" href="/discover">Browse Discover</a>
      </section>
    {/if}
  </div>
</div>

<ScrollToTop />

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
    padding: 22px var(--s-gutter) 20px;
    border-bottom: 1px solid rgba(255,255,255,.05);
    background:
      radial-gradient(circle at 80% -30%, rgba(255,255,255,.04), transparent 50%),
      #000;
  }
  .search-hero-inner {
    width: min(920px, 100%);
    margin-inline: auto;
  }

  /* Primary page heading — promoted from the old eyebrow breadcrumb. */
  .search-heading {
    display: inline-flex; align-items: center; gap: 8px;
    margin: 0 0 16px;
    color: #f5f5f5;
    font-size: clamp(1.4rem, 4.6vw, 2rem);
    font-weight: 800;
    letter-spacing: -.02em;
    line-height: 1.1;
    text-wrap: balance;
  }
  .heading-icon {
    display: inline-grid; place-items: center;
    color: #b7b7bd;
    flex: 0 0 auto;
  }
  .heading-brand { color: #f5f5f5; }
  .heading-sep { color: #55555d; font-weight: 700; }
  .heading-page { color: #e8e8ec; }

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

  /* Filter row */
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
    padding: 0 16px;
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
    text-decoration: none;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .empty-action:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.24); }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .search-hero { padding-top: 18px; padding-bottom: 16px; }
    .search-heading { font-size: clamp(1.25rem, 5.4vw, 1.6rem); margin-bottom: 14px; gap: 6px; }
    .search-field { height: 52px; }
    .search-field input { font-size: .88rem; }
    .type-segmented { display: flex; width: 100%; }
    .type-seg { flex: 1 1 0; min-width: 0; padding: 0 8px; justify-content: center; }
    .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 11px; }
    .empty-search { padding: 32px 16px; }
  }

  @media (min-width: 900px) {
    .search-hero { padding-top: 36px; padding-bottom: 28px; }
    .search-heading { font-size: clamp(1.8rem, 3.2vw, 2.2rem); }
    .search-field { height: 60px; }
    .search-field input { font-size: 1rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .search-field, .type-seg, .clear-btn, .search-message.loading :global(svg) { transition: none; animation: none; }
  }
</style>
