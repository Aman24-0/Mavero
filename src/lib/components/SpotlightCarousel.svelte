<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ArrowLeft, ArrowRight, Clapperboard, Info, Play } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import { haptic } from '$lib/client/haptics';

  // MAVERO — Explorer Spotlight Carousel (Movies / TV Shows / Anime
  // Explorer redesign, Change 1A).
  //
  // A cinematic 6-slide carousel at the top of each Explorer page:
  //   - Exactly up to 6 slides in the data/rendering window (the server
  //     lineup targets 6; fewer only when the catalog is genuinely thin).
  //   - Auto-rotates every 4 seconds (SPOTLIGHT_ROTATION_MS).
  //   - Occupies ~90% of the available viewport width (width: 90%;
  //     margin-inline: auto) with a capped max for very wide screens.
  //   - Responsive at every breakpoint — no hardcoded dimensions that
  //     break large/small viewports (height is clamp/vh based).
  //   - Honors prefers-reduced-motion (no auto rotation, no smooth
  //     scroll, no entry animation) — the app-wide contract.
  //   - Play / More-details navigation uses the EXISTING route patterns
  //     (/watch/{type}/{id} and /{type}/{id}) — playback preserved.
  //
  // Interaction contracts mirror the Discover hero gallery (pointer/
  // focus pause, visibility pause, keyboard arrows/Home/End/Space,
  // scroll-snap track, dots + prev/next buttons) — the established
  // carousel a11y pattern in this codebase.

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
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let isScrolling = false;
  let destroyed = false;

  let activeSlide = $derived(slides[activeIndex]);
  let activeImage = $derived(activeSlide?.backdrop?.trim() || activeSlide?.poster?.trim() || '');

  function metaLine(item: MediaItem): string {
    return [
      item.year ? String(item.year) : '',
      item.rating ? `★ ${item.rating.toFixed(1)}` : '',
      ...(item.genres ?? []).slice(0, 2)
    ].filter(Boolean).join('  ·  ');
  }

  function clearTimers() {
    if (rotationTimer) clearTimeout(rotationTimer);
    if (releaseTimer) clearTimeout(releaseTimer);
    if (scrollTimer) clearTimeout(scrollTimer);
    rotationTimer = undefined;
    releaseTimer = undefined;
    scrollTimer = undefined;
  }

  function queueRotation() {
    if (slides.length < 2 || paused || reducedMotion || destroyed) return;
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      rotationTimer = undefined;
      if (!paused && !document.hidden) {
        scrollToSlide((activeIndex + 1) % slides.length, true);
      }
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

  function releaseInteractionPause() {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;
      resume();
    }, SPOTLIGHT_ROTATION_MS * 2);
  }

  function scrollToSlide(index: number, notify = false) {
    if (!track || slides.length === 0) return;
    activeIndex = index;
    track.scrollTo({ left: track.clientWidth * index, behavior: reducedMotion ? 'auto' : 'smooth' });
    if (notify) haptic('light');
  }

  function handleScroll() {
    if (!track || slides.length === 0) return;
    isScrolling = true;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      isScrolling = false;
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
    if (event.key === 'ArrowRight') { event.preventDefault(); pause(); releaseInteractionPause(); scrollToSlide((activeIndex + 1) % slides.length, true); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); pause(); releaseInteractionPause(); scrollToSlide((activeIndex - 1 + slides.length) % slides.length, true); }
    else if (event.key === 'Home') { event.preventDefault(); pause(); releaseInteractionPause(); scrollToSlide(0, true); }
    else if (event.key === 'End') { event.preventDefault(); pause(); releaseInteractionPause(); scrollToSlide(slides.length - 1, true); }
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
    <div class="spotlight-track" bind:this={track} onscroll={handleScroll}>
      {#each slides as slide, index (slide.type + ':' + slide.id)}
        <div class="spotlight-slide" class:active={index === activeIndex}>
          <div class="slide-media" aria-hidden="true">
            {#if slide.backdrop?.trim() || slide.poster?.trim()}
              <picture>
                <source media="(max-width: 640px)" srcset={slide.backdropSmall || slide.backdrop || slide.poster} />
                <source media="(min-width: 641px)" srcset={slide.backdrop || slide.backdropSmall || slide.poster} />
                <img
                  src={slide.backdrop || slide.poster}
                  alt=""
                  width="1280"
                  height="720"
                  sizes="(max-width: 640px) 90vw, 1280px"
                  loading={index === 0 ? 'eager' : 'lazy'}
                  fetchpriority={index === 0 ? 'high' : 'auto'}
                  decoding="async"
                />
              </picture>
            {/if}
          </div>
          <div class="slide-scrim" aria-hidden="true"></div>
          <div class="slide-content">
            <div class="slide-copy" aria-live={index === activeIndex ? 'polite' : 'off'}>
              <div class="slide-eyebrow"><Clapperboard size={12} /> MAVERO / Spotlight</div>
              <h2 class="slide-title">{slide.title}</h2>
              {#if metaLine(slide)}<p class="slide-meta">{metaLine(slide)}</p>{/if}
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
      <div class="spotlight-nav">
        <button class="spotlight-nav-btn" type="button" aria-label="Previous spotlight title" onclick={() => { pause(); releaseInteractionPause(); scrollToSlide((activeIndex - 1 + slides.length) % slides.length, true); }}>
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
              onclick={() => { pause(); releaseInteractionPause(); scrollToSlide(index, true); }}
            ></button>
          {/each}
        </div>
        <button class="spotlight-nav-btn" type="button" aria-label="Next spotlight title" onclick={() => { pause(); releaseInteractionPause(); scrollToSlide((activeIndex + 1) % slides.length, true); }}>
          <ArrowRight size={13} />
        </button>
      </div>
    {/if}
  </section>
{/if}

<style>
  /* ~90% of the available viewport width, centered — the spec's
     cinematic presentation target. The max cap keeps line lengths and
     artwork quality sane on TV-sized/4K viewports. */
  .spotlight {
    position: relative;
    width: 90%;
    max-width: 1480px;
    margin-inline: auto;
    border-radius: clamp(12px, 1.6vw, 20px);
    overflow: hidden;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    box-shadow: 0 24px 64px rgba(0, 0, 0, .45);
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
    /* Height adapts to the viewport (cinematic on every breakpoint —
       no hardcoded pixel dimensions). */
    min-height: clamp(300px, 46vh, 480px);
    display: flex;
    align-items: flex-end;
    overflow: hidden;
  }
  .slide-media { position: absolute; inset: 0; z-index: -2; }
  .slide-media img {
    width: 100%; height: 100%;
    object-fit: cover;
    object-position: center 20%;
    transform: scale(1.02);
    animation: slide-drift 18s ease-in-out infinite alternate;
  }
  @keyframes slide-drift {
    from { transform: scale(1.02) translateX(0); }
    to { transform: scale(1.06) translateX(-1.25%); }
  }
  .slide-scrim {
    position: absolute; inset: 0; z-index: -1;
    background:
      linear-gradient(to top, rgba(4, 6, 8, .96) 10%, rgba(4, 6, 8, .5) 46%, rgba(4, 6, 8, .16) 78%, rgba(4, 6, 8, .3) 100%),
      linear-gradient(to right, rgba(4, 6, 8, .7), transparent 62%);
  }
  .slide-content {
    display: grid;
    width: min(620px, 100%);
    padding: clamp(18px, 3.6vw, 40px) clamp(16px, 4vw, 44px) clamp(18px, 3.4vw, 38px);
  }
  .slide-eyebrow {
    display: inline-flex; align-items: center; gap: 7px;
    color: var(--color-primary);
    font-size: .6rem; font-weight: 800;
    letter-spacing: .14em; text-transform: uppercase;
    text-shadow: 0 0 12px rgba(0, 255, 156, .35);
  }
  .slide-title {
    margin: 0;
    color: #f5f5f5;
    font-size: clamp(1.6rem, 4.2vw, 3rem);
    font-weight: 880; line-height: 1.04; letter-spacing: -.025em;
    text-wrap: balance;
    text-shadow: 0 2px 24px rgba(0, 0, 0, .6);
  }
  .slide-meta {
    margin: 0;
    color: #c7c7cd;
    font-size: .76rem; font-weight: 700; letter-spacing: .02em;
  }
  .slide-desc {
    margin: 0;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
    color: #9a9aa2;
    font-size: .8rem; line-height: 1.6;
    max-width: 520px;
  }
  .slide-actions { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
  .slide-play, .slide-more {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 44px; padding: 0 20px;
    border-radius: 999px;
    font-size: .78rem; font-weight: 800; letter-spacing: .01em;
    text-decoration: none;
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .slide-play {
    color: #050708;
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
    box-shadow: var(--glow-primary);
  }
  .slide-play:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .slide-play:active { transform: scale(.98); }
  .slide-more {
    color: #e7e7ea;
    background: rgba(8, 11, 13, .55);
    border: 1px solid rgba(255, 255, 255, .14);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .slide-more:hover { border-color: rgba(255, 255, 255, .3); background: rgba(8, 11, 13, .75); }
  .slide-play:focus-visible, .slide-more:focus-visible, .spotlight:focus-visible {
    outline: 2px solid var(--color-focus); outline-offset: 2px;
  }

  /* Nav + dots */
  .spotlight-nav {
    position: absolute; bottom: 12px; right: clamp(12px, 2.4vw, 24px); z-index: 5;
    display: flex; align-items: center; gap: 10px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(4, 6, 8, .55);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, .1);
  }
  .spotlight-nav-btn {
    display: grid; place-items: center;
    width: 30px; height: 30px;
    border: 1px solid transparent; border-radius: 8px;
    color: #e7e7ea; background: transparent; cursor: pointer;
    transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast);
  }
  .spotlight-nav-btn:hover { color: var(--color-primary); background: rgba(255, 255, 255, .08); }
  .spotlight-nav-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .spotlight-dots { display: flex; align-items: center; gap: 6px; }
  .spotlight-dot {
    width: 7px; height: 7px; padding: 0;
    border: none; border-radius: 999px;
    background: rgba(255, 255, 255, .32);
    cursor: pointer;
    transition: background var(--motion-fast), width var(--motion-fast), box-shadow var(--motion-fast);
  }
  .spotlight-dot:hover { background: rgba(255, 255, 255, .6); }
  .spotlight-dot.active {
    width: 18px;
    background: var(--color-primary);
    box-shadow: 0 0 10px rgba(0, 255, 156, .5);
  }
  .spotlight-dot:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Mobile: the ~90% width + cinematic treatment still hold; copy
     tightens so the carousel never eats the whole viewport. ── */
  @media (max-width: 640px) {
    .spotlight { width: 90%; border-radius: 14px; }
    .spotlight-slide { min-height: clamp(280px, 42vh, 380px); }
    .slide-content { padding: 16px 16px 54px; }
    .slide-desc { -webkit-line-clamp: 2; line-clamp: 2; font-size: .76rem; }
    .slide-play, .slide-more { flex: 0 1 auto; padding: 0 16px; }
    .spotlight-nav { bottom: 10px; right: 10px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .slide-media img { animation: none; }
    .spotlight-track { scroll-behavior: auto; }
    .slide-play, .slide-more, .spotlight-dot, .spotlight-nav-btn { transition: none; }
  }
</style>
