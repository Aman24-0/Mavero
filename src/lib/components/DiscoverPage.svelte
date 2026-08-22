<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getContinueWatching } from '$lib/client/progress/service';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { continueWatchingRecords } from '$lib/shared/progress-merge';
  import { progressToMedia } from '$lib/client/progress/presenter';
  import { navigating, page } from '$app/state';
  import { ArrowLeft, ArrowRight, Play, Sparkles } from 'lucide-svelte';
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
    const pools = {
      Movie: uniqueItems(movieItems),
      Series: uniqueItems(seriesItems),
      Anime: uniqueItems(animeItems)
    } satisfies Record<GalleryCategory, MediaItem[]>;

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
    return {
      x: visibleDepth * 10,
      y: visibleDepth * 14,
      scale: 1 - visibleDepth * 0.028,
      rotation: visibleDepth === 0 ? 0 : (visibleDepth % 2 ? 0.32 : -0.24) * (visibleDepth > 3 ? 0.72 : 1),
      opacity: 1 - visibleDepth * 0.09,
      zIndex: 20 - visibleDepth
    };
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
    if (outgoing) {
      timeline.set(outgoing, { zIndex: 21 }, 0);
      timeline.set(outgoing, { zIndex: positionFor(fromIndex, toIndex).zIndex }, duration * 0.52);
    }
  }

  function queueGalleryRotation() {
    if (gallerySlides.length !== 6 || galleryPaused || galleryAnimating) return;
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    galleryRotationTimer = setTimeout(() => {
      galleryRotationTimer = undefined;
      if (galleryPaused || galleryAnimating) return;
      changeGallerySlide((galleryIndex + 1) % gallerySlides.length);
    }, GALLERY_ROTATION_MS);
  }

  function finishGalleryTransition() {
    departingGalleryIndex = -1;
    galleryAnimating = false;
    galleryTransitionTimer = undefined;
    if (!galleryPaused) queueGalleryRotation();
  }

  function changeGallerySlide(nextIndex: number) {
    if (gallerySlides.length !== 6 || galleryAnimating || nextIndex === galleryIndex) return;
    const fromIndex = galleryIndex;
    departingGalleryIndex = fromIndex;
    galleryIndex = nextIndex;
    galleryAnimating = true;
    void tick().then(() => animateStack(fromIndex, nextIndex));
    if (galleryTransitionTimer) clearTimeout(galleryTransitionTimer);
    galleryTransitionTimer = setTimeout(finishGalleryTransition, reducedMotion ? 180 : GALLERY_TRANSITION_MS);
  }

  function pauseGallery() {
    galleryPaused = true;
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    galleryRotationTimer = undefined;
  }

  function resumeGallery() {
    galleryPaused = false;
    if (!galleryAnimating) queueGalleryRotation();
  }

  function selectGallerySlide(index: number) {
    if (index === galleryIndex || galleryAnimating || gallerySlides.length !== 6) return;
    pauseGallery();
    changeGallerySlide(index);
  }

  function handleGalleryKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      pauseGallery();
      changeGallerySlide((galleryIndex + 1) % gallerySlides.length);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      pauseGallery();
      changeGallerySlide((galleryIndex - 1 + gallerySlides.length) % gallerySlides.length);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (galleryPaused) resumeGallery();
      else pauseGallery();
    }
  }

  onMount(() => {
    let cancelled = false;
    void (async () => {
      const loadContinue = async () => {
        if (page.data.user) {
          const cloud = await syncAuthenticatedState();
          return continueWatchingRecords(cloud.progress, cloud.favorites);
        }
        return getContinueWatching();
      };
      void loadContinue().then((records) => {
        if (cancelled) return;
        localContinueItems = records.map(progressToMedia);
        localContinueLoaded = true;
      });

      const { gsap } = await import('gsap');
      if (cancelled) return;
      animationEngine = gsap;
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      galleryCards = galleryStack ? Array.from(galleryStack.querySelectorAll<HTMLElement>('[data-gallery-card]')) : [];
      setInitialStack();
      if (!reducedMotion && intro) {
        gsap.fromTo(intro.querySelectorAll('[data-reveal]'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.42, stagger: 0.045, ease: 'power2.out' });
      }
      queueGalleryRotation();
    })();

    return () => {
      cancelled = true;
      clearGalleryTimers();
      if (animationEngine && galleryCards.length) animationEngine.killTweensOf(galleryCards);
      animationEngine = undefined;
    };
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
    <section class:reduced-motion={reducedMotion} class="gallery-hero" aria-labelledby="gallery-title" aria-roledescription="carousel" tabindex="0" onpointerenter={pauseGallery} onpointerleave={resumeGallery} onfocusin={pauseGallery} onfocusout={resumeGallery} onkeydown={handleGalleryKeydown}>
      <div class="gallery-ambient" aria-hidden="true" style={`background-image: url(${JSON.stringify(activeSlide.item.backdrop || activeSlide.item.poster)})`}></div>
      <div class="container-wide gallery-content">
        <div class="gallery-heading" data-reveal>
          <div class="hero-kicker"><Sparkles size={13} /> Mavero selects <span class="hero-kicker-rule"></span> Tonight</div>
          <span class="gallery-count">{String(galleryIndex + 1).padStart(2, '0')} / 06</span>
        </div>
        <div class="gallery-main">
          <div class="gallery-copy" data-gallery-copy data-reveal>
            <div class="gallery-category">{activeSlide.category} <span class="category-line"></span> Featured sequence</div>
            <h1>{activeSlide.item.title}</h1>
            <p>{activeSlide.item.description}</p>
            <div class="gallery-meta"><strong>{activeSlide.item.year}</strong><span class="dot"></span><span>{activeSlide.item.runtime}</span><span class="dot"></span><span>{activeSlide.item.maturity}</span><span class="dot"></span><span>{activeSlide.item.genres.slice(0, 2).join(' · ')}</span></div>
            <div class="gallery-actions"><a class="btn btn-primary" href={`/watch/${activeSlide.item.type}/${activeSlide.item.id}`}><Play size={14} fill="currentColor" /> Watch now</a><a class="btn btn-secondary" href={`/${activeSlide.item.type}/${activeSlide.item.id}`}>More details <ArrowRight size={13} /></a></div>
            <div class="gallery-pulse"><span></span><small>One story at a time</small></div>
          </div>
          <div bind:this={galleryStack} class="gallery-stage" aria-label="Six trending titles">
            <div class="gallery-stack">
              {#each gallerySlides as slide, index}
                <article class:active={index === galleryIndex} class:outgoing={galleryAnimating && index === departingGalleryIndex} class="gallery-card" data-gallery-card aria-hidden="true">
                  <div class="gallery-card-image" style={`background-image: url(${JSON.stringify(slide.item.backdrop || slide.item.poster)})`}></div>
                  <div class="gallery-card-shade"></div>
                  <div class="gallery-card-index"><span>{slide.category}</span><small>{String(index + 1).padStart(2, '0')}</small></div>
                </article>
              {/each}
            </div>
            <div class="gallery-shadow" aria-hidden="true"></div>
            <div class="gallery-controls" data-gallery-controls aria-label="Gallery controls">
              <button class="gallery-arrow" type="button" aria-label="Previous title" onclick={() => { pauseGallery(); changeGallerySlide((galleryIndex - 1 + gallerySlides.length) % gallerySlides.length); }}><ArrowLeft size={15} /></button>
              <div class="gallery-dots" role="tablist" aria-label="Choose trending title">
                {#each gallerySlides as slide, index}
                  <button class:active={index === galleryIndex} class="gallery-dot" type="button" role="tab" aria-selected={index === galleryIndex} aria-label={`Show ${slide.item.title}`} onclick={() => selectGallerySlide(index)}></button>
                {/each}
              </div>
              <button class="gallery-arrow" type="button" aria-label="Next title" onclick={() => { pauseGallery(); changeGallerySlide((galleryIndex + 1) % gallerySlides.length); }}><ArrowRight size={15} /></button>
            </div>
          </div>
        </div>
        <div id="gallery-title" class="sr-only">Trending Gallery</div>
      </div>
    </section>
  {/if}

  <div class="container-wide main-content">
    {#if errorMessage}<div class="catalog-warning" role="alert">{errorMessage}</div>{/if}
    {#if hasCatalog}
      <nav class="discover-explore" aria-label="Explore MAVERO">
        <div class="explore-heading"><span class="explore-eyebrow">Explore</span><strong>Find your next world</strong></div>
        <div class="explore-links">
          <a href="/discover/movies"><span>Movies</span><ArrowRight size={13} /></a>
          <a href="/discover/series"><span>Series</span><ArrowRight size={13} /></a>
          <a href="/discover/anime"><span>Anime</span><ArrowRight size={13} /></a>
        </div>
      </nav>
      {#if localContinue.length}<ContentRail title="Continue watching" eyebrow="Pick up where you left off" items={localContinue} href="/my-list?status=watching" compact variant="editorial" />{/if}
      {#if movies.length}<ContentRail title="Trending movies" eyebrow="What people are watching" items={movies} href="/discover/movies" variant="editorial" />{/if}
      {#if series.length}<ContentRail title="Trending shows" eyebrow="Stories worth staying for" items={series} href="/discover/series" variant="editorial" />{/if}
      {#if anime.length}<ContentRail title="Trending anime" eyebrow="From another world" items={anime} href="/discover/anime" variant="editorial" />{/if}
      {#if popularMovies.length}<ContentRail title="Popular movies" eyebrow="The essential watchlist" items={popularMovies} href="/discover/movies" variant="editorial" />{/if}
      {#if popularSeries.length}<ContentRail title="Popular series" eyebrow="Binge-worthy worlds" items={popularSeries} href="/discover/series" variant="editorial" />{/if}
      {#if popularAnime.length}<ContentRail title="Popular anime" eyebrow="Fan favourites" items={popularAnime} href="/discover/anime" variant="editorial" />{/if}
    {:else}
      <EmptyState eyebrow="MAVERO / Catalog unavailable" title="The shelves are quiet." message="The live catalog is temporarily unavailable. Please try again in a moment." actionLabel="Retry Discover" actionHref="/discover" />
    {/if}
    <footer class="footer"><strong>MAVERO</strong><span>Discover. Watch.</span></footer>
  </div>
</div>

{#if navigatingAway}<RouteLoading />{/if}

<style>
  .gallery-hero { position: relative; min-height: min(760px, calc(100dvh - 76px)); overflow: hidden; border-bottom: 1px solid rgba(244,241,234,.08); background: var(--base); }
  .gallery-hero::before { content: ''; position: absolute; inset: 0; z-index: 1; background: radial-gradient(circle at 74% 38%, rgba(214,163,93,.11), transparent 30rem), linear-gradient(90deg, rgba(9,10,12,.98) 0%, rgba(9,10,12,.78) 33%, rgba(9,10,12,.18) 76%, rgba(9,10,12,.7) 100%), linear-gradient(0deg, var(--base) 0%, transparent 40%); pointer-events: none; }
  .gallery-ambient { position: absolute; inset: -8%; z-index: 0; background-position: center; background-size: cover; filter: blur(48px) saturate(.72); opacity: .28; transform: scale(1.08); transition: opacity 700ms var(--ease-out), background-image 700ms var(--ease-out); }
  .gallery-ambient::after { content: ''; position: absolute; inset: 0; background: rgba(9,10,12,.32); }
  .gallery-content { position: relative; z-index: 2; display: flex; flex-direction: column; min-height: min(760px, calc(100dvh - 76px)); padding-top: clamp(28px, 4vw, 52px); padding-bottom: clamp(28px, 4vw, 52px); }
  .gallery-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: clamp(24px, 4vw, 42px); }
  .hero-kicker { display: inline-flex; align-items: center; gap: 9px; color: var(--accent-strong); font-family: 'DM Mono', monospace; font-size: .61rem; letter-spacing: .14em; text-transform: uppercase; }
  .hero-kicker-rule { width: 28px; height: 1px; background: var(--accent); opacity: .8; }
  .gallery-count { color: var(--muted); font-family: 'DM Mono', monospace; font-size: .6rem; letter-spacing: .1em; }
  .gallery-main { display: grid; grid-template-columns: minmax(250px, .76fr) minmax(0, 1.42fr); align-items: center; gap: clamp(38px, 7vw, 116px); flex: 1; min-height: 0; }
  .gallery-copy { max-width: 540px; padding-bottom: 10px; }
  .gallery-category { display: flex; align-items: center; gap: 10px; color: var(--secondary); font-family: 'DM Mono', monospace; font-size: .61rem; letter-spacing: .12em; text-transform: uppercase; }
  .category-line { width: 24px; height: 1px; background: var(--accent); }
  .gallery-copy h1 { max-width: 620px; margin: 20px 0 18px; color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: clamp(2.7rem, 5.4vw, 6.25rem); font-weight: 600; letter-spacing: -.085em; line-height: .9; text-wrap: balance; }
  .gallery-copy > p { display: -webkit-box; max-width: 520px; margin: 0; overflow: hidden; color: var(--ink-soft); font-size: clamp(.82rem, 1.1vw, .98rem); line-height: 1.68; text-wrap: pretty; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; }
  .gallery-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 22px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .58rem; }
  .gallery-meta strong { color: var(--ink); }
  .gallery-meta .dot { width: 3px; height: 3px; background: var(--muted-deep); }
  .gallery-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 28px; }
  .gallery-actions :global(.btn) { min-height: 46px; padding-inline: 18px; }
  .gallery-pulse { display: flex; align-items: center; gap: 9px; margin-top: 34px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .54rem; letter-spacing: .06em; text-transform: uppercase; }
  .gallery-pulse span { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 5px rgba(214,163,93,.1); }
  .gallery-stage { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; }
  .gallery-stack { position: relative; width: min(100%, 900px); aspect-ratio: 1.62; isolation: isolate; transform: rotate(-.7deg); }
  .gallery-card { position: absolute; z-index: 1; inset: 0; overflow: hidden; border: 1px solid rgba(244,241,234,.14); border-radius: var(--radius-xl); background: var(--surface); box-shadow: 0 30px 90px rgba(0,0,0,.42); pointer-events: none; transform-origin: 50% 86%; will-change: transform, opacity; }
  .gallery-card.active { border-color: rgba(240,194,127,.64); box-shadow: 0 34px 110px rgba(0,0,0,.54), 0 0 0 1px rgba(240,194,127,.1); }
  .gallery-card.outgoing { pointer-events: none; }
  .gallery-card-image, .gallery-card-shade { position: absolute; inset: 0; }
  .gallery-card-image { background-position: center; background-size: cover; filter: saturate(.84) contrast(1.04); transition: transform 900ms var(--ease-out); }
  .gallery-card.active .gallery-card-image { transform: scale(1.015); }
  .gallery-card-shade { background: linear-gradient(180deg, rgba(9,10,12,.06) 12%, rgba(9,10,12,.08) 48%, rgba(9,10,12,.85) 100%), linear-gradient(96deg, rgba(9,10,12,.34), transparent 58%); }
  .gallery-card-index { position: absolute; top: clamp(16px, 2vw, 28px); right: clamp(16px, 2vw, 28px); left: clamp(16px, 2vw, 28px); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .gallery-card-index span, .gallery-card-index small { color: rgba(244,241,234,.72); font-family: 'DM Mono', monospace; font-size: .56rem; letter-spacing: .12em; text-transform: uppercase; }
  .gallery-card-index span { color: var(--accent-strong); }
  .gallery-controls { position: relative; z-index: 30; display: flex; align-items: center; justify-content: center; gap: 15px; margin-top: 18px; }
  .gallery-arrow { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid rgba(244,241,234,.17); border-radius: 50%; color: var(--ink); background: rgba(9,10,12,.56); backdrop-filter: blur(12px); transition: color 180ms var(--ease-out), border-color 180ms var(--ease-out), background 180ms var(--ease-out), transform 180ms var(--ease-out); }
  .gallery-arrow:hover, .gallery-arrow:focus-visible { border-color: rgba(240,194,127,.65); color: var(--accent-strong); background: rgba(214,163,93,.1); transform: translateY(-1px); outline: 0; }
  .gallery-arrow:active { transform: scale(.96); }
  .gallery-dots { display: flex; align-items: center; gap: 6px; min-height: 10px; }
  .gallery-dot { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 999px; background: rgba(244,241,234,.25); transition: width 180ms var(--ease-out), background 180ms var(--ease-out), transform 180ms var(--ease-out); }
  .gallery-dot:hover, .gallery-dot:focus-visible { background: rgba(244,241,234,.72); outline: 0; }
  .gallery-dot.active { width: 24px; background: var(--accent-strong); }
  .gallery-shadow { position: absolute; z-index: -1; right: -8%; bottom: -4%; left: 8%; height: 14%; border-radius: 50%; background: rgba(0,0,0,.52); filter: blur(28px); }
  .discover-explore { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin: 0 0 36px; padding: 15px 0 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .explore-heading { display: grid; gap: 3px; }
  .explore-eyebrow { color: var(--accent-strong); font-family: 'DM Mono', monospace; font-size: .55rem; letter-spacing: .12em; text-transform: uppercase; }
  .explore-heading strong { color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: .92rem; letter-spacing: -.035em; }
  .explore-links { display: flex; align-items: center; gap: 9px; }
  .explore-links a { display: inline-flex; align-items: center; gap: 9px; min-height: 37px; padding: 0 12px; border: 1px solid rgba(244,241,234,.12); color: var(--muted); font-family: 'DM Mono', monospace; font-size: .58rem; letter-spacing: .04em; text-decoration: none; transition: color 180ms var(--ease-out), border-color 180ms var(--ease-out), background 180ms var(--ease-out), transform 180ms var(--ease-out); }
  .explore-links a:hover, .explore-links a:focus-visible { border-color: rgba(240,194,127,.52); background: rgba(214,163,93,.07); color: var(--ink); transform: translateY(-1px); outline: 0; }
  .catalog-warning { margin: 14px 0 0; padding: 11px 13px; border: 1px solid rgba(224,174,114,.35); color: var(--warning); font-family: 'DM Mono', monospace; font-size: .62rem; line-height: 1.5; }
  .footer { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 38px 0 20px; text-align: center; }
  .footer strong { color: var(--ink); letter-spacing: .18em; }
  .footer span { color: var(--muted-deep); }
  @media (max-width: 1100px) and (min-width: 701px) { .gallery-main { grid-template-columns: minmax(220px, .72fr) minmax(0, 1.28fr); gap: 34px; } .gallery-copy h1 { font-size: clamp(2.7rem, 5.6vw, 4.7rem); } .gallery-copy > p { font-size: .82rem; } .gallery-stack { width: min(100%, 640px); aspect-ratio: 1.42; } }
  @media (max-width: 700px) { .gallery-hero { min-height: auto; } .gallery-hero::before { background: linear-gradient(180deg, rgba(9,10,12,.18) 0%, rgba(9,10,12,.14) 30%, rgba(9,10,12,.86) 72%, var(--base) 100%); } .gallery-content { min-height: auto; gap: 0; padding-top: 78px; padding-bottom: 24px; } .gallery-heading { margin-bottom: 16px; } .hero-kicker { font-size: .55rem; } .hero-kicker-rule { width: 18px; } .gallery-main { display: flex; flex-direction: column; align-items: stretch; gap: 18px; } .gallery-stage { order: 1; padding: 0 8px; } .gallery-stack { width: min(78vw, 310px); aspect-ratio: .88; transform: rotate(-.35deg); } .gallery-card { border-radius: 22px; } .gallery-card-index { top: 15px; right: 16px; left: 16px; } .gallery-card-index span, .gallery-card-index small { font-size: .51rem; } .gallery-controls { margin-top: 10px; } .gallery-arrow { width: 38px; height: 38px; } .gallery-copy { order: 2; max-width: none; padding: 0 2px; } .gallery-category { font-size: .56rem; } .gallery-copy h1 { max-width: 340px; margin: 12px 0 10px; font-size: clamp(2.2rem, 12vw, 3.65rem); line-height: .92; } .gallery-copy > p { max-width: 340px; font-size: .78rem; line-height: 1.55; -webkit-line-clamp: 3; line-clamp: 3; } .gallery-meta { margin-top: 13px; font-size: .54rem; } .gallery-actions { margin-top: 17px; } .gallery-actions :global(.btn) { min-height: 42px; padding-inline: 14px; font-size: .67rem; } .gallery-pulse { margin-top: 18px; } .discover-explore { align-items: stretch; flex-direction: column; gap: 13px; margin-bottom: 30px; } .explore-links { width: 100%; } .explore-links a { flex: 1 1 0; justify-content: center; padding: 0 8px; } }
  @media (prefers-reduced-motion: reduce) { .gallery-ambient, .gallery-card-image, .explore-links a { transition: none; transform: none; } }
</style>
