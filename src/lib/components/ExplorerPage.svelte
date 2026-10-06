<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { Check, LoaderCircle, RotateCw, SlidersHorizontal } from 'lucide-svelte';
  import type { ContentType } from '$data/content';
  import type { MediaItem } from '$data/content';
  import { DESTINATION_LABELS } from '$lib/shared/content-labels';
  import { EXPLORER_GENRES, EXPLORER_LANGUAGES } from '$lib/shared/explorer-taxonomy';
  import ContentRail from '$components/ContentRail.svelte';
  import SpotlightCarousel from '$components/SpotlightCarousel.svelte';
  import MediaCard from '$components/MediaCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';

  // MAVERO — Explorer page (Movies / TV Shows / Anime redesign, Change 1).
  //
  // ONE shared component powers the three dedicated Explorers:
  //
  //   1. SPOTLIGHT — the 6-slide cinematic carousel (recent/popular
  //      daily-rotating titles, ~90% viewport width, 4s auto-rotation —
  //      see SpotlightCarousel.svelte). Honest fallback block when the
  //      catalog cannot supply a lineup.
  //   2. FILTER CHIPS — a Genre row + a Language row directly below the
  //      spotlight. Horizontally scrollable, sticky while browsing
  //      filtered results, inactive by default. Values come from the
  //      SHARED closed taxonomy (explorer-taxonomy.ts) — the same lists
  //      the server validates URL/feed values against.
  //   3. CONTENT —
  //        no filter active  → Popular + Top Rated sections (existing
  //                            ContentRail; server-side cross-section
  //                            dedup — no title repeats).
  //        filter active     → the filtered results area: an SSR page-1
  //                            seed, topped up client-side to the
  //                            RESPONSIVE grid capacity (columns ×
  //                            visible rows — never a hardcoded "20"),
  //                            then infinite scroll via the
  //                            /api/explorer/feed endpoint (the
  //                            existing Discover client-fetch
  //                            architecture, same closed contracts).
  //
  // Filter state lives in the URL (?genre=&language=) — the existing
  // app convention (shareable, refresh/back-safe, server-validated).

  let {
    type,
    spotlight = [],
    sections = [],
    filteredItems = [],
    currentPage = 1,
    hasNextPage = false,
    totalPages = undefined,
    filters = {},
    errorMessage = undefined
  }: {
    type: ContentType;
    spotlight?: MediaItem[];
    sections?: { key: string; title: string; items: MediaItem[] }[];
    filteredItems?: MediaItem[];
    currentPage?: number;
    hasNextPage?: boolean;
    totalPages?: number | undefined;
    filters?: { genre?: string; language?: string };
    errorMessage?: string | undefined;
  } = $props();

  const labels = $derived(DESTINATION_LABELS[type]);
  const genreOptions = $derived(EXPLORER_GENRES[type]);
  const languageOptions = $derived(EXPLORER_LANGUAGES[type]);

  const selectedGenre = $derived(filters.genre || '');
  const selectedLanguage = $derived(filters.language && filters.language !== 'all' ? filters.language : '');
  const filtersActive = $derived(Boolean(selectedGenre || selectedLanguage));

  // ============================================================
  // Filter chip interactions — URL is the source of truth (the same
  // replaceState/noScroll/keepFocus contract the collection page used:
  // filter changes never pollute the history stack).
  // ============================================================
  function updateFilters(next: { genre?: string; language?: string }) {
    const params = new URLSearchParams();
    if (next.genre && next.genre !== 'All') params.set('genre', next.genre);
    if (next.language && next.language !== 'all') params.set('language', next.language);
    const query = params.toString();
    void goto(`${page.url.pathname}${query ? `?${query}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function toggleGenre(name: string) {
    updateFilters({ genre: selectedGenre === name ? 'All' : name, language: selectedLanguage || 'all' });
  }

  function toggleLanguage(code: string) {
    updateFilters({ genre: selectedGenre || 'All', language: selectedLanguage === code ? 'all' : code });
  }

  function clearAllFilters() {
    updateFilters({ genre: 'All', language: 'all' });
  }

  // ============================================================
  // Filtered results — client-side progressive/infinite loading.
  //
  // The SSR seed (page 1, 10 items) renders instantly; after mount the
  // grid is topped up to the RESPONSIVE capacity so the first batch
  // always visually fills the available viewport (no awkward blank
  // region, no universal hardcoded page size); an IntersectionObserver
  // sentinel then loads further pages while the user scrolls.
  // ============================================================
  let feedItems = $state<MediaItem[]>([]);
  let feedPage = $state(1);
  let feedHasNext = $state(false);
  let feedTotalPages = $state<number | undefined>(undefined);
  let feedExhausted = $state(false);
  let loadingMore = $state(false);
  let feedError = $state('');
  let requestSequence = 0;
  let routeActive = true;

  let gridEl: HTMLElement | undefined = $state();
  let sentinelEl: HTMLElement | undefined = $state();
  let observer: IntersectionObserver | undefined;
  let topUpInFlight = false;

  function itemKey(item: MediaItem): string {
    return `${item.type}:${item.id}`;
  }

  // Re-seed the client feed whenever the server data changes (filter
  // change, popstate restore, refresh). Identity-keyed on the seed
  // array so an unchanged data object never resets accumulated items.
  let lastSeed: MediaItem[] | undefined;
  $effect(() => {
    if (filteredItems !== lastSeed) {
      lastSeed = filteredItems;
      requestSequence += 1; // cancel any in-flight appends
      feedItems = [...filteredItems];
      feedPage = currentPage;
      feedHasNext = hasNextPage;
      feedTotalPages = totalPages;
      feedError = errorMessage ?? '';
      feedExhausted = !hasNextPage || (totalPages !== undefined && currentPage >= totalPages);
      loadingMore = false;
      if (routeActive && filtersActive && !feedExhausted && feedItems.length > 0) {
        void topUpToResponsiveTarget();
      }
    }
  });

  // ============================================================
  // RESPONSIVE FIRST BATCH — columns × visible rows.
  //
  // Measures the ACTUAL rendered grid (computed columns + first-card
  // row height) and the vertical space below the grid's top, then
  // fetches whole feed pages (10 titles each) until the target is
  // met — bounded [8, 30] so a huge viewport can never trigger an
  // unbounded request burst, and a phone never renders a batch that
  // finishes mid-viewport with a blank region below.
  // ============================================================
  const MIN_RESPONSIVE_TARGET = 8;
  const MAX_RESPONSIVE_TARGET = 30;
  const MAX_TOP_UP_PAGES = 3;
  const MAX_FEED_PAGE = 20;

  function estimateColumns(width: number): number {
    if (width <= 640) return 2;
    return Math.max(3, Math.floor((width - 120) / 198));
  }

  function computeResponsiveTarget(): number {
    try {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let columns = estimateColumns(viewportWidth);
      let rowHeight = 0;
      if (gridEl) {
        const computed = getComputedStyle(gridEl).gridTemplateColumns;
        const columnCount = computed.split(' ').filter(Boolean).length;
        if (columnCount > 0) columns = columnCount;
        const gapRow = parseFloat(getComputedStyle(gridEl).rowGap) || 22;
        const firstCard = gridEl.querySelector<HTMLElement>('.explorer-card');
        if (firstCard) {
          rowHeight = firstCard.getBoundingClientRect().height + gapRow;
        }
      }
      if (rowHeight <= 0) {
        // Estimate: poster (2:3) + two-line title block + meta.
        const gridWidth = gridEl?.clientWidth ?? Math.min(viewportWidth - 32, 1200);
        const cardWidth = Math.max(120, (gridWidth - (columns - 1) * 16) / columns);
        rowHeight = cardWidth * 1.5 + 66 + 22;
      }
      const gridTop = gridEl ? gridEl.getBoundingClientRect().top : viewportHeight * 0.4;
      const availableHeight = Math.max(320, viewportHeight - Math.max(0, Math.min(gridTop, viewportHeight * 0.75)));
      const rows = Math.max(2, Math.ceil(availableHeight / rowHeight));
      return Math.min(Math.max(columns * rows, MIN_RESPONSIVE_TARGET), MAX_RESPONSIVE_TARGET);
    } catch {
      return MIN_RESPONSIVE_TARGET;
    }
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || !feedHasNext || feedExhausted || feedPage >= MAX_FEED_PAGE) return;
    loadingMore = true;
    feedError = '';
    const seq = ++requestSequence;
    try {
      const params = new URLSearchParams({ type, page: String(feedPage + 1) });
      if (selectedGenre) params.set('genre', selectedGenre);
      if (selectedLanguage) params.set('language', selectedLanguage);
      const response = await fetch(`/api/explorer/feed?${params.toString()}`);
      if (seq !== requestSequence || !routeActive) return;
      const payload = await response.json();
      if (seq !== requestSequence || !routeActive) return;
      if (!response.ok || !payload.ok) {
        feedError = payload?.error?.message || 'Unable to load more titles right now.';
        return;
      }
      const seen = new Set(feedItems.map(itemKey));
      for (const item of payload.items as MediaItem[]) {
        const key = itemKey(item);
        if (!seen.has(key)) {
          feedItems.push(item);
          seen.add(key);
        }
      }
      feedPage = payload.page;
      feedHasNext = Boolean(payload.hasNextPage);
      if (typeof payload.totalPages === 'number') feedTotalPages = payload.totalPages;
      if (!payload.hasNextPage || (feedTotalPages !== undefined && feedPage >= feedTotalPages)) {
        feedExhausted = true;
      }
    } catch {
      if (seq === requestSequence) feedError = 'Unable to load more titles right now.';
    } finally {
      if (seq === requestSequence) loadingMore = false;
    }
  }

  async function topUpToResponsiveTarget(): Promise<void> {
    if (topUpInFlight) return;
    topUpInFlight = true;
    try {
      const target = computeResponsiveTarget();
      let pagesFetched = 0;
      while (
        routeActive &&
        feedItems.length < target &&
        feedHasNext &&
        !feedExhausted &&
        !feedError &&
        feedPage < MAX_FEED_PAGE &&
        pagesFetched < MAX_TOP_UP_PAGES
      ) {
        await loadMore();
        pagesFetched += 1;
      }
    } finally {
      topUpInFlight = false;
    }
  }

  function retryLoadMore() {
    feedError = '';
    void loadMore();
  }

  // IntersectionObserver — re-observed whenever the sentinel enters the
  // DOM (it only renders while more pages exist).
  $effect(() => {
    if (sentinelEl && observer) observer.observe(sentinelEl);
    return () => {
      if (sentinelEl && observer) observer.unobserve(sentinelEl);
    };
  });

  onMount(() => {
    routeActive = true;
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: '600px 0px' }
    );
    if (filtersActive && !feedExhausted && feedItems.length > 0) {
      void topUpToResponsiveTarget();
    }
    return () => {
      routeActive = false;
      requestSequence += 1;
      observer?.disconnect();
      observer = undefined;
    };
  });

  // Same-route navigation (filter change): the shell stays mounted
  // while the server load runs — swap the grid to a matching skeleton
  // instead of stale content. Cross-route arrivals render SSR content
  // directly; popstate restores instantly from the load cache.
  const sameRouteNavigation = $derived(
    Boolean(
      navigating.from &&
      navigating.to &&
      navigating.type !== 'popstate' &&
      navigating.from.url.pathname === navigating.to.url.pathname
    )
  );

  const skeletonCount = $derived(Math.min(Math.max(feedItems.length || 10, 8), 20));
  const activeFilterCount = $derived((selectedGenre ? 1 : 0) + (selectedLanguage ? 1 : 0));
