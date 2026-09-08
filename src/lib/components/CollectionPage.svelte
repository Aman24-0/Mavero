<script lang="ts">
  import { goto } from '$app/navigation';
  import { page, navigating } from '$app/state';
  import { ArrowLeft, ArrowRight, Layers3 } from 'lucide-svelte';
  import type { ContentType } from '$data/content';
  import { media as fixtureMedia, formatType, type MediaItem } from '$data/content';
  import FilterBar from '$components/FilterBar.svelte';
  import type { FilterState } from '$components/filter-types';
  import MediaCard from '$components/MediaCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  type CollectionFilters = { genre?: string; year?: string; sort?: 'For you' | 'Top rated' | 'Newest' };
  export let type: ContentType = 'movie';
  export let contentItems: MediaItem[] = fixtureMedia.filter((item) => item.type === type);
  export let currentPage = 1;
  export let hasNextPage = false;
  // "Page X of Y" total from the server collection contract, when the
  // upstream source provides one (TMDB discover does; the anime merged
  // path does not). Already clamped server-side to the 1..20 serving
  // window — the UI never invents a total it was not given.
  export let totalPages: number | undefined = undefined;
  export let collectionFilters: CollectionFilters = {};
  export let errorMessage: string | undefined;
  const validSorts = ['For you', 'Top rated', 'Newest'];
  const fallbackGenres = [...new Set(fixtureMedia.filter((item) => item.type === type).flatMap((item) => item.genres))].sort();
  $: label = formatType(type);
  // Anime is its own classification, not a pluralised "Animes" — the
  // heading stays visually consistent across all three collections while
  // using content-appropriate copy.
  $: headingLabel = type === 'anime' ? 'Anime' : `${label}s`;
  $: filterState = { genre: collectionFilters.genre || 'All', sort: validSorts.includes(collectionFilters.sort || '') ? collectionFilters.sort || 'For you' : 'For you', year: collectionFilters.year || 'All' } satisfies FilterState;
  $: hasActiveFilters = filterState.genre !== 'All' || filterState.year !== 'All' || filterState.sort !== 'For you';
  $: genres = [...new Set([...fallbackGenres, ...contentItems.flatMap((item) => item.genres)])].sort();
  function collectionHref(targetPage: number) { const params = new URLSearchParams(page.url.searchParams); params.set('page', String(Math.max(1, targetPage))); return `${page.url.pathname}?${params.toString()}`; }
  function updateFilters(next: FilterState) { const params = new URLSearchParams(); if (next.genre !== 'All') params.set('genre', next.genre); if (next.sort !== 'For you') params.set('sort', next.sort); if (next.year !== 'All') params.set('year', next.year); params.set('page', '1'); const query = params.toString(); void goto(`${page.url.pathname}${query ? `?${query}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true }); }
  // Empty-state "Clear filters": drops genre/year/sort and returns to a
  // clean canonical URL on page 1 (updateFilters already builds it).
  function clearFilters() { updateFilters({ genre: 'All', sort: 'For you', year: 'All' }); }
  // Same-route navigation (filter/pagination change): the collection
  // shell stays mounted while the server load runs, so the grid swaps to
  // a matching skeleton instead of sitting on stale content with no
  // feedback. Cross-route arrivals render SSR content directly, and
  // Back/Forward (popstate) is excluded — restored history content shows
  // instantly from the client-side load cache.
  $: sameRouteNavigation = Boolean(navigating.from && navigating.to && navigating.type !== 'popstate' && navigating.from.url.pathname === navigating.to.url.pathname && navigating.to.url.pathname.startsWith('/discover/'));
  $: skeletonCount = Math.max(4, Math.min(contentItems.length || 12, 20));
  $: hasNextPageSafe = hasNextPage && (totalPages === undefined || currentPage < totalPages);
</script>

<svelte:head><title>{headingLabel} — Mavero</title><meta name="description" content={`Explore MAVERO's focused collection of ${label.toLowerCase()} stories.`} /><link rel="canonical" href={`${page.url.origin}${page.url.pathname}`} /><meta property="og:title" content={`${headingLabel} — Mavero`} /><meta property="og:description" content={`Explore MAVERO's focused collection of ${label.toLowerCase()} stories.`} /><meta property="og:url" content={`${page.url.origin}${page.url.pathname}`} /><meta name="twitter:card" content="summary" /></svelte:head>

