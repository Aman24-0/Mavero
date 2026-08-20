<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Search, LoaderCircle } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { ContentType } from '$lib/server/content/types';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';

  export let data: PageData;

  let query = data.query;
  let type: 'All' | 'Movies' | 'Series' | 'Anime' = data.type === 'movie' ? 'Movies' : data.type === 'series' ? 'Series' : data.type === 'anime' ? 'Anime' : 'All';
  let results: MediaItem[] = data.items;
  let loading = false;
  let errorMessage = data.errorMessage ?? '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const types = [
    { label: 'Movies', value: 'Movies' },
    { label: 'Shows', value: 'Series' },
    { label: 'Anime', value: 'Anime' }
  ] as const;

  function typeParam(value: typeof type): ContentType | undefined {
    return value === 'Movies' ? 'movie' : value === 'Series' ? 'series' : value === 'Anime' ? 'anime' : undefined;
  }

  function syncUrl() {
    const urlParams = new URLSearchParams(page.url.searchParams);
    const normalized = query.trim();
    if (normalized) urlParams.set('q', normalized); else urlParams.delete('q');
    const selectedType = typeParam(type);
    if (selectedType) urlParams.set('type', selectedType); else urlParams.delete('type');
    void goto(`${page.url.pathname}${urlParams.toString() ? `?${urlParams.toString()}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function scheduleSearch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runSearch, 340);
  }

  async function runSearch() {
    const normalized = query.trim();
    syncUrl();
    if (!normalized) {
      results = [];
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

  function selectType(value: 'Movies' | 'Series' | 'Anime') {
    type = type === value ? 'All' : value;
    syncUrl();
    if (query.trim()) void runSearch();
    else results = [];
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

<div class="container-wide search-page">
  <section class="search-panel" aria-label="Search MAVERO">
    <div class="search-band search-large" role="search"><Search size={18} aria-hidden="true" /><label class="sr-only" for="catalog-search">Search titles</label><input id="catalog-search" bind:value={query} oninput={scheduleSearch} aria-label="Search titles" placeholder="Search movies, shows, or anime" /></div>
    <div class="filter-chips" role="group" aria-label="Filter search by type">
      {#each types as item}<button class:active={type === item.value} class="filter-chip" aria-pressed={type === item.value} onclick={() => selectType(item.value)}>{item.label}</button>{/each}
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
    <section class="empty-search" aria-live="polite"><div class="empty-mark">/</div><h2>No matching stories.</h2><p>Try another title or switch the content filter.</p></section>
  {:else if !loading}
    <section class="search-prompt" aria-live="polite"><span>Search the MAVERO catalog</span><small>Movies, shows, and anime from one quiet interface.</small></section>
  {/if}
</div>

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .search-page { min-height: calc(100dvh - 68px); padding-top: 26px; padding-bottom: 70px; }
  .search-panel { width: min(780px, 100%); margin-inline: auto; }
  .search-large { margin: 0; padding: 14px 16px; }
  .search-large input { font-size: .92rem; }
  .filter-chips { display: flex; justify-content: center; gap: 7px; margin-top: 10px; }
  .filter-chip { min-height: 32px; border: 1px solid var(--line); border-radius: 999px; padding: 0 14px; color: var(--muted); background: transparent; font-size: .67rem; font-weight: 800; transition: color 160ms ease-out, border-color 160ms ease-out, background 160ms ease-out; }
  .filter-chip:hover, .filter-chip.active { color: var(--ink); border-color: rgba(155,135,245,.5); background: var(--accent-soft); }
  .search-loading, .search-error { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 22px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .62rem; }
  .search-error { color: #d4b27c; }
  .results-section { margin-top: 32px; }
  .result-summary { display: flex; align-items: baseline; gap: 10px; margin-bottom: 13px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; text-transform: uppercase; }
  .result-summary strong { color: var(--ink); font-family: Manrope, sans-serif; font-size: .88rem; letter-spacing: -.02em; text-transform: none; }
  .results-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 18px 12px; }
  .search-prompt, .empty-search { display: grid; place-items: center; gap: 6px; min-height: 210px; margin-top: 34px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); color: var(--muted); text-align: center; }
  .search-prompt span { color: var(--ink); font-size: .9rem; font-weight: 800; }
  .search-prompt small, .empty-search p { margin: 0; color: var(--muted-deep); font-size: .72rem; }
  .empty-mark { color: var(--accent); font-family: 'DM Mono', monospace; font-size: 1.4rem; }
  .empty-search h2 { margin: 0; color: var(--ink); font-size: 1rem; letter-spacing: -.03em; }
  .empty-search p { max-width: 280px; }
  @media (max-width: 1000px) { .results-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .search-page { padding-top: 16px; } .filter-chips { justify-content: flex-start; } .filter-chip { flex: 1; } .results-section { margin-top: 26px; } .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 10px; } }
</style>
