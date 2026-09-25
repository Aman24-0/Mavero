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
  import DiscoverSection from '$components/DiscoverSection.svelte';
  import AdultDiscoverSection from '$components/AdultDiscoverSection.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import AppFooter from '$components/AppFooter.svelte';
  import { haptic } from '$lib/client/haptics';
  import { toggleFavorite, isFavorite } from '$lib/client/progress/service';
  import { clearRailCache } from '$lib/client/discover/rail-cache';
  // Phase 9 fix: import the canonical SECTION_PRIORITY + canonicalExcludeIds
  // from the SHARED module (client-safe). The server dedup loop walks the
  // SAME SECTION_PRIORITY, so Show More exclude lists honor the same
  // canonical priority — even when the visual UI order differs (Comedy is
  // rendered before Crime/Thriller/Sci-Fi, but those are higher canonical
  // priority and must be excluded from Comedy's Show More).
  import { canonicalExcludeIds } from '$lib/shared/discover-batch';
  import type { DiscoverSectionKey } from '$lib/server/content/types';

  let {
    featuredItem,
    heroItems = [],
    movies = [],
    series = [],
    anime = [],
    popularSeries = [],
    popularAnime = [],
    trendingHindiMovies = [],
    trendingRegionalMovies = [],
    topRatedMovies = [],
    topRatedSeries = [],
    topRatedAnime = [],
    newMovies = [],
    genreCollections = [],
    errorMessage = '',
  }: {
    featuredItem: MediaItem | undefined;
    /** Server-selected Hero lineup in strict M/S/M/S/M/S order. May be empty
     *  on failure — the component falls back to the legacy createFeaturedItems
     *  path. May contain fewer than 6 items when candidate depth is thin. */
    heroItems?: MediaItem[];
    movies?: MediaItem[];
    series?: MediaItem[];
    anime?: MediaItem[];
    popularSeries?: MediaItem[];
    popularAnime?: MediaItem[];
    trendingHindiMovies?: MediaItem[];
    trendingRegionalMovies?: MediaItem[];
    topRatedMovies?: MediaItem[];
    topRatedSeries?: MediaItem[];
    topRatedAnime?: MediaItem[];
    newMovies?: MediaItem[];
    genreCollections?: { title: string; items: MediaItem[]; href: string }[];
    errorMessage?: string;
  } = $props();

  type GalleryCategory = 'Movie' | 'Series' | 'Anime';
  type FeaturedHeroItem = { item: MediaItem; category: GalleryCategory };

  const GALLERY_ROTATION_MS = 7000;
  const MAX_FEATURED_ITEMS = 6;

  const quickChips = [
    { label: 'Movies', href: '/discover/movies' },
    { label: 'TV Shows', href: '/discover/series' },
    { label: 'Anime', href: '/discover/anime' },
  ];

  // ============================================================
  // Discover V2 — data-driven section list.
  //
  // Each entry maps to a `DiscoverSectionKey` that the server-side
  // `discoverRail()` builder resolves to the right TMDB endpoint +
  // filters. The section order is EXACTLY as specified:
  //   theatre → new-ott → popular-{movie,series,anime} →
  //   top-rated-{movie,series,anime} → 9 genre rails.
  //
  // Language-filterable sections render a language dropdown.
  // The OTT section renders a provider dropdown (loaded from
  // /api/discover/providers). Anime sections have NO dropdown —
  // only a "View all →" link to /discover/anime.
  // ============================================================
  type SectionDef = {
    key: DiscoverSectionKey;
    title: string;
    languageFilter: boolean;
    providerFilter: boolean;
    viewAllHref?: string;
  };
  const SECTIONS: SectionDef[] = [
    { key: 'theatre', title: 'Running in theatre 🎥', languageFilter: true, providerFilter: false },
    { key: 'new-ott', title: 'New on OTT', languageFilter: false, providerFilter: true },
    { key: 'popular-movie', title: 'Popular movies', languageFilter: true, providerFilter: false },
    { key: 'popular-series', title: 'Popular TV shows', languageFilter: true, providerFilter: false },
    { key: 'popular-anime', title: 'Popular anime', languageFilter: false, providerFilter: false, viewAllHref: '/discover/anime' },
    { key: 'top-rated-movie', title: 'Top rated movies', languageFilter: true, providerFilter: false },
    { key: 'top-rated-series', title: 'Top rated TV shows', languageFilter: true, providerFilter: false },
    { key: 'top-rated-anime', title: 'Top rated anime', languageFilter: false, providerFilter: false, viewAllHref: '/discover/anime' },
    { key: 'genre-action', title: 'Action', languageFilter: true, providerFilter: false },
    { key: 'genre-adventure', title: 'Adventure', languageFilter: true, providerFilter: false },
    { key: 'genre-comedy', title: 'Comedy', languageFilter: true, providerFilter: false },
    { key: 'genre-crime', title: 'Crime', languageFilter: true, providerFilter: false },
    { key: 'genre-thriller', title: 'Thriller', languageFilter: true, providerFilter: false },
    { key: 'genre-scifi', title: 'Sci-Fi', languageFilter: true, providerFilter: false },
    { key: 'genre-drama', title: 'Drama', languageFilter: true, providerFilter: false },
    { key: 'genre-horror', title: 'Horror', languageFilter: true, providerFilter: false },
    { key: 'genre-romance', title: 'Romance', languageFilter: true, providerFilter: false },
  ];

  // Adult mode state — fetched client-side from /api/settings/adult-mode.
  // The server is the authority; the client only reflects server state.
  // Phase 8: the "Indian Adult Shows" rail no longer uses the legacy
  // watch-provider dropdown endpoint — the Phase 7 Adult Discover contract
  // has NO provider parameter (the verified Adult network set is
  // server-controlled and invisible to the client). The dedicated
  // AdultDiscoverSection component fetches the authorized,
  // classifier-confirmed catalog from the dedicated adult-discover API,
  // which independently re-evaluates authorization on every request.
  let adultCanAccess = $state(false);

  // Phase 8: cross-rail dedup state. The batch endpoint fetches all rails
  // in priority order with a global seen set. The results are distributed
  // to each DiscoverSection as initialItems, and the excludeIds (all
  // canonical IDs from higher-priority rails) are passed for Show More.
  // Phase 9: each rail result now also includes `page` (the ACTUAL last
  // fetched page the batch consumed) and `hasNextPage` — both passed
  // through to DiscoverSection so Show More resumes from the correct
  // continuation page and the hasNextPage flag is authoritative (not
  // inferred from item count).
  let batchRails = $state<Record<string, { items: MediaItem[]; page: number; hasNextPage: boolean } | undefined>>({});
  let batchStatus = $state<'pending' | 'success' | 'failed'>('pending');

  async function loadBatchRails() {
    try {
      const response = await fetch('/api/discover/batch?language=all');
      if (!response.ok) { batchStatus = 'failed'; return; }
      const payload = await response.json();
      if (!payload.ok || !payload.rails) { batchStatus = 'failed'; return; }
      batchRails = payload.rails;
      batchStatus = 'success';
      // Phase 8 fix: clear the rail cache so stale independent-rail data
      // from the old architecture cannot bypass the new global dedup.
      // The batch results are the authoritative initial state — cached
      // independent rails may contain duplicates.
      clearRailCache();
    } catch {
      // Silent fail — sections will fall back to independent fetches.
      batchStatus = 'failed';
    }
  }

  // ============================================================
  // Cross-rail exclude list — CANONICAL PRIORITY, NOT VISUAL ORDER.
  //
  // Phase 9 critical fix:
  //   The previous implementation walked the visual UI SECTIONS array,
  //   which has Comedy rendered BEFORE Crime/Thriller/Sci-Fi. But the
  //   server dedup loop walks SECTION_PRIORITY (canonical server order),
  //   where Crime/Thriller/Sci-Fi come BEFORE Comedy.
  //
  //   This mismatch caused Show More on genre-comedy to NOT exclude
  //   items already accepted into genre-crime / genre-thriller /
  //   genre-scifi (which appear visually below comedy) — allowing the
  //   same canonical ID to be reintroduced by Show More and breaking
  //   the cross-rail dedup invariant.
  //
  //   Fix: delegate to `canonicalExcludeIds()` from the SHARED module.
  //   It walks SECTION_PRIORITY (the SAME order the server uses), so
  //   every section that is canonically higher-priority than the
  //   current section contributes its IDs to the exclude list —
  //   REGARDLESS of where the section appears in the visual UI.
  //
  //   The visual UI SECTIONS array above is INTENTIONALLY left in its
  //   current order (Comedy before Crime/Thriller/Sci-Fi) — that order
  //   matches the spec's "spectacle-first" UX. Only the exclude-list
  //   computation is now canonical-priority-aware.
  // ============================================================
  function excludeIdsFor(sectionKey: string): string[] {
    return canonicalExcludeIds(sectionKey, batchRails);
  }

  async function loadAdultModeSettings() {
    try {
      const response = await fetch('/api/settings/adult-mode');
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload.ok) return;
      adultCanAccess = Boolean(payload.canAccess);
    } catch {
      // Silent fail — adult section stays hidden.
    }
  }

  // OTT provider list (loaded client-side from /api/discover/providers).
  // Built from real TMDB India provider metadata — never random favicons.
  let ottProviders = $state<{ value: string; label: string; logoUrl?: string }[]>([]);

  async function loadOttProviders() {
    try {
      const response = await fetch('/api/discover/providers');
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload.ok || !Array.isArray(payload.providers)) return;
      // Curate to ~15 recognizable India-relevant providers. We prioritize
      // well-known names; the rest are still available but lower in the list.
      const known = ['netflix', 'amazon-prime-video', 'prime-video', 'jiocinema', 'jiohotstar', 'hotstar', 'sonyliv', 'sony-liv', 'zee5', 'sunnxt', 'sun-nxt', 'mx-player', 'aha', 'hoichoi', 'mubi', 'lionsgate-play', 'discovery-plus', 'apple-tv', 'apple-tv-plus'];
      const sorted = [...payload.providers].sort((a: { key: string; name: string }, b: { key: string; name: string }) => {
        const ai = known.indexOf(a.key);
        const bi = known.indexOf(b.key);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.name.localeCompare(b.name);
      });
      ottProviders = sorted.slice(0, 15).map((p: { key: string; name: string; logoUrl: string }) => ({ value: p.key, label: p.name, logoUrl: p.logoUrl }));
    } catch {
      // Silent fail — the OTT section will still load with "All OTT" only.
    }
  }

  // PHASE E fix: these MUST be $state. In Svelte 5 runes mode a plain `let`
  // is NOT reactive — the $derived below reads these values, so assignments
  // made after the async loadContinue() resolve (onMount, visibilitychange,
  // pageshow/BFCache reload) never invalidated the derived and the
  // "Continue watching" rail stayed hidden even when records existed.
  // My List avoids the same trap by declaring its records with $state.
  let localContinueLoaded = $state(false);
  let localContinueItems = $state<MediaItem[]>([]);
  let heroTrack = $state<HTMLElement>();
  let galleryPaused = false;
  let reducedMotion = false;
  let galleryRotationTimer: ReturnType<typeof setTimeout> | undefined;
  let interactionReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let motionQuery: MediaQueryList | undefined;
  let isScrolling = false;
  let scrollTimeout: ReturnType<typeof setTimeout> | undefined;
  let heroFavoriteSet = $state(new Set<string>());

  async function toggleHeroFavorite(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (!activeHero) return;
    const item = activeHero.item;
    const key = `${item.type}:${item.id}`;
    const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
    try {
      const result = await toggleFavorite(item.type, item.id, snapshot);
      const next = new Set(heroFavoriteSet);
      if (result.saved) {
        next.add(key);
      } else {
        next.delete(key);
      }
      heroFavoriteSet = next;
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
      const next = new Set(heroFavoriteSet);
      if (fav) next.add(key); else next.delete(key);
      heroFavoriteSet = next;
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

  let localContinue = $derived(localContinueLoaded ? localContinueItems : []);
  let hasCatalog = $derived(Boolean(featuredItem || localContinue.length || movies.length || series.length || anime.length));
  // ===========================================================================
  // Hero lineage contract (production bug fix — commit after 89bb711).
  //
  // The previous implementation had a legacy fallback that took the
  // server-selected `heroItems` and topped it up with items from the
  // raw trending rails (via `createFallbackItems()`). The fallback
  // had NO freshness filter and NO M/S/M/S/M/S enforcement. When the
  // server-side selector returned [] (because all trending movies
  // were >30 days old at the test date), the fallback picked
  // `featuredItem` (computed by selectFeatured — no freshness) which
  // was Reacher, then 5 movies from trending → S/M/M/M/M/M.
  //
  // The contract now is:
  //   1. The server is the SOLE canonical source of Hero slides via
  //      `heroItems` (returned by loadDiscoverData → loadHeroLineup →
  //      selectHeroLineup).
  //   2. `featuredItems` is derived DIRECTLY from `heroItems` — no
  //      legacy fallback, no createFeaturedItems, no createFallbackItems.
  //   3. When `heroItems` is shorter than 6, the carousel renders
  //      fewer slides — NEVER appends stale content to fill the UI.
  //   4. When `heroItems` is empty (TMDB failure), the existing
  //      `.hero-fallback` "Featured title unavailable" section renders
  //      below — no fake content.
  // ===========================================================================
  let featuredItems = $derived(
    heroItems
      .filter((item) => item.id.trim() && item.title.trim() && hasHeroImage(item))
      .slice(0, MAX_FEATURED_ITEMS)
      .map((item) => ({ item, category: categoryFor(item) }))
  );
  // Reset activeIndex if it's out of bounds after featuredItems changes.
  let activeIndex = $state(0);
  let activeHero = $derived(featuredItems[activeIndex]);
  let activeHeroImage = $derived(activeHero?.item.backdrop?.trim() || activeHero?.item.poster?.trim() || '');
  let heroFavoriteKey = $derived(activeHero ? `${activeHero.item.type}:${activeHero.item.id}` : '');
  let isHeroFavorite = $derived(heroFavoriteSet.has(heroFavoriteKey));
  // Refresh favorite state when hero changes
  $effect(() => {
    if (heroFavoriteKey && !destroyed) void refreshHeroFavoriteState();
  });
  // Clamp activeIndex when featuredItems shrinks.
  $effect(() => {
    if (activeIndex >= featuredItems.length && featuredItems.length) activeIndex = 0;
  });

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
    else {
      if (!galleryPaused) queueGalleryRotation();
      // Phase 9 fix: reload Continue Watching when the page becomes visible
      // again (e.g. user navigates back from the watch route). The old code
      // only handled gallery rotation on visibility change, not progress reload.
      void loadContinue().then((records) => { if (destroyed) return; localContinueItems = records.map(progressToMedia); });
    }
  }

  function handleMotionChange(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
    if (reducedMotion) { if (galleryRotationTimer) clearTimeout(galleryRotationTimer); galleryRotationTimer = undefined; }
    else if (!galleryPaused) { queueGalleryRotation(); }
  }

  // Phase 9: moved loadContinue out of onMount so handleDocumentVisibility can call it.
  async function loadContinue() {
    try {
      if (page.data.user) { const cloud = await syncAuthenticatedState(); return continueWatchingRecords(cloud.progress, cloud.favorites); }
      return getContinueWatching();
    } catch { return []; }
  }

  onMount(() => {
    destroyed = false;
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = motionQuery.matches;
    motionQuery.addEventListener?.('change', handleMotionChange);
    document.addEventListener('visibilitychange', handleDocumentVisibility);
    // Phase 9: handle BFCache restoration — when the browser serves the page
    // from the Back/Forward Cache, visibilitychange does NOT fire. The pageshow
    // event with event.persisted === true is the only reliable signal.
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void loadContinue().then((records) => { if (destroyed) return; localContinueItems = records.map(progressToMedia); });
      }
    };
    window.addEventListener('pageshow', handlePageShow);

    let cancelled = false;
    void loadContinue().then((records) => { if (cancelled) return; localContinueItems = records.map(progressToMedia); localContinueLoaded = true; });
    void loadOttProviders();
    void loadAdultModeSettings();
    void loadBatchRails(); // Phase 8: server-authoritative cross-rail dedup
    queueGalleryRotation();

    return () => {
      cancelled = true; destroyed = true; clearTimers();
      motionQuery?.removeEventListener?.('change', handleMotionChange);
      document.removeEventListener('visibilitychange', handleDocumentVisibility);
      window.removeEventListener('pageshow', handlePageShow);
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
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
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
                  <!-- Responsive hero artwork:
                       - mobile (≤640px), standard DPI: w780 (bandwidth-friendly)
                       - mobile (≤640px), high DPI (≥2x): w1280 (sharp on retina)
                       - tablet/desktop (>640px): original (sharpest, larger bandwidth
                         is acceptable on a bigger pipe and a bigger display)
                       Fallback <img src> uses w1280 for non-<picture> browsers. -->
                  <source media="(max-width: 640px) and (-webkit-min-device-pixel-ratio: 2), (max-width: 640px) and (min-resolution: 192dpi)" srcset={slide.item.backdrop || slide.item.backdropSmall || slide.item.poster} />
                  <source media="(max-width: 640px)" srcset={slide.item.backdropSmall || slide.item.backdrop || slide.item.poster} />
                  <source media="(min-width: 641px)" srcset={slide.item.backdropHero || slide.item.backdrop || slide.item.backdropSmall || slide.item.poster} />
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

      <!-- ============================================================
           Discover V2 — data-driven section list.
           Each DiscoverSection owns its own independent state (language,
           provider, page, items, loading, error). Show more appends;
           language switch replaces; sections never interfere with each
           other. No fixtures are used as successful results — a failed
           upstream query renders the section as empty/unavailable.
           ============================================================ -->
      {#each SECTIONS as sectionDef (sectionDef.key)}
        <DiscoverSection
          section={sectionDef.key}
          title={sectionDef.title}
          languageFilter={sectionDef.languageFilter}
          providerFilter={sectionDef.providerFilter}
          providers={sectionDef.providerFilter ? ottProviders : []}
          viewAllHref={sectionDef.viewAllHref ?? ''}
          initialItems={batchRails[sectionDef.key]?.items ?? []}
          initialHasNextPage={batchRails[sectionDef.key]?.hasNextPage ?? false}
          initialPage={batchRails[sectionDef.key]?.page ?? 1}
          excludeIds={excludeIdsFor(sectionDef.key)}
          batchStatus={batchStatus}
        />
      {/each}
      <!-- Phase 8: Indian Adult Shows — the LAST content rail before the
           footer, now backed by the Phase 7 dedicated Adult Discover API.
           Only rendered when the server says adult access is allowed (the
           /api/settings/adult-mode state fetched above). The server enforces
           this independently — the /api/content/adult-discover endpoint
           re-evaluates the Phase 5 policy on EVERY request and answers
           unauthorized calls with the non-disclosing 404, so this
           client-side check is purely for rendering convenience. -->
      {#if adultCanAccess}
        <AdultDiscoverSection title="Indian Adult Shows" />
      {/if}
    {:else}
      <EmptyState eyebrow="MAVERO / Catalog unavailable" title="The shelves are quiet." message="The live catalog is temporarily unavailable. Please try again in a moment." actionLabel="Retry Discover" actionHref="/discover" />
    {/if}
    <AppFooter />
  </div>
</div>

<ScrollToTop />

<style>
  .discover-page {
    /* Phase B Part 3: legacy --d-* tokens replaced with the global
       Phase B design tokens (defined in app.css). The previous local
       palette used pure black #000000 which mismatched the cinematic
       Phase B background #050708; consolidating here removes the
       mismatch without introducing a second color system. */
    --d-gutter: clamp(16px, 5vw, 48px);
  }

  /* === HERO === */
  .hero { position: relative; overflow: hidden; background: var(--color-bg); }
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
  .hero-image-fallback { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 70% 28%, color-mix(in srgb, var(--hero-accent) 30%, transparent), transparent 42%), var(--color-surface-elevated); }
  .hero-image-fallback span { color: rgba(242,255,248,.06); font-size: clamp(2rem, 8vw, 5rem); font-weight: 800; }

  .hero-scrim {
    position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(to bottom, transparent 35%, rgba(5,7,8,.35) 60%, var(--color-bg) 100%);
  }

  .hero-content { position: relative; z-index: 2; display: flex; align-items: flex-end; min-height: min(78vh, 680px); padding: 90px clamp(16px, 5vw, 56px) 76px; }
  .hero-copy { max-width: 560px; }
  /* Phase D.A — text transition synchronized with image: when a slide
     becomes active, the hero-copy fades up subtly. When inactive, it
     fades down. The CSS transition is on opacity+transform so the
     text movement syncs with the slide scroll. Reduced-motion: the
     prefers-reduced-motion block below disables the transition. */
  .hero-slide .hero-copy { opacity: .4; transform: translateY(8px); transition: opacity var(--motion-slow, 600ms) var(--ease-out, ease-out), transform var(--motion-slow, 600ms) var(--ease-out, ease-out); }
  .hero-slide.active .hero-copy { opacity: 1; transform: translateY(0); }
  /* Subtle image scale on the active slide (Ken Burns). Stays within
     object-fit: cover so no letterboxing appears. */
  .hero-slide .hero-image { transform: scale(1); transition: transform var(--motion-slow, 600ms) var(--ease-out, ease-out); }
  .hero-slide.active .hero-image { transform: scale(1.03); }
  .hero-kicker { color: var(--color-primary); font-size: .62rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; text-shadow: 0 0 12px rgba(0,255,156,.3); }
  .hero-copy h1 {
    margin: 8px 0 0; color: var(--color-text); font-size: clamp(2rem, 5.5vw, 3.8rem); font-weight: 900;
    letter-spacing: -.03em; line-height: .95; text-wrap: balance;
    text-shadow: 0 2px 16px rgba(0,0,0,.5);
  }
  .hero-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 10px; color: var(--color-text-muted); font-size: .74rem; font-weight: 500; }
  .hero-meta .rating { color: #ffc94d; font-weight: 700; }
  .dot { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: .5; }
  .hero-copy p {
    max-width: 460px; margin: 8px 0 0; color: var(--color-text-muted); font-size: .8rem; line-height: 1.5;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  }

  .hero-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .hero-play {
    display: inline-flex; align-items: center; gap: 7px; padding: 10px 24px; border-radius: 999px;
    color: #050708; font-size: .82rem; font-weight: 800; text-decoration: none;
    background: var(--color-primary); box-shadow: 0 4px 20px rgba(0,255,156,.22), var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .hero-play:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 6px 24px rgba(0,255,156,.32), var(--glow-primary); }
  .hero-play:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
  .hero-btn {
    display: inline-flex; align-items: center; gap: 5px; padding: 10px 16px; border-radius: 999px;
    color: var(--color-text); font-size: .76rem; font-weight: 700; text-decoration: none;
    background: var(--color-primary-soft); border: 1px solid var(--color-border-strong);
    backdrop-filter: blur(6px);
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .hero-btn:hover { background: var(--color-primary-soft); border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .hero-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .hero-btn.icon-only { padding: 10px 12px; }

  .hero-nav { position: absolute; right: clamp(16px, 4vw, 48px); bottom: 14px; z-index: 3; display: flex; align-items: center; gap: 6px; }
  .hero-nav-btn {
    display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--color-border-strong);
    border-radius: 50%; color: var(--color-text-muted); background: rgba(5,7,8,.55);
    backdrop-filter: blur(8px);
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); cursor: pointer;
  }
  .hero-nav-btn:hover { border-color: var(--color-primary-border); color: var(--color-text); background: rgba(5,7,8,.75); }
  .hero-nav-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .hero-dots { display: flex; align-items: center; gap: 4px; }
  .hero-dot { width: 18px; height: 18px; padding: 0; border: 0; background: transparent; cursor: pointer; }
  .hero-dot::after { content: ''; display: block; width: 5px; height: 5px; border-radius: 50%; background: rgba(242,255,248,.25); transition: all var(--motion-fast) var(--ease-out); }
  .hero-dot:hover::after { background: rgba(242,255,248,.5); }
  .hero-dot:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; border-radius: 50%; }
  .hero-dot.active::after { width: 16px; border-radius: 3px; background: var(--color-primary); box-shadow: var(--glow-primary); }
  .hero-fallback { min-height: 50vh; background: var(--color-bg); }

  /* === BODY === */
  .discover-body { padding: 0 0 40px; }

  /* Quick chips fill the full row width — three independent equal-flex buttons. */
  .quick-chips {
    display: flex; gap: 8px; width: 100%;
    padding: 14px var(--d-gutter) 0;
    box-sizing: border-box;
  }
  .quick-chips a {
    flex: 1 1 0; min-width: 0; height: 40px;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0 8px;
    border-radius: 10px; color: var(--color-text-muted); text-decoration: none;
    font-size: .74rem; font-weight: 700; letter-spacing: .01em;
    background: var(--color-surface-elevated); border: 1px solid var(--color-border);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .quick-chips a:hover { color: var(--color-text); background: var(--color-surface-raised); border-color: var(--color-primary-border); }
  .quick-chips a:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
  .quick-chips a:active { transform: scale(.98); }

  .catalog-warning { margin: 16px var(--d-gutter) 0; padding: 10px 12px; border: 1px solid rgba(255,194,71,.3); border-radius: var(--radius-sm); color: var(--color-warning); font-size: .7rem; }

  /* Tablet hero — slightly shorter than desktop, more compact copy. */
  @media (max-width: 900px) {
    .hero-slide { min-height: min(68vh, 540px); }
    .hero-content { min-height: min(68vh, 540px); padding-top: 70px; padding-bottom: 56px; }
  }

  /* Mobile hero — shorter height, larger gradient to keep title readable
     over the artwork, Play becomes full-width. */
  @media (max-width: 640px) {
    .hero-slide { min-height: 66vh; }
    .hero-image { object-position: center 12%; }
    .hero-scrim { background: linear-gradient(to bottom, transparent 25%, rgba(5,7,8,.4) 55%, var(--color-bg) 100%); }
    .hero-content { align-items: flex-end; min-height: 66vh; padding: 56px var(--d-gutter) 50px; }
    .hero-copy { max-width: none; }
    .hero-copy h1 { font-size: clamp(1.6rem, 7vw, 2.4rem); font-weight: 880; }
    .hero-copy p { font-size: .76rem; -webkit-line-clamp: 2; line-clamp: 2; }
    .hero-actions { gap: 6px; }
    .hero-play { flex: 1; justify-content: center; }
    .hero-nav-btn { display: none; }
    .hero-nav { right: 50%; transform: translateX(50%); bottom: 10px; }
    /* Quick chips keep equal-width split on every mobile viewport. */
    .quick-chips { gap: 6px; }
    .quick-chips a { height: 38px; font-size: .72rem; padding: 0 6px; }
  }

  /* Landscape mobile (max-height: 480px) — keep the hero compact so the
     title + Play stay above the fold. Don't push the rails below the
     visible viewport. */
  @media (max-width: 900px) and (orientation: landscape) and (max-height: 500px) {
    .hero-slide { min-height: auto; }
    .hero-content { min-height: auto; padding-top: 48px; padding-bottom: 22px; align-items: flex-end; }
    .hero-copy h1 { font-size: clamp(1.3rem, 3.4vw, 1.8rem); }
    .hero-copy p { -webkit-line-clamp: 1; line-clamp: 1; }
    .hero-actions { gap: 6px; margin-top: 10px; }
    .hero-play { flex: 1; justify-content: center; padding: 8px 18px; }
    .hero-nav { bottom: 6px; }
  }

  /* Large desktop / TV — wider container, larger hero typography,
     larger hero actions. The hero stays bounded so 4K doesn't look
     like an enlarged 1080p layout. */
  @media (min-width: 1900px) {
    .hero-slide { min-height: min(82vh, 760px); }
    .hero-content { min-height: min(82vh, 760px); padding: 120px clamp(48px, 6vw, 96px) 90px; }
    .hero-copy { max-width: 680px; }
    .hero-copy h1 { font-size: clamp(3rem, 4.4vw, 4.4rem); }
    .hero-copy p { max-width: 540px; font-size: .88rem; }
    .hero-play { padding: 12px 30px; font-size: .9rem; }
    .hero-btn { padding: 12px 20px; font-size: .8rem; }
    .hero-nav { right: clamp(40px, 4vw, 80px); bottom: 24px; }
    .hero-nav-btn { width: 38px; height: 38px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .hero-track { scroll-behavior: auto; }
    .hero-nav-btn, .hero-dot::after, .quick-chips a, .hero-play, .hero-btn { transition: none; }
    /* Phase D.E: disable the active-slide text fade-up and image Ken
       Burns scale when the user prefers reduced motion. The slides
       still change, but with no animation. */
    .hero-slide .hero-copy, .hero-slide.active .hero-copy { opacity: 1; transform: none; transition: none; }
    .hero-slide .hero-image, .hero-slide.active .hero-image { transform: none; transition: none; }
  }
</style>
