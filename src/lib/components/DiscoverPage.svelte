<script lang="ts">
  import { onMount } from 'svelte';
  import { getContinueWatching } from '$lib/client/progress/service';
  import { progressToMedia } from '$lib/client/progress/presenter';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowRight, Play, Search, SlidersHorizontal, Sparkles } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import ContentRail from '$components/ContentRail.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import FilterBar from '$components/FilterBar.svelte';
  import type { FilterState } from '$components/filter-types';

  export let featuredItem: MediaItem | undefined;
  export let movies: MediaItem[] = [];
  export let series: MediaItem[] = [];
  export let anime: MediaItem[] = [];
  export let continueItems: MediaItem[] = [];
  export let errorMessage = '';
  let localContinueLoaded = false;
  let localContinueItems: MediaItem[] = [];
  let activeMode = page.url.searchParams.get('type') === 'movie' ? 'Movies' : page.url.searchParams.get('type') === 'series' ? 'Series' : page.url.searchParams.get('type') === 'anime' ? 'Anime' : 'All';
  let query = '';
  let intro: HTMLElement;
  let filterState: FilterState = { genre: page.url.searchParams.get('genre') || 'All', sort: page.url.searchParams.get('sort') || 'For you', year: page.url.searchParams.get('year') || 'All' };
  $: contentMedia = [...movies, ...series, ...anime];
  $: genres = [...new Set(contentMedia.flatMap((item) => item.genres))].sort();
  $: filteredMovies = applyFilters(movies);
  $: filteredSeries = applyFilters(series);
  $: filteredAnime = applyFilters(anime);
  $: selectedItems = activeMode === 'Movies' ? filteredMovies : activeMode === 'Series' ? filteredSeries : activeMode === 'Anime' ? filteredAnime : [...filteredMovies, ...filteredSeries, ...filteredAnime];
  $: localContinue = localContinueLoaded ? localContinueItems : continueItems;
  $: filteredMedia = query.trim() ? contentMedia.filter((item) => `${item.title} ${item.genres.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())) : [];

  const modes = ['All', 'Movies', 'Series', 'Anime'];

  function applyFilters(items: MediaItem[]) {
    return [...items]
      .filter((item) => filterState.genre === 'All' || item.genres.includes(filterState.genre))
      .filter((item) => filterState.year === 'All' || String(item.year) === filterState.year)
      .sort((a, b) => filterState.sort === 'Top rated' ? b.rating - a.rating : filterState.sort === 'Newest' ? b.year - a.year : 0);
  }

  function modeParam(mode: string) {
    return mode === 'Movies' ? 'movie' : mode === 'Series' ? 'series' : mode === 'Anime' ? 'anime' : '';
  }

  function selectMode(mode: string) {
    activeMode = mode;
    const params = new URLSearchParams(page.url.searchParams);
    if (modeParam(mode)) params.set('type', modeParam(mode)); else params.delete('type');
    void goto(`${page.url.pathname}${params.toString() ? `?${params.toString()}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function updateFilters(next: FilterState) {
    filterState = next;
    const params = new URLSearchParams(page.url.searchParams);
    for (const [key, value] of Object.entries(next)) value === 'All' || value === 'For you' ? params.delete(key) : params.set(key, value);
    void goto(`${page.url.pathname}${params.toString() ? `?${params.toString()}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  onMount(async () => {
    void getContinueWatching().then((records) => { localContinueItems = records.map(progressToMedia); localContinueLoaded = true; });
    const { gsap } = await import('gsap');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !intro) return;
    gsap.fromTo(intro.querySelectorAll('[data-reveal]'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.42, stagger: 0.045, ease: 'power2.out' });
  });
</script>

<svelte:head>
  <title>Mavero — Discover. Watch.</title>
  <meta name="description" content="Discover movies, series, and anime on MAVERO." />
  <link rel="canonical" href={page.url.origin}/>
  <meta property="og:title" content="Mavero — Discover. Watch." />
  <meta property="og:description" content="A considered place to find your next story." />
  <meta property="og:url" content={page.url.origin}/>
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary" />
</svelte:head>

<div bind:this={intro} class="discover-page">
  {#if featuredItem}
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-media" style={`background-image: url('${featuredItem.backdrop || featuredItem.poster}')`}></div>
      <div class="container-wide hero-content">
        <div class="hero-kicker" data-reveal><Sparkles size={13} /> Tonight’s edit</div>
        <h1 id="hero-title" data-reveal>{featuredItem.title}</h1>
        <p class="hero-description" data-reveal>{featuredItem.description}</p>
        <div class="meta-row" data-reveal><strong>{featuredItem.year}</strong><span class="dot"></span><span>{featuredItem.runtime}</span><span class="dot"></span><span>{featuredItem.maturity}</span><span class="dot"></span><span>{featuredItem.genres.slice(0, 2).join(' · ')}</span></div>
        <div class="hero-actions" data-reveal><a class="btn btn-primary" href={`/watch/${featuredItem.type}/${featuredItem.id}`}><Play size={15} fill="currentColor" /> Watch now</a><a class="btn btn-secondary" href={`/${featuredItem.type}/${featuredItem.id}`}>View details <ArrowRight size={14} /></a></div>
      </div>
      <div class="hero-signal" aria-hidden="true"><b>01</b><span>Featured</span></div>
    </section>
  {/if}

  <div class="container-wide main-content">
    {#if errorMessage}<div class="catalog-warning" role="alert">{errorMessage}</div>{/if}
    <section class="discovery-tools" aria-label="Discover catalog controls">
      <div class="search-band" role="search" aria-label="Quick catalog search"><Search size={16} aria-hidden="true" /><label class="sr-only" for="discover-search">Search titles</label><input id="discover-search" bind:value={query} aria-label="Search titles" placeholder="Search movies, series, or anime" /><a class="section-link" href="/search">Full search <ArrowRight size={13} /></a></div>
      <div class="catalog-switcher">
        <div class="mode-tabs" role="group" aria-label="Content type">
          {#each modes as mode}<button class:active={activeMode === mode} class="mode-tab" aria-pressed={activeMode === mode} onclick={() => selectMode(mode)}>{mode}</button>{/each}
        </div>
        <div class="filter-wrap"><SlidersHorizontal size={14} aria-hidden="true" /><FilterBar value={filterState} {genres} onChange={updateFilters} /></div>
      </div>
    </section>

    {#if query.trim()}
      {#if filteredMedia.length}<ContentRail title={`Results for “${query}”`} eyebrow="Quick matches" items={filteredMedia} href="/search" compact />{:else}<EmptyState search eyebrow="MAVERO / No quick matches" title="Nothing in this cut." message="Try another title or open full search for the complete catalog." actionLabel="Open full search" actionHref="/search" />{/if}
    {:else if selectedItems.length}
      {#if localContinue.length}<ContentRail title="Continue watching" eyebrow="Pick up where you left off" items={localContinue} href="/profile" compact />{/if}
      {#if activeMode === 'All' || activeMode === 'Movies'}<ContentRail title="Trending movies" eyebrow="Make tonight count" items={filteredMovies} href="/discover/movies" />{/if}
      {#if activeMode === 'All' || activeMode === 'Series'}<ContentRail title="Stories worth staying for" eyebrow="Series" items={filteredSeries} href="/discover/series" />{/if}
      {#if activeMode === 'All' || activeMode === 'Anime'}<ContentRail title="The anime edit" eyebrow="From another world" items={filteredAnime} href="/discover/anime" />{/if}
    {:else}
      <EmptyState eyebrow="MAVERO / No titles match" title="A quieter cut." message="Try clearing a filter or choose another content type to keep exploring." actionLabel="Clear filters" actionHref="/discover" />
    {/if}

    <footer class="footer"><span><strong>MAVERO</strong> — Discover. Watch.</span><span>Built for the next story.</span></footer>
  </div>
</div>

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .catalog-warning { margin: 14px 0 0; padding: 11px 13px; border: 1px solid rgba(212,178,124,.35); color: #d4b27c; font-family: 'DM Mono', monospace; font-size: .64rem; line-height: 1.5; }
  .discovery-tools { margin-top: 20px; }
  .catalog-switcher { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
  .mode-tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .mode-tabs::-webkit-scrollbar { display: none; }
  .mode-tab { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; color: var(--muted); background: transparent; font-size: .68rem; font-weight: 800; }
  .mode-tab:hover, .mode-tab.active { color: var(--ink); border-color: rgba(155,135,245,.48); background: var(--accent-soft); }
  .filter-wrap { display: flex; align-items: center; gap: 6px; color: var(--muted); }
  .filter-wrap :global(.filter-bar) { border: 0; padding: 0; background: transparent; }
  .filter-wrap :global(.filter-label) { display: none; }
  .filter-wrap :global(label) { min-height: 32px; padding: 0 8px; }
  @media (max-width: 720px) { .catalog-switcher { display: grid; gap: 8px; } .filter-wrap { justify-content: flex-end; } .filter-wrap :global(label) { flex: 1; } }
</style>
