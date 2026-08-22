<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft, ArrowRight } from 'lucide-svelte';
  import type { ContentType } from '$data/content';
  import { media as fixtureMedia, formatType, type MediaItem } from '$data/content';
  import FilterBar from '$components/FilterBar.svelte';
  import type { FilterState } from '$components/filter-types';
  import MediaCard from '$components/MediaCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  type CollectionFilters = { genre?: string; year?: string; sort?: 'For you' | 'Top rated' | 'Newest' };

  export let type: ContentType = 'movie';
  export let contentItems: MediaItem[] = fixtureMedia.filter((item) => item.type === type);
  export let currentPage = 1;
  export let hasNextPage = false;
  export let collectionFilters: CollectionFilters = {};
  export let errorMessage: string | undefined;

  const validSorts = ['For you', 'Top rated', 'Newest'];
  const fallbackGenres = [...new Set(fixtureMedia.filter((item) => item.type === type).flatMap((item) => item.genres))].sort();
  $: label = formatType(type);
  $: filterState = {
    genre: collectionFilters.genre || 'All',
    sort: validSorts.includes(collectionFilters.sort || '') ? collectionFilters.sort || 'For you' : 'For you',
    year: collectionFilters.year || 'All'
  } satisfies FilterState;
  $: genres = [...new Set([...fallbackGenres, ...contentItems.flatMap((item) => item.genres)])].sort();

  function collectionHref(targetPage: number) {
    const params = new URLSearchParams(page.url.searchParams);
    params.set('page', String(Math.max(1, targetPage)));
    return `${page.url.pathname}?${params.toString()}`;
  }

  function updateFilters(next: FilterState) {
    const params = new URLSearchParams();
    if (next.genre !== 'All') params.set('genre', next.genre);
    if (next.sort !== 'For you') params.set('sort', next.sort);
    if (next.year !== 'All') params.set('year', next.year);
    params.set('page', '1');
    const query = params.toString();
    void goto(`${page.url.pathname}${query ? `?${query}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true });
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
  <a class="back-link" href="/discover"><ArrowLeft size={15} /> Discover</a>
  <section class="collection-heading"><div class="eyebrow">MAVERO / Explore</div><div class="heading-row"><div><h1>{label}s <em>in focus.</em></h1><p>Browse the latest {label.toLowerCase()} stories, ranked and ready for tonight.</p></div><div class="collection-count"><strong>{contentItems.length}</strong><span>titles on page {currentPage}</span></div></div></section>
  <div class="collection-tools"><FilterBar value={filterState} {genres} onChange={updateFilters} /></div>
  {#if errorMessage}
    <EmptyState eyebrow={`MAVERO / ${label} catalog`} title="The signal is quiet." message={errorMessage} actionLabel="View all" actionHref={`/discover/${type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'anime'}`} />
  {:else if contentItems.length}
    <div class="results-grid">{#each contentItems as item}<MediaCard {item} compact />{/each}</div>
  {:else}
    <EmptyState eyebrow={`MAVERO / No ${label.toLowerCase()} matches`} title="A quieter cut." message="Try clearing one of your filters or explore the full collection." actionLabel={`View all ${label.toLowerCase()}`} actionHref={`/discover/${type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'anime'}`} />
  {/if}
  <nav class="pagination" aria-label={`${label} collection pagination`}>
    {#if currentPage > 1}<a class="pagination-link" href={collectionHref(currentPage - 1)}><ArrowLeft size={14} /> Previous</a>{:else}<span class="pagination-link disabled"><ArrowLeft size={14} /> Previous</span>{/if}
    <span class="pagination-page">Page {currentPage}</span>
    {#if hasNextPage}<a class="pagination-link" href={collectionHref(currentPage + 1)}>Next <ArrowRight size={14} /></a>{:else}<span class="pagination-link disabled">Next <ArrowRight size={14} /></span>{/if}
  </nav>
</div>

<style>
  em { color: var(--accent-strong); font-style: normal; }
  .back-link { display: inline-flex; align-items: center; gap: 7px; padding-top: 24px; color: var(--muted); font-size: .67rem; font-weight: 800; text-decoration: none; }
  .back-link:hover { color: var(--ink); }
  .collection-heading { padding: 30px 0 20px; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  .collection-heading h1 { margin: 7px 0 0; font-family: 'Space Grotesk', sans-serif; font-size: clamp(2.25rem, 5vw, 4.35rem); line-height: .95; letter-spacing: -.075em; }
  .collection-heading p { max-width: 520px; margin: 12px 0 0; color: var(--muted); font-size: .8rem; line-height: 1.55; }
  .collection-count { display: grid; justify-items: end; gap: 2px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .56rem; text-transform: uppercase; }
  .collection-count strong { color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: 1.65rem; letter-spacing: -.06em; }
  .collection-tools { margin: 0 0 24px; }
  .results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 172px)); justify-content: start; gap: 25px 15px; padding-bottom: 28px; }
  .pagination { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 0 34px; }
  .pagination-link { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); font-size: .67rem; font-weight: 800; text-decoration: none; }
  .pagination-link:hover { border-color: var(--accent-strong); }
  .pagination-link.disabled { color: var(--muted); opacity: .5; pointer-events: none; }
  .pagination-page { color: var(--muted); font-family: 'DM Mono', monospace; font-size: .62rem; text-transform: uppercase; }
  @media (max-width: 640px) { .back-link { padding-top: 84px; } .collection-heading { padding: 24px 0 14px; } .heading-row { align-items: start; } .collection-heading h1 { font-size: 2.75rem; } .collection-count { padding-top: 5px; } .collection-tools { margin-bottom: 18px; } .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 11px; } .pagination { padding-bottom: 24px; } }
</style>
