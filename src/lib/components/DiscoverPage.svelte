<script lang="ts">
  import { onMount, tick } from 'svelte';
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
  import { toggleFavorite, isFavorite } from '$lib/client/progress/service';

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
  export let genreCollections: { title: string; items: MediaItem[]; href: string }[] = [];
  export let errorMessage = '';

  type GalleryCategory = 'Movie' | 'Series' | 'Anime';
  type FeaturedHeroItem = { item: MediaItem; category: GalleryCategory };

  const GALLERY_ROTATION_MS = 7000;
  const MAX_FEATURED_ITEMS = 6;

  const quickChips = [
    { label: 'Movies', href: '/discover/movies' },
    { label: 'TV Shows', href: '/discover/series' },
    { label: 'Anime', href: '/discover/anime' },
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

  $: genreTiles = genreTileDefs.map((g) => {
    const collection = genreCollections.find((c) => c.title.toLowerCase().includes(g.label.toLowerCase()));
    const fallbackItems = [...movies, ...series, ...popularMovies, ...popularSeries];
    const artItem = collection?.items?.[0] ?? fallbackItems.find((i) => i.genres?.some((gn) => gn.toLowerCase() === g.label.toLowerCase()));
    return { ...g, artwork: artItem?.backdrop || artItem?.poster || '', accent: artItem?.accent || '#333' };
  });

  let localContinueLoaded = false;
  let localContinueItems: MediaItem[] = [];
  let heroTrack: HTMLElement;
  let activeIndex = 0;
  let galleryPaused = false;
  let reducedMotion = false;
  let galleryRotationTimer: ReturnType<typeof setTimeout> | undefined;
  let interactionReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let motionQuery: MediaQueryList | undefined;
  let isScrolling = false;
  let scrollTimeout: ReturnType<typeof setTimeout> | undefined;
  let heroFavoriteSet = new Set<string>();

  async function toggleHeroFavorite(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (!activeHero) return;
    const item = activeHero.item;
    const key = `${item.type}:${item.id}`;
    const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
    try {
      const result = await toggleFavorite(item.type, item.id, snapshot);
      if (result.saved) {
        heroFavoriteSet.add(key);
      } else {
        heroFavoriteSet.delete(key);
      }
      heroFavoriteSet = heroFavoriteSet;
      haptic('light');
    } catch {
      // Silent fail — don't break hero interaction
    }
  }

  async function refreshHeroFavoriteState() {
    if (!activeHero) return;
    const item = activeHero.item;
    const key = `${item.type}:${item.id}`;
    try {
      const fav = await isFavorite(item.type, item.id);
      if (fav) heroFavoriteSet.add(key); else heroFavoriteSet.delete(key);
      heroFavoriteSet = heroFavoriteSet;
    } catch {
      // ignore
    }
  }

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
    ...movies, ...series, ...anime,
    ...popularMovies, ...popularSeries, ...popularAnime
  ]);
  $: if (activeIndex >= featuredItems.length && featuredItems.length) activeIndex = 0;
  $: activeHero = featuredItems[activeIndex];
  $: activeHeroImage = activeHero?.item.backdrop?.trim() || activeHero?.item.poster?.trim() || '';
  $: heroFavoriteKey = activeHero ? `${activeHero.item.type}:${activeHero.item.id}` : '';
  $: isHeroFavorite = heroFavoriteSet.has(heroFavoriteKey);
  // Refresh favorite state when hero changes
  $: if (heroFavoriteKey && !destroyed) void refreshHeroFavoriteState();

  function clearTimers() {
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    if (interactionReleaseTimer) clearTimeout(interactionReleaseTimer);
    if (scrollTimeout) clearTimeout(scrollTimeout);
    galleryRotationTimer = undefined;
    interactionReleaseTimer = undefined;
    scrollTimeout = undefined;
  }

  function queueGalleryRotation() {
    if (featuredItems.length < 2 || galleryPaused || reducedMotion || destroyed) return;
    if (galleryRotationTimer) clearTimeout(galleryRotationTimer);
    galleryRotationTimer = setTimeout(() => {
      galleryRotationTimer = undefined;
      if (!galleryPaused && !document.hidden) {
        scrollToSlide((activeIndex + 1) % featuredItems.length, true);
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
    queueGalleryRotation();
  }

  function releaseInteractionPause() {
    if (interactionReleaseTimer) clearTimeout(interactionReleaseTimer);
    interactionReleaseTimer = setTimeout(() => { interactionReleaseTimer = undefined; resumeGallery(); }, GALLERY_ROTATION_MS * 2);
  }

  function preloadImage(url: string) {
    return new Promise<boolean>((resolve) => {
      if (!url) { resolve(false); return; }
      const image = new Image();
      image.onload = () => { if ('decode' in image) { void image.decode().catch(() => undefined).finally(() => resolve(true)); } else { resolve(true); } };
      image.onerror = () => resolve(false);
      image.src = url;
    });
  }

  function scrollToSlide(index: number, autoRotated = false) {
    if (!heroTrack || featuredItems.length === 0) return;
    const slideWidth = heroTrack.clientWidth;
    activeIndex = index;
    heroTrack.scrollTo({ left: slideWidth * index, behavior: reducedMotion ? 'auto' : 'smooth' });
    if (autoRotated) haptic('light');
  }

  function handleHeroScroll() {
    if (!heroTrack || featuredItems.length === 0) return;
    isScrolling = true;
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      isScrolling = false;
      if (!heroTrack) return;
      const slideWidth = heroTrack.clientWidth;
      const newIndex = Math.round(heroTrack.scrollLeft / slideWidth);
      if (newIndex !== activeIndex) {
        activeIndex = newIndex;
        haptic('light');
      }
    }, 150);
  }

  function handleHeroKeydown(event: KeyboardEvent) {
    if (!featuredItems.length) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); pauseGallery(); releaseInteractionPause(); scrollToSlide((activeIndex + 1) % featuredItems.length, true); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); pauseGallery(); releaseInteractionPause(); scrollToSlide((activeIndex - 1 + featuredItems.length) % featuredItems.length, true); }
    else if (event.key === 'Home') { event.preventDefault(); pauseGallery(); releaseInteractionPause(); scrollToSlide(0, true); }
    else if (event.key === 'End') { event.preventDefault(); pauseGallery(); releaseInteractionPause(); scrollToSlide(featuredItems.length - 1, true); }
    else if (event.key === ' ') { event.preventDefault(); if (galleryPaused) resumeGallery(); else pauseGallery(); }
  }

  function handleDocumentVisibility() {
    if (document.hidden) { if (galleryRotationTimer) clearTimeout(galleryRotationTimer); galleryRotationTimer = undefined; }
    else if (!galleryPaused) { queueGalleryRotation(); }
  }

  function handleMotionChange(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
    if (reducedMotion) { if (galleryRotationTimer) clearTimeout(galleryRotationTimer); galleryRotationTimer = undefined; }
    else if (!galleryPaused) { queueGalleryRotation(); }
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
      cancelled = true; destroyed = true; clearTimers();
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
  {#if featuredItems.length > 0}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
    <section
      class="hero"
      aria-roledescription="carousel"
      aria-label="Featured titles"
      tabindex="0"
      onpointerenter={pauseGallery}
      onpointerleave={resumeGallery}
      onfocusin={pauseGallery}
      onfocusout={resumeGallery}
      onkeydown={handleHeroKeydown}
    >
      <div class="hero-track" bind:this={heroTrack} onscroll={handleHeroScroll}>
        {#each featuredItems as slide, index}
          <div class="hero-slide" class:active={index === activeIndex}>
            <div class="hero-media" aria-hidden="true">
              {#if (slide.item.backdrop?.trim() || slide.item.poster?.trim())}
                <picture>
                  <source media="(max-width: 640px)" srcset={slide.item.backdropSmall || slide.item.backdrop || slide.item.poster} />
                  <img class="hero-image" src={slide.item.backdrop || slide.item.poster} alt={`${slide.item.title} backdrop`} width="1280" height="720" sizes="100vw" loading={index === 0 ? 'eager' : 'lazy'} fetchpriority={index === 0 ? 'high' : 'auto'} decoding="async" />
                </picture>
              {:else}
                <div class="hero-image-fallback" style={`--hero-accent: ${slide.item.accent}`}><span>{slide.item.title}</span></div>
              {/if}
            </div>
            <div class="hero-scrim" aria-hidden="true"></div>
            <div class="hero-content">
              <div class="hero-copy" aria-live={index === activeIndex ? 'polite' : 'off'}>
                <div class="hero-kicker">{slide.category}</div>
                <h1>{slide.item.title}</h1>
                <div class="hero-meta">
                  {#if slide.item.rating > 0}<span class="rating">★ {slide.item.rating.toFixed(1)}</span>{/if}
                  {#if slide.item.year > 0}<span>{slide.item.year}</span>{/if}
                  {#if slide.item.maturity}<span class="dot"></span><span>{slide.item.maturity}</span>{/if}
                  {#if slide.item.genres?.length}<span class="dot"></span><span>{slide.item.genres.slice(0,2).join(' · ')}</span>{/if}
                </div>
                {#if slide.item.description?.trim()}
                  <p>{slide.item.description.trim()}</p>
                {:else}
                  <p>No description available.</p>
                {/if}
                <div class="hero-actions">
                  <a class="hero-play" href={`/watch/${slide.item.type}/${slide.item.id}`}><Play size={15} fill="currentColor" strokeWidth={0} /> Play</a>
                  <a class="hero-btn" href={`/${slide.item.type}/${slide.item.id}`} aria-label={`Details for ${slide.item.title}`}><Info size={14} /> See More</a>
                  <button class="hero-btn icon-only" type="button" aria-label={isHeroFavorite ? `Remove ${slide.item.title} from My List` : `Add ${slide.item.title} to My List`} onclick={toggleHeroFavorite}>
                    <ListPlus size={14} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        {/each}
      </div>

      {#if featuredItems.length > 1}
        <div class="hero-nav">
          <button class="hero-nav-btn" type="button" aria-label="Previous title" onclick={() => { pauseGallery(); releaseInteractionPause(); scrollToSlide((activeIndex - 1 + featuredItems.length) % featuredItems.length, true); }}><ArrowLeft size={13} /></button>
          <div class="hero-dots" role="tablist" aria-label="Choose featured title">
            {#each featuredItems as slide, index}
              <button class:active={index === activeIndex} class="hero-dot" type="button" role="tab" aria-selected={index === activeIndex} aria-label={`Show ${slide.item.title}`} onclick={() => { pauseGallery(); releaseInteractionPause(); scrollToSlide(index, true); }}></button>
            {/each}
          </div>
          <button class="hero-nav-btn" type="button" aria-label="Next title" onclick={() => { pauseGallery(); releaseInteractionPause(); scrollToSlide((activeIndex + 1) % featuredItems.length, true); }}><ArrowRight size={13} /></button>
        </div>
      {/if}
    </section>
  {:else if hasCatalog}
    <section class="hero hero-fallback" aria-label="Featured title unavailable">
      <div class="hero-content"><div class="hero-copy">
        <div class="hero-kicker">MAVERO</div>
        <h1>Featured title unavailable.</h1>
        <p>The catalog is available below.</p>
      </div></div>
    </section>
  {/if}

  <div class="discover-body">
    {#if errorMessage}<div class="catalog-warning" role="alert">{errorMessage}</div>{/if}
    {#if hasCatalog}
      <nav class="quick-chips" aria-label="Quick discovery">
        {#each quickChips as chip}<a href={chip.href}>{chip.label}</a>{/each}
      </nav>

      {#if localContinue.length}<ContentRail title="Continue watching" items={localContinue} href="/my-list?status=watching" compact />{/if}
      {#if movies.length || series.length}<ContentRail title="Trending right now" items={[...movies.slice(0, 10), ...series.slice(0, 10)]} href="/discover" />{/if}
      {#if newMovies.length}<ContentRail title="New movies" items={newMovies} href="/discover/movies?sort=Newest" />{/if}
      {#if popularSeries.length}<ContentRail title="Popular TV shows" items={popularSeries} href="/discover/series" />{/if}
      {#if anime.length}<ContentRail title="Popular anime" items={anime} href="/discover/anime" />{/if}
      {#if popularAnime.length}<ContentRail title="Trending anime" items={popularAnime} href="/discover/anime" />{/if}
      {#each genreCollections as col}<ContentRail title={col.title} items={col.items} href={col.href} />{/each}

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

      {#if topRatedMovies.length}<ContentRail title="Top rated movies" items={topRatedMovies} href="/discover/movies?sort=Top+rated" />{/if}
      {#if topRatedSeries.length}<ContentRail title="Top rated TV shows" items={topRatedSeries} href="/discover/series?sort=Top+rated" />{/if}
      {#if topRatedAnime.length}<ContentRail title="Top rated anime" items={topRatedAnime} href="/discover/anime?sort=Top+rated" />{/if}
      {#if popularMovies.length}<ContentRail title="Popular movies" items={popularMovies} href="/discover/movies" />{/if}
    {:else}
      <EmptyState eyebrow="MAVERO / Catalog unavailable" title="The shelves are quiet." message="The live catalog is temporarily unavailable. Please try again in a moment." actionLabel="Retry Discover" actionHref="/discover" />
    {/if}
    <footer class="discover-footer"><strong>MAVERO</strong><span>Movies, series &amp; anime — all in one place.</span></footer>
  </div>
</div>

<style>
  .discover-page {
    --d-base: #000000;
    --d-surface: #090909;
    --d-surface-2: #111111;
    --d-surface-raised: #171717;
    --d-ink: #f5f5f5;
    --d-ink-soft: #b7b7bd;
    --d-muted: #77777f;
    --d-line: rgba(255,255,255,.08);
    --d-line-strong: rgba(255,255,255,.14);
    --d-accent: #f5f5f5;
    --d-accent-soft: #c7c7cc;
    --d-ease: cubic-bezier(.22, 1, .36, 1);
  }

  /* === HERO === */
  .hero { position: relative; overflow: hidden; background: var(--d-base); }
  .hero-track {
    display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none;
    -webkit-overflow-scrolling: touch; scroll-behavior: smooth;
  }
  .hero-track::-webkit-scrollbar { display: none; }

  .hero-slide {
    position: relative; flex: 0 0 100%; scroll-snap-align: start; scroll-snap-stop: always;
    min-height: min(78vh, 680px); overflow: hidden;
  }
  .hero-media { position: absolute; inset: 0; overflow: hidden; }
  .hero-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 18%; }
  .hero-image-fallback { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 70% 28%, color-mix(in srgb, var(--hero-accent) 30%, transparent), transparent 42%), var(--d-surface-2); }
  .hero-image-fallback span { color: rgba(255,255,255,.06); font-size: clamp(2rem, 8vw, 5rem); font-weight: 800; }

  .hero-scrim {
    position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(to bottom, transparent 35%, rgba(0,0,0,.35) 60%, var(--d-base) 100%);
  }

  .hero-content { position: relative; z-index: 2; display: flex; align-items: flex-end; min-height: min(78vh, 680px); padding: 90px clamp(16px, 5vw, 56px) 76px; }
  .hero-copy { max-width: 560px; }
  .hero-kicker { color: var(--d-accent-soft); font-size: .62rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .hero-copy h1 {
    margin: 8px 0 0; color: var(--d-ink); font-size: clamp(2rem, 5.5vw, 3.8rem); font-weight: 800;
    letter-spacing: -.03em; line-height: .95; text-wrap: balance;
    text-shadow: 0 2px 16px rgba(0,0,0,.5);
  }
  .hero-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 10px; color: var(--d-ink-soft); font-size: .74rem; font-weight: 500; }
  .hero-meta .rating { color: #ffc94d; font-weight: 600; }
  .dot { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: .5; }
  .hero-copy p {
    max-width: 460px; margin: 8px 0 0; color: var(--d-ink-soft); font-size: .8rem; line-height: 1.5;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  }

  .hero-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .hero-play {
    display: inline-flex; align-items: center; gap: 7px; padding: 10px 24px; border-radius: 999px;
    color: #000; font-size: .82rem; font-weight: 700; text-decoration: none;
    background: #fff; box-shadow: 0 4px 20px rgba(255,255,255,.15);
    transition: transform 220ms var(--d-ease), box-shadow 220ms var(--d-ease);
  }
  .hero-play:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(255,255,255,.2); }
  .hero-btn {
    display: inline-flex; align-items: center; gap: 5px; padding: 10px 16px; border-radius: 999px;
    color: var(--d-ink); font-size: .76rem; font-weight: 600; text-decoration: none;
    background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12);
    transition: background 220ms var(--d-ease), border-color 220ms var(--d-ease);
  }
  .hero-btn:hover { background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.2); }
  .hero-btn.icon-only { padding: 10px 12px; }

  .hero-nav { position: absolute; right: clamp(16px, 4vw, 48px); bottom: 14px; z-index: 3; display: flex; align-items: center; gap: 6px; }
  .hero-nav-btn {
    display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--d-line);
    border-radius: 50%; color: var(--d-ink-soft); background: rgba(0,0,0,.4);
    transition: all 200ms var(--d-ease); cursor: pointer;
  }
  .hero-nav-btn:hover { border-color: var(--d-line-strong); color: var(--d-ink); background: rgba(0,0,0,.6); }
  .hero-dots { display: flex; align-items: center; gap: 4px; }
  .hero-dot { width: 18px; height: 18px; padding: 0; border: 0; background: transparent; cursor: pointer; }
  .hero-dot::after { content: ''; display: block; width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,.25); transition: all 200ms var(--d-ease); }
  .hero-dot:hover::after { background: rgba(255,255,255,.5); }
  .hero-dot:focus-visible { outline: 2px solid var(--d-accent); outline-offset: 1px; }
  .hero-dot.active::after { width: 16px; border-radius: 3px; background: var(--d-accent); }
  .hero-fallback { min-height: 50vh; background: var(--d-base); }

  /* === BODY === */
  .discover-body { padding: 0 0 40px; }
  .quick-chips { display: flex; gap: 6px; padding: 14px clamp(16px, 4vw, 48px) 0; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  .quick-chips::-webkit-scrollbar { display: none; }
  .quick-chips a {
    flex: 0 0 auto; height: 38px; display: inline-flex; align-items: center; padding: 0 16px;
    border-radius: 19px; color: var(--d-ink-soft); text-decoration: none; font-size: .74rem; font-weight: 600;
    background: var(--d-surface-2); border: 1px solid var(--d-line);
    transition: all 200ms var(--d-ease);
  }
  .quick-chips a:hover { color: var(--d-ink); background: var(--d-surface-raised); border-color: var(--d-line-strong); }
  .quick-chips a:focus-visible { outline: 2px solid var(--d-accent); outline-offset: 1px; }

  .genre-section { margin-top: 28px; padding: 0 clamp(16px, 4vw, 48px); }
  .genre-head { margin-bottom: 10px; }
  .genre-title { color: var(--d-ink); font-size: clamp(1rem, 2vw, 1.25rem); font-weight: 700; letter-spacing: -.02em; }
  .genre-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
  .genre-tile {
    position: relative; display: flex; align-items: center; justify-content: center; height: 64px;
    border-radius: 10px; overflow: hidden; text-decoration: none; background: var(--d-surface-2);
    border: 1px solid var(--d-line);
    transition: transform 220ms var(--d-ease), border-color 220ms var(--d-ease);
  }
  .genre-tile:hover { transform: translateY(-2px); border-color: var(--d-line-strong); }
  .genre-tile:focus-visible { outline: 2px solid var(--d-accent); outline-offset: 1px; }
  .genre-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .5; }
  .genre-overlay { position: absolute; inset: 0; background: linear-gradient(135deg, rgba(0,0,0,.45), rgba(0,0,0,.15)); }
  .genre-label { position: relative; z-index: 1; color: var(--d-ink); font-size: .76rem; font-weight: 700; letter-spacing: .02em; }

  .catalog-warning { margin: 16px clamp(16px, 4vw, 48px) 0; padding: 10px 12px; border: 1px solid rgba(255,176,32,.3); border-radius: 6px; color: var(--warning); font-size: .7rem; }
  .discover-footer { padding: 40px 0 20px; text-align: center; }
  .discover-footer strong { color: var(--d-ink); font-size: .8rem; }
  .discover-footer span { display: block; margin-top: 3px; color: var(--d-muted); font-size: .65rem; }

  @media (max-width: 900px) {
    .hero-slide { min-height: min(68vh, 540px); }
    .hero-content { min-height: min(68vh, 540px); padding-top: 70px; padding-bottom: 56px; }
  }
  @media (max-width: 640px) {
    .hero-slide { min-height: 66vh; }
    .hero-image { object-position: center 12%; }
    .hero-scrim { background: linear-gradient(to bottom, transparent 25%, rgba(0,0,0,.4) 55%, var(--d-base) 100%); }
    .hero-content { align-items: flex-end; min-height: 66vh; padding: 56px 16px 50px; }
    .hero-copy { max-width: none; }
    .hero-copy h1 { font-size: clamp(1.6rem, 7vw, 2.4rem); font-weight: 780; }
    .hero-copy p { font-size: .76rem; -webkit-line-clamp: 2; line-clamp: 2; }
    .hero-actions { gap: 6px; }
    .hero-play { flex: 1; justify-content: center; }
    .hero-nav-btn { display: none; }
    .hero-nav { right: 50%; transform: translateX(50%); bottom: 10px; }
    .genre-grid { grid-template-columns: repeat(2, 1fr); }
    .genre-tile { height: 56px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .hero-track { scroll-behavior: auto; }
    .hero-nav-btn, .hero-dot::after, .quick-chips a, .genre-tile, .hero-play, .hero-btn { transition: none; }
  }
</style>
