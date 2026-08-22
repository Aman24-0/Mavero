<script lang="ts">
  import { onMount, tick } from 'svelte';
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

  type GalleryCategory = 'Movie' | 'Series' | 'Anime';
  type GallerySlide = { item: MediaItem; category: GalleryCategory };
  type CardPosition = { x: number; y: number; scale: number; rotation: number; opacity: number; zIndex: number };

  const GALLERY_ROTATION_MS = 3000;
  const GALLERY_TRANSITION_MS = 720;
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
  $: hasCatalog = Boolean(featuredItem || localContinue.length || movies.length || series.length || anime.length || popularMovies.length || popularSeries.length || popularAnime.length);
  $: gallerySlides = createGallerySlides([...popularMovies, ...movies], [...popularSeries, ...series], [...popularAnime, ...anime]);

  function positionFor(index: number, activeIndex: number): CardPosition {
    const depth = gallerySlides.length ? (index - activeIndex + gallerySlides.length) % gallerySlides.length : 0;
    const visibleDepth = Math.min(depth, 5);
    return {
      x: visibleDepth * 8,
      y: visibleDepth * 13,
      scale: 1 - visibleDepth * 0.035,
      rotation: visibleDepth === 0 ? 0 : (visibleDepth % 2 ? 1.15 : -0.8) * (visibleDepth > 3 ? 0.65 : 1),
      opacity: 1 - visibleDepth * 0.105,
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

    galleryCards.forEach((card, index) => {
      const start = positionFor(index, fromIndex);
      const end = positionFor(index, toIndex);
      animationEngine?.set(card, { ...start, zIndex: start.zIndex });
      animationEngine?.to(card, { ...end, duration, ease: reducedMotion ? 'power1.out' : 'power3.inOut', overwrite: true });
    });

    const incoming = galleryCards[toIndex];
    const outgoing = galleryCards[fromIndex];
    if (incoming) animationEngine.set(incoming, { zIndex: 20 });
    if (outgoing) animationEngine.set(outgoing, { zIndex: 14 });
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
  {#if gallerySlides.length === 6}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
    <section class:reduced-motion={reducedMotion} class="gallery-hero" aria-labelledby="gallery-title" aria-roledescription="carousel" tabindex="0" onpointerenter={pauseGallery} onpointerleave={resumeGallery} onfocusin={pauseGallery} onfocusout={resumeGallery} onkeydown={handleGalleryKeydown}>
      <div class="container-wide gallery-content">
        <div class="gallery-heading" data-reveal>
          <div class="hero-kicker"><Sparkles size={13} /> Trending Gallery</div>
          <span class="gallery-count">{String(galleryIndex + 1).padStart(2, '0')} / 06</span>
        </div>
        <div bind:this={galleryStack} class="gallery-stage" aria-label="Six trending titles">
          <div class="gallery-stack">
            {#each gallerySlides as slide, index}
              <article class:active={index === galleryIndex} class:outgoing={galleryAnimating && index === departingGalleryIndex} class="gallery-card" data-gallery-card aria-hidden={index === galleryIndex ? undefined : 'true'}>
                <div class="gallery-card-image" style={`background-image: url(${JSON.stringify(slide.item.backdrop || slide.item.poster)})`}></div>
                <div class="gallery-card-shade"></div>
                <div class="gallery-card-content">
                  <div class="gallery-card-topline"><span>{slide.category}</span><small>{String(index + 1).padStart(2, '0')} / 06</small></div>
                  <div class="gallery-card-copy">
                    <a class="gallery-card-title" href={`/${slide.item.type}/${slide.item.id}`} tabindex={index === galleryIndex ? 0 : -1}>{slide.item.title}</a>
                    <p>{slide.item.description}</p>
                    <div class="gallery-card-meta"><strong>{slide.item.year}</strong><span class="dot"></span><span>{slide.item.runtime}</span><span class="dot"></span><span>{slide.item.maturity}</span><span class="dot"></span><span>{slide.item.genres.slice(0, 2).join(' · ')}</span></div>
                    <div class="gallery-card-actions"><a class="btn btn-primary" href={`/watch/${slide.item.type}/${slide.item.id}`} tabindex={index === galleryIndex ? 0 : -1}><Play size={14} fill="currentColor" /> Watch now</a><a class="btn btn-secondary" href={`/${slide.item.type}/${slide.item.id}`} tabindex={index === galleryIndex ? 0 : -1}>Details <ArrowRight size={13} /></a></div>
                  </div>
                </div>
              </article>
            {/each}
          </div>
          <div class="gallery-shadow" aria-hidden="true"></div>
        </div>
        <p id="gallery-title" class="gallery-hint" data-reveal>Popular stories, physically stacked. Use the card actions to start watching or open details.</p>
      </div>
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
  .gallery-hero { position: relative; min-height: min(780px, 88dvh); overflow: hidden; border-bottom: 1px solid rgba(243,240,233,.08); background: radial-gradient(circle at 74% 34%, rgba(145,182,173,.12), transparent 27rem), radial-gradient(circle at 19% 82%, rgba(212,168,106,.08), transparent 24rem), var(--base); }
  .gallery-content { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(400px, 520px) minmax(0, 1fr); align-items: center; gap: 30px; min-height: min(780px, 88dvh); padding-top: 68px; padding-bottom: 48px; }
  .gallery-heading { display: flex; align-self: start; align-items: center; justify-content: space-between; gap: 18px; margin-top: 18px; }
  .hero-kicker { display: inline-flex; align-items: center; gap: 8px; color: var(--accent-strong); font-family: 'DM Mono', monospace; font-size: .58rem; letter-spacing: .1em; text-transform: uppercase; }
  .gallery-count { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; letter-spacing: .08em; }
  .gallery-stage { position: relative; display: grid; place-items: center; min-height: 630px; }
  .gallery-stack { position: relative; width: min(100%, 470px); aspect-ratio: .69; isolation: isolate; }
  .gallery-card { position: absolute; z-index: 1; inset: 0; display: block; overflow: hidden; border: 1px solid rgba(243,240,233,.15); border-radius: 26px; background: var(--surface); box-shadow: 0 24px 70px rgba(0,0,0,.32); pointer-events: none; transform-origin: 50% 82%; }
  .gallery-card.active { pointer-events: auto; border-color: rgba(212,168,106,.65); box-shadow: 0 32px 100px rgba(0,0,0,.5), 0 0 0 1px rgba(212,168,106,.12); }
  .gallery-card.active:focus-within { outline: 0; box-shadow: 0 32px 100px rgba(0,0,0,.5), 0 0 0 4px rgba(212,168,106,.13); }
  .gallery-card.outgoing { pointer-events: none; }
  .gallery-card-image, .gallery-card-shade { position: absolute; inset: 0; }
  .gallery-card-image { background-position: center; background-size: cover; filter: saturate(.86); }
  .gallery-card-shade { background: linear-gradient(180deg, rgba(4,8,9,.08) 18%, rgba(4,8,9,.22) 43%, rgba(4,8,9,.94) 100%), linear-gradient(100deg, rgba(4,8,9,.35), transparent 60%); }
  .gallery-card-content { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 20px; }
  .gallery-card-topline { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .gallery-card-topline span { color: var(--accent-strong); font-family: 'DM Mono', monospace; font-size: .56rem; letter-spacing: .1em; text-transform: uppercase; }
  .gallery-card-topline small { color: rgba(243,240,233,.55); font-family: 'DM Mono', monospace; font-size: .54rem; }
  .gallery-card-copy { max-width: 420px; }
  .gallery-card-title { display: block; color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: clamp(1.8rem, 3.4vw, 3rem); font-weight: 700; letter-spacing: -.075em; line-height: .95; text-decoration: none; text-wrap: balance; }
  .gallery-card-title:hover { color: var(--accent-strong); }
  .gallery-card-copy p { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 12px 0 0; color: rgba(243,240,233,.7); font-size: .72rem; line-height: 1.55; }
  .gallery-card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 14px; color: rgba(243,240,233,.67); font-family: 'DM Mono', monospace; font-size: .53rem; }
  .gallery-card-meta strong { color: var(--ink); }
  .gallery-card-meta .dot { width: 3px; height: 3px; background: rgba(243,240,233,.45); }
  .gallery-card-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .gallery-card-actions :global(.btn) { min-height: 37px; font-size: .67rem; }
  .gallery-hint { align-self: end; max-width: 230px; margin: 0; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .57rem; line-height: 1.55; }
  .gallery-shadow { position: absolute; z-index: -1; right: -7%; bottom: -4%; left: 7%; height: 14%; border-radius: 50%; background: rgba(0,0,0,.48); filter: blur(28px); }
  .catalog-warning { margin: 14px 0 0; padding: 11px 13px; border: 1px solid rgba(224,174,114,.35); color: var(--warning); font-family: 'DM Mono', monospace; font-size: .62rem; line-height: 1.5; }
  .footer { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 38px 0 20px; text-align: center; }
  .footer strong { color: var(--ink); letter-spacing: .18em; }
  .footer span { color: var(--muted-deep); }
  @media (max-width: 1040px) { .gallery-content { grid-template-columns: minmax(0, .4fr) minmax(360px, 500px) minmax(0, .4fr); gap: 20px; } .gallery-stage { min-height: 560px; } }
  @media (max-width: 700px) { .gallery-hero { min-height: auto; } .gallery-content { display: flex; flex-direction: column; align-items: stretch; gap: 10px; min-height: auto; padding-top: 84px; padding-bottom: 34px; } .gallery-heading { margin-top: 0; } .gallery-stage { min-height: 0; padding: 5px 8px 0; } .gallery-stack { width: min(84vw, 340px); } .gallery-card { border-radius: 22px; } .gallery-card-content { padding: 17px; } .gallery-card-title { font-size: clamp(1.85rem, 10vw, 2.7rem); } .gallery-card-copy p { -webkit-line-clamp: 2; line-clamp: 2; font-size: .68rem; } .gallery-card-actions :global(.btn) { min-height: 38px; } .gallery-hint { max-width: none; margin: 10px 0 0; } }
  @media (prefers-reduced-motion: reduce) { .gallery-card, .gallery-card-image { transition: none; } }
</style>
