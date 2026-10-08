<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ArrowLeft, ArrowRight, Info, Play } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import { haptic } from '$lib/client/haptics';

  // MAVERO — Explorer Spotlight Carousel (Movies / TV Shows / Anime).
  //
  // LT-18 — cinematic full-bleed hero redesign. The old presentation was a
  // centered 90%-width closed card (border + radius + shadow + hard-edge
  // scrim), which read as a boxed dashboard widget next to Discover's hero.
  // The carousel now speaks Discover's VISUAL DESIGN LANGUAGE (DiscoverPage
  // is the reference implementation and stays untouched):
  //
  //     * full-width backdrop bleeding to the viewport edges (no border,
  //       no radius, no shadow, no max-width box);
  //     * viewport-height slides (min(78vh, 680px) desktop, 66vh mobile)
  //       instead of card heights;
  //     * the bottom scrim DISSOLVES into the page background — no visible
  //       bottom edge;
  //     * content anchored bottom-left: kicker (Movie/Series/Anime),
  //       prominent title, rating/year/genre metadata line, 2-line
  //       description, Play + More details;
  //     * cinematic pagination cluster at the BOTTOM RIGHT (prev · dots ·
  //       next; mobile keeps centered dots only);
  //     * active-slide treatment (copy fade-up + a gentle Ken Burns scale)
  //       instead of the old infinite drift;
  //     * 100vw-sized lazy artwork for non-active slides.
  //
  // UNCHANGED (the LT-18 §5 preserve list): the public props and data
  // contract (items/ariaLabel), the 6-slide lineup window, the 4s autoplay
  // lifecycle, keyboard controls, reduced-motion support, accessibility,
  // the /watch/{type}/{id} + /{type}/{id} route links, and the server
  // loader/filters architecture below the hero.
  //
  // AUTOPLAY LIFECYCLE (Follow-up task 2 §4 — the exact 4s contract):
  //   - ONE deterministic timer. On fire: advance, then RE-QUEUE.
  //   - Manual navigation (arrows, dots, keyboard) shows the slide
  //     immediately and RESETS the countdown to a full 4s.
  //   - Pointer over the carousel / keyboard focus inside it pauses;
  //     leaving resumes with a fresh 4s countdown. Visibility hidden
  //     clears the timer; returning re-queues. Reduced motion disables
  //     automatic movement entirely. No duplicate timers by construction
  //     (queueRotation always clears before setting).

  let {
    items = [],
    ariaLabel = 'Spotlight'
  }: {
    items?: MediaItem[];
    ariaLabel?: string;
  } = $props();

  const SPOTLIGHT_ROTATION_MS = 4000;
  const MAX_SLIDES = 6;

  let slides = $derived(items.slice(0, MAX_SLIDES));

  let track: HTMLElement | undefined = $state();
  let activeIndex = $state(0);
  let paused = false;
  let reducedMotion = false;
  let motionQuery: MediaQueryList | undefined;
  let rotationTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  let activeSlide = $derived(slides[activeIndex]);

  // The kicker label — the same truthful type-derived category Discover's
  // hero shows (Movie / Series / Anime from the item's own type field).
  function kickerFor(item: MediaItem): string {
    return item.type === 'movie' ? 'Movie' : item.type === 'series' ? 'Series' : 'Anime';
  }

  function clearTimers() {
    if (rotationTimer) clearTimeout(rotationTimer);
    if (scrollTimer) clearTimeout(scrollTimer);
    rotationTimer = undefined;
    scrollTimer = undefined;
  }

  // ONE rotation entry point: always clears any pending timer first —
  // duplicate timers are impossible by construction.
  function queueRotation() {
    if (slides.length < 2 || paused || reducedMotion || destroyed) return;
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      rotationTimer = undefined;
      if (paused || reducedMotion || destroyed || document.hidden) return;
      scrollToSlide((activeIndex + 1) % slides.length, true);
      // THE lifecycle fix: re-queue after every automatic advance so
      // the normal cadence is exactly 4s forever.
      queueRotation();
    }, SPOTLIGHT_ROTATION_MS);
  }

  function pause() {
    paused = true;
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = undefined;
  }

  function resume() {
    paused = false;
    queueRotation();
  }

  function scrollToSlide(index: number, notify = false) {
    if (!track || slides.length === 0) return;
    activeIndex = index;
    track.scrollTo({ left: track.clientWidth * index, behavior: reducedMotion ? 'auto' : 'smooth' });
    if (notify) haptic('light');
  }

  // Manual navigation: the slide shows IMMEDIATELY and the countdown
  // RESETS to a full 4s (a no-op while the user is actively hovering /
  // focused — leaving the interaction area resumes with a fresh
  // countdown).
  function manualNav(index: number) {
    scrollToSlide(index, true);
    queueRotation();
  }

  function handleScroll() {
    if (!track || slides.length === 0) return;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (!track) return;
      const newIndex = Math.round(track.scrollLeft / track.clientWidth);
      if (newIndex !== activeIndex) {
        activeIndex = newIndex;
        haptic('light');
      }
    }, 150);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!slides.length) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); manualNav((activeIndex + 1) % slides.length); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); manualNav((activeIndex - 1 + slides.length) % slides.length); }
    else if (event.key === 'Home') { event.preventDefault(); manualNav(0); }
    else if (event.key === 'End') { event.preventDefault(); manualNav(slides.length - 1); }
    else if (event.key === ' ') { event.preventDefault(); if (paused) resume(); else pause(); }
  }

  function handleVisibility() {
    if (document.hidden) {
      if (rotationTimer) clearTimeout(rotationTimer);
      rotationTimer = undefined;
    } else if (!paused) {
      queueRotation();
    }
  }

  function handleMotionChange(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
    if (reducedMotion) {
      if (rotationTimer) clearTimeout(rotationTimer);
      rotationTimer = undefined;
    } else if (!paused) {
      queueRotation();
    }
  }

  // Clamp activeIndex when the slide set shrinks (e.g. data refresh).
  $effect(() => {
    if (activeIndex >= slides.length && slides.length) activeIndex = 0;
  });

  onMount(() => {
    destroyed = false;
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = motionQuery.matches;
    motionQuery.addEventListener?.('change', handleMotionChange);
    document.addEventListener('visibilitychange', handleVisibility);
    queueRotation();
    return () => {
      destroyed = true;
      clearTimers();
      motionQuery?.removeEventListener?.('change', handleMotionChange);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  });

  onDestroy(() => {
    destroyed = true;
    clearTimers();
  });
</script>

{#if slides.length > 0}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <section
    class="spotlight"
    aria-roledescription="carousel"
    aria-label={ariaLabel}
    tabindex="0"
    onpointerenter={pause}
    onpointerleave={resume}
    onfocusin={pause}
    onfocusout={resume}
    onkeydown={handleKeydown}
  >
    <!-- media + scrim layers (the scroll-snap track) -->
    <div class="spotlight-track" bind:this={track} onscroll={handleScroll}>
      {#each slides as slide, index (slide.type + ':' + slide.id)}
        <div class="spotlight-slide" class:active={index === activeIndex}>
          <div class="slide-media" aria-hidden="true">
            {#if slide.backdrop?.trim() || slide.poster?.trim()}
              <picture>
                <!-- Responsive hero artwork (Discover's contract): smaller
                     backdrop on standard-DPI phones, sharper on retina and
                     desktop; 100vw-sized, eager only for the first slide. -->
                <source media="(max-width: 640px) and (-webkit-min-device-pixel-ratio: 2), (max-width: 640px) and (min-resolution: 192dpi)" srcset={slide.backdrop || slide.backdropSmall || slide.poster} />
                <source media="(max-width: 640px)" srcset={slide.backdropSmall || slide.backdrop || slide.poster} />
                <source media="(min-width: 641px)" srcset={slide.backdropHero || slide.backdrop || slide.backdropSmall || slide.poster} />
                <img
                  src={slide.backdrop || slide.poster}
                  alt=""
                  width="1280"
                  height="720"
                  sizes="100vw"
                  loading={index === 0 ? 'eager' : 'lazy'}
                  fetchpriority={index === 0 ? 'high' : 'auto'}
                  decoding="async"
                />
              </picture>
            {/if}
          </div>
          <div class="slide-scrim" aria-hidden="true"></div>
          <!-- content layer — anchored bottom-left -->
          <div class="slide-content">
            <div class="slide-copy" aria-live={index === activeIndex ? 'polite' : 'off'}>
              <div class="slide-kicker">{kickerFor(slide)}</div>
              <h2 class="slide-title">{slide.title}</h2>
              <div class="slide-meta">
                {#if slide.rating > 0}<span class="rating">★ {slide.rating.toFixed(1)}</span>{/if}
                {#if slide.year > 0}<span>{slide.year}</span>{/if}
                {#if slide.genres?.length}<span class="dot"></span><span>{slide.genres.slice(0, 2).join(' · ')}</span>{/if}
              </div>
              {#if slide.description?.trim()}
                <p class="slide-desc">{slide.description.trim()}</p>
              {/if}
              <div class="slide-actions">
                <a class="slide-play" href={`/watch/${slide.type}/${slide.id}`}>
                  <Play size={15} fill="currentColor" strokeWidth={0} /> Play
                </a>
                <a class="slide-more" href={`/${slide.type}/${slide.id}`} aria-label={`Details for ${slide.title}`}>
                  <Info size={14} /> More details
                </a>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>

    {#if slides.length > 1}
      <!-- cinematic pagination cluster — bottom right (Discover's hero-nav
           language): prev · dots · next in one row; mobile keeps the dots
           centered and drops the arrows (native swipe stays primary). -->
      <div class="spotlight-nav">
        <button class="spotlight-nav-btn" type="button" aria-label="Previous spotlight title" onclick={() => manualNav((activeIndex - 1 + slides.length) % slides.length)}>
          <ArrowLeft size={13} />
        </button>
        <div class="spotlight-dots" role="tablist" aria-label="Choose spotlight title">
          {#each slides as slide, index (slide.type + ':' + slide.id)}
            <button
              class:active={index === activeIndex}
              class="spotlight-dot"
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              aria-label={`Show ${slide.title}`}
              onclick={() => manualNav(index)}
            ></button>
          {/each}
        </div>
        <button class="spotlight-nav-btn" type="button" aria-label="Next spotlight title" onclick={() => manualNav((activeIndex + 1) % slides.length)}>
          <ArrowRight size={13} />
        </button>
      </div>
    {/if}
  </section>
{/if}

<style>
  /* ── Cinematic full-bleed hero (LT-18): the backdrop bleeds to the
     viewport edges — no border, no radius, no shadow, no width cap, no
     closed-card framing. The bottom scrim dissolves into the page
     background so the hero merges with the Explorer below. ── */
  .spotlight {
    position: relative;
    width: 100%;
    overflow: hidden;
    background: var(--color-bg);
    isolation: isolate;
  }

  .spotlight-track {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    scroll-behavior: smooth;
  }
  .spotlight-track::-webkit-scrollbar { display: none; }

  .spotlight-slide {
    position: relative;
    flex: 0 0 100%;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    /* Viewport-height hero (Discover's model): dominant on desktop/TV,
       shorter on tablets/phones so the first content rail still begins
       naturally. */
    min-height: min(78vh, 680px);
    overflow: hidden;
    display: flex;
    align-items: flex-end;
  }
  .slide-media { position: absolute; inset: 0; z-index: -2; overflow: hidden; }
  .slide-media img {
    position: absolute;
    inset: 0;
    width: 100%; height: 100%;
    object-fit: cover;
    object-position: center 18%;
    transform: scale(1);
    transition: transform var(--motion-slow, 600ms) var(--ease-out, ease-out);
  }
  /* Active-slide treatment: a gentle Ken Burns scale on the artwork (the
     old infinite drift animation is gone — reduced-motion disables this). */
  .spotlight-slide.active .slide-media img { transform: scale(1.03); }

  /* The scrim fades into the page background — no hard bottom edge, the
     same gradient contract as Discover's hero. */
  .slide-scrim {
    position: absolute; inset: 0; z-index: -1;
    background: linear-gradient(to bottom, transparent 35%, rgba(5, 7, 8, .35) 60%, var(--color-bg) 100%);
  }

  .slide-content {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: flex-end;
    width: 100%;
    /* Bottom padding reserves the pagination cluster's space. */
    padding: 90px clamp(16px, 5vw, 56px) 72px;
  }
  .slide-copy {
    max-width: 560px;
    opacity: .4;
    transform: translateY(8px);
    transition: opacity var(--motion-slow, 600ms) var(--ease-out, ease-out), transform var(--motion-slow, 600ms) var(--ease-out, ease-out);
  }
  .spotlight-slide.active .slide-copy { opacity: 1; transform: translateY(0); }

  .slide-kicker {
    color: var(--color-primary);
    font-size: .62rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    text-shadow: 0 0 12px rgba(0, 255, 156, .3);
  }
  .slide-title {
    margin: 8px 0 0;
    color: var(--color-text);
    font-size: clamp(2rem, 5.5vw, 3.8rem);
    font-weight: 900;
    letter-spacing: -.03em;
    line-height: .95;
    text-wrap: balance;
    text-shadow: 0 2px 16px rgba(0, 0, 0, .5);
  }
  .slide-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
    margin-top: 10px;
    color: var(--color-text-muted);
    font-size: .74rem;
    font-weight: 500;
  }
  .slide-meta .rating { color: #ffc94d; font-weight: 700; }
  .slide-meta .dot { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: .5; }
  .slide-desc {
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
    max-width: 460px;
    margin: 8px 0 0;
    color: var(--color-text-muted);
    font-size: .8rem;
    line-height: 1.5;
  }

  .slide-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .slide-play, .slide-more {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 44px; padding: 10px 24px;
    border-radius: 999px;
    font-size: .82rem; font-weight: 800; letter-spacing: .01em;
    text-decoration: none;
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .slide-play {
    color: #050708;
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
    box-shadow: 0 4px 20px rgba(0, 255, 156, .22), var(--glow-primary);
  }
  .slide-play:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .slide-play:active { transform: scale(.98); }
  .slide-more {
    color: var(--color-text);
    background: rgba(8, 11, 13, .55);
    border: 1px solid rgba(255, 255, 255, .14);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .slide-more:hover { border-color: rgba(255, 255, 255, .3); background: rgba(8, 11, 13, .75); }
  .slide-play:focus-visible, .slide-more:focus-visible, .spotlight:focus-visible {
    outline: 2px solid var(--color-focus); outline-offset: 3px;
  }

  /* ── Cinematic pagination cluster — bottom RIGHT (Discover's hero-nav):
     prev · dots · next in one row; compact glass buttons. ── */
  .spotlight-nav {
    position: absolute;
    right: clamp(16px, 4vw, 48px);
    bottom: 14px;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .spotlight-nav-btn {
    display: grid; place-items: center;
    width: 32px; height: 32px;
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
    color: var(--color-text-muted);
    background: rgba(5, 7, 8, .55);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  }
  .spotlight-nav-btn:hover { border-color: var(--color-primary-border); color: var(--color-text); background: rgba(5, 7, 8, .75); }
  .spotlight-nav-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .spotlight-dots { display: flex; align-items: center; gap: 4px; }
  .spotlight-dot {
    width: 18px; height: 18px; padding: 0;
    border: 0; border-radius: 50%;
    background: transparent;
    cursor: pointer;
  }
  .spotlight-dot::after {
    content: '';
    display: block;
    width: 5px; height: 5px;
    margin-inline: auto;
    border-radius: 50%;
    background: rgba(242, 255, 248, .25);
    transition: all var(--motion-fast) var(--ease-out);
  }
  .spotlight-dot:hover::after { background: rgba(242, 255, 248, .5); }
  .spotlight-dot:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; border-radius: 50%; }
  .spotlight-dot.active::after {
    width: 16px;
    border-radius: 3px;
    background: var(--color-primary);
    box-shadow: var(--glow-primary);
  }

  /* ── Tablet — slightly shorter than desktop (Discover's breakpoint). ── */
  @media (max-width: 900px) {
    .spotlight-slide { min-height: min(68vh, 540px); }
    .slide-content { padding: 70px clamp(16px, 5vw, 48px) 56px; }
  }

  /* ── Mobile — shorter hero, larger scrim share for readability, Play
     grows, arrows drop (native swipe stays primary), dots center. ── */
  @media (max-width: 640px) {
    .spotlight-slide { min-height: 66vh; }
    .slide-media img { object-position: center 12%; }
    .slide-scrim { background: linear-gradient(to bottom, transparent 25%, rgba(5, 7, 8, .4) 55%, var(--color-bg) 100%); }
    .slide-content { padding: 56px var(--d-gutter, clamp(16px, 5vw, 48px)) 50px; }
    .slide-copy { max-width: none; }
    .slide-title { font-size: clamp(1.6rem, 7vw, 2.4rem); font-weight: 880; }
    .slide-desc { font-size: .76rem; -webkit-line-clamp: 2; line-clamp: 2; }
    .slide-actions { gap: 6px; }
    .slide-play { flex: 1; justify-content: center; padding: 10px 18px; }
    .spotlight-nav-btn { display: none; }
    .spotlight-nav { right: 50%; transform: translateX(50%); bottom: 10px; }
  }

  /* ── Landscape mobile — compact so title + Play stay above the fold. ── */
  @media (max-width: 900px) and (orientation: landscape) and (max-height: 500px) {
    .spotlight-slide { min-height: auto; }
    .slide-content { padding: 48px clamp(16px, 5vw, 48px) 22px; align-items: flex-end; }
    .slide-title { font-size: clamp(1.3rem, 3.4vw, 1.8rem); }
    .slide-desc { -webkit-line-clamp: 1; line-clamp: 1; }
    .slide-actions { gap: 6px; margin-top: 10px; }
    .slide-play { flex: 1; justify-content: center; padding: 8px 18px; }
    .spotlight-nav { bottom: 6px; }
  }

  /* ── Large desktop / TV — the hero stays bounded so 4K doesn't look
     like an enlarged 1080p layout (Discover's ≥1900px contract). ── */
  @media (min-width: 1900px) {
    .spotlight-slide { min-height: min(82vh, 760px); }
    .slide-content { padding: 120px clamp(48px, 6vw, 96px) 90px; }
    .slide-copy { max-width: 680px; }
    .slide-title { font-size: clamp(3rem, 4.4vw, 4.4rem); }
    .slide-desc { max-width: 540px; font-size: .88rem; }
    .spotlight-nav { right: clamp(40px, 4vw, 80px); bottom: 24px; }
    .spotlight-nav-btn { width: 38px; height: 38px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .spotlight-track { scroll-behavior: auto; }
    .slide-play, .slide-more, .spotlight-dot::after, .spotlight-nav-btn { transition: none; }
    /* No active-slide animation: the slides still change, but nothing
       moves on its own. */
    .slide-media img, .spotlight-slide.active .slide-media img { transform: none; transition: none; }
    .slide-copy, .spotlight-slide.active .slide-copy { opacity: 1; transform: none; transition: none; }
  }
</style>