<div class="collection-page">
  <a class="back-link" href="/discover"><ArrowLeft size={15} /> Discover</a>
  <section class="collection-heading">
    <div class="eyebrow"><Layers3 size={13} /> Mavero / Explore</div>
    <div class="heading-row">
      <div>
        <h1>{headingLabel} <em>in focus.</em></h1>
        <p>Browse the latest {label.toLowerCase()} stories, ranked and ready for tonight.</p>
      </div>
      <div class="collection-count"><strong>{contentItems.length}</strong><span>titles on page {currentPage}</span></div>
    </div>
  </section>
  <div class="collection-tools"><FilterBar value={filterState} {genres} onChange={updateFilters} /></div>
  {#if errorMessage}
    <EmptyState eyebrow={`MAVERO / ${label} catalog`} title="The signal is quiet." message={errorMessage} actionLabel="View all" actionHref={`/discover/${type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'anime'}`} />
  {:else if sameRouteNavigation}
    <div class="results-grid results-grid-loading" aria-busy="true" aria-label={`Loading ${label.toLowerCase()}`}>
      {#each Array(skeletonCount) as _}<SkeletonCard compact />{/each}
    </div>
  {:else if contentItems.length}
    <div class="results-grid">{#each contentItems as item}<MediaCard {item} compact editorial />{/each}</div>
  {:else if hasActiveFilters}
    <EmptyState eyebrow={`MAVERO / No ${label.toLowerCase()} matches`} title="Nothing found" message="Try changing your filters or clear them to explore the full collection." actionLabel="Clear filters" onAction={clearFilters} />
  {:else}
    <EmptyState eyebrow={`MAVERO / No ${label.toLowerCase()} matches`} title="A quieter cut." message={`There are no ${label.toLowerCase()} titles to show right now. Check back soon.`} actionLabel={`View all ${label.toLowerCase()}`} actionHref={`/discover/${type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'anime'}`} />
  {/if}
  <nav class="pagination" aria-label={`${label} collection pagination`}>
    <div>{#if currentPage > 1}<a class="pagination-link" href={collectionHref(currentPage - 1)}><ArrowLeft size={14} /> Previous</a>{:else}<span class="pagination-link disabled"><ArrowLeft size={14} /> Previous</span>{/if}</div>
    <span class="pagination-page">{#if totalPages !== undefined}Page {currentPage} of {totalPages}{:else}Page {currentPage}{/if}</span>
    <div>{#if hasNextPageSafe}<a class="pagination-link" href={collectionHref(currentPage + 1)}>Next <ArrowRight size={14} /></a>{:else}<span class="pagination-link disabled">Next <ArrowRight size={14} /></span>{/if}</div>
  </nav>
</div>

<ScrollToTop />

<style>
  .collection-page {
    /* Single consistent mobile→desktop content gutter — matches Discover/ContentRail. */
    --c-gutter: clamp(16px, 5vw, 48px);
    width: min(1600px, calc(100% - 2 * var(--c-gutter))); margin-inline: auto;
    padding-bottom: 40px;
  }
  em { color: #77777f; font-style: normal; }
  .back-link {
    display: inline-flex; align-items: center; gap: 7px; padding-top: 28px;
    color: #77777f; font-size: .74rem; font-weight: 700; text-decoration: none;
    transition: color 200ms cubic-bezier(.22,1,.36,1), transform 200ms cubic-bezier(.22,1,.36,1);
  }
  .back-link:hover { color: #f5f5f5; transform: translateX(-2px); }
  .collection-heading { padding: 30px 0 22px; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  .collection-heading h1 {
    margin: 10px 0 0; color: #f5f5f5; font-size: clamp(2rem, 4.4vw, 3.4rem);
    font-weight: 800; line-height: 1.02; letter-spacing: -.025em;
  }
  .collection-heading p { max-width: 520px; margin: 12px 0 0; color: #77777f; font-size: .84rem; line-height: 1.6; }
  .collection-count { display: grid; justify-items: end; gap: 3px; color: #77777f; font-size: .64rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .collection-count strong { color: #f5f5f5; font-size: 1.8rem; font-weight: 800; line-height: 1; }
  .collection-tools { margin: 0 0 28px; padding: 14px 0; border-top: 1px solid rgba(255,255,255,.06); border-bottom: 1px solid rgba(255,255,255,.06); }
  .results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 182px)); justify-content: start; gap: 28px 16px; padding-bottom: 34px; }
  /* Collection grid: card titles may wrap to two lines but never more,
     and every card reserves the same two-line block — long titles can
     no longer create uneven rows. Scoped to this grid (via :global)
     so MediaCard behavior on every other surface is untouched. */
  .results-grid :global(.mc-title) {
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    min-height: 2.5em; overflow: hidden; white-space: normal;
  }
  .results-grid-loading { min-height: 320px; }
  .pagination { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 14px; padding: 16px 0 40px; border-top: 1px solid rgba(255,255,255,.06); }
  .pagination > :last-child { justify-self: end; }
  .pagination-link {
    display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 0 15px;
    border: 1px solid rgba(255,255,255,.08); border-radius: 999px; color: #f5f5f5;
    font-size: .72rem; font-weight: 700; text-decoration: none;
    transition: border-color 200ms cubic-bezier(.22,1,.36,1), background 200ms cubic-bezier(.22,1,.36,1), transform 200ms cubic-bezier(.22,1,.36,1);
  }
  .pagination-link:hover { border-color: rgba(255,255,255,.14); background: rgba(255,255,255,.06); transform: translateY(-1px); }
  .pagination-link.disabled { color: #444444; opacity: .5; pointer-events: none; }
  .pagination-page { color: #77777f; font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  @media (max-width: 640px) {
    .collection-page {
      /* On mobile, take the full width and use padding for the gutter so the
         filter bar can stretch edge-to-edge within that gutter, matching the
         Discover chips behaviour. */
      width: 100%; margin-inline: 0;
      padding-left: var(--c-gutter); padding-right: var(--c-gutter);
    }
    .back-link { padding-top: calc(10px + env(safe-area-inset-top)); }
    /* Vertical efficiency: the first poster row should appear sooner.
       Tightened heading rhythm + a short 2-line description block — no
       information removed, whitespace trimmed. */
    .collection-heading { padding: 16px 0 12px; }
    .heading-row { align-items: start; }
    .collection-heading h1 { margin-top: 6px; font-size: 2.1rem; }
    .collection-heading p {
      display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; margin-top: 7px; font-size: .8rem;
    }
    .collection-count { padding-top: 3px; }
    .collection-tools { margin-bottom: 16px; padding: 10px 0; }
    .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 11px; padding-bottom: 34px; }
    .pagination { padding-bottom: calc(26px + env(safe-area-inset-bottom, 0px)); }
    .pagination-link { padding-inline: 12px; }
  }
</style>
