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

  type GalleryCategory = 'Movie' | 'Series' | 'Anime';
  type GallerySlide = { item: MediaItem; category: GalleryCategory };
  type GallerySlot = { depth: number; x: number; y: number; scale: number; rotation: number };

  const GALLERY_ROTATION_MS = 3000;
  const GALLERY_TRANSITION_MS = 720;

  let localContinueLoaded = false;
  let localContinueItems: MediaItem[] = [];
  let intro: HTMLElement;
  let galleryIndex = 0;
  let galleryAnimating = false;
  let departingGalleryIndex = -1;
  let galleryPaused = false;
  let reducedMotion = false;
  let galleryRotationTimer: ReturnType<typeof setTimeout> | undefined;
  let galleryTransitionTimer: ReturnType<typeof setTimeout> | undefined;

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
    const sequence: GalleryCategory[] = ['Movie', 'Series', 'Anime', 'Movie', 'Series', 'Anime'];
    return sequence.flatMap((category, position) => {
      const pool = pools[category];
      const item = pool[position < 3 ? 0 : 1] ?? pool[0];
      return item ? [{ item, category }] : [];
    });
  }

  $: localContinue = localContinueLoaded ? localContinueItems : continueItems;
  $: hasCatalog = Boolean(featuredItem || localContinue.length || movies.length || series.length || anime.length || popularMovies.length || popularSeries.length || popularAnime.length);
  $: gallerySlides = createGallerySlides([...popularMovies, ...movies], [...popularSeries, ...series], [...popularAnime, ...anime]);
  $: activeGallerySlide = gallerySlides[galleryIndex] ?? null;
  $: if (gallerySlides.length && galleryIndex >= gallerySlides.length) galleryIndex = 0;

  function gallerySlot(index: number): GallerySlot {
    const depth = gallerySlides.length ? (index - galleryIndex + gallerySlides.length) % gallerySlides.length : 0;
    const visibleDepth = Math.min(depth, 5);
    return {
      depth: visibleDepth,
      x: visibleDepth * 8,
      y: visibleDepth * 13,
      scale: 1 - visibleDepth * 0.035,
      rotation: visibleDepth === 0 ? 0 : (visibleDepth % 2 ? 1.15 : -0.8) * (visibleDepth > 3 ? 0.65 : 1)
    };
  }

  function clearGalleryTimers() {
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    if (galleryTransitionTimer) clearTimeout(galleryTransitionTimer);
    galleryRotationTimer = undefined;
    galleryTransitionTimer = undefined;
  }

  function queueGalleryRotation() {
    if (gallerySlides.length !== 6 || galleryPaused) return;
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    galleryRotationTimer = setTimeout(() => {
      galleryRotationTimer = undefined;
      if (galleryPaused || galleryAnimating) {
        queueGalleryRotation();
        return;
      }
      departingGalleryIndex = galleryIndex;
      galleryIndex = (galleryIndex + 1) % gallerySlides.length;
      galleryAnimating = true;
      galleryTransitionTimer = setTimeout(() => {
        departingGalleryIndex = -1;
        galleryAnimating = false;
        galleryTransitionTimer = undefined;
        queueGalleryRotation();
      }, GALLERY_TRANSITION_MS);
    }, GALLERY_ROTATION_MS);
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
    departingGalleryIndex = galleryIndex;
    galleryIndex = index;
    galleryAnimating = true;
    galleryTransitionTimer = setTimeout(() => {
      departingGalleryIndex = -1;
      galleryAnimating = false;
      galleryTransitionTimer = undefined;
      resumeGallery();
    }, GALLERY_TRANSITION_MS);
  }

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
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || !intro) return;
    gsap.fromTo(intro.querySelectorAll('[data-reveal]'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.42, stagger: 0.045, ease: 'power2.out' });
  });

  onMount(() => {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    queueGalleryRotation();
    return clearGalleryTimers;
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
  {#if gallerySlides.length === 6 && activeGallerySlide}
    <section class:reduced-motion={reducedMotion} class="gallery-hero" aria-labelledby="gallery-title" onpointerenter={pauseGallery} onpointerleave={resumeGallery} onfocusin={pauseGallery} onfocusout={resumeGallery}>
      <div class="gallery-backdrop" style={`background-image: url(${JSON.stringify(activeGallerySlide.item.backdrop || activeGallerySlide.item.poster)})`}></div>
      <div class="gallery-wash"></div>
      <div class="container-wide gallery-content">
        <div class="gallery-copy" aria-live="polite">
          <div class="hero-topline" data-reveal><div class="hero-kicker"><Sparkles size={13} /> Trending Gallery</div><span class="hero-count">{String(galleryIndex + 1).padStart(2, '0')} / 06</span></div>
          <div class="gallery-category" data-reveal>{activeGallerySlide.category} / Trending now</div>
          <h1 id="gallery-title" data-reveal>{activeGallerySlide.item.title}</h1>
          <p class="hero-description" data-reveal>{activeGallerySlide.item.description}</p>
          <div class="meta-row" data-reveal><strong>{activeGallerySlide.item.year}</strong><span class="dot"></span><span>{activeGallerySlide.item.runtime}</span><span class="dot"></span><span>{activeGallerySlide.item.maturity}</span><span class="dot"></span><span>{activeGallerySlide.item.genres.slice(0, 2).join(' · ')}</span></div>
          <div class="hero-actions" data-reveal><a class="btn btn-primary" href={`/watch/${activeGallerySlide.item.type}/${activeGallerySlide.item.id}`}><Play size={15} fill="currentColor" /> Watch now</a><a class="btn btn-secondary" href={`/${activeGallerySlide.item.type}/${activeGallerySlide.item.id}`}>View details <ArrowRight size={14} /></a></div>
          <div class="gallery-pagination" aria-label="Trending Gallery slides">
            {#each gallerySlides as slide, index}
              <button class:active={index === galleryIndex} type="button" aria-label={`Show ${slide.category}: ${slide.item.title}`} aria-current={index === galleryIndex ? 'true' : undefined} onclick={() => selectGallerySlide(index)}><span></span></button>
            {/each}
          </div>
        </div>
        <div class="gallery-stage" aria-label="Six trending titles">
          <div class="gallery-stack">
            {#each gallerySlides as slide, index}
              {@const slot = gallerySlot(index)}
              <a class:active={index === galleryIndex} class:outgoing={galleryAnimating && index === departingGalleryIndex} class="gallery-card" href={`/${slide.item.type}/${slide.item.id}`} tabindex={index === galleryIndex ? 0 : -1} aria-label={`Open details for ${slide.item.title}`} aria-hidden={index === galleryIndex ? undefined : 'true'} style={`--slot-x: ${slot.x}px; --slot-y: ${slot.y}px; --slot-scale: ${slot.scale}; --slot-rotation: ${slot.rotation}deg; --slot-depth: ${slot.depth};`}>
                <div class="gallery-card-image" style={`background-image: url(${JSON.stringify(slide.item.backdrop || slide.item.poster)})`}></div>
                <div class="gallery-card-shade"></div>
                <div class="gallery-card-label"><span>{slide.category}</span><strong>{slide.item.title}</strong></div>
              </a>
            {/each}
          </div>
          <div class="gallery-shadow" aria-hidden="true"></div>
        </div>
      </div>
    </section>
  {:else if featuredItem}
    <section class="gallery-fallback" aria-labelledby="gallery-fallback-title">
      <div class="container-wide gallery-fallback-inner">
        <div><div class="hero-kicker"><Sparkles size={13} /> Trending Gallery</div><h1 id="gallery-fallback-title">Preparing the trending stack.</h1><p>We’re waiting for one complete title from each catalog so the gallery can stay real and balanced.</p></div>
        <a class="btn btn-secondary" href={`/${featuredItem.type}/${featuredItem.id}`}>Open featured title <ArrowRight size={14} /></a>
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
  .gallery-hero { position: relative; min-height: min(700px, 78dvh); overflow: hidden; border-bottom: 1px solid rgba(243,240,233,.08); background: var(--base); }
  .gallery-backdrop, .gallery-wash { position: absolute; inset: 0; pointer-events: none; }
  .gallery-backdrop { background-position: center; background-size: cover; filter: saturate(.76); opacity: .46; transform: scale(1.04); transition: background-image 500ms ease-out; }
  .gallery-wash { background: linear-gradient(90deg, rgba(8,12,13,.98) 0%, rgba(8,12,13,.88) 34%, rgba(8,12,13,.42) 66%, rgba(8,12,13,.72) 100%), linear-gradient(180deg, rgba(8,12,13,.18), var(--base) 98%); }
  .gallery-content { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0, .82fr) minmax(400px, .95fr); align-items: center; gap: clamp(30px, 7vw, 100px); min-height: min(700px, 78dvh); padding-top: 68px; padding-bottom: 52px; }
  .gallery-copy { max-width: 560px; padding-top: 22px; }
  .gallery-category { margin-top: 28px; color: var(--secondary); font-family: 'DM Mono', monospace; font-size: .58rem; letter-spacing: .09em; text-transform: uppercase; }
  .gallery-copy h1 { max-width: 600px; margin: 10px 0 13px; font-family: 'Space Grotesk', sans-serif; font-size: clamp(2.6rem, 5.2vw, 5.3rem); line-height: .9; letter-spacing: -.085em; text-wrap: balance; }
  .gallery-copy .hero-description { max-width: 510px; margin: 0; color: rgba(243,240,233,.68); font-size: .82rem; line-height: 1.65; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .gallery-copy .meta-row { margin-top: 18px; }
  .gallery-copy .hero-actions { margin-top: 22px; }
  .gallery-pagination { display: flex; align-items: center; gap: 7px; margin-top: 34px; }
  .gallery-pagination button { display: grid; place-items: center; width: 28px; height: 24px; border: 0; padding: 0; background: transparent; cursor: pointer; }
  .gallery-pagination button span { display: block; width: 17px; height: 3px; border-radius: 99px; background: rgba(243,240,233,.25); transition: width 180ms var(--ease-out), background 180ms var(--ease-out); }
  .gallery-pagination button:hover span, .gallery-pagination button:focus-visible span { background: var(--ink); }
  .gallery-pagination button.active span { width: 28px; background: var(--accent-strong); }
  .gallery-stage { position: relative; display: grid; place-items: center; min-height: 560px; }
  .gallery-stack { position: relative; width: min(100%, 480px); aspect-ratio: .72; isolation: isolate; }
  .gallery-card { position: absolute; z-index: calc(20 - var(--slot-depth)); inset: 0; display: block; overflow: hidden; border: 1px solid rgba(243,240,233,.17); border-radius: 24px; background: var(--surface); box-shadow: 0 24px 70px rgba(0,0,0,.28); pointer-events: none; transform: translate3d(var(--slot-x), var(--slot-y), 0) scale(var(--slot-scale)) rotate(var(--slot-rotation)); opacity: calc(1 - (var(--slot-depth) * .105)); transform-origin: 50% 80%; transition: transform 720ms var(--ease-in-out), opacity 520ms ease-out, box-shadow 240ms ease-out, border-color 240ms ease-out; }
  .gallery-card.active { pointer-events: auto; border-color: rgba(212,168,106,.52); box-shadow: 0 30px 90px rgba(0,0,0,.42), 0 0 0 1px rgba(212,168,106,.1); }
  .gallery-card.active:hover, .gallery-card.active:focus-visible { border-color: var(--accent-strong); box-shadow: 0 34px 100px rgba(0,0,0,.5), 0 0 0 4px rgba(212,168,106,.11); outline: 0; }
  .gallery-card.outgoing { --slot-x: -10px; --slot-y: 58px; --slot-scale: .92; --slot-rotation: -4.2deg; --slot-depth: 6; pointer-events: none; }
  .gallery-card-image, .gallery-card-shade { position: absolute; inset: 0; }
  .gallery-card-image { background-position: center; background-size: cover; filter: saturate(.88); transition: transform 720ms var(--ease-in-out); }
  .gallery-card.active:hover .gallery-card-image, .gallery-card.active:focus-visible .gallery-card-image { transform: scale(1.035); }
  .gallery-card-shade { background: linear-gradient(180deg, rgba(4,8,9,.06) 40%, rgba(4,8,9,.82) 100%); }
  .gallery-card-label { position: absolute; right: 20px; bottom: 20px; left: 20px; display: grid; gap: 5px; }
  .gallery-card-label span { color: var(--accent-strong); font-family: 'DM Mono', monospace; font-size: .56rem; letter-spacing: .1em; text-transform: uppercase; }
  .gallery-card-label strong { color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: clamp(1.05rem, 2vw, 1.4rem); letter-spacing: -.045em; }
  .gallery-shadow { position: absolute; z-index: -1; right: -4%; bottom: -4%; left: 9%; height: 18%; border-radius: 50%; background: rgba(0,0,0,.42); filter: blur(25px); }
  .gallery-fallback { min-height: 350px; border-bottom: 1px solid var(--line); background: radial-gradient(circle at 80% 40%, rgba(212,168,106,.11), transparent 26rem), var(--base); }
  .gallery-fallback-inner { display: flex; align-items: end; justify-content: space-between; gap: 24px; min-height: 350px; padding-top: 80px; padding-bottom: 50px; }
  .gallery-fallback h1 { max-width: 540px; margin: 10px 0 8px; font-family: 'Space Grotesk', sans-serif; font-size: clamp(2.4rem, 5vw, 4.5rem); line-height: .92; letter-spacing: -.08em; }
  .gallery-fallback p { max-width: 450px; margin: 0; color: var(--muted); font-size: .8rem; line-height: 1.6; }
  .gallery-fallback .btn { flex: 0 0 auto; }
  .gallery-hero.reduced-motion .gallery-card { transform: none !important; opacity: 0; transition: opacity 180ms ease-out; }
  .gallery-hero.reduced-motion .gallery-card.active { opacity: 1; }
  .hero-count { color: rgba(243,240,233,.5); font-family: 'DM Mono', monospace; font-size: .56rem; letter-spacing: .1em; text-transform: uppercase; }
  .catalog-warning { margin: 14px 0 0; padding: 11px 13px; border: 1px solid rgba(224,174,114,.35); color: var(--warning); font-family: 'DM Mono', monospace; font-size: .62rem; line-height: 1.5; }
  .footer { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 38px 0 20px; text-align: center; }
  .footer strong { color: var(--ink); letter-spacing: .18em; }
  .footer span { color: var(--muted-deep); }
  @media (max-width: 900px) { .gallery-content { grid-template-columns: minmax(0, .9fr) minmax(320px, .8fr); gap: 28px; } .gallery-stage { min-height: 480px; } }
  @media (max-width: 700px) { .gallery-hero { min-height: auto; } .gallery-content { display: flex; flex-direction: column-reverse; align-items: stretch; gap: 8px; min-height: auto; padding-top: 84px; padding-bottom: 36px; } .gallery-stage { min-height: 0; padding: 8px 14px 0; } .gallery-stack { width: min(100%, 315px); } .gallery-copy { max-width: none; padding: 4px 0 0; } .gallery-category { margin-top: 20px; } .gallery-copy h1 { font-size: clamp(2.45rem, 12vw, 4.1rem); } .gallery-copy .hero-description { -webkit-line-clamp: 2; line-clamp: 2; } .gallery-pagination { margin-top: 25px; } .gallery-backdrop { opacity: .32; } .gallery-wash { background: linear-gradient(180deg, rgba(8,12,13,.64) 0%, rgba(8,12,13,.92) 43%, var(--base) 82%); } .gallery-fallback-inner { align-items: start; flex-direction: column; min-height: 360px; padding-top: 110px; } }
  @media (prefers-reduced-motion: reduce) { .gallery-backdrop, .gallery-card, .gallery-card-image, .gallery-pagination button span { transition: none; } }
</style>
