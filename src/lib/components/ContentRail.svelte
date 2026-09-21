<script lang="ts">
  import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-svelte';
  import type { MediaItem } from '$lib/data/content';
  import MediaCard from '$components/MediaCard.svelte';

  let {
    title,
    eyebrow = '',
    items = [],
    href = '',
    compact = false,
    variant = 'default'
  }: {
    title: string;
    eyebrow?: string;
    items?: MediaItem[];
    href?: string;
    compact?: boolean;
    variant?: 'default' | 'editorial';
  } = $props();

  let railEl: HTMLElement;

  const railId = $derived(`rail-${title.toLowerCase().replaceAll(' ', '-')}`);

  function scrollByCard(direction: 1 | -1) {
    if (!railEl) return;
    // Walk the first item to find its measured width (including gap),
    // then scroll by ~2 cards in the requested direction. Falls back
    // to a fraction of the visible width if the first child isn't ready.
    const firstChild = railEl.querySelector<HTMLElement>(':scope > * > *');
    const step = firstChild
      ? firstChild.getBoundingClientRect().width +
        parseFloat(getComputedStyle(railEl).gap || '0')
      : railEl.clientWidth * 0.6;
    railEl.scrollBy({ left: direction * step * 2, behavior: 'smooth' });
  }
</script>

<section
  class="section"
  class:editorial={variant === 'editorial'}
  aria-labelledby={railId}
