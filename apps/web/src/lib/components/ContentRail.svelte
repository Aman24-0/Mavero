<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-svelte';
  import type { MediaItem } from '$lib/data/content';
  import MediaCard from '$components/MediaCard.svelte';
  // TV-UX pass (widget build only): the rail's trailing SHOW MORE control.
  // On the TV the rail SLIDES via transform and focus must never vanish at
  // the row's end — Right past the last card lands on this button, which
  // LOADS MORE items and hands focus to the first newly-added card.
  import { IS_WGT_BUILD } from '$lib/shared/build-mode';
  import { focusTvElement } from '$lib/tv/focus';

  let {
    title,
    eyebrow = '',
    items = [],
    href = '',
    linkLabel = 'View all',
    compact = false,
    variant = 'default',
    episodeBadges = undefined,
    tvLoadMore = null
  }: {
    title: string;
    eyebrow?: string;
    items?: MediaItem[];
    href?: string;
    /** Header CTA label. Default "View all" keeps every existing
     *  caller byte-identical; the Explorer passes "Show more" (the
     *  Follow-up task 2 §10 continuation CTA on the Popular / Top
     *  Rated rails). */
    linkLabel?: string;
    compact?: boolean;
    variant?: 'default' | 'editorial';
    /** Current Airing rail only — latest-episode badge text per card,
     *  keyed by the MediaItem composite key (`${type}:${id}`), composed
     *  server-side (formatLatestEpisodeBadge). Undefined on every other
     *  rail → cards render with no badge, byte-identical to before. */
    episodeBadges?: Record<string, string>;
    /** TV-UX pass (widget build only) — async loader for the trailing
     *  SHOW MORE control. Production callers omit it → the button never
     *  renders → the rail markup is byte-identical on the web. The loader
     *  returns the newly-appended items (or null when nothing/exhausted). */
    tvLoadMore?: (() => Promise<MediaItem[] | null>) | null;
  } = $props();

  let railEl: HTMLElement;

  const railId = $derived(`rail-${title.toLowerCase().replaceAll(' ', '-')}`);

  // ============================================================
  // Follow-up task 2 (§11) — real edge state for the rail arrows.
  //
  // The arrows are no longer hover-only: on desktop/tablet/TV pointer
  // surfaces they render at full opacity so horizontal scrolling is
  // discoverable, and they DISABLE (not just dim) at the actual scroll
  // ends so a dead arrow is never offered as clickable. The state is
  // derived from the rail's own scrollLeft/scrollWidth on every scroll
  // event (passive) + after the item set or viewport changes (Resize
  // entry on the rail). No layout measurement on scroll — scrollLeft
  // and scrollWidth are already computed values the browser maintains.
  // ============================================================
  let atStart = $state(true);
  let atEnd = $state(false);

  function updateScrollState() {
    if (!railEl) return;
    const max = railEl.scrollWidth - railEl.clientWidth;
    const current = railEl.scrollLeft;
    atStart = current <= 1;
    atEnd = max - current <= 1;
  }

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

  onMount(() => {
    updateScrollState();
    const rail = railEl;
    const resize = new ResizeObserver(() => updateScrollState());
    resize.observe(rail);
    return () => resize.disconnect();
  });

  // Re-sync the edge state whenever the item set changes (a rail whose
  // items grow may no longer be at the end).
  $effect(() => {
    void items.length;
    updateScrollState();
  });

  // ============================================================
  // TV SHOW MORE (widget build only): loads the next batch through the
  // caller's loader, appends it to the rail and moves TV FOCUS to the
  // first newly-added card — the reported "focus disappears at the rail's
  // end" contract: focus must never vanish, and it must CONTINUE into the
  // new cards after loading. Exhausted loaders return null → the button
  // hides (the row's end becomes a hard stop, no wrap).
  // ============================================================
  let tvLoadingMore = $state(false);
  let tvExhausted = $state(false);
  const tvShowMoreVisible = $derived(IS_WGT_BUILD && Boolean(tvLoadMore) && !tvExhausted);

  async function handleTvShowMore() {
    if (!tvLoadMore || tvLoadingMore || tvExhausted) return;
    tvLoadingMore = true;
    const previousCount = items.length;
    try {
      const appended = await tvLoadMore();
      if (appended === null || appended.length === 0) {
        tvExhausted = true;
        // EXHAUSTED: the button unmounts while focused — focus must NEVER
        // fall to body (Samsung rule 6). Hand it to the row's LAST card so
        // the rail end stays a walkable hard stop.
        requestAnimationFrame(() => {
          try {
            const railCards = railEl?.querySelectorAll<HTMLElement>('.mc-wrap .mc-card-link');
            if (railCards && railCards.length) {
              focusTvElement(railCards[railCards.length - 1]);
            }
          } catch {
            /* focus handoff is best-effort */
          }
        });
        return;
      }
    } finally {
      tvLoadingMore = false;
    }
    // Hand TV focus to the FIRST newly-added card (the focus must continue
    // into the new cards). The appended cards mount with the next render —
    // wait a frame, then resolve the card at the previous boundary.
    requestAnimationFrame(() => {
      try {
        const railCards = railEl?.querySelectorAll<HTMLElement>('.mc-wrap .mc-card-link');
        if (railCards && railCards.length > previousCount) {
          focusTvElement(railCards[previousCount]);
        }
      } catch {
        /* focus handoff is best-effort */
      }
    });
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
      <a class="section-link" href={href} aria-label={`${linkLabel} ${title}`}>
        {linkLabel} <ArrowRight size={13} />
      </a>
    {/if}
  </div>

  <div class="rail-wrap">
    <!-- Rail navigation arrows (Follow-up task 2 §11): edge-aligned,
         vertically centered against the card row, VISIBLE by default on
         ≥641px pointer surfaces (no longer hover-only — desktop/TV/trackpad
         users get a discoverable scroll affordance), disabled at the
         actual scroll ends, still hidden on ≤640px phones where native
         swipe is the primary interaction. They sit OUTSIDE the rail
         scrollport (a true edge overlay) so they never cover card
         content mid-scroll. -->
    <button
      type="button"
      class="rail-nav rail-nav-prev"
      aria-label={`Scroll ${title} left`}
      disabled={atStart}
      onclick={() => scrollByCard(-1)}
    >
      <ChevronLeft size={18} />
    </button>
    <button
      type="button"
      class="rail-nav rail-nav-next"
      aria-label={`Scroll ${title} right`}
      disabled={atEnd}
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
      onscroll={updateScrollState}
    >
      {#each items as item (item.type + ':' + item.id)}
        <div role="listitem"><MediaCard {item} {compact} editorial={variant === 'editorial'} episodeBadge={episodeBadges?.[item.type + ':' + item.id] ?? ''} /></div>
      {/each}
      {#if tvShowMoreVisible}
        <!-- TV SHOW MORE (widget build only): the row-end focus stop that
             loads more items. Styled ONLY by the injected tv-mode layer
             (wgt_patch_shell §7) — production CSS untouched. -->
        <div role="listitem" class="rail-tv-more-cell">
          <button
            type="button"
            class="rail-tv-more"
            disabled={tvLoadingMore}
            aria-label={`Show more ${title}`}
            onclick={handleTvShowMore}
          >{tvLoadingMore ? 'Loading…' : 'Show more'}</button>
        </div>
      {/if}
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
    text-shadow: 0 0 10px rgba(255, 255, 255, .3);
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
  /* CLS #8: reserve a min-height for the rail row so the page doesn't
     shift when cards hydrate client-side. The poster aspect ratio is 2:3,
     so a 200px card is ~300px tall + 36px title/meta = ~336px. On mobile a
     140px card is ~210px + 36px = ~246px. This min-height is only a floor —
     once cards render the actual height takes over. */
  .rail-wrap { position: relative; overflow: hidden; min-height: 250px; }
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

  /* ---- Rail navigation arrows (Follow-up task 2 §11) ----
     Hidden on touch / small viewports (where native horizontal scroll
     is the expected interaction). VISIBLE by default on ≥641px pointer
     surfaces — no longer hover-only (the spec's requirement: explicit
     arrow controls for pointer/remote/keyboard environments, native
     scrolling preserved for touch/trackpad). Disabled at the actual
     scroll ends so a dead arrow is never clickable. */
  .rail-nav {
    position: absolute; top: 50%; transform: translateY(-50%);
    z-index: 6;
    display: grid; place-items: center;
    width: 38px; height: 56px;
    border: 1px solid var(--color-border-strong); border-radius: var(--radius-md);
    background: rgba(8, 11, 13, .82); backdrop-filter: blur(12px);
    color: var(--color-text);
    cursor: pointer;
    transition: opacity var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .rail-nav:focus-visible {
    outline: 2px solid var(--color-focus); outline-offset: 2px;
  }
  .rail-nav:hover {
    background: rgba(255, 255, 255, .12);
    border-color: var(--color-primary-border);
    box-shadow: var(--glow-primary);
  }
  /* Edge state: visibly and functionally off at the scroll ends (the
     layout slot stays — no arrow appear/disappear jumpiness). */
  .rail-nav:disabled {
    opacity: .22;
    pointer-events: none;
    box-shadow: none;
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
