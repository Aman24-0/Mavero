<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUp } from 'lucide-svelte';
  // TV-UX pass 4 (bug 7, widget build only): on the TV the FAB is reachable
  // ONLY when the page is scrolled to the TRUE BOTTOM — while walking down
  // the page the button must not exist at all, so the spatial walk can never
  // drop focus onto it (the reported "Down steals focus onto scroll-to-top
  // while a lower section is not yet in the viewport"). Compile-time dead on
  // production: the web keeps the exact fade-in-after-240px behavior.
  import { IS_WGT_BUILD } from '$lib/shared/build-mode';

  // Reusable scroll-to-top FAB with a circular scroll-progress ring.
  // Behavior:
  //   - hidden when scrollTop is at/near 0
  //   - fades in after the user scrolls down
  //   - the outer ring fills clockwise proportionally to scroll progress
  //   - tap = smooth scroll to top (instant under prefers-reduced-motion)
  //   - keyboard accessible (button + aria-label + focus-visible)
  //   - passive scroll listener + requestAnimationFrame throttling
  //   - sits above the mobile floating bottom nav
  //   - safe-area aware
  //
  // The component is presentational only — it does not own any business
  // logic and can be dropped into any long page.

  let visible = $state(false);
  let progress = $state(0); // 0..1
  let fabEl = $state<HTMLButtonElement | undefined>();
  let rafId: number | undefined;

  const CIRCUMFERENCE = 2 * Math.PI * 18; // r=18 → matches the SVG circle

  function readScroll() {
    rafId = undefined;
    // TV-UX pass 4 (bug 7, widget build only): render ONLY at the true
    // bottom of the ACTIVE scroll surface (the engine may scroll the window
    // or .app-main — height:100dvh does not parse on the TV-era engine, so
    // the window is usually the scroller there). Ratio ~1 = last element
    // reached; the FAB mounts at that moment and is otherwise absent from
    // the focusable set. Production never evaluates this branch.
    if (IS_WGT_BUILD) {
      try {
        const main = document.querySelector<HTMLElement>('.app-main');
        const mainScrolls = Boolean(main && main.scrollHeight > main.clientHeight + 4);
        const scroller = mainScrolls && main ? main : document.documentElement;
        const max = scroller.scrollHeight - scroller.clientHeight;
        const top = mainScrolls && main ? main.scrollTop : window.scrollY || document.documentElement.scrollTop || 0;
        const ratio = max > 0 ? Math.min(1, Math.max(0, top / max)) : 1;
        progress = ratio;
        visible = ratio >= 0.985;
      } catch {
        visible = false;
      }
      return;
    }
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const top = window.scrollY || doc.scrollTop || 0;
    const ratio = max > 0 ? Math.min(1, Math.max(0, top / max)) : 0;
    progress = ratio;
    // Show after scrolling ~12% of the viewport or 240px, whichever is smaller.
    const threshold = Math.min(window.innerHeight * 0.12, 240);
    visible = top > threshold;
  }

  function onScroll() {
    if (rafId !== undefined) return;
    rafId = requestAnimationFrame(readScroll);
  }

  function scrollToTop() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo(0, 0);
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    fabEl?.focus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      scrollToTop();
    }
  }

  // onMount only runs client-side, so window/document are safe here.
  // Returning a cleanup function from onMount is the Svelte-idiomatic
  // equivalent of onDestroy and avoids any SSR-time window access.
  onMount(() => {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    // TV-UX pass 4 (bug 7, widget build only): the active scroll surface may
    // be .app-main on engines where the 100dvh main height DOES parse —
    // mirror its scroll events into the same reader so the bottom-gated
    // visibility stays accurate on both scroll surfaces.
    let mainScroller: HTMLElement | null = null;
    if (IS_WGT_BUILD) {
      try {
        mainScroller = document.querySelector('.app-main');
        mainScroller?.addEventListener('scroll', onScroll, { passive: true });
      } catch { /* cosmetic */ }
    }
    readScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (mainScroller) mainScroller.removeEventListener('scroll', onScroll);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  });

  // ringOffset drives the SVG stroke-dashoffset — 0 = full ring, CIRCUMFERENCE = empty ring.
  let ringOffset = $derived(CIRCUMFERENCE * (1 - progress));
</script>

{#if visible}
  <button
    type="button"
    class="scroll-to-top"
    bind:this={fabEl}
    aria-label="Scroll back to top"
    title="Scroll to top"
    onclick={scrollToTop}
    onkeydown={handleKeydown}
  >
    <svg class="progress-ring" viewBox="0 0 40 40" aria-hidden="true">
      <!-- track -->
      <circle class="ring-track" cx="20" cy="20" r="18" />
      <!-- progress -->
      <circle
        class="ring-progress"
        cx="20" cy="20" r="18"
        stroke-dasharray={CIRCUMFERENCE}
        stroke-dashoffset={ringOffset}
      />
    </svg>
    <span class="fab-arrow" aria-hidden="true"><ArrowUp size={16} /></span>
  </button>
{/if}

<style>
  .scroll-to-top {
    position: fixed;
    right: clamp(14px, 4vw, 24px);
    /* Sit comfortably above the floating pill bottom nav on mobile,
       and at a comfortable bottom-right on desktop. */
    bottom: calc(96px + env(safe-area-inset-bottom, 0px));
    z-index: 45;
    display: grid; place-items: center;
    width: 44px; height: 44px;
    border: 1px solid var(--color-primary-border);
    border-radius: 50%;
    background: rgba(8, 11, 13, .82);
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, .5), var(--glow-primary);
    color: var(--color-text);
    cursor: pointer;
    padding: 0;
    transition: transform var(--motion-fast) var(--ease-out),
                opacity var(--motion-fast) var(--ease-out),
                border-color var(--motion-fast) var(--ease-out);
    animation: fab-in 220ms var(--ease-out);
  }
  .scroll-to-top:hover {
    transform: translateY(-2px);
    border-color: var(--color-primary);
  }
  .scroll-to-top:active { transform: scale(.94); }
  .scroll-to-top:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 3px;
  }

  .progress-ring {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    transform: rotate(-90deg); /* start the ring at 12 o'clock */
  }
  .ring-track {
    fill: none;
    stroke: rgba(242, 255, 248, .1);
    stroke-width: 2;
  }
  .ring-progress {
    fill: none;
    stroke: var(--color-primary);
    stroke-width: 2;
    stroke-linecap: round;
    transition: stroke-dashoffset 120ms linear;
  }

  .fab-arrow {
    position: relative;
    display: grid; place-items: center;
    color: var(--color-primary);
  }

  /* Desktop: lift the FAB a bit higher since there's no floating bottom nav. */
  @media (min-width: 641px) {
    .scroll-to-top {
      bottom: calc(28px + env(safe-area-inset-bottom, 0px));
      width: 46px; height: 46px;
    }
  }

  @keyframes fab-in {
    from { opacity: 0; transform: translateY(8px) scale(.92); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .scroll-to-top { animation: none; transition: none; }
    .ring-progress { transition: none; }
  }
</style>
