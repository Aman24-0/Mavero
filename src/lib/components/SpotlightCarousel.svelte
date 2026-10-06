<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ArrowLeft, ArrowRight, Info, Play } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import { haptic } from '$lib/client/haptics';

  // MAVERO — Explorer Spotlight Carousel (Movies / TV Shows / Anime
  // Explorer redesign, Change 1A; visual redesign + autoplay lifecycle
  // hardening per Follow-up task 2 §3/§4/§12).
  //
  // Cinematic hero composition — deliberate layout LAYERS, not
  // absolutely-positioned miscellany:
  //     1. media layer      (the scroll-snap slide track + artwork)
  //     2. scrim layer      (readability gradients)
  //     3. content layer    (title / meta / description / CTAs)
  //     4. edge nav layer   (prev arrow at the LEFT edge, next arrow at
  //                         the RIGHT edge — both vertically centered
  //                         against the media, glass/dark, same control
  //                         language as the ContentRail arrows but
  //                         slightly larger — the hero is the primary
  //                         control surface)
  //     5. pagination layer (dots at the BOTTOM CENTER, compact, clearly
  //                         separated from the CTA row — never touching
  //                         "More details")
  // The old bottom-right navigation capsule and the "MAVERO /
  // Spotlight" eyebrow are gone.
  //
  // AUTOPLAY LIFECYCLE (Follow-up task 2 §4 — the exact 4s contract):
  //   - ONE deterministic timer. On fire: advance, then RE-QUEUE (the
  //     old implementation advanced once and never re-queued — rotation
  //     silently stopped after the first tick).
  //   - Manual navigation (arrows, dots, keyboard) shows the slide
  //     immediately and RESETS the countdown — the next automatic
  //     transition is a full 4s later (never the old 8-12s release
  //     window).
  //   - Pointer over the carousel / keyboard focus inside it pauses;
  //     leaving resumes with a fresh 4s countdown. Visibility hidden
  //     clears the timer; returning re-queues. Reduced motion disables
  //     automatic movement entirely. No duplicate timers by
  //     construction (queueRotation always clears before setting).
  //
  // Responsive height is per-breakpoint (viewport width + height
  // aware): compact-but-cinematic on phones so the first rail begins
  // naturally, substantially more spacious on desktop/TV. Play /
  // More-details keep the existing route patterns (/watch/{type}/{id}
  // and /{type}/{id}) — playback preserved.

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
      // the normal cadence is exactly 4s forever (the old code stopped
      // after the first tick). While hidden, the visibilitychange
      // handler re-queues on return.
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
  // countdown). The old 8s "interaction release" window is gone.
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
    <!-- 1 + 2. media + scrim layers (the scroll-snap track) -->
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
          <!-- 3. content layer -->
          <div class="slide-content">
            <div class="slide-copy" aria-live={index === activeIndex ? 'polite' : 'off'}>
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
      <!-- 4. edge navigation layer — LEFT edge, vertically centered -->
      <button
        class="spotlight-arrow spotlight-arrow-prev"
        type="button"
        aria-label="Previous spotlight title"
        onclick={() => manualNav((activeIndex - 1 + slides.length) % slides.length)}
      >
        <ArrowLeft size={18} />
      </button>
      <!-- 4. edge navigation layer — RIGHT edge, vertically centered -->
      <button
        class="spotlight-arrow spotlight-arrow-next"
        type="button"
        aria-label="Next spotlight title"
        onclick={() => manualNav((activeIndex + 1) % slides.length)}
      >
        <ArrowRight size={18} />
      </button>

      <!-- 5. pagination layer — bottom center, independent of the CTA
           row, with deliberate separation (the content layer reserves
           the space via its bottom padding). -->
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
    /* Responsive cinematic height (Follow-up task 2 §3): one
       per-breakpoint model instead of a single fixed height —
       desktop/TV feel substantially more spacious; mobile stays
       compact enough that the first content rail begins naturally. */
    min-height: clamp(420px, 56dvh, 620px);
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
    /* Bottom padding reserves the pagination layer's space — the CTA
       row and the dots never touch (Follow-up task 2 §3). */
    padding: clamp(28px, 4.5vh, 52px) clamp(20px, 4vw, 48px) 92px;
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
  .slide-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
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

  /* ── 4. Edge navigation layer (§12) — the same glass/dark control
     language as the ContentRail arrows, slightly LARGER because the
     Spotlight is the primary hero control. Vertically centered against
     the media, clear of the copy block (the copy is width-capped at
     min(620px, 100%), so on ≥641px viewports the arrows never overlap
     the text). The carousel loops, so both arrows stay enabled. ── */
  .spotlight-arrow {
    position: absolute; top: 50%; transform: translateY(-50%);
    z-index: 5;
    display: grid; place-items: center;
    width: 46px; height: 46px;
    border: 1px solid var(--color-border-strong); border-radius: 14px;
    background: rgba(8, 11, 13, .72);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    color: var(--color-text);
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .spotlight-arrow:hover {
    color: var(--color-primary);
    background: rgba(0, 255, 156, .12);
    border-color: var(--color-primary-border);
    box-shadow: var(--glow-primary);
  }
  .spotlight-arrow:active { transform: translateY(-50%) scale(.96); }
  .spotlight-arrow:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .spotlight-arrow-prev { left: clamp(12px, 2vw, 24px); }
  .spotlight-arrow-next { right: clamp(12px, 2vw, 24px); }

  /* ── 5. Pagination layer — bottom CENTER, compact, independent of
     the CTA row. No capsule/pill container (§3: no giant pill unless
     the design benefits — it doesn't here). ── */
  .spotlight-dots {
    position: absolute; bottom: 22px; left: 50%; transform: translateX(-50%);
    z-index: 5;
    display: flex; align-items: center; gap: 7px;
  }
  .spotlight-dot {
    width: 8px; height: 8px; padding: 0;
    border: none; border-radius: 999px;
    background: rgba(255, 255, 255, .32);
    cursor: pointer;
    transition: background var(--motion-fast), width var(--motion-fast), box-shadow var(--motion-fast);
  }
  .spotlight-dot:hover { background: rgba(255, 255, 255, .6); }
  .spotlight-dot.active {
    width: 20px;
    background: var(--color-primary);
    box-shadow: 0 0 10px rgba(0, 255, 156, .5);
  }
  .spotlight-dot:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Tablet 641–1024px: roomier than phones, tighter than desktop. ── */
  @media (min-width: 641px) and (max-width: 1024px) {
    .spotlight-slide { min-height: clamp(360px, 48dvh, 480px); }
    .slide-content { padding: clamp(24px, 4vh, 40px) clamp(18px, 3.5vw, 36px) 84px; }
  }

  /* ── Mobile ≤640px: cinematic but compact — the first content rail
     still begins naturally. Native swipe stays the primary navigation
     (the edge arrows stay desktop/tablet-only, matching the
     ContentRail contract); the dots remain for direct selection. ── */
  @media (max-width: 640px) {
    .spotlight { width: 90%; border-radius: 14px; }
    .spotlight-slide { min-height: clamp(300px, 44dvh, 400px); }
    .slide-content { padding: 18px 18px 64px; }
    .slide-desc { -webkit-line-clamp: 2; line-clamp: 2; font-size: .76rem; }
    .slide-play, .slide-more { flex: 0 1 auto; padding: 0 16px; }
    .slide-actions { margin-top: 10px; }
    .spotlight-arrow { display: none; }
    .spotlight-dots { bottom: 16px; gap: 6px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .slide-media img { animation: none; }
    .spotlight-track { scroll-behavior: auto; }
    .slide-play, .slide-more, .spotlight-dot, .spotlight-arrow { transition: none; }
  }
</style>
