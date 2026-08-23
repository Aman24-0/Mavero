<script lang="ts">
  import { onMount } from 'svelte';
  import { getContinueWatching } from '$lib/client/progress/service';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { continueWatchingRecords } from '$lib/shared/progress-merge';
  import { progressToMedia } from '$lib/client/progress/presenter';
  import { page } from '$app/state';
  import { ArrowLeft, ArrowRight, Info, ListPlus, Play } from 'lucide-svelte';
  import type { MediaItem } from '$lib/data/content';
  import { formatType } from '$lib/data/content';
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
  type FeaturedHeroItem = { item: MediaItem; category: GalleryCategory };

  const GALLERY_ROTATION_MS = 6500;
  const MAX_FEATURED_ITEMS = 6;

  let localContinueLoaded = false;
  let localContinueItems: MediaItem[] = [];
  let hero: HTMLElement;
  let activeIndex = 0;
  let galleryPaused = false;
  let galleryTransitioning = false;
  let reducedMotion = false;
  let imageLoadFailed = false;
  let galleryRotationTimer: ReturnType<typeof setTimeout> | undefined;
  let galleryTransitionTimer: ReturnType<typeof setTimeout> | undefined;
  let interactionReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  let transitionToken = 0;
  let destroyed = false;
  let motionQuery: MediaQueryList | undefined;

  function uniqueItems(items: MediaItem[]) {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function hasHeroImage(item: MediaItem) {
    return Boolean(item.backdrop?.trim() || item.poster?.trim());
  }

  function categoryFor(item: MediaItem): GalleryCategory {
    return item.type === 'movie' ? 'Movie' : item.type === 'series' ? 'Series' : 'Anime';
  }

  function createFeaturedItems(items: MediaItem[]): FeaturedHeroItem[] {
    return uniqueItems(items)
      .filter((item) => item.id.trim() && item.title.trim() && hasHeroImage(item))
      .slice(0, MAX_FEATURED_ITEMS)
      .map((item) => ({ item, category: categoryFor(item) }));
  }

  $: localContinue = localContinueLoaded ? localContinueItems : continueItems;
  $: hasCatalog = Boolean(featuredItem || localContinue.length || movies.length || series.length || anime.length || popularMovies.length || popularSeries.length || popularAnime.length);
  $: featuredItems = createFeaturedItems([
    ...(featuredItem ? [featuredItem] : []),
    ...movies,
    ...series,
    ...anime,
    ...popularMovies,
    ...popularSeries,
    ...popularAnime
  ]);
  $: if (activeIndex >= featuredItems.length && featuredItems.length) activeIndex = 0;
  $: activeHero = featuredItems[activeIndex];
  $: activeHeroImage = activeHero?.item.backdrop?.trim() || activeHero?.item.poster?.trim() || '';

  function clearGalleryTimers() {
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    if (galleryTransitionTimer) clearTimeout(galleryTransitionTimer);
    if (interactionReleaseTimer) clearTimeout(interactionReleaseTimer);
    galleryRotationTimer = undefined;
    galleryTransitionTimer = undefined;
    interactionReleaseTimer = undefined;
  }

  function queueGalleryRotation() {
    if (featuredItems.length < 2 || galleryPaused || galleryTransitioning || reducedMotion || destroyed) return;
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    galleryRotationTimer = setTimeout(() => {
      galleryRotationTimer = undefined;
      if (!galleryPaused && !galleryTransitioning && !document.hidden) {
        void changeGallerySlide((activeIndex + 1) % featuredItems.length);
      }
    }, GALLERY_ROTATION_MS);
  }

  function pauseGallery() {
    galleryPaused = true;
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    galleryRotationTimer = undefined;
  }

  function resumeGallery() {
    galleryPaused = false;
    if (!galleryTransitioning) queueGalleryRotation();
  }

  function releaseInteractionPause() {
    if (interactionReleaseTimer) clearTimeout(interactionReleaseTimer);
    interactionReleaseTimer = setTimeout(() => {
      interactionReleaseTimer = undefined;
      resumeGallery();
    }, GALLERY_ROTATION_MS * 2);
  }

  function preloadImage(url: string) {
    return new Promise<boolean>((resolve) => {
      if (!url) {
        resolve(false);
        return;
      }
      const image = new Image();
      image.onload = () => {
        if ('decode' in image) {
          void image.decode().catch(() => undefined).finally(() => resolve(true));
        } else {
          resolve(true);
        }
      };
      image.onerror = () => resolve(false);
      image.src = url;
    });
  }

  async function changeGallerySlide(nextIndex: number) {
    const nextHero = featuredItems[nextIndex];
    if (!nextHero || nextIndex === activeIndex || galleryTransitioning || featuredItems.length < 2) return;

    galleryTransitioning = true;
    pauseGallery();
    const token = ++transitionToken;
    const nextImage = nextHero.item.backdrop?.trim() || nextHero.item.poster?.trim() || '';
    const imageReady = await preloadImage(nextImage);
    if (destroyed || token !== transitionToken) return;

    imageLoadFailed = !imageReady;
    activeIndex = nextIndex;

    if (reducedMotion) {
      galleryTransitioning = false;
      resumeGallery();
      return;
    }

    if (galleryTransitionTimer) clearTimeout(galleryTransitionTimer);
    galleryTransitionTimer = setTimeout(() => {
      galleryTransitionTimer = undefined;
      galleryTransitioning = false;
      if (!galleryPaused) queueGalleryRotation();
    }, 220);
  }

  function selectGallerySlide(index: number) {
    if (index === activeIndex) {
      pauseGallery();
      releaseInteractionPause();
      return;
    }
    pauseGallery();
    releaseInteractionPause();
    void changeGallerySlide(index);
  }

  function handleGalleryKeydown(event: KeyboardEvent) {
    if (!featuredItems.length) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      pauseGallery();
      releaseInteractionPause();
      void changeGallerySlide((activeIndex + 1) % featuredItems.length);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      pauseGallery();
      releaseInteractionPause();
      void changeGallerySlide((activeIndex - 1 + featuredItems.length) % featuredItems.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      pauseGallery();
      releaseInteractionPause();
      void changeGallerySlide(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      pauseGallery();
      releaseInteractionPause();
      void changeGallerySlide(featuredItems.length - 1);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (galleryPaused) resumeGallery();
      else pauseGallery();
    }
  }

  function handleDocumentVisibility() {
    if (document.hidden) {
      if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
      galleryRotationTimer = undefined;
    } else if (!galleryPaused && !galleryTransitioning) {
      queueGalleryRotation();
    }
  }

  function handleMotionChange(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
    if (reducedMotion) {
      if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
      galleryRotationTimer = undefined;
    } else if (!galleryPaused && !galleryTransitioning) {
      queueGalleryRotation();
    }
  }

  onMount(() => {
    destroyed = false;
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = motionQuery.matches;
    motionQuery.addEventListener?.('change', handleMotionChange);
    document.addEventListener('visibilitychange', handleDocumentVisibility);

    let cancelled = false;
    const loadContinue = async () => {
      try {
        if (page.data.user) {
          const cloud = await syncAuthenticatedState();
          return continueWatchingRecords(cloud.progress, cloud.favorites);
        }
        return getContinueWatching();
      } catch {
        return [];
      }
    };

    void loadContinue().then((records) => {
      if (cancelled) return;
      localContinueItems = records.map(progressToMedia);
      localContinueLoaded = true;
    });

    queueGalleryRotation();

    return () => {
      cancelled = true;
      destroyed = true;
      transitionToken += 1;
      clearGalleryTimers();
      motionQuery?.removeEventListener?.('change', handleMotionChange);
      document.removeEventListener('visibilitychange', handleDocumentVisibility);
    };
  });
</script>

<svelte:head>
  <title>Mavero — Movies, series &amp; anime, all in one place</title>
  <meta name="description" content="Stream movies, series, and anime on MAVERO." />
  <link rel="canonical" href={page.url.origin} />
  <meta property="og:title" content="Mavero — Movies, series & anime, all in one place" />
  <meta property="og:description" content="A fast, modern home for your next watch." />
  <meta property="og:url" content={page.url.origin} />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary" />
</svelte:head>

<div class="discover-page">
  {#if activeHero}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
    <section
      bind:this={hero}
      class="hero"
      class:transitioning={galleryTransitioning}
      aria-roledescription="carousel"
      aria-label="Featured titles"
      tabindex="0"
      onpointerenter={pauseGallery}
      onpointerleave={resumeGallery}
      onfocusin={pauseGallery}
      onfocusout={(event) => { if (!hero?.contains(event.relatedTarget as Node | null)) resumeGallery(); }}
      onkeydown={handleGalleryKeydown}
    >
      <div class="hero-media" aria-hidden="true">
        {#if activeHeroImage && !imageLoadFailed}
          <picture>
            <source media="(max-width: 640px)" srcset={activeHero.item.backdropSmall || activeHeroImage} />
            <img
              class="hero-image"
              src={activeHeroImage}
              alt={`${activeHero.item.title} backdrop`}
              width="1280"
              height="720"
              sizes="100vw"
              loading={activeIndex === 0 ? 'eager' : 'lazy'}
              fetchpriority={activeIndex === 0 ? 'high' : 'auto'}
              decoding="async"
              onerror={() => { imageLoadFailed = true; }}
            />
          </picture>
        {:else}
          <div class="hero-image-fallback" style={`--hero-accent: ${activeHero.item.accent}`}>
            <span>{activeHero.item.title}</span>
          </div>
        {/if}
      </div>
      <div class="hero-scrim" aria-hidden="true"></div>
      <div class="hero-scrim-bottom" aria-hidden="true"></div>

      <div class="container-wide hero-body">
        <div class="hero-copy" aria-live="polite">
          <div class="hero-kicker">{activeHero.category} <span class="dot"></span> Featured</div>
          <h1>{activeHero.item.title}</h1>
          <div class="hero-meta">
            {#if activeHero.item.rating > 0}<span class="rating">★ {activeHero.item.rating.toFixed(1)}</span>{/if}
            {#if activeHero.item.year > 0}<span>{activeHero.item.year}</span>{/if}
            {#if activeHero.item.maturity}<span class="dot"></span><span>{activeHero.item.maturity}</span>{/if}
            {#if activeHero.item.runtime}<span class="dot"></span><span>{activeHero.item.runtime}</span>{/if}
          </div>
          <p>{activeHero.item.description?.trim() || 'No description available.'}</p>
          {#if activeHero.item.genres?.length}
            <div class="hero-genres" aria-label="Genres">
              {#each activeHero.item.genres.slice(0, 3) as genre}<span>{genre}</span>{/each}
            </div>
          {/if}
          <div class="hero-actions">
            <a class="btn btn-primary" href={`/watch/${activeHero.item.type}/${activeHero.item.id}`}><Play size={16} fill="currentColor" /> Play</a>
            <a class="btn btn-secondary" href={`/${activeHero.item.type}/${activeHero.item.id}`}><Info size={16} /> More info</a>
            <a class="btn btn-secondary icon-only" href={`/${activeHero.item.type}/${activeHero.item.id}`} aria-label={`Add ${activeHero.item.title} to My List`}><ListPlus size={16} /></a>
          </div>
        </div>
      </div>

      <div class="hero-controls" aria-label="Featured title controls">
        <button class="hero-arrow" type="button" aria-label="Previous title" aria-disabled={galleryTransitioning} disabled={galleryTransitioning} onclick={() => { pauseGallery(); releaseInteractionPause(); void changeGallerySlide((activeIndex - 1 + featuredItems.length) % featuredItems.length); }}><ArrowLeft size={16} /></button>
        <div class="hero-dots" role="tablist" aria-label="Choose featured title">
          {#each featuredItems as slide, index}
            <button class:active={index === activeIndex} class="hero-dot" type="button" role="tab" aria-selected={index === activeIndex} aria-label={`Show ${slide.item.title}`} aria-disabled={galleryTransitioning} disabled={galleryTransitioning} onclick={() => selectGallerySlide(index)}></button>
          {/each}
        </div>
        <button class="hero-arrow" type="button" aria-label="Next title" aria-disabled={galleryTransitioning} disabled={galleryTransitioning} onclick={() => { pauseGallery(); releaseInteractionPause(); void changeGallerySlide((activeIndex + 1) % featuredItems.length); }}><ArrowRight size={16} /></button>
      </div>
    </section>
  {:else if hasCatalog}
    <section class="hero hero-fallback" aria-label="Featured title unavailable">
      <div class="container-wide hero-body">
        <div class="hero-copy">
          <div class="hero-kicker">MAVERO <span class="dot"></span> Featured</div>
          <h1>Featured title unavailable.</h1>
          <p>The catalog is available below, but the next featured image is not ready yet.</p>
          <div class="hero-actions"><a class="btn btn-secondary" href="/discover">Browse the catalog</a></div>
        </div>
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
  .hero-media { position: absolute; inset: 0; overflow: hidden; background: var(--base); }
  .hero-image, .hero-image-fallback { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; transition: opacity 220ms var(--ease-out), transform 220ms var(--ease-out); }
  .hero-image { display: block; }
  .hero.transitioning .hero-image { opacity: .82; transform: scale(1.01); }
  .hero-image-fallback { display: grid; place-items: center; background: radial-gradient(circle at 70% 28%, color-mix(in srgb, var(--hero-accent) 38%, transparent), transparent 42%), linear-gradient(135deg, var(--surface-2), var(--base)); }
  .hero-image-fallback span { max-width: 70%; color: rgba(245,246,250,.18); font-size: clamp(2rem, 8vw, 7rem); font-weight: 900; letter-spacing: -.05em; text-align: center; }
  .hero-scrim { position: absolute; inset: 0; background: linear-gradient(100deg, rgba(6,6,10,.97) 8%, rgba(6,6,10,.75) 32%, rgba(6,6,10,.28) 58%, rgba(6,6,10,.55) 100%); pointer-events: none; }
  .hero-scrim-bottom { position: absolute; inset: auto 0 0 0; height: 45%; background: linear-gradient(0deg, var(--base) 0%, transparent 100%); pointer-events: none; }
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
  .hero-arrow:hover:not(:disabled), .hero-arrow:focus-visible:not(:disabled) { border-color: rgba(255,90,122,.6); background: var(--accent-soft); transform: translateY(-1px); outline: 0; }
  .hero-arrow:disabled, .hero-dot:disabled { cursor: wait; opacity: .55; }
  .hero-dots { display: flex; align-items: center; gap: 6px; }
  .hero-dot { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 999px; background: rgba(245,246,250,.28); transition: width var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .hero-dot:hover:not(:disabled), .hero-dot:focus-visible:not(:disabled) { background: rgba(245,246,250,.65); outline: 0; }
  .hero-dot.active { width: 22px; background: var(--accent-gradient); }
  .hero-fallback { background: radial-gradient(circle at 72% 28%, rgba(255,90,122,.18), transparent 38%), var(--base); }

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
    .hero-image, .hero-image-fallback { object-position: center 18%; }
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
  @media (prefers-reduced-motion: reduce) {
    .hero-image, .hero-image-fallback, .hero-arrow, .hero-dot, .discover-routes a { transition: none; }
  }
</style>
