<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUpRight, Play, Plus, Search, SlidersHorizontal, Sparkles } from 'lucide-svelte';
  import { featured as fixtureFeatured, media as fixtureMedia, continueWatching as fixtureContinueWatching, trendingMovies as fixtureMovies, trendingSeries as fixtureSeries, trendingAnime as fixtureAnime, type MediaItem } from '$data/content';
  import ContentRail from '$components/ContentRail.svelte';

  export let featuredItem: MediaItem = fixtureFeatured;
  export let movies: MediaItem[] = fixtureMovies;
  export let series: MediaItem[] = fixtureSeries;
  export let anime: MediaItem[] = fixtureAnime;
  export let continueItems: MediaItem[] = fixtureContinueWatching;

  let activeMode = 'All';
  let query = '';
  let intro: HTMLElement;
  $: contentMedia = [...movies, ...series, ...anime];

  const modes = ['All', 'Movies', 'Series', 'Anime'];
  $: filteredMedia = query.trim()
    ? contentMedia.filter((item) => `${item.title} ${item.genres.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  onMount(async () => {
    const { gsap } = await import('gsap');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !intro) return;
    gsap.fromTo(intro.querySelectorAll('[data-reveal]'), { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.07, ease: 'power2.out' });
  });
</script>

<svelte:head>
  <title>Mavero — Discover. Watch.</title>
  <meta name="description" content="Discover movies, series, and anime on MAVERO." />
</svelte:head>

<div bind:this={intro}>
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-media" style={`background-image: url('${featuredItem.backdrop}')`}></div>
    <div class="container-wide hero-content">
      <div class="hero-kicker" data-reveal><Sparkles size={13} /> {featuredItem.tags?.[0] ?? 'Featured story'}</div>
      <h1 id="hero-title" data-reveal>{featuredItem.title}</h1>
      <p class="hero-description" data-reveal>{featuredItem.description}</p>
      <div class="meta-row" data-reveal>
        <strong>{featuredItem.year}</strong><span class="dot"></span><span>{featuredItem.runtime}</span><span class="dot"></span><span>{featuredItem.maturity}</span><span class="dot"></span><span>{featuredItem.genres.slice(0, 2).join(' · ')}</span>
      </div>
      <div class="hero-actions" data-reveal>
        <a class="btn btn-primary" href={`/watch/${featuredItem.type}/${featuredItem.id}`}><Play size={15} fill="currentColor" /> Start watching</a>
        <a class="btn btn-secondary" href={`/${featuredItem.type}/${featuredItem.id}`}><ArrowUpRight size={15} /> Details</a>
      </div>
    </div>
    <div class="hero-signal" aria-hidden="true"><b>01</b><span>Now showing</span></div>
  </section>

  <div class="container-wide main-content">
    <div class="search-band">
      <Search size={16} />
      <input bind:value={query} aria-label="Search MAVERO" placeholder="Search a title, genre, or feeling" />
      <a class="section-link" href="/search">Open search <ArrowUpRight size={13} /></a>
    </div>

    <div class="mode-tabs" aria-label="Content type filters">
      {#each modes as mode}
        <button class:active={activeMode === mode} class="mode-tab" onclick={() => (activeMode = mode)}>{mode}</button>
      {/each}
      <button class="mode-tab" aria-label="Open filters"><SlidersHorizontal size={14} /> Filters</button>
    </div>

    {#if query.trim()}
      <ContentRail title={`Results for “${query}”`} eyebrow="Quick search" items={filteredMedia} href="/search" compact />
    {:else}
      {#if activeMode === 'All' || activeMode === 'Movies'}
        <ContentRail title="Trending movies" eyebrow="Make tonight count" items={movies} href="/discover/movies" />
      {/if}
      {#if activeMode === 'All' || activeMode === 'Series'}
        <ContentRail title="Stories worth staying for" eyebrow="Series" items={series} href="/discover/series" />
      {/if}
      {#if activeMode === 'All' || activeMode === 'Anime'}
        <ContentRail title="The anime edit" eyebrow="From another world" items={anime} href="/discover/anime" />
      {/if}
      {#if continueItems.length}
        <ContentRail title="Continue watching" eyebrow="Pick up where you left off" items={continueItems} href="/profile" compact />
      {/if}
      <section class="quiet-banner">
        <div><div class="eyebrow">MAVERO / The short list</div><h2>Less scrolling.<br /><em>More finding.</em></h2></div>
        <p>Curated worlds, new voices, and the kind of story you think about tomorrow.</p>
        <a class="btn btn-secondary" href="/discover">Explore the collection <ArrowUpRight size={15} /></a>
      </section>
    {/if}

    <footer class="footer"><span><strong>MAVERO</strong> — Discover. Watch.</span><span>Built for the next story.</span></footer>
  </div>
</div>

<style>
  .quiet-banner { display: grid; grid-template-columns: 1.3fr .9fr auto; align-items: end; gap: 36px; margin-top: 64px; padding: 34px 0 8px; border-top: 1px solid var(--line); }
  .quiet-banner h2 { margin: 8px 0 0; color: var(--ink); font-size: clamp(2rem, 4vw, 3.8rem); line-height: .98; letter-spacing: -.07em; }
  .quiet-banner h2 em { color: var(--accent); font-style: normal; }
  .quiet-banner p { max-width: 270px; margin: 0; color: var(--muted); font-size: .82rem; line-height: 1.65; }
  .quiet-banner .btn { justify-self: end; }
  @media (max-width: 780px) { .quiet-banner { grid-template-columns: 1fr; gap: 18px; } .quiet-banner .btn { justify-self: start; } }
</style>
