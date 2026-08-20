<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft, ChevronDown } from 'lucide-svelte';
  import type { ContentType } from '$data/content';
  import { media as fixtureMedia, formatType, type MediaItem } from '$data/content';
  import FilterBar from '$components/FilterBar.svelte';
  import type { FilterState } from '$components/filter-types';
  import MediaCard from '$components/MediaCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';

  export let type: ContentType = 'movie';
  export let contentItems: MediaItem[] = fixtureMedia.filter((item) => item.type === type);

  const validSorts = ['For you', 'Top rated', 'Newest'];
  const currentFilters = (): FilterState => ({
    genre: page.url.searchParams.get('genre') || 'All',
    sort: validSorts.includes(page.url.searchParams.get('sort') || '') ? page.url.searchParams.get('sort') || 'For you' : 'For you',
    year: page.url.searchParams.get('year') || 'All'
  });

  let filterState = currentFilters();
  let showAdvanced = false;
  $: items = contentItems;
  $: label = formatType(type);
  $: genres = [...new Set(contentItems.flatMap((item) => item.genres))].sort();
  $: filteredItems = contentItems
    .filter((item) => filterState.genre === 'All' || item.genres.includes(filterState.genre))
    .filter((item) => filterState.year === 'All' || String(item.year) === filterState.year)
    .sort((a, b) => filterState.sort === 'Top rated' ? b.rating - a.rating : filterState.sort === 'Newest' ? b.year - a.year : 0);

  function updateFilters(next: FilterState) {
    filterState = next;
    const params = new URLSearchParams();
    if (next.genre !== 'All') params.set('genre', next.genre);
    if (next.sort !== 'For you') params.set('sort', next.sort);
    if (next.year !== 'All') params.set('year', next.year);
    params.set('page', page.url.searchParams.get('page') || '1');
    void goto(`${page.url.pathname}?${params.toString()}`, { replaceState: true, noScroll: true, keepFocus: true });
  }
</script>

<svelte:head>
  <title>{label}s — Mavero</title>
  <meta name="description" content={`Explore MAVERO’s focused collection of ${label.toLowerCase()} stories.`} />
  <link rel="canonical" href={`${page.url.origin}${page.url.pathname}`} />
  <meta property="og:title" content={`${label}s — Mavero`} />
  <meta property="og:description" content={`Explore MAVERO’s focused collection of ${label.toLowerCase()} stories.`} />
  <meta property="og:url" content={`${page.url.origin}${page.url.pathname}`} />
  <meta name="twitter:card" content="summary" />
</svelte:head>

<div class="container-wide collection-page">
  <a class="back-link" href="/discover"><ArrowLeft size={15} /> Back to Discover</a>
  <section class="page-heading"><div class="eyebrow">MAVERO / Explore</div><h1>{label}s<br /><em>in focus.</em></h1><p>A focused collection for the nights when you know the kind of world you want to step into.</p></section>
  <div class="collection-tools"><FilterBar value={filterState} {genres} onChange={updateFilters} /><button class:active={showAdvanced} class="mode-tab advanced-toggle" aria-expanded={showAdvanced} aria-controls="advanced-filter-note" onclick={() => (showAdvanced = !showAdvanced)}><ChevronDown size={13} /> {showAdvanced ? 'Hide filters' : 'More filters'}</button></div>
  {#if showAdvanced}<div id="advanced-filter-note" class="advanced-filter-note" role="region" aria-label="Advanced filter information">Filters are URL-synchronized, composable, and page-aware. The `page` query parameter is reserved for future continuous loading.</div>{/if}
  {#if filteredItems.length}
    <div class="results-grid">{#each filteredItems as item}<MediaCard {item} compact />{/each}</div>
  {:else}
    <EmptyState eyebrow={`MAVERO / No ${label.toLowerCase()} matches`} title="A quieter cut." message="Try clearing one of your filters or explore the full collection." actionLabel={`View all ${label.toLowerCase()}`} actionHref={`/discover/${type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'anime'}`} />
  {/if}
  <div class="load-sentinel" aria-hidden="true" data-next-page="2"></div>
</div>

<style>
  em { color: var(--accent); font-style: normal; }
  .back-link { display: inline-flex; align-items: center; gap: 8px; padding-top: 30px; color: var(--muted); font-size: .72rem; font-weight: 800; text-decoration: none; }
  .collection-page .page-heading { padding-top: 55px; }
  .collection-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 6px 0 30px; }
  .advanced-toggle { display: inline-flex; align-items: center; gap: 6px; }
  .advanced-toggle.active { color: var(--ink); border-color: rgba(155,135,245,.45); background: var(--accent-soft); }
  .advanced-filter-note { margin: -14px 0 22px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .59rem; line-height: 1.5; }
  .results-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 22px 14px; padding-bottom: 30px; }
  .load-sentinel { height: 1px; margin-top: 20px; }
  @media (max-width: 1000px) { .results-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .back-link { padding-top: 101px; } .collection-page .page-heading { padding-top: 48px; } .collection-tools { align-items: stretch; flex-direction: column; } .advanced-toggle { align-self: flex-start; } .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 12px; } }
</style>