</script>

<svelte:head>
  <title>{labels.plural} — Mavero</title>
  <meta name="description" content={`Explore MAVERO's ${labels.prose}: spotlight picks, popular and top rated titles, and filters by genre and language.`} />
  <link rel="canonical" href={`/`} />
  <meta property="og:title" content={`${labels.plural} — Mavero`} />
  <meta property="og:description" content={`Explore MAVERO's ${labels.prose}: spotlight picks, popular and top rated titles, and filters by genre and language.`} />
  <meta name="twitter:card" content="summary" />
</svelte:head>

<div class="explorer-page" data-destination={type}>
  {#if spotlight.length > 0}
    <SpotlightCarousel items={spotlight} ariaLabel={`${labels.plural} spotlight`} />
  {:else}
    <!-- Quiet fallback when the catalog cannot supply a spotlight lineup -->
    <section class="explorer-hero-fallback" aria-label={labels.plural}>
      <div class="fallback-eyebrow">MAVERO / {labels.plural}</div>
      <h1 class="fallback-title">{labels.plural} <em>in focus.</em></h1>
      <p class="fallback-desc">{errorMessage ?? labels.description}</p>
    </section>
  {/if}

  <!-- Genre + Language filter rows (sticky while browsing results) -->
  <div class="explorer-filters" data-active={filtersActive || null}>
    <div class="filters-inner">
      <div class="chip-row" role="group" aria-label={`Filter ${labels.prose} by genre`}>
        <span class="chip-row-label"><SlidersHorizontal size={13} aria-hidden="true" /> Genre</span>
        <div class="chip-scroll" data-chip-row="genre">
          <button
            class="filter-chip"
            class:active={!selectedGenre}
            type="button"
            aria-pressed={!selectedGenre}
            onclick={() => updateFilters({ genre: 'All', language: selectedLanguage || 'all' })}
          >All</button>
          {#each genreOptions as genre (genre.name)}
            <button
              class="filter-chip"
              class:active={selectedGenre === genre.name}
              type="button"
              aria-pressed={selectedGenre === genre.name}
              onclick={() => toggleGenre(genre.name)}
            >{genre.name}{#if selectedGenre === genre.name}<Check size={12} aria-hidden="true" />{/if}</button>
          {/each}
        </div>
      </div>
      <div class="chip-row" role="group" aria-label={`Filter ${labels.prose} by language`}>
        <span class="chip-row-label">Language</span>
        <div class="chip-scroll" data-chip-row="language">
          <button
            class="filter-chip"
            class:active={!selectedLanguage}
            type="button"
            aria-pressed={!selectedLanguage}
            onclick={() => updateFilters({ genre: selectedGenre || 'All', language: 'all' })}
          >All</button>
          {#each languageOptions as option (option.value)}
            <button
              class="filter-chip"
              class:active={selectedLanguage === option.value}
              type="button"
              aria-pressed={selectedLanguage === option.value}
              onclick={() => toggleLanguage(option.value)}
            >{option.label}{#if selectedLanguage === option.value}<Check size={12} aria-hidden="true" />{/if}</button>
          {/each}
        </div>
      </div>
    </div>
  </div>

  {#if filtersActive}
    <!-- ============================================================
         FILTERED CONTENT AREA — replaces the normal Explorer sections
         while a genre and/or language filter is active.
         ============================================================ -->
    <div class="explorer-results">
      <div class="results-heading">
        <h2 class="results-title">
          {[selectedGenre, selectedLanguage ? languageOptions.find((o) => o.value === selectedLanguage)?.label : ''].filter(Boolean).join(' · ') || labels.plural}
        </h2>
        {#if activeFilterCount > 0}
          <button class="clear-filters" type="button" onclick={clearAllFilters}>Clear filters</button>
        {/if}
      </div>

      {#if errorMessage && feedItems.length === 0}
        <EmptyState
          eyebrow={`MAVERO / ${labels.plural} catalog`}
          title="The signal is quiet."
          message={errorMessage}
          actionLabel={`View all ${labels.prose}`}
          actionHref={`/${type === 'series' ? 'tv-shows' : type}`}
        />
      {:else if sameRouteNavigation}
        <div class="explorer-grid grid-loading" aria-busy="true" aria-label={`Loading ${labels.prose}`}>
          {#each Array(skeletonCount) as _, index (index)}<SkeletonCard compact />{/each}
        </div>
      {:else if feedItems.length === 0}
        <EmptyState
          eyebrow={`MAVERO / No ${labels.singular} matches`}
          title="Nothing found"
          message={`No ${labels.prose} match the selected genre or language. Try a different combination or clear the filters.`}
          actionLabel="Clear filters"
          onAction={clearAllFilters}
        />
      {:else}
        <div class="explorer-grid" bind:this={gridEl}>
          {#each feedItems as item (item.type + ':' + item.id)}
            <div class="explorer-card"><MediaCard {item} compact editorial /></div>
          {/each}
          {#if loadingMore}
            {#each Array(4) as _, index (index + feedItems.length)}<SkeletonCard compact />{/each}
          {/if}
        </div>

        {#if feedError}
          <div class="load-error" role="alert">
            <span>{feedError}</span>
            <button class="retry-btn" type="button" onclick={retryLoadMore}>
              <RotateCw size={14} aria-hidden="true" /> <span>Retry</span>
            </button>
          </div>
        {:else if !feedExhausted}
          <div class="load-more-row" aria-live="polite">
            <div class="load-sentinel" bind:this={sentinelEl} aria-hidden="true"></div>
            {#if loadingMore}
              <span class="loading-hint"><LoaderCircle size={14} class="spin" aria-hidden="true" /> Loading more…</span>
            {/if}
          </div>
        {:else}
          <div class="end-of-results" role="status">You've reached the end of the results.</div>
        {/if}
      {/if}
    </div>
  {:else}
    <!-- ============================================================
         UNFILTERED EXPLORER SECTIONS — Popular + Top Rated (server
         composed, cross-section deduped; empty sections omitted).
         ============================================================ -->
    <div class="explorer-sections">
      {#if errorMessage}
        <div class="catalog-warning" role="alert">{errorMessage}</div>
      {/if}
      {#each sections as section (section.key)}
        <ContentRail title={section.title} items={section.items} />
      {/each}
    </div>
  {/if}
</div>

<ScrollToTop />

<style>
  .explorer-page {
    --c-gutter: clamp(16px, 5vw, 48px);
    padding-top: 14px;
    padding-bottom: 40px;
  }

  /* ── Spotlight fallback (no lineup available) — quiet framed block ── */
  .explorer-hero-fallback {
    width: 90%;
    max-width: 1480px;
    margin: 0 auto;
    padding: clamp(20px, 4vw, 40px);
    border-radius: clamp(12px, 1.6vw, 20px);
    background:
      radial-gradient(circle at 88% -40%, var(--color-primary-soft), transparent 46%),
      var(--color-bg);
    border: 1px solid var(--color-border);
    box-sizing: border-box;
  }
  .fallback-eyebrow {
    color: var(--color-primary);
    font-size: .6rem; font-weight: 800;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .fallback-title {
    margin: 10px 0 0;
    color: #f5f5f5;
    font-size: clamp(1.6rem, 4vw, 2.6rem);
    font-weight: 880; letter-spacing: -.02em;
  }
  .fallback-title em { color: #9a9aa2; font-style: normal; }
  .fallback-desc { margin: 10px 0 0; color: #9a9aa2; font-size: .82rem; line-height: 1.6; max-width: 520px; }

  /* ── Filter chips (sticky) ──
     Mobile ≤640px: below the fixed topbar (var(--topbar-h-safe)).
     Tablet 641–1024px: below the 72px sticky topbar.
     Desktop ≥1025px: top of the app-main scroll container (no topbar).
     z-index sits BELOW the topbar (40) so chips slide under it. */
  .explorer-filters {
    position: sticky;
    top: var(--topbar-h-safe);
    z-index: 30;
    margin-top: 14px;
    padding: 8px 0 6px;
    background: rgba(5, 7, 8, .92);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border-bottom: 1px solid rgba(255, 255, 255, .06);
  }
  .filters-inner {
    width: 90%;
    max-width: 1480px;
    margin-inline: auto;
    display: grid;
    gap: 6px;
  }
  .chip-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .chip-row-label {
    display: inline-flex; align-items: center; gap: 5px;
    flex-shrink: 0;
    color: var(--color-text-deep);
    font-size: .6rem; font-weight: 800;
    letter-spacing: .12em; text-transform: uppercase;
    width: 74px;
  }
  .chip-scroll {
    display: flex;
    flex-wrap: nowrap;
    gap: 7px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
    padding: 2px 2px 4px;
  }
  .chip-scroll::-webkit-scrollbar { display: none; }
  .filter-chip {
    display: inline-flex; align-items: center; gap: 5px;
    flex-shrink: 0;
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 999px;
    color: #c7c7cd;
    background: rgba(10, 13, 16, .6);
    font: inherit;
    font-size: .72rem; font-weight: 700; letter-spacing: .01em;
    white-space: nowrap;
    cursor: pointer;
    scroll-snap-align: start;
    transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .filter-chip:hover { color: #f5f5f5; border-color: rgba(255, 255, 255, .22); }
  .filter-chip:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .filter-chip.active {
    color: var(--color-primary);
    background: var(--color-primary-soft);
    border-color: var(--color-primary-border);
    box-shadow: 0 0 0 1px rgba(0, 255, 156, .12);
  }
  .filter-chip.active :global(svg) { color: var(--color-primary); }

  /* ── Filtered results area ── */
  .explorer-results {
    width: 90%;
    max-width: 1480px;
    margin-inline: auto;
    padding-top: 18px;
  }
  .results-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 6px 0 16px;
  }
  .results-title {
    margin: 0;
    color: #f5f5f5;
    font-size: clamp(1.25rem, 2.4vw, 1.8rem);
    font-weight: 800; letter-spacing: -.02em;
    text-wrap: balance;
  }
  .clear-filters {
    flex-shrink: 0;
    display: inline-flex; align-items: center;
    min-height: 36px; padding: 0 14px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 999px;
    color: #c7c7cd;
    background: rgba(10, 13, 16, .6);
    font: inherit; font-size: .72rem; font-weight: 700;
    cursor: pointer;
    transition: color var(--motion-fast), border-color var(--motion-fast), background var(--motion-fast);
  }
  .clear-filters:hover { color: var(--color-primary); border-color: var(--color-primary-border); }
  .clear-filters:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .explorer-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 182px));
    justify-content: start;
    gap: 28px 16px;
    padding-bottom: 20px;
  }
  /* Card titles wrap to two lines but never more — long titles cannot
     create uneven rows (the same contract the collection grid used). */
  .explorer-grid :global(.mc-title) {
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    min-height: 2.5em; overflow: hidden; white-space: normal;
  }
  .explorer-grid.grid-loading { min-height: 320px; }

  .load-more-row { min-height: 48px; display: grid; place-items: center; padding-bottom: 26px; }
  .load-sentinel { width: 100%; height: 1px; }
  .loading-hint {
    display: inline-flex; align-items: center; gap: 8px;
    color: #77777f; font-size: .72rem; font-weight: 700;
  }
  .loading-hint :global(.spin) { animation: chip-spin 900ms linear infinite; }
  @keyframes chip-spin { to { transform: rotate(360deg); } }
  .end-of-results {
    padding: 18px 0 30px;
    color: #77777f; font-size: .68rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: .1em;
    text-align: center;
  }
  .load-error {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin: 4px 0 18px; padding: 12px 14px;
    border: 1px solid rgba(255, 120, 120, .25);
    border-radius: 12px;
    color: #ffb3b3; font-size: .76rem;
    background: rgba(60, 12, 12, .35);
  }
  .retry-btn {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 34px; padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: 999px;
    color: #f5f5f5; background: rgba(255, 255, 255, .05);
    font: inherit; font-size: .7rem; font-weight: 700;
    cursor: pointer;
  }
  .retry-btn:hover { border-color: rgba(255, 255, 255, .3); }
  .retry-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Unfiltered sections ── */
  .explorer-sections { padding-top: 6px; }
  .catalog-warning {
    width: 90%;
    max-width: 1480px;
    margin: 0 auto 16px;
    padding: 12px 16px;
    border: 1px solid rgba(255, 177, 80, .3);
    border-radius: 12px;
    color: #ffd17a; font-size: .76rem; line-height: 1.5;
    background: rgba(50, 34, 8, .3);
  }

  /* ── Mobile ── */
  @media (max-width: 640px) {
    .explorer-page { padding-top: 10px; }
    .explorer-filters { top: var(--topbar-h-safe); margin-top: 10px; }
    .filters-inner { width: calc(100% - 24px); gap: 5px; }
    .chip-row-label { width: auto; }
    /* Comfortable touch targets while keeping both rows compact. */
    .filter-chip { min-height: 40px; padding: 0 13px; }
    .explorer-results { width: calc(100% - 24px); padding-top: 14px; }
    .results-heading { padding: 2px 0 12px; }
    .results-title { font-size: 1.15rem; }
    .explorer-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 11px; }
    .explorer-hero-fallback { width: calc(100% - 24px); }
  }

  @media (min-width: 641px) and (max-width: 1024px) {
    .explorer-filters { top: 72px; }
  }

  @media (min-width: 1025px) {
    .explorer-filters { top: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .filter-chip, .clear-filters, .retry-btn { transition: none; }
    .loading-hint :global(.spin) { animation: none; }
  }
</style>
