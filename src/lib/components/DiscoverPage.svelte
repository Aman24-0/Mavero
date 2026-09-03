<script lang="ts">
  import { onMount } from 'svelte';
  import { getContinueWatching } from '$lib/client/progress/service';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { continueWatchingRecords } from '$lib/shared/progress-merge';
  import { progressToMedia } from '$lib/client/progress/presenter';
  import { page } from '$app/state';
  import { ArrowLeft, ArrowRight, Info, ListPlus, Play } from 'lucide-svelte';
  import type { MediaItem } from '$lib/data/content';
  import ContentRail from '$components/ContentRail.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import { haptic } from '$lib/client/haptics';

  export let featuredItem: MediaItem | undefined;
  export let movies: MediaItem[] = [];
  export let series: MediaItem[] = [];
  export let anime: MediaItem[] = [];
  export let popularMovies: MediaItem[] = [];
  export let popularSeries: MediaItem[] = [];
  export let popularAnime: MediaItem[] = [];
  export let topRatedMovies: MediaItem[] = [];
  export let topRatedSeries: MediaItem[] = [];
  export let topRatedAnime: MediaItem[] = [];
  export let newMovies: MediaItem[] = [];
  export let genreCollections: { title: string; items: MediaItem[] }[] = [];
  export let errorMessage = '';

  type GalleryCategory = 'Movie' | 'Series' | 'Anime';
  type FeaturedHeroItem = { item: MediaItem; category: GalleryCategory };

  const GALLERY_ROTATION_MS = 6500;
  const MAX_FEATURED_ITEMS = 6;

  const quickChips = [
    { label: 'Movies', href: '/discover/movies' },
    { label: 'TV Shows', href: '/discover/series' },
    { label: 'Anime', href: '/discover/anime' },
    { label: 'Trending', href: '/discover' },
  ];

  const genreTileDefs = [
    { label: 'Action', href: '/discover/movies?genre=Action' },
    { label: 'Comedy', href: '/discover/movies?genre=Comedy' },
    { label: 'Horror', href: '/discover/movies?genre=Horror' },
    { label: 'Sci-Fi', href: '/discover/movies?genre=Sci-Fi' },
    { label: 'Romance', href: '/discover/movies?genre=Romance' },
    { label: 'Drama', href: '/discover/movies?genre=Drama' },
    { label: 'Thriller', href: '/discover/movies?genre=Thriller' },
    { label: 'Fantasy', href: '/discover/movies?genre=Fantasy' },
  ];

  // Build genre tiles with real artwork from available data
  $: genreTiles = genreTileDefs.map((g) => {
    const collection = genreCollections.find((c) => c.title.toLowerCase().includes(g.label.toLowerCase()));
    const fallbackItems = [...movies, ...series, ...popularMovies, ...popularSeries];
    const artItem = collection?.items?.[0] ?? fallbackItems.find((i) => i.genres?.some((gn) => gn.toLowerCase() === g.label.toLowerCase()));
    return { ...g, artwork: artItem?.backdrop || artItem?.poster || '' };
  });

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

  $: localContinue = localContinueLoaded ? localContinueItems : [];
  $: hasCatalog = Boolean(featuredItem || localContinue.length || movies.length || series.length || anime.length || popularMovies.length || popularSeries.length || popularAnime.length || topRatedMovies.length || topRatedSeries.length || topRatedAnime.length || newMovies.length || genreCollections.length);
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
      if (!url) { resolve(false); return; }
      const image = new Image();
      image.onload = () => {
        if ('decode' in image) { void image.decode().catch(() => undefined).finally(() => resolve(true)); }
        else { resolve(true); }
      };
      image.onerror = () => resolve(false);
      image.src = url;
    });
  }

  async function changeGallerySlide(nextIndex: number, userInitiated = false) {
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
    if (userInitiated) haptic('light');
    if (reducedMotion) { galleryTransitioning = false; resumeGallery(); return; }
    if (galleryTransitionTimer) clearTimeout(galleryTransitionTimer);
    galleryTransitionTimer = setTimeout(() => {
      galleryTransitionTimer = undefined;
      galleryTransitioning = false;
      if (!galleryPaused) queueGalleryRotation();
    }, 220);
  }

  function selectGallerySlide(index: number) {
    if (index === activeIndex) { pauseGallery(); releaseInteractionPause(); return; }
    pauseGallery();
    releaseInteractionPause();
    void changeGallerySlide(index, true);
  }

  function handleGalleryKeydown(event: KeyboardEvent) {
    if (!featuredItems.length) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); pauseGallery(); releaseInteractionPause(); void changeGallerySlide((activeIndex + 1) % featuredItems.length, true); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); pauseGallery(); releaseInteractionPause(); void changeGallerySlide((activeIndex - 1 + featuredItems.length) % featuredItems.length, true); }
    else if (event.key === 'Home') { event.preventDefault(); pauseGallery(); releaseInteractionPause(); void changeGallerySlide(0, true); }
    else if (event.key === 'End') { event.preventDefault(); pauseGallery(); releaseInteractionPause(); void changeGallerySlide(featuredItems.length - 1, true); }
    else if (event.key === ' ') { event.preventDefault(); if (galleryPaused) resumeGallery(); else pauseGallery(); }
  }

  function handleDocumentVisibility() {
    if (document.hidden) { if (galleryRotationTimer) clearTimeout(galleryRotationTimer); galleryRotationTimer = undefined; }
    else if (!galleryPaused && !galleryTransitioning) { queueGalleryRotation(); }
  }

  function handleMotionChange(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
    if (reducedMotion) { if (galleryRotationTimer) clearTimeout(galleryRotationTimer); galleryRotationTimer = undefined; }
    else if (!galleryPaused && !galleryTransitioning) { queueGalleryRotation(); }
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
        if (page.data.user) { const cloud = await syncAuthenticatedState(); return continueWatchingRecords(cloud.progress, cloud.favorites); }
        return getContinueWatching();
      } catch { return []; }
    };
    void loadContinue().then((records) => { if (cancelled) return; localContinueItems = records.map(progressToMedia); localContinueLoaded = true; });
    queueGalleryRotation();
    return () => {
      cancelled = true; destroyed = true; transitionToken += 1; clearGalleryTimers();
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
            <img class="hero-image" src={activeHeroImage} alt={`${activeHero.item.title} backdrop`} width="1280" height="720" sizes="100vw" loading={activeIndex === 0 ? 'eager' : 'lazy'} fetchpriority={activeIndex === 0 ? 'high' : 'auto'} decoding="async" onerror={() => { imageLoadFailed = true; }} />
          </picture>
        {:else}
          <div class="hero-image-fallback" style={`--hero-accent: ${activeHero.item.accent}`}><span>{activeHero.item.title}</span></div>
        {/if}
      </div>
      <div class="hero-scrim" aria-hidden="true"></div>

      <div class="hero-content">
        <div class="hero-copy" aria-live="polite">
          <div class="hero-kicker">{activeHero.category}</div>
          <h1>{activeHero.item.title}</h1>
          <div class="hero-meta">
            {#if activeHero.item.rating > 0}<span class="rating">★ {activeHero.item.rating.toFixed(1)}</span>{/if}
            {#if activeHero.item.year > 0}<span>{activeHero.item.year}</span>{/if}
            {#if activeHero.item.maturity}<span class="dot"></span><span>{activeHero.item.maturity}</span>{/if}
            {#if activeHero.item.genres?.length}<span class="dot"></span><span>{activeHero.item.genres.slice(0,2).join(' · ')}</span>{/if}
          </div>
          {#if activeHero.item.description?.trim()}
            <p>{activeHero.item.description.trim()}</p>
          {:else}
            <p>No description available.</p>
          {/if}
          <div class="hero-actions">
            <a class="hero-play" href={`/watch/${activeHero.item.type}/${activeHero.item.id}`}><Play size={15} fill="currentColor" strokeWidth={0} /> Play</a>
            <a class="hero-btn" href={`/${activeHero.item.type}/${activeHero.item.id}`} aria-label={`Details for ${activeHero.item.title}`}><Info size={14} /> Details</a>
            <a class="hero-btn icon-only" href={`/${activeHero.item.type}/${activeHero.item.id}`} aria-label={`Add ${activeHero.item.title} to My List`}><ListPlus size={14} /></a>
          </div>
        </div>
      </div>

      {#if featuredItems.length > 1}
        <div class="hero-nav">
          <button class="hero-nav-btn" type="button" aria-label="Previous title" aria-disabled={galleryTransitioning} disabled={galleryTransitioning} onclick={() => { pauseGallery(); releaseInteractionPause(); void changeGallerySlide((activeIndex - 1 + featuredItems.length) % featuredItems.length, true); }}><ArrowLeft size={14} /></button>
          <div class="hero-dots" role="tablist" aria-label="Choose featured title">
            {#each featuredItems as slide, index}
              <button class:active={index === activeIndex} class="hero-dot" type="button" role="tab" aria-selected={index === activeIndex} aria-label={`Show ${slide.item.title}`} aria-disabled={galleryTransitioning} disabled={galleryTransitioning} onclick={() => selectGallerySlide(index)}></button>
            {/each}
          </div>
          <button class="hero-nav-btn" type="button" aria-label="Next title" aria-disabled={galleryTransitioning} disabled={galleryTransitioning} onclick={() => { pauseGallery(); releaseInteractionPause(); void changeGallerySlide((activeIndex + 1) % featuredItems.length, true); }}><ArrowRight size={14} /></button>
        </div>
      {/if}
    </section>
  {:else if hasCatalog}
    <section class="hero hero-fallback" aria-label="Featured title unavailable">
      <div class="hero-content">
        <div class="hero-copy">
          <div class="hero-kicker">MAVERO</div>
          <h1>Featured title unavailable.</h1>
          <p>The catalog is available below.</p>
        </div>
      </div>
    </section>
  {/if}

  <div class="discover-body">
    {#if errorMessage}<div class="catalog-warning" role="alert">{errorMessage}</div>{/if}
    {#if hasCatalog}
      <nav class="quick-chips" aria-label="Quick discovery">
        {#each quickChips as chip}
          <a href={chip.href}>{chip.label}</a>
        {/each}
      </nav>

      {#if localContinue.length}
        <ContentRail title="Continue watching" items={localContinue} href="/my-list?status=watching" compact />
      {/if}

      {#if movies.length || series.length}
        <ContentRail title="Trending right now" items={[...movies.slice(0, 10), ...series.slice(0, 10)]} href="/discover" />
      {/if}

      {#if newMovies.length}
        <ContentRail title="New movies" items={newMovies} href="/discover/movies?sort=Newest" />
      {/if}

      {#if popularSeries.length}
        <ContentRail title="Popular TV shows" items={popularSeries} href="/discover/series" />
      {/if}

      {#if anime.length}
        <ContentRail title="Popular anime" items={anime} href="/discover/anime" />
      {/if}
      {#if popularAnime.length}
        <ContentRail title="Trending anime" items={popularAnime} href="/discover/anime" />
      {/if}

      {#each genreCollections as col}
        <ContentRail title={col.title} items={col.items} href="/discover/movies" />
      {/each}

      {#if genreTiles.length}
        <section class="genre-section" aria-labelledby="genre-discover">
          <div class="genre-head"><h2 class="genre-title" id="genre-discover">Browse by genre</h2></div>
          <div class="genre-grid">
            {#each genreTiles as tile}
              <a class="genre-tile" href={tile.href}>
                {#if tile.artwork}
                  <img src={tile.artwork} alt="" loading="lazy" decoding="async" class="genre-art" />
                {/if}
                <div class="genre-overlay"></div>
                <span class="genre-label">{tile.label}</span>
              </a>
            {/each}
          </div>
        </section>
      {/if}

      {#if topRatedMovies.length}
        <ContentRail title="Top rated movies" items={topRatedMovies} href="/discover/movies?sort=Top+rated" />
      {/if}
      {#if topRatedSeries.length}
        <ContentRail title="Top rated TV shows" items={topRatedSeries} href="/discover/series?sort=Top+rated" />
      {/if}
      {#if topRatedAnime.length}
        <ContentRail title="Top rated anime" items={topRatedAnime} href="/discover/anime?sort=Top+rated" />
      {/if}

      {#if popularMovies.length}
        <ContentRail title="Popular movies" items={popularMovies} href="/discover/movies" />
      {/if}
    {:else}
      <EmptyState eyebrow="MAVERO / Catalog unavailable" title="The shelves are quiet." message="The live catalog is temporarily unavailable. Please try again in a moment." actionLabel="Retry Discover" actionHref="/discover" />
    {/if}
    <footer class="discover-footer"><strong>MAVERO</strong><span>Movies, series &amp; anime — all in one place.</span></footer>
  </div>
</div>

<style>
  .discover-page {
    --d-base: #000000;
    --d-surface: #0a0a0a;
    --d-surface-2: #111111;
    --d-ink: #f5f5f5;
    --d-ink-soft: #9a9a9a;
    --d-muted: #666666;
    --d-line: rgba(255,255,255,.08);
    --d-line-strong: rgba(255,255,255,.14);
  }

  /* === HERO === */
  .hero { position: relative; min-height: min(80vh, 720px); overflow: hidden; background: var(--d-base); }
  .hero-media { position: absolute; inset: 0; overflow: hidden; }
  .hero-image, .hero-image-fallback { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; transition: opacity 200ms var(--ease-out); }
  .hero.transitioning .hero-image { opacity: .85; }
  .hero-image-fallback { display: grid; place-items: center; background: radial-gradient(circle at 70% 28%, color-mix(in srgb, var(--hero-accent) 35%, transparent), transparent 42%), var(--d-surface-2); }
  .hero-image-fallback span { color: rgba(255,255,255,.08); font-size: clamp(2rem, 8vw, 5rem); font-weight: 900; }

  .hero-scrim { position: absolute; inset: 0; background: linear-gradient(0deg, var(--d-base) 2%, rgba(0,0,0,.3) 30%, rgba(0,0,0,.1) 55%, rgba(0,0,0,.4) 100%); pointer-events: none; }

  .hero-content { position: relative; z-index: 2; display: flex; align-items: flex-end; min-height: min(80vh, 720px); padding: 100px clamp(16px, 5vw, 56px) 90px; }
  .hero-copy { max-width: 580px; }
  .hero-kicker { color: var(--accent-strong); font-size: .65rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .hero-copy h1 { margin: 8px 0 0; color: var(--d-ink); font-size: clamp(2rem, 5.5vw, 4rem); font-weight: 900; letter-spacing: -.025em; line-height: .96; text-wrap: balance; text-shadow: 0 2px 20px rgba(0,0,0,.6); }
  .hero-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 12px; color: var(--d-ink-soft); font-size: .75rem; font-weight: 600; }
  .hero-meta .rating { color: #ffc94d; }
  .dot { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: .5; }
  .hero-copy p { max-width: 480px; margin: 10px 0 0; color: var(--d-ink-soft); font-size: .82rem; line-height: 1.5; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; text-wrap: pretty; }

  .hero-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .hero-play { display: inline-flex; align-items: center; gap: 6px; padding: 10px 22px; border-radius: 6px; color: #fff; font-size: .82rem; font-weight: 700; text-decoration: none; background: var(--accent); transition: background var(--motion-fast); }
  .hero-play:hover { background: var(--accent-strong); }
  .hero-btn { display: inline-flex; align-items: center; gap: 5px; padding: 10px 16px; border-radius: 6px; color: var(--d-ink); font-size: .78rem; font-weight: 600; text-decoration: none; background: rgba(255,255,255,.1); backdrop-filter: blur(4px); transition: background var(--motion-fast); }
  .hero-btn:hover { background: rgba(255,255,255,.16); }
  .hero-btn.icon-only { padding: 10px 12px; }

  .hero-nav { position: absolute; right: clamp(16px, 4vw, 48px); bottom: 16px; z-index: 3; display: flex; align-items: center; gap: 6px; }
  .hero-nav-btn { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--d-line); border-radius: 6px; color: var(--d-ink-soft); background: rgba(0,0,0,.4); transition: all var(--motion-fast); }
  .hero-nav-btn:hover:not(:disabled) { border-color: var(--d-line-strong); color: var(--d-ink); background: rgba(0,0,0,.6); }
  .hero-nav-btn:disabled { opacity: .4; cursor: wait; }
  .hero-dots { display: flex; align-items: center; gap: 3px; }
  .hero-dot { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 0; background: transparent; }
  .hero-dot::after { content: ''; display: block; width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,.3); transition: all var(--motion-fast); }
  .hero-dot:hover:not(:disabled)::after { background: rgba(255,255,255,.6); }
  .hero-dot:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
  .hero-dot.active::after { width: 16px; border-radius: 3px; background: var(--accent); }
  .hero-dot:disabled { opacity: .4; }
  .hero-fallback { background: radial-gradient(circle at 72% 28%, rgba(255,90,122,.12), transparent 38%), var(--d-base); }

  /* === BODY === */
  .discover-body { padding: 0 0 40px; }

  .quick-chips { display: flex; gap: 6px; padding: 16px clamp(16px, 4vw, 48px) 0; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  .quick-chips::-webkit-scrollbar { display: none; }
  .quick-chips a { flex: 0 0 auto; padding: 5px 14px; border-radius: 20px; color: var(--ink-soft); text-decoration: none; font-size: .72rem; font-weight: 600; background: rgba(255,255,255,.05); transition: all var(--motion-fast); }
  .quick-chips a:hover { color: var(--ink); background: rgba(255,255,255,.1); }
  .quick-chips a:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }

  /* === GENRE === */
  .genre-section { margin-top: 24px; padding: 0 clamp(16px, 4vw, 48px); }
  .genre-head { margin-bottom: 10px; }
  .genre-title { color: var(--ink); font-size: clamp(1rem, 2vw, 1.3rem); font-weight: 700; letter-spacing: -.015em; }
  .genre-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
  .genre-tile { position: relative; display: flex; align-items: flex-end; height: 64px; border-radius: 8px; overflow: hidden; text-decoration: none; background: var(--surface-2); transition: transform var(--motion-fast); }
  .genre-tile:hover { transform: translateY(-2px); }
  .genre-tile:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
  .genre-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .35; }
  .genre-overlay { position: absolute; inset: 0; background: linear-gradient(135deg, rgba(0,0,0,.6), rgba(0,0,0,.3)); }
  .genre-label { position: relative; z-index: 1; padding: 8px 10px; color: var(--ink); font-size: .76rem; font-weight: 700; }

  .catalog-warning { margin: 16px clamp(16px, 4vw, 48px) 0; padding: 10px 12px; border: 1px solid rgba(255,176,32,.3); border-radius: 6px; color: var(--warning); font-size: .7rem; }
  .discover-footer { padding: 40px 0 20px; text-align: center; }
  .discover-footer strong { color: var(--ink); font-size: .8rem; letter-spacing: .03em; }
  .discover-footer span { display: block; margin-top: 3px; color: var(--muted); font-size: .65rem; }

  @media (max-width: 900px) {
    .hero { min-height: min(70vh, 580px); }
    .hero-content { min-height: min(70vh, 580px); padding-top: 80px; padding-bottom: 70px; }
  }
  @media (max-width: 640px) {
    .hero { min-height: 70vh; }
    .hero-image, .hero-image-fallback { object-position: center 15%; }
    .hero-scrim { background: linear-gradient(0deg, var(--d-base) 5%, rgba(0,0,0,.2) 35%, rgba(0,0,0,.05) 60%, rgba(0,0,0,.3) 100%); }
    .hero-content { align-items: flex-end; min-height: 70vh; padding: 70px 16px 60px; }
    .hero-copy { max-width: none; }
    .hero-copy h1 { font-size: clamp(1.6rem, 7vw, 2.4rem); }
    .hero-copy p { font-size: .76rem; -webkit-line-clamp: 2; line-clamp: 2; }
    .hero-actions { gap: 6px; }
    .hero-play { flex: 1; justify-content: center; }
    .hero-nav { right: 12px; bottom: 8px; }
    .hero-nav-btn { width: 28px; height: 28px; }
    .genre-grid { grid-template-columns: repeat(2, 1fr); }
    .genre-tile { height: 56px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .hero-image, .hero-nav-btn, .hero-dot::after, .quick-chips a, .genre-tile { transition: none; }
  }
</style>
