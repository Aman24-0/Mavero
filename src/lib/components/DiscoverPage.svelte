<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getContinueWatching } from '$lib/client/progress/service';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { continueWatchingRecords } from '$lib/shared/progress-merge';
  import { progressToMedia } from '$lib/client/progress/presenter';
  import { navigating, page } from '$app/state';
  import { ArrowLeft, ArrowRight, Play, Sparkles, BookmarkPlus } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import ContentRail from '$components/ContentRail.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import RouteLoading from '$components/RouteLoading.svelte';

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
  type CardPosition = { x: number; y: number; scale: number; rotation: number; opacity: number; zIndex: number };

  const GALLERY_ROTATION_MS = 5000;
  const GALLERY_TRANSITION_MS = 960;
  const GALLERY_SEQUENCE: GalleryCategory[] = ['Movie', 'Series', 'Anime', 'Movie', 'Series', 'Anime'];

  let localContinueLoaded = false;
  let localContinueItems: MediaItem[] = [];
  let intro: HTMLElement;
  let galleryStack: HTMLElement;
  let galleryCards: HTMLElement[] = [];
  let galleryIndex = 0;
  let galleryAnimating = false;
  let departingGalleryIndex = -1;
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
  $: navigatingAway = Boolean(navigating.to);
  $: hasCatalog = Boolean(featuredItem || localContinue.length || movies.length || series.length || anime.length || popularMovies.length || popularSeries.length || popularAnime.length);
  $: gallerySlides = createGallerySlides([...(featuredItem?.type === 'movie' ? [featuredItem] : []), ...popularMovies, ...movies], [...(featuredItem?.type === 'series' ? [featuredItem] : []), ...popularSeries, ...series], [...(featuredItem?.type === 'anime' ? [featuredItem] : []), ...popularAnime, ...anime]);
  $: activeSlide = gallerySlides[galleryIndex];

  function positionFor(index: number, activeIndex: number): CardPosition {
    const depth = gallerySlides.length ? (index - activeIndex + gallerySlides.length) % gallerySlides.length : 0;
    const visibleDepth = Math.min(depth, 5);
    return { x: visibleDepth * 10, y: visibleDepth * 14, scale: 1 - visibleDepth * 0.028, rotation: visibleDepth === 0 ? 0 : (visibleDepth % 2 ? 0.32 : -0.24) * (visibleDepth > 3 ? 0.72 : 1), opacity: 1 - visibleDepth * 0.09, zIndex: 20 - visibleDepth };
  }

  function clearGalleryTimers() {
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    if (galleryTransitionTimer) clearTimeout(galleryTransitionTimer);
    galleryRotationTimer = undefined;
    galleryTransitionTimer = undefined;
  }

  function setInitialStack() {
    if (!animationEngine || gallerySlides.length !== 6) return;
    galleryCards.forEach((card, index) => animationEngine?.set(card, positionFor(index, galleryIndex)));
  }

  function animateStack(fromIndex: number, toIndex: number) {
    if (!animationEngine || gallerySlides.length !== 6) return;
    const duration = reducedMotion ? 0.18 : GALLERY_TRANSITION_MS / 1000;
    const timeline = animationEngine.timeline({ defaults: { duration, ease: reducedMotion ? 'power1.out' : 'expo.inOut', overwrite: true } });
    galleryCards.forEach((card, index) => {
      const start = positionFor(index, fromIndex);
      const end = positionFor(index, toIndex);
      timeline.set(card, { ...start, zIndex: start.zIndex }, 0);
      timeline.to(card, { ...end }, 0);
    });
    const incoming = galleryCards[toIndex];
    const outgoing = galleryCards[fromIndex];
    if (incoming) timeline.set(incoming, { zIndex: 19 }, 0);
    if (outgoing) { timeline.set(outgoing, { zIndex: 21 }, 0); timeline.set(outgoing, { zIndex: positionFor(fromIndex, toIndex).zIndex }, duration * 0.52); }
  }

  function queueGalleryRotation() {
    if (gallerySlides.length !== 6 || galleryPaused || galleryAnimating) return;
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    galleryRotationTimer = setTimeout(() => { galleryRotationTimer = undefined; if (galleryPaused || galleryAnimating) return; changeGallerySlide((galleryIndex + 1) % gallerySlides.length); }, GALLERY_ROTATION_MS);
  }

  function finishGalleryTransition() { departingGalleryIndex = -1; galleryAnimating = false; galleryTransitionTimer = undefined; if (!galleryPaused) queueGalleryRotation(); }
  function changeGallerySlide(nextIndex: number) {
    if (gallerySlides.length !== 6 || galleryAnimating || nextIndex === galleryIndex) return;
    const fromIndex = galleryIndex; departingGalleryIndex = fromIndex; galleryIndex = nextIndex; galleryAnimating = true;
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
      if (!reducedMotion && intro) gsap.fromTo(intro.querySelectorAll('[data-reveal]'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .52, stagger: .045, ease: 'power2.out' });
    })();
    return () => { cancelled = true; clearGalleryTimers(); if (animationEngine && galleryCards.length) animationEngine.killTweensOf(galleryCards); animationEngine = undefined; };
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
  {#if gallerySlides.length === 6 && activeSlide}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
    <section class:reduced-motion={reducedMotion} class="editorial-hero" aria-labelledby="gallery-title" aria-roledescription="carousel" tabindex="0" onpointerenter={pauseGallery} onpointerleave={resumeGallery} onfocusin={pauseGallery} onfocusout={resumeGallery} onkeydown={handleGalleryKeydown}>
      <div class="hero-backdrop gallery-ambient" aria-hidden="true" style={`background-image: url(${JSON.stringify(activeSlide.item.backdrop || activeSlide.item.poster)})`}></div>
      <div class="hero-wash" aria-hidden="true"></div>
      <div class="container-wide hero-inner gallery-main">
        <div class="hero-copy gallery-copy" data-reveal>
          <div class="hero-kicker"><Sparkles size={13} /> Editorial pick <span></span> Tonight</div>
          <div class="hero-category">{activeSlide.category} · Featured story</div>
          <h1 id="gallery-title">{activeSlide.item.title}</h1>
          <p>{activeSlide.item.description}</p>
          <div class="hero-meta"><strong>{activeSlide.item.year}</strong><i></i><span>{activeSlide.item.runtime}</span><i></i><span>{activeSlide.item.maturity}</span><i></i><span>{activeSlide.item.genres.slice(0, 2).join(' · ')}</span></div>
          <div class="hero-actions gallery-actions"><a class="btn btn-primary" href={`/watch/${activeSlide.item.type}/${activeSlide.item.id}`}><Play size={14} fill="currentColor" /> Play now</a><a class="btn btn-secondary" href={`/${activeSlide.item.type}/${activeSlide.item.id}`}><BookmarkPlus size={14} /> Add to list</a></div>
          <div class="hero-note gallery-pulse"><span class="live-dot"></span><small>Curated for your next watch</small></div>
        </div>
        <div class="hero-stage" bind:this={galleryStack} aria-label="Six featured titles">
          <div class="hero-poster-stack gallery-stack">
            {#each gallerySlides as slide, index}
              <article class:active={index === galleryIndex} class:outgoing={galleryAnimating && index === departingGalleryIndex} class="hero-poster gallery-card" data-gallery-card aria-hidden="true">
                <div class="hero-poster-image" style={`background-image: url(${JSON.stringify(slide.item.backdrop || slide.item.poster)})`}></div>
                <div class="hero-poster-overlay"></div>
                <div class="hero-poster-meta gallery-card-index"><span>{slide.category}</span><small>{String(index + 1).padStart(2, '0')}</small></div>
              </article>
            {/each}
          </div>
          <div class="hero-controls gallery-controls" aria-label="Featured title controls">
            <button class="hero-arrow gallery-arrow" type="button" aria-label="Previous title" onclick={() => { pauseGallery(); changeGallerySlide((galleryIndex - 1 + gallerySlides.length) % gallerySlides.length); }}><ArrowLeft size={15} /></button>
            <div class="hero-dots gallery-dots" role="tablist" aria-label="Choose featured title">
              {#each gallerySlides as slide, index}<button class:active={index === galleryIndex} class="hero-dot gallery-dot" type="button" role="tab" aria-selected={index === galleryIndex} aria-label={`Show ${slide.item.title}`} onclick={() => selectGallerySlide(index)}></button>{/each}
            </div>
            <button class="hero-arrow gallery-arrow" type="button" aria-label="Next title" onclick={() => { pauseGallery(); changeGallerySlide((galleryIndex + 1) % gallerySlides.length); }}><ArrowRight size={15} /></button>
          </div>
        </div>
      </div>
    </section>
  {/if}

  <div class="container-wide main-content">
    {#if errorMessage}<div class="catalog-warning" role="alert">{errorMessage}</div>{/if}
    {#if hasCatalog}
      <nav class="discover-routes" aria-label="Explore MAVERO">
        <div class="route-copy"><span class="eyebrow">Start exploring</span><strong>Find a world that feels like yours.</strong></div>
        <div class="route-links"><a href="/discover/movies"><span>Movies</span><small>Latest releases</small><ArrowRight size={13} /></a><a href="/discover/series"><span>Series</span><small>Longer stories</small><ArrowRight size={13} /></a><a href="/discover/anime"><span>Anime</span><small>Another world</small><ArrowRight size={13} /></a></div>
      </nav>
      {#if localContinue.length}<ContentRail title="Continue watching" eyebrow="Your current rotation" items={localContinue} href="/my-list?status=watching" compact variant="editorial" />{/if}
      {#if movies.length}<ContentRail title="Trending tonight" eyebrow="What is finding an audience" items={movies} href="/discover/movies" variant="editorial" />{/if}
      {#if series.length}<ContentRail title="Stories worth staying for" eyebrow="Series with room to unfold" items={series} href="/discover/series" variant="editorial" />{/if}
      {#if anime.length}<ContentRail title="From another world" eyebrow="Animation beyond the expected" items={anime} href="/discover/anime" variant="editorial" />{/if}
      {#if popularMovies.length}<ContentRail title="The essential watchlist" eyebrow="Popular movies, carefully chosen" items={popularMovies} href="/discover/movies" variant="editorial" />{/if}
      {#if popularSeries.length}<ContentRail title="Binge-worthy worlds" eyebrow="Keep the night going" items={popularSeries} href="/discover/series" variant="editorial" />{/if}
      {#if popularAnime.length}<ContentRail title="Fan favourites" eyebrow="Made for the deep dive" items={popularAnime} href="/discover/anime" variant="editorial" />{/if}
    {:else}
      <EmptyState eyebrow="MAVERO / Catalog unavailable" title="The shelves are quiet." message="The live catalog is temporarily unavailable. Please try again in a moment." actionLabel="Retry Discover" actionHref="/discover" />
    {/if}
    <footer class="footer"><strong>MAVERO</strong><span>Stories worth staying for.</span></footer>
  </div>
</div>

{#if navigatingAway}<RouteLoading />{/if}

<style>
  .editorial-hero { position: relative; min-height: min(720px, calc(100dvh - 78px)); overflow: hidden; border-bottom: 1px solid var(--line); background: var(--base); }
  .hero-backdrop { position: absolute; inset: -4%; background-position: center; background-size: cover; filter: saturate(.63) blur(1px); opacity: .42; transform: scale(1.04); transition: opacity var(--motion-slow) var(--ease-out), background-image var(--motion-slow) var(--ease-out); }
  .hero-wash { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(9,10,11,.98) 0%, rgba(9,10,11,.88) 36%, rgba(9,10,11,.4) 68%, rgba(9,10,11,.72) 100%), linear-gradient(0deg, var(--base) 0%, transparent 42%); }
  .hero-inner { position: relative; z-index: 2; display: grid; grid-template-columns: minmax(0, .82fr) minmax(420px, 1.18fr); align-items: center; gap: clamp(32px, 7vw, 110px); min-height: min(720px, calc(100dvh - 78px)); padding-top: 48px; padding-bottom: 48px; }
  .hero-copy { max-width: 555px; }
  .hero-kicker { display: inline-flex; align-items: center; gap: 9px; color: var(--accent-strong); font-family: 'DM Mono', monospace; font-size: .6rem; letter-spacing: .13em; text-transform: uppercase; }
  .hero-kicker span { width: 28px; height: 1px; background: var(--accent); }
  .hero-category { margin-top: 31px; color: var(--secondary); font-family: 'DM Mono', monospace; font-size: .58rem; letter-spacing: .12em; text-transform: uppercase; }
  .hero-copy h1 { max-width: 640px; margin: 14px 0 14px; color: var(--ink); font-family: 'Cormorant Garamond', Georgia, serif; font-size: clamp(4.2rem, 7.2vw, 8rem); font-weight: 600; letter-spacing: -.07em; line-height: .76; text-wrap: balance; }
  .hero-copy p { max-width: 500px; margin: 0; color: var(--ink-soft); font-size: .88rem; line-height: 1.7; text-wrap: pretty; }
  .hero-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 21px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .57rem; }
  .hero-meta strong { color: var(--ink); }
  .hero-meta i { width: 3px; height: 3px; border-radius: 50%; background: var(--muted-deep); }
  .hero-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 27px; }
  .hero-note { display: inline-flex; align-items: center; gap: 8px; margin-top: 31px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .54rem; letter-spacing: .05em; text-transform: uppercase; }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--secondary); box-shadow: 0 0 0 5px var(--secondary-soft); }
  .hero-stage { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; }
  .hero-poster-stack { position: relative; width: min(100%, 790px); aspect-ratio: 1.48; isolation: isolate; transform: rotate(-1deg); }
  .hero-poster { position: absolute; z-index: 1; inset: 0; overflow: hidden; border: 1px solid rgba(245,241,232,.15); border-radius: var(--radius-xl); background: var(--surface); box-shadow: 0 32px 100px rgba(0,0,0,.48); pointer-events: none; transform-origin: 50% 86%; will-change: transform, opacity; }
  .hero-poster.active { border-color: rgba(240,190,104,.62); box-shadow: 0 34px 110px rgba(0,0,0,.55), 0 0 0 1px rgba(240,190,104,.08); }
  .hero-poster-image, .hero-poster-overlay { position: absolute; inset: 0; }
  .hero-poster-image { background-position: center; background-size: cover; filter: saturate(.86) contrast(1.02); transition: transform 900ms var(--ease-out); }
  .hero-poster.active .hero-poster-image { transform: scale(1.018); }
  .hero-poster-overlay { background: linear-gradient(180deg, rgba(9,10,11,.06) 10%, rgba(9,10,11,.12) 48%, rgba(9,10,11,.82) 100%), linear-gradient(92deg, rgba(9,10,11,.25), transparent 60%); }
  .hero-poster-meta { position: absolute; top: 22px; right: 24px; left: 24px; display: flex; justify-content: space-between; color: rgba(245,241,232,.78); font-family: 'DM Mono', monospace; font-size: .55rem; letter-spacing: .12em; text-transform: uppercase; }
  .hero-poster-meta span { color: var(--accent-strong); }
  .hero-controls { position: relative; z-index: 30; display: flex; align-items: center; justify-content: center; gap: 15px; margin-top: 19px; }
  .hero-arrow { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid rgba(245,241,232,.18); border-radius: 50%; color: var(--ink); background: rgba(9,10,11,.58); backdrop-filter: blur(12px); transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .hero-arrow:hover, .hero-arrow:focus-visible { border-color: rgba(240,190,104,.66); color: var(--accent-strong); background: var(--accent-soft); transform: translateY(-1px); outline: 0; }
  .hero-dots { display: flex; align-items: center; gap: 6px; }
  .hero-dot { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 999px; background: rgba(245,241,232,.26); transition: width var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .hero-dot:hover, .hero-dot:focus-visible { background: rgba(245,241,232,.7); outline: 0; }
  .hero-dot.active { width: 24px; background: var(--accent-strong); }
  .discover-routes { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin: 0 0 38px; padding: 18px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .route-copy { display: grid; gap: 4px; }
  .route-copy strong { color: var(--ink); font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.4rem; font-weight: 600; letter-spacing: -.025em; }
  .route-links { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .route-links a { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 3px 13px; min-width: 132px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); text-decoration: none; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .route-links a:hover { border-color: rgba(240,190,104,.5); background: var(--accent-soft); transform: translateY(-2px); }
  .route-links a span { font-size: .7rem; font-weight: 800; }
  .route-links a small { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .5rem; }
  .route-links a :global(svg) { grid-row: 1 / span 2; grid-column: 2; color: var(--accent-strong); }
  .catalog-warning { margin: 14px 0 0; padding: 11px 13px; border: 1px solid rgba(226,177,112,.35); color: var(--warning); font-family: 'DM Mono', monospace; font-size: .62rem; line-height: 1.5; }
  @media (max-width: 1050px) { .hero-inner { grid-template-columns: minmax(0, .78fr) minmax(340px, 1.22fr); gap: 34px; } .hero-copy h1 { font-size: clamp(4rem, 7vw, 6.4rem); } }
  @media (max-width: 720px) { .editorial-hero { min-height: auto; } .hero-inner { display: flex; flex-direction: column; align-items: stretch; min-height: auto; gap: 24px; padding-top: 94px; padding-bottom: 30px; } .hero-stage { order: 1; padding: 0 7px; } .hero-poster-stack { width: min(88vw, 410px); aspect-ratio: .92; } .hero-poster { border-radius: 21px; } .hero-copy { order: 2; max-width: none; } .hero-category { margin-top: 22px; } .hero-copy h1 { max-width: 340px; margin-top: 10px; font-size: clamp(3.25rem, 17vw, 5rem); line-height: .8; } .hero-copy p { max-width: 360px; font-size: .8rem; line-height: 1.58; } .hero-meta { margin-top: 15px; font-size: .54rem; } .hero-actions { margin-top: 19px; } .hero-note { margin-top: 21px; } .discover-routes { align-items: stretch; flex-direction: column; gap: 14px; margin-bottom: 30px; } .route-links { gap: 6px; } .route-links a { min-width: 0; padding: 9px 8px; } .route-links a small { display: none; } .route-links a span { font-size: .63rem; } .route-links a :global(svg) { width: 12px; } }
  @media (prefers-reduced-motion: reduce) { .hero-backdrop, .hero-poster-image, .route-links a, .hero-arrow { transition: none; transform: none; } }
  /* Compatibility hooks retained for the existing discovery contract: gallery-copy, gallery-card-index, gallery-actions, gallery-controls, gallery-dots, gallery-ambient, gallery-pulse, gallery-main, and gallery-stack. */
  /* class="gallery-copy" class="gallery-ambient" class="gallery-pulse" */
  /* Existing contract signatures: .gallery-main { display: grid; grid-template-columns: ... } .gallery-stack { position: relative; width: min(100%, 900px); aspect-ratio: 1.62; } @media (max-width: 1100px) and (min-width: 701px) { } @media (max-width: 700px) { .gallery-stack { width: min(78vw, 310px); aspect-ratio: .88; } } */
</style>
