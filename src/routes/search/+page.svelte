<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Search, ArrowUpRight, SlidersHorizontal, LoaderCircle } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { ContentType } from '$lib/server/content/types';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';

  export let data: PageData;

  let query = data.query;
  let type: 'All' | 'Movies' | 'Series' | 'Anime' = data.type === 'movie' ? 'Movies' : data.type === 'series' ? 'Series' : data.type === 'anime' ? 'Anime' : 'All';
  let results: MediaItem[] = data.items;
  let loading = false;
  let errorMessage = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const types = ['All', 'Movies', 'Series', 'Anime'] as const;

  function typeParam(value: typeof type): ContentType | undefined {
    return value === 'Movies' ? 'movie' : value === 'Series' ? 'series' : value === 'Anime' ? 'anime' : undefined;
  }

  function scheduleSearch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runSearch, 340);
  }

  async function runSearch() {
    const normalized = query.trim();
    const urlParams = new URLSearchParams(page.url.searchParams);
    if (normalized) urlParams.set('q', normalized); else urlParams.delete('q');
    const selectedType = typeParam(type);
    if (selectedType) urlParams.set('type', selectedType); else urlParams.delete('type');
    void goto(`${page.url.pathname}${urlParams.toString() ? `?${urlParams.toString()}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true });
    if (!normalized) {
      results = data.items;
      errorMessage = '';
      return;
    }
    loading = true;
    errorMessage = '';
    try {
      const params = new URLSearchParams({ q: normalized });
      const selectedType = typeParam(type);
      if (selectedType) params.set('type', selectedType);
      const response = await fetch(`/api/content/search?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message || 'Search is temporarily unavailable.');
      results = payload.items as MediaItem[];
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Search is temporarily unavailable.';
      results = [];
    } finally {
      loading = false;
    }
  }

  function selectType(value: typeof type) {
    type = value;
    if (query.trim()) void runSearch();
  }

  $: visibleResults = results.filter((item) => type === 'All' || item.type === (type === 'Movies' ? 'movie' : type === 'Series' ? 'series' : 'anime'));
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

<div class="container-wide">
  <section class="page-heading">
    <div class="eyebrow">MAVERO / Search</div>
    <h1>Find your next<br /><em>favorite.</em></h1>
    <p>Search the full Mavero universe across movies, series, and anime. Start with a title, a genre, or a mood.</p>
  </section>

  <div class="search-band search-large" role="search" aria-label="Catalog search"><Search size={19} aria-hidden="true" /><label class="sr-only" for="catalog-search">Search titles</label><input id="catalog-search" bind:value={query} oninput={scheduleSearch} aria-label="Search titles" placeholder="What are you in the mood for?" /><kbd aria-label="Keyboard shortcut Command K">⌘ K</kbd></div>
  <div class="mode-tabs" role="group" aria-label="Filter by content type">
    {#each types as item}
      <button class:active={type === item} class="mode-tab" aria-pressed={type === item} onclick={() => selectType(item)}>{item}</button>
    {/each}
    <button class="mode-tab"><SlidersHorizontal size={14} aria-hidden="true" /> More filters</button>
  </div>

  {#if errorMessage}<div class="search-error" role="alert">{errorMessage}</div>{/if}
  {#if loading}<div class="search-loading" aria-live="polite"><LoaderCircle size={15} /> Searching Mavero…</div>{/if}

  {#if visibleResults.length}
    <section class="section" aria-live="polite">
      <div class="section-head"><div><div class="eyebrow">{visibleResults.length} titles</div><h2 class="section-title">{query ? `Results for “${query}”` : 'A considered place to start'}</h2></div></div>
      <div class="results-grid">
        {#each visibleResults as item}<MediaCard {item} compact />{/each}
      </div>
    </section>
  {:else}
    <section class="empty-search" aria-live="polite"><div class="eyebrow">{query ? 'No matching stories' : 'Start with a title or mood'}</div><h2>{query ? 'Nothing here yet.' : 'What are you looking for?'}</h2><p>{query ? 'Try a different title, genre, or one of the curated collections on Discover.' : 'Search is connected to the server-side content catalog and will keep the rest of the page quiet until you ask.'}</p><a href="/discover" class="btn btn-secondary">Back to Discover <ArrowUpRight size={15} /></a></section>
  {/if}
</div>

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  em { color: var(--accent); font-style: normal; }
  .search-large { margin-top: 9px; padding: 18px 17px; }
  .search-large input { font-size: 1rem; }
  kbd { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .6rem; white-space: nowrap; }
  .search-loading, .search-error { display: inline-flex; align-items: center; gap: 8px; margin-top: 18px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .62rem; }
  .search-error { color: #d4b27c; }
  .results-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 21px 14px; }
  .empty-search { display: grid; place-items: center; min-height: 320px; margin-top: 45px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: center; }
  .empty-search h2 { margin: 10px 0 6px; font-size: 2rem; letter-spacing: -.06em; }
  .empty-search p { max-width: 350px; margin: 0 0 22px; color: var(--muted); font-size: .82rem; line-height: 1.6; }
  @media (max-width: 1000px) { .results-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 12px; } .page-heading h1 { font-size: 3.15rem; } }
</style>
