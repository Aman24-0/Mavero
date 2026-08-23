<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getContinueWatching } from '$lib/client/progress/service';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { continueWatchingRecords } from '$lib/shared/progress-merge';
  import { progressToMedia } from '$lib/client/progress/presenter';
  import { page } from '$app/state';
  import { ArrowLeft, ArrowRight, Play, Info, ListPlus } from 'lucide-svelte';
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

  type GalleryCategory = 'Movie' | 'Series' | 'Anime';
  type GallerySlide = { item: MediaItem; category: GalleryCategory };
  type SlideState = { opacity: number; scale: number; zIndex: number };

  const GALLERY_ROTATION_MS = 6500;
  const GALLERY_TRANSITION_MS = 900;
  const GALLERY_SEQUENCE: GalleryCategory[] = ['Movie', 'Series', 'Anime', 'Movie', 'Series', 'Anime'];

  let localContinueLoaded = false;
  let localContinueItems: MediaItem[] = [];
  let intro: HTMLElement;
  let galleryStack: HTMLElement;
  let galleryCards: HTMLElement[] = [];
  let galleryIndex = 0;
  let galleryAnimating = false;
  let galleryPaused = false;
  let reducedMotion = false;
  let galleryRotationTimer: ReturnType<typeof setTimeout> | undefined;
  let galleryTransitionTimer: ReturnType<typeof setTimeout> | undefined;
  let animationEngine: typeof import('gsap').gsap | undefined;

  function uniqueItems(items: MediaItem[]) {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function createGallerySlides(movieItems: MediaItem[], seriesItems: MediaItem[], animeItems: MediaItem[]): GallerySlide[] {
    const pools = { Movie: uniqueItems(movieItems), Series: uniqueItems(seriesItems), Anime: uniqueItems(animeItems) } satisfies Record<GalleryCategory, MediaItem[]>;
    return GALLERY_SEQUENCE.flatMap((category, position) => {
      const pool = pools[category];
      const item = pool[position < 3 ? 0 : 1] ?? pool[0];
      return item ? [{ item, category }] : [];
    });
  }

  $: localContinue = localContinueLoaded ? localContinueItems : continueItems;
  $: hasCatalog = Boolean(featuredItem || localContinue.length || movies.length || series.length || anime.length || popularMovies.length || popularSeries.length || popularAnime.length);
  $: gallerySlides = createGallerySlides([...(featuredItem?.type === 'movie' ? [featuredItem] : []), ...popularMovies, ...movies], [...(featuredItem?.type === 'series' ? [featuredItem] : []), ...popularSeries, ...series], [...(featuredItem?.type === 'anime' ? [featuredItem] : []), ...popularAnime, ...anime]);
  $: activeSlide = gallerySlides[galleryIndex];

  function stateFor(index: number, activeIndex: number): SlideState {
    return index === activeIndex ? { opacity: 1, scale: 1.045, zIndex: 2 } : { opacity: 0, scale: 1, zIndex: 1 };
  }

  function clearGalleryTimers() {
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    if (galleryTransitionTimer) clearTimeout(galleryTransitionTimer);
    galleryRotationTimer = undefined;
    galleryTransitionTimer = undefined;
  }

  function setInitialStack() {
    if (!animationEngine || gallerySlides.length !== 6) return;
    galleryCards.forEach((card, index) => animationEngine?.set(card, stateFor(index, galleryIndex)));
  }

  function animateStack(fromIndex: number, toIndex: number) {
    if (!animationEngine || gallerySlides.length !== 6) return;
    const duration = reducedMotion ? 0.18 : GALLERY_TRANSITION_MS / 1000;
    const timeline = animationEngine.timeline({ defaults: { duration, ease: reducedMotion ? 'power1.out' : 'power2.inOut', overwrite: true } });
    const outgoing = galleryCards[fromIndex];
    const incoming = galleryCards[toIndex];
    if (outgoing) timeline.set(outgoing, { zIndex: 2 }, 0);
    if (incoming) timeline.fromTo(incoming, { opacity: 0, scale: 1.1 }, { opacity: 1, scale: 1.045, zIndex: 3 }, 0);
    if (outgoing) timeline.to(outgoing, { opacity: 0, scale: 1 }, 0);
  }

  function queueGalleryRotation() {
    if (gallerySlides.length !== 6 || galleryPaused || galleryAnimating) return;
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    galleryRotationTimer = setTimeout(() => { galleryRotationTimer = undefined; if (galleryPaused || galleryAnimating) return; changeGallerySlide((galleryIndex + 1) % gallerySlides.length); }, GALLERY_ROTATION_MS);
  }

  function finishGalleryTransition() { galleryAnimating = false; galleryTransitionTimer = undefined; if (!galleryPaused) queueGalleryRotation(); }
  function changeGallerySlide(nextIndex: number) {
    if (gallerySlides.length !== 6 || galleryAnimating || nextIndex === galleryIndex) return;
    const fromIndex = galleryIndex; galleryIndex = nextIndex; galleryAnimating = true;
    void tick().then(() => animateStack(fromIndex, nextIndex));
    if (galleryTransitionTimer) clearTimeout(galleryTransitionTimer);
    galleryTransitionTimer = setTimeout(finishGalleryTransition, reducedMotion ? 180 : GALLERY_TRANSITION_MS);
  }
  function pauseGallery() { galleryPaused = true; if (galleryRotationTimer) clearTimeout(galleryRotationTimer); galleryRotationTimer = undefined; }
  function resumeGallery() { galleryPaused = false; if (!galleryAnimating) queueGalleryRotation(); }
  function selectGallerySlide(index: number) { if (index === galleryIndex || galleryAnimating || gallerySlides.length !== 6) return; pauseGallery(); changeGallerySlide(index); }
  function handleGalleryKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') { event.preventDefault(); pauseGallery(); changeGallerySlide((galleryIndex + 1) % gallerySlides.length); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); pauseGallery(); changeGallerySlide((galleryIndex - 1 + gallerySlides.length) % gallerySlides.length); }
    else if (event.key === ' ') { event.preventDefault(); if (galleryPaused) resumeGallery(); else pauseGallery(); }
  }

  onMount(() => {
    let cancelled = false;
    void (async () => {
      const loadContinue = async () => {
        if (page.data.user) { const cloud = await syncAuthenticatedState(); return continueWatchingRecords(cloud.progress, cloud.favorites); }
        return getContinueWatching();
      };
      void loadContinue().then((records) => { if (cancelled) return; localContinueItems = records.map(progressToMedia); localContinueLoaded = true; });
      const { gsap } = await import('gsap');
      if (cancelled) return;
      animationEngine = gsap; reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      galleryCards = galleryStack ? Array.from(galleryStack.querySelectorAll<HTMLElement>('[data-gallery-card]')) : [];
      setInitialStack(); queueGalleryRotation();
      if (!reducedMotion && intro) gsap.fromTo(intro.querySelectorAll('[data-reveal]'), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: .5, stagger: .05, ease: 'power2.out' });
    })();
    return () => { cancelled = true; clearGalleryTimers(); if (animationEngine && galleryCards.length) animationEngine.killTweensOf(galleryCards); animationEngine = undefined; };
  });