>
  <div class="section-head">
    <div class="section-heading-copy">
      {#if eyebrow}<div class="eyebrow">{eyebrow}</div>{/if}
      <h2 class="section-title" id={railId}>{title}</h2>
    </div>
    {#if href}
      <a class="section-link" href={href} aria-label={`View all ${title}`}>
        View all <ArrowRight size={13} />
      </a>
    {/if}
  </div>

  <div class="rail-wrap">
    <!-- Rail navigation arrows. Only visible on hover/focus and only on
         pointer devices — touch users scroll natively. Arrows sit OUTSIDE
         the rail viewport so they never overlap poster content. -->
    <button
      type="button"
      class="rail-nav rail-nav-prev"
      aria-label={`Scroll ${title} left`}
      onclick={() => scrollByCard(-1)}
    >
      <ChevronLeft size={18} />
    </button>
    <button
      type="button"
      class="rail-nav rail-nav-next"
      aria-label={`Scroll ${title} right`}
      onclick={() => scrollByCard(1)}
    >
      <ChevronRight size={18} />
    </button>

    <div
      class="rail"
      class:compact
      bind:this={railEl}
      role="list"
      aria-label={title}
    >
      {#each items as item (item.type + ':' + item.id)}
        <div role="listitem"><MediaCard {item} {compact} editorial={variant === 'editorial'} /></div>
      {/each}
    </div>
  </div>
</section>

<style>
  /* The rail container is intentionally full-bleed inside its parent so
     that the rail scrolls to the viewport edges. The header above stays
     aligned with the parent's content padding. */
  .section { margin-top: clamp(28px, 4vw, 46px); }
  .section.editorial { margin-top: clamp(36px, 5vw, 56px); }

  .section-head {
    display: flex; align-items: end; justify-content: space-between; gap: 16px;
    margin-bottom: 14px;
    padding: 0 var(--d-gutter, clamp(16px, 5vw, 48px));
  }
  .section-heading-copy { display: flex; flex-direction: column; gap: 2px; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 7px;
    color: var(--color-primary);
    font-size: .58rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
    text-shadow: 0 0 10px rgba(0, 255, 156, .3);
  }
  .section-title {
    margin: 4px 0 0;
    color: var(--color-text);
    font-size: clamp(1.1rem, 1.8vw, 1.45rem);
    font-weight: 800; letter-spacing: -.02em;
  }
  .section-link {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 6px 2px;
    color: var(--color-text-muted);
    text-decoration: none; font-size: .72rem; font-weight: 700;
    flex: 0 0 auto;
    transition: color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .section-link:hover { color: var(--color-primary); transform: translateX(3px); }
  .section-link:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; border-radius: 4px; }
  .section-link :global(svg) { transition: transform var(--motion-fast) var(--ease-out); }
  .section-link:hover :global(svg) { transform: translateX(3px); }

  /* ---- Rail container ----
     The rail-wrap clips overflow so cards can extend slightly past the
     viewport edge without causing page-wide horizontal scroll. The
     rail itself scrolls horizontally inside this wrapper. */
  .rail-wrap { position: relative; overflow: hidden; }
  .rail {
    display: grid; grid-auto-flow: column;
    /* Density: clamp(MIN, VW-BASED, MAX) per breakpoint. Mobile shows
       2–2.5 cards, tablet 3–4, desktop 5–6, large desktop / TV 6–8. */
    grid-auto-columns: clamp(140px, 38vw, 200px);
    gap: 10px;
    overflow-x: auto; overflow-y: visible;
    scroll-snap-type: x proximity;
    scroll-behavior: smooth;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 6px var(--d-gutter, clamp(16px, 5vw, 48px)) 14px;
  }
  .rail::-webkit-scrollbar { display: none; }
  .rail > * { scroll-snap-align: start; min-width: 0; }

  /* Compact rail: narrower cards (used for "You may also like" recs on
     the detail page and other secondary rails). */
  .rail.compact { grid-auto-columns: clamp(120px, 30vw, 170px); gap: 10px; }

  /* ---- Rail navigation arrows ----
     Hidden on touch / small viewports (where native horizontal scroll
     is the expected interaction). Revealed on hover/focus on desktop. */
  .rail-nav {
    position: absolute; top: 50%; transform: translateY(-50%);
    z-index: 6;
    display: grid; place-items: center;
    width: 38px; height: 56px;
    border: 1px solid var(--color-border-strong); border-radius: var(--radius-md);
    background: rgba(8, 11, 13, .82); backdrop-filter: blur(12px);
    color: var(--color-text);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .rail-nav:focus-visible {
    opacity: 1;
    outline: 2px solid var(--color-focus); outline-offset: 2px;
  }
  .rail-wrap:hover .rail-nav { opacity: 1; }
  .rail-nav:hover {
    background: rgba(0, 255, 156, .12);
    border-color: var(--color-primary-border);
    box-shadow: var(--glow-primary);
  }
  .rail-nav-prev { left: 6px; }
  .rail-nav-next { right: 6px; }

  /* ---- TABLET 641–1024px ---- */
  @media (min-width: 641px) {
    .rail { grid-auto-columns: clamp(150px, 22vw, 200px); gap: 14px; }
    .rail.compact { grid-auto-columns: clamp(130px, 18vw, 170px); }
  }

  /* ---- DESKTOP 1025–1899px ---- */
  @media (min-width: 1025px) {
    .rail { grid-auto-columns: clamp(160px, 14vw, 200px); gap: 16px; }
    .rail.compact { grid-auto-columns: clamp(140px, 11vw, 170px); }
  }

  /* ---- LARGE DESKTOP / 4K / TV 1900px+ ---- */
  @media (min-width: 1900px) {
    .rail { grid-auto-columns: clamp(170px, 12vw, 220px); gap: 20px; }
    .rail.compact { grid-auto-columns: clamp(150px, 9vw, 190px); }
    .rail-nav { width: 44px; height: 64px; }
    .section { margin-top: clamp(40px, 4vw, 60px); }
  }

  /* ---- MOBILE ≤640px ---- */
  @media (max-width: 640px) {
    .section { margin-top: 24px; }
    .rail { grid-auto-columns: 42vw; gap: 10px; padding-bottom: 10px; }
    .rail.compact { grid-auto-columns: 38vw; }
    /* Hide rail-nav arrows on mobile: native horizontal scroll only. */
    .rail-nav { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .rail { scroll-behavior: auto; }
    .section-link, .rail-nav, .section-link :global(svg) { transition: none; }
  }
</style>
