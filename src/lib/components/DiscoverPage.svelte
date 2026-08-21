<script lang="ts">
  import { onMount } from 'svelte';
  import { getContinueWatching } from '$lib/client/progress/service';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { continueWatchingRecords } from '$lib/shared/progress-merge';
  import { progressToMedia } from '$lib/client/progress/presenter';
  import { page } from '$app/state';
  import { ArrowRight, Play, Sparkles } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import ContentRail from '$components/ContentRail.svelte';
  import EmptyState from '$components/EmptyState.svelte';

  export let featuredItem: MediaItem | undefined;
  export let movies: MediaItem[] = [];
  export let series: MediaItem[] = [];
  export let anime: MediaItem[] = [];
  export let popularMovies: MediaItem[] = [];
  export let popularSeries: MediaItem[] = [];
  export let popularAnime: MediaItem[] = [];
  export let continueItems: MediaItem[] = [];
  export let errorMessage = '';

  let localContinueLoaded = false;
  let localContinueItems: MediaItem[] = [];
  let intro: HTMLElement;
  $: localContinue = localContinueLoaded ? localContinueItems : continueItems;
  $: hasCatalog = Boolean(featuredItem || localContinue.length || movies.length || series.length || anime.length || popularMovies.length || popularSeries.length || popularAnime.length);

  onMount(async () => {
    const loadContinue = async () => {
      if (page.data.user) {
        const cloud = await syncAuthenticatedState();
        return continueWatchingRecords(cloud.progress, cloud.favorites);
      }
      return getContinueWatching();
    };
    void loadContinue().then((records) => { localContinueItems = records.map(progressToMedia); localContinueLoaded = true; });
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
    {#if hasCatalog}
      {#if localContinue.length}<ContentRail title="Continue watching" eyebrow="Pick up where you left off" items={localContinue} href="/my-list?status=watching" compact />{/if}
      {#if movies.length}<ContentRail title="Trending movies" eyebrow="What people are watching" items={movies} href="/discover/movies" />{/if}
      {#if series.length}<ContentRail title="Trending shows" eyebrow="Stories worth staying for" items={series} href="/discover/series" />{/if}
      {#if anime.length}<ContentRail title="Trending anime" eyebrow="From another world" items={anime} href="/discover/anime" />{/if}
      {#if popularMovies.length}<ContentRail title="Popular movies" eyebrow="The essential watchlist" items={popularMovies} href="/discover/movies" />{/if}
      {#if popularSeries.length}<ContentRail title="Popular shows" eyebrow="Binge-worthy worlds" items={popularSeries} href="/discover/series" />{/if}
      {#if popularAnime.length}<ContentRail title="Popular anime" eyebrow="Fan favourites" items={popularAnime} href="/discover/anime" />{/if}
    {:else}
      <EmptyState eyebrow="MAVERO / Catalog unavailable" title="The shelves are quiet." message="The live catalog is temporarily unavailable. Please try again in a moment." actionLabel="Retry Discover" actionHref="/discover" />
    {/if}
    <footer class="footer"><strong>MAVERO</strong><span>Discover. Watch.</span></footer>
  </div>
</div>

<style>
  .catalog-warning { margin: 14px 0 0; padding: 11px 13px; border: 1px solid rgba(212,178,124,.35); color: #d4b27c; font-family: 'DM Mono', monospace; font-size: .64rem; line-height: 1.5; }
  .footer { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 38px 0 20px; text-align: center; }
  .footer strong { color: var(--ink); letter-spacing: .18em; }
  .footer span { color: var(--muted-deep); }
</style>