</script>

<svelte:head>
  <title>Mavero — Movies, series &amp; anime, all in one place</title>
  <meta name="description" content="Stream movies, series, and anime on MAVERO." />
  <link rel="canonical" href={page.url.origin}/>
  <meta property="og:title" content="Mavero — Movies, series & anime, all in one place" />
  <meta property="og:description" content="A fast, modern home for your next watch." />
  <meta property="og:url" content={page.url.origin}/>
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary" />
</svelte:head>

<div bind:this={intro} class="discover-page">
  {#if gallerySlides.length === 6 && activeSlide}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
    <section class="hero" aria-roledescription="carousel" aria-label="Featured titles" tabindex="0" onpointerenter={pauseGallery} onpointerleave={resumeGallery} onfocusin={pauseGallery} onfocusout={resumeGallery} onkeydown={handleGalleryKeydown}>
      <div class="hero-stack" bind:this={galleryStack} aria-hidden="true">
        {#each gallerySlides as slide, index}
          <div class:active={index === galleryIndex} class="hero-slide" data-gallery-card style={`background-image: url(${JSON.stringify(slide.item.poster)})`} aria-hidden={index !== galleryIndex}></div>
        {/each}
      </div>
      <div class="hero-scrim" aria-hidden="true"></div>
      <div class="hero-scrim-bottom" aria-hidden="true"></div>

      <div class="container-wide hero-body">
        {#key `${activeSlide.item.type}:${activeSlide.item.id}`}
          <div class="hero-copy" data-reveal aria-live="polite">
            <div class="hero-kicker">{activeSlide.category} <span class="dot"></span> Featured</div>
            <h1>{activeSlide.item.title}</h1>
            <div class="hero-meta">
              {#if activeSlide.item.rating > 0}<span class="rating">★ {activeSlide.item.rating.toFixed(1)}</span>{/if}
              <span>{activeSlide.item.year}</span><span class="dot"></span>
              <span>{activeSlide.item.maturity}</span><span class="dot"></span>
              <span>{activeSlide.item.runtime}</span>
            </div>
            <p>{activeSlide.item.description}</p>
            <div class="hero-genres">{#each activeSlide.item.genres.slice(0, 3) as genre}<span>{genre}</span>{/each}</div>
            <div class="hero-actions">
              <a class="btn btn-primary" href={`/watch/${activeSlide.item.type}/${activeSlide.item.id}`}><Play size={16} fill="currentColor" /> Play</a>
              <a class="btn btn-secondary" href={`/${activeSlide.item.type}/${activeSlide.item.id}`}><Info size={16} /> More info</a>
              <a class="btn btn-secondary icon-only" href={`/${activeSlide.item.type}/${activeSlide.item.id}`} aria-label="Add to My List"><ListPlus size={16} /></a>
            </div>
          </div>
        {/key}
      </div>

      <div class="hero-controls" aria-label="Featured title controls">
        <button class="hero-arrow" type="button" aria-label="Previous title" onclick={() => { pauseGallery(); changeGallerySlide((galleryIndex - 1 + gallerySlides.length) % gallerySlides.length); }}><ArrowLeft size={16} /></button>
        <div class="hero-dots" role="tablist" aria-label="Choose featured title">
          {#each gallerySlides as slide, index}<button class:active={index === galleryIndex} class="hero-dot" type="button" role="tab" aria-selected={index === galleryIndex} aria-label={`Show ${slide.item.title}`} onclick={() => selectGallerySlide(index)}></button>{/each}
        </div>
        <button class="hero-arrow" type="button" aria-label="Next title" onclick={() => { pauseGallery(); changeGallerySlide((galleryIndex + 1) % gallerySlides.length); }}><ArrowRight size={16} /></button>
      </div>
    </section>
  {/if}

  <div class="container-wide main-content">
    {#if errorMessage}<div class="catalog-warning" role="alert">{errorMessage}</div>{/if}
    {#if hasCatalog}
      <nav class="discover-routes" aria-label="Explore MAVERO">
        <a href="/discover/movies"><span>Movies</span><ArrowRight size={13} /></a>
        <a href="/discover/series"><span>Series</span><ArrowRight size={13} /></a>
        <a href="/discover/anime"><span>Anime</span><ArrowRight size={13} /></a>
      </nav>
      {#if localContinue.length}<ContentRail title="Continue watching" items={localContinue} href="/my-list?status=watching" compact />{/if}
      {#if movies.length}<ContentRail title="Trending movies" items={movies} href="/discover/movies" />{/if}
      {#if series.length}<ContentRail title="Trending series" items={series} href="/discover/series" />{/if}
      {#if anime.length}<ContentRail title="Trending anime" items={anime} href="/discover/anime" />{/if}
      {#if popularMovies.length}<ContentRail title="Popular movies" items={popularMovies} href="/discover/movies" />{/if}
      {#if popularSeries.length}<ContentRail title="Popular series" items={popularSeries} href="/discover/series" />{/if}
      {#if popularAnime.length}<ContentRail title="Popular anime" items={popularAnime} href="/discover/anime" />{/if}
    {:else}
      <EmptyState eyebrow="MAVERO / Catalog unavailable" title="The shelves are quiet." message="The live catalog is temporarily unavailable. Please try again in a moment." actionLabel="Retry Discover" actionHref="/discover" />
    {/if}
    <footer class="footer"><strong>MAVERO</strong><span>Movies, series &amp; anime — all in one place.</span></footer>
  </div>
</div>


<style>
  .hero { position: relative; min-height: min(88vh, 820px); overflow: hidden; background: var(--base); }
  .hero-stack { position: absolute; inset: 0; }
  .hero-slide { position: absolute; inset: 0; background-position: center 22%; background-size: cover; opacity: 0; will-change: opacity, transform; }
  .hero-slide.active { opacity: 1; }
  .hero-scrim { position: absolute; inset: 0; background: linear-gradient(100deg, rgba(6,6,10,.97) 8%, rgba(6,6,10,.75) 32%, rgba(6,6,10,.28) 58%, rgba(6,6,10,.55) 100%); }
  .hero-scrim-bottom { position: absolute; inset: auto 0 0 0; height: 45%; background: linear-gradient(0deg, var(--base) 0%, transparent 100%); }
  .hero-body { position: relative; z-index: 2; display: flex; align-items: flex-end; min-height: min(88vh, 820px); padding-bottom: 96px; padding-top: 120px; }
  .hero-copy { max-width: 620px; }
  .hero-kicker { display: inline-flex; align-items: center; gap: 8px; color: var(--accent-strong); font-size: .72rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  .dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .6; }
  .hero-copy h1 { margin: 12px 0 0; color: var(--ink); font-size: clamp(2.4rem, 5.4vw, 4.6rem); font-weight: 900; letter-spacing: -.03em; line-height: .98; text-wrap: balance; }
  .hero-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 16px; color: var(--ink-soft); font-size: .8rem; font-weight: 600; }
  .hero-meta .rating { color: #ffc94d; }
  .hero-meta .dot { color: var(--muted-deep); }
  .hero-copy p { max-width: 540px; margin: 16px 0 0; color: var(--ink-soft); font-size: .92rem; line-height: 1.6; text-wrap: pretty; }
  .hero-genres { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .hero-genres span { border: 1px solid var(--line-strong); border-radius: 999px; padding: 5px 12px; color: var(--ink-soft); font-size: .68rem; font-weight: 600; background: rgba(245,246,250,.05); }
  .hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
  .icon-only { width: 46px; padding: 0; flex: 0 0 auto; }
  .hero-controls { position: absolute; right: clamp(20px, 4vw, 48px); bottom: 28px; z-index: 3; display: flex; align-items: center; gap: 12px; }
  .hero-arrow { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--ink); background: rgba(6,6,10,.5); backdrop-filter: blur(10px); transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .hero-arrow:hover, .hero-arrow:focus-visible { border-color: rgba(255,90,122,.6); background: var(--accent-soft); transform: translateY(-1px); outline: 0; }
  .hero-dots { display: flex; align-items: center; gap: 6px; }
  .hero-dot { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 999px; background: rgba(245,246,250,.28); transition: width var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .hero-dot:hover, .hero-dot:focus-visible { background: rgba(245,246,250,.65); outline: 0; }
  .hero-dot.active { width: 22px; background: var(--accent-gradient); }

  .discover-routes { display: flex; gap: 10px; margin: 22px 0 40px; }
  .discover-routes a { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); text-decoration: none; font-size: .78rem; font-weight: 700; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .discover-routes a:hover { border-color: rgba(255,90,122,.5); background: var(--accent-soft); transform: translateY(-2px); }
  .discover-routes a :global(svg) { color: var(--accent-strong); }
  .catalog-warning { margin: 16px 0 0; padding: 12px 14px; border: 1px solid rgba(255,176,32,.35); border-radius: var(--radius-sm); color: var(--warning); font-size: .72rem; line-height: 1.5; }

  @media (max-width: 900px) {
    .hero { min-height: min(78vh, 680px); }
    .hero-body { min-height: min(78vh, 680px); padding-top: 90px; padding-bottom: 84px; }
  }
  @media (max-width: 640px) {
    .hero { min-height: 84vh; }
    .hero-slide { background-position: center 18%; }
    .hero-scrim { background: linear-gradient(0deg, rgba(6,6,10,.98) 18%, rgba(6,6,10,.55) 55%, rgba(6,6,10,.35) 100%); }
    .hero-body { align-items: flex-end; min-height: 84vh; padding-top: 76px; padding-bottom: 74px; }
    .hero-copy { max-width: none; }
    .hero-copy h1 { font-size: clamp(2rem, 9vw, 2.9rem); }
    .hero-copy p { font-size: .82rem; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }
    .hero-genres { display: none; }
    .hero-actions .btn:not(.icon-only) { flex: 1; }
    .hero-controls { right: 20px; bottom: 14px; }
    .hero-arrow { width: 32px; height: 32px; }
    .discover-routes { margin: 16px 0 30px; overflow-x: auto; scrollbar-width: none; }
    .discover-routes::-webkit-scrollbar { display: none; }
    .discover-routes a { flex: 0 0 auto; }
  }
  @media (prefers-reduced-motion: reduce) { .hero-slide, .hero-arrow, .discover-routes a { transition: none; } }
</style>
