<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft } from 'lucide-svelte';
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
  <a class="back-link" href="/discover"><ArrowLeft size={15} /> Discover</a>
  <section class="collection-heading"><div class="eyebrow">MAVERO / Explore</div><div class="heading-row"><div><h1>{label}s <em>in focus.</em></h1><p>Browse the latest {label.toLowerCase()} stories, ranked and ready for tonight.</p></div><div class="collection-count"><strong>{filteredItems.length}</strong><span>titles</span></div></div></section>
  <div class="collection-tools"><FilterBar value={filterState} {genres} onChange={updateFilters} /></div>
  {#if filteredItems.length}
    <div class="results-grid">{#each filteredItems as item}<MediaCard {item} compact />{/each}</div>
  {:else}
    <EmptyState eyebrow={`MAVERO / No ${label.toLowerCase()} matches`} title="A quieter cut." message="Try clearing one of your filters or explore the full collection." actionLabel={`View all ${label.toLowerCase()}`} actionHref={`/discover/${type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'anime'}`} />
  {/if}
  <div class="load-sentinel" aria-hidden="true" data-next-page="2"></div>
</div>

<style>
  em { color: var(--accent); font-style: normal; }
  .back-link { display: inline-flex; align-items: center; gap: 7px; padding-top: 24px; color: var(--muted); font-size: .68rem; font-weight: 800; text-decoration: none; }
  .back-link:hover { color: var(--ink); }
  .collection-heading { padding: 30px 0 18px; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  .collection-heading h1 { margin: 7px 0 0; font-size: clamp(2.35rem, 5vw, 4.7rem); line-height: .95; letter-spacing: -.075em; }
  .collection-heading p { max-width: 520px; margin: 12px 0 0; color: var(--muted); font-size: .82rem; line-height: 1.55; }
  .collection-count { display: grid; justify-items: end; gap: 2px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .58rem; text-transform: uppercase; }
  .collection-count strong { color: var(--ink); font-family: Manrope, sans-serif; font-size: 1.65rem; letter-spacing: -.06em; }
  .collection-tools { margin: 0 0 22px; }
  .results-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 20px 13px; padding-bottom: 28px; }
  .load-sentinel { height: 1px; }
  @media (max-width: 1000px) { .results-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .back-link { padding-top: 84px; } .collection-heading { padding: 24px 0 14px; } .heading-row { align-items: start; } .collection-heading h1 { font-size: 2.75rem; } .collection-count { padding-top: 5px; } .collection-tools { margin-bottom: 18px; } .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 11px; } }
</style>
