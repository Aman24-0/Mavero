<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft, ArrowRight, Layers3 } from 'lucide-svelte';
  import type { ContentType } from '$data/content';
  import { media as fixtureMedia, type MediaItem } from '$data/content';
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
  $: label = type === 'movie' ? 'Movie' : type === 'series' ? 'Series' : 'Anime';
  $: filterState = { genre: collectionFilters.genre || 'All', sort: validSorts.includes(collectionFilters.sort || '') ? collectionFilters.sort || 'For you' : 'For you', year: collectionFilters.year || 'All' } satisfies FilterState;
  $: genres = [...new Set([...fallbackGenres, ...contentItems.flatMap((item) => item.genres)])].sort();
  function collectionHref(targetPage: number) { const params = new URLSearchParams(page.url.searchParams); params.set('page', String(Math.max(1, targetPage))); return `${page.url.pathname}?${params.toString()}`; }
  function updateFilters(next: FilterState) { const params = new URLSearchParams(); if (next.genre !== 'All') params.set('genre', next.genre); if (next.sort !== 'For you') params.set('sort', next.sort); if (next.year !== 'All') params.set('year', next.year); params.set('page', '1'); const query = params.toString(); void goto(`${page.url.pathname}${query ? `?${query}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true }); }
</script>

<svelte:head><title>{label === 'Movie' ? 'Movies' : label === 'Series' ? 'Series' : 'Anime'} — Mavero</title><meta name="description" content={`Explore MAVERO’s ${label.toLowerCase()} catalogue.`} /><link rel="canonical" href={`${page.url.origin}${page.url.pathname}`} /><meta property="og:title" content={`${label === 'Movie' ? 'Movies' : label === 'Series' ? 'Series' : 'Anime'} — Mavero`} /><meta property="og:description" content={`Explore MAVERO’s ${label.toLowerCase()} catalogue.`} /><meta property="og:url" content={`${page.url.origin}${page.url.pathname}`} /><meta name="twitter:card" content="summary" /></svelte:head>

<div class="container-wide collection-page">
  <a class="back-link" href="/discover"><ArrowLeft size={15} /> Discover</a>
  <section class="collection-heading"><div class="eyebrow"><Layers3 size={13} /> Mavero / Explore</div><div class="heading-row"><h1>{label === 'Movie' ? 'Movies' : label === 'Series' ? 'Series' : 'Anime'}</h1><div class="collection-count"><strong>{contentItems.length}</strong><span>titles on page {currentPage}</span></div></div></section>
  <div class="collection-tools"><FilterBar value={filterState} {genres} onChange={updateFilters} /></div>
  {#if errorMessage}<EmptyState eyebrow={`MAVERO / ${label} catalog`} title="The signal is quiet." message={errorMessage} actionLabel="View all" actionHref={`/discover/${type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'anime'}`} />{:else if contentItems.length}<div class="results-grid">{#each contentItems as item}<MediaCard {item} compact featured />{/each}</div>{:else}<EmptyState eyebrow={`MAVERO / No ${label.toLowerCase()} matches`} title="A quieter cut." message="Try clearing one of your filters or explore the full collection." actionLabel={`View all ${label.toLowerCase()}`} actionHref={`/discover/${type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'anime'}`} />{/if}
  <nav class="pagination" aria-label={`${label} collection pagination`}><div>{#if currentPage > 1}<a class="pagination-link" href={collectionHref(currentPage - 1)}><ArrowLeft size={14} /> Previous</a>{:else}<span class="pagination-link disabled"><ArrowLeft size={14} /> Previous</span>{/if}</div><span class="pagination-page">Page {currentPage}</span><div>{#if hasNextPage}<a class="pagination-link" href={collectionHref(currentPage + 1)}>Next <ArrowRight size={14} /></a>{:else}<span class="pagination-link disabled">Next <ArrowRight size={14} /></span>{/if}</div></nav>
</div>

<style>
  .back-link { display: inline-flex; align-items: center; gap: 7px; padding-top: 28px; color: var(--muted); font-size: .67rem; font-weight: 800; text-decoration: none; transition: color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .back-link:hover { color: var(--accent-strong); transform: translateX(-2px); }
  .collection-heading { padding: 28px 0 17px; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  .collection-heading h1 { margin: 8px 0 0; font-family: 'Space Grotesk', sans-serif; font-size: clamp(2.2rem, 4vw, 3.8rem); font-weight: 600; line-height: .92; letter-spacing: -.07em; }
  .collection-count { display: grid; justify-items: end; gap: 4px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .56rem; text-transform: uppercase; }
  .collection-count strong { color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: 2.2rem; font-weight: 600; line-height: .8; }
  .collection-tools { margin: 0 0 22px; padding: 9px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 182px)); justify-content: start; gap: 30px 16px; padding-bottom: 34px; }
  .pagination { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 14px; padding: 13px 0 40px; border-top: 1px solid var(--line); }
  .pagination > :last-child { justify-self: end; }
  .pagination-link { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 13px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); font-size: .67rem; font-weight: 800; text-decoration: none; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .pagination-link:hover { border-color: var(--accent-strong); background: var(--accent-soft); transform: translateY(-1px); }
  .pagination-link.disabled { color: var(--muted-deep); opacity: .55; pointer-events: none; }
  .pagination-page { color: var(--muted); font-family: 'DM Mono', monospace; font-size: .62rem; text-transform: uppercase; }
  @media (max-width: 640px) { .back-link { padding-top: 88px; } .collection-heading { padding: 20px 0 14px; } .heading-row { align-items: start; } .collection-heading h1 { font-size: 2.8rem; } .collection-count { padding-top: 5px; } .collection-tools { margin-bottom: 16px; } .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 11px; } .pagination { padding-bottom: 26px; } .pagination-link { padding-inline: 10px; } }
</style>
