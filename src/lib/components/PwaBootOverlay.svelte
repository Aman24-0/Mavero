<script lang="ts">
  import { onMount } from 'svelte';

  // ============================================================
  // PWA Branded Launch / Boot Overlay
  // ============================================================
  //
  // Purpose:
  //   When Mavero is launched as an INSTALLED PWA, the browser/OS
  //   shows a native splash screen (controlled by the manifest — we
  //   do NOT touch it). Once the web app starts rendering, this
  //   overlay shows a short premium Mavero-branded boot screen so the
  //   transition from native splash → app doesn't feel like a plain
  //   website loader.
  //
  // Eligibility:
  //   The overlay ONLY appears when running in standalone mode
  //   (installed PWA). Normal browser tab loads NEVER see it. This is
  //   detected via:
  //     - window.matchMedia('(display-mode: standalone)').matches
  //     - navigator.standalone (iOS Safari)
  //
  // Lifecycle (deterministic, no arbitrary delay):
  //   1. Component mounts (only in standalone mode — the parent
  //      +layout.svelte gates the render on isStandalone()).
  //   2. The Mavero wordmark + thin indeterminate progress bar render
  //      immediately.
  //   3. We wait for the app to be "ready" = the browser has painted
  //      at least 2 animation frames (rAF). This is the standard
  //      signal that the SvelteKit shell has hydrated + the first page
  //      is rendering. Two frames (not one) avoids a flash if the
  //      first rAF fires before the DOM is actually visible.
  //   4. Once ready, the overlay fades out (150ms) and is removed
  //      from the DOM.
  //   5. Defensive max fallback: if rAF somehow never fires (headless
  //      test environments, extremely slow devices), a 2.5s
  //      setTimeout removes the overlay. This is a SAFETY NET only —
  //      it never fires in normal browser/PWA usage where rAF fires
  //      in <16ms.
  //
  // No navigation interference:
  //   No popstate, no history.back, no goto, no disableScrollHandling,
  //   no beforeNavigate/afterNavigate. The overlay is a pure visual
  //   layer. After the entrance animation completes, pointer-events
  //   becomes none so the overlay never blocks interaction even
  //   during the brief fade-out.
  //
  // Accessibility:
  //   - aria-hidden="true" on the entire overlay (decorative boot UI;
  //     screen readers should skip it and read the actual app content
  //     underneath).
  //   - No focusable elements inside the overlay.
  //   - prefers-reduced-motion: static wordmark + static progress bar
  //     (no animation). The overlay still disappears via the same rAF
  //     lifecycle — reduced-motion only affects the visual animation,
  //     not the lifecycle.

  let visible = true;
  let fading = false;

  // Standalone detection — same robust check as PwaExperience.
  // The parent (+layout.svelte) gates the render, but we also guard
  // here defensively in case the component is mounted in a non-
  // standalone context (e.g. during SSR where window is undefined).
  function isStandalone(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    return Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  }

  onMount(() => {
    // If somehow mounted in non-standalone mode, bail immediately —
    // never show the overlay. This is a defensive guard; the parent
    // already gates the render.
    if (!isStandalone()) {
      visible = false;
      return;
    }

    let frameCount = 0;
    let rafId = 0;
    let maxFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      cancelAnimationFrame(rafId);
      if (maxFallbackTimer) clearTimeout(maxFallbackTimer);
      // Start the fade-out, then remove from DOM after it completes.
      fading = true;
      setTimeout(() => { visible = false; }, 160);
    }

    // Ready signal: 2 animation frames = the browser has painted at
    // least once after hydration. This is the standard "app is
    // rendering" signal — no arbitrary delay.
    rafId = requestAnimationFrame(function tick() {
      frameCount += 1;
      if (frameCount >= 2) {
        finish();
        return;
      }
      rafId = requestAnimationFrame(tick);
    });

    // Defensive max fallback: 2.5s. This ONLY fires if rAF never
    // fires (headless test environments,极端 throttled background
    // tabs). In normal PWA usage rAF fires in <16ms so this never
    // runs. It guarantees the overlay can never get stuck
    // permanently.
    maxFallbackTimer = setTimeout(finish, 2500);

    return () => {
      done = true;
      cancelAnimationFrame(rafId);
      if (maxFallbackTimer) clearTimeout(maxFallbackTimer);
    };
  });
</script>

{#if visible}
  <div
    class="pwa-boot"
    class:fading
    aria-hidden="true"
    role="presentation"
  >
    <div class="pwa-boot-content">
      <!-- Mavero wordmark — the visual focus. Uses the Inter font
           already loaded globally. Letter-spacing + weight match the
           existing Mavero brand language (see AppShell brand lockup). -->
      <div class="pwa-boot-wordmark">
        <span class="pwa-boot-mark">M</span>
        <span class="pwa-boot-text">MAVERO</span>
      </div>
      <!-- Thin indeterminate progress bar — subtle, not a giant
           spinner. Matches the Mavero accent (white-on-dark). -->
      <div class="pwa-boot-progress" aria-hidden="true">
        <div class="pwa-boot-progress-bar"></div>
      </div>
    </div>
  </div>
{/if}

<style>
  .pwa-boot {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: grid;
    place-items: center;
    /* Mavero dark background — matches --base (#000) + a subtle
       radial glow for depth (premium OTT feel, not a flat loader). */
    background:
      radial-gradient(circle at 50% 38%, rgba(245, 245, 245, 0.04), transparent 60%),
      #000000;
    /* Smooth fade-out when the app is ready. pointer-events: none
       so the overlay never blocks interaction even during fade. */
    pointer-events: none;
    opacity: 1;
    transition: opacity 160ms var(--ease-out, cubic-bezier(.22, 1, .36, 1));
  }
  .pwa-boot.fading {
    opacity: 0;
  }

  .pwa-boot-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
    /* Subtle entrance: wordmark scales up + fades in. */
    animation: pwa-boot-enter 360ms var(--ease-out, cubic-bezier(.22, 1, .36, 1));
  }

  /* ---- Wordmark ---- */
  .pwa-boot-wordmark {
    display: inline-flex;
    align-items: center;
    gap: 11px;
  }
  .pwa-boot-mark {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    color: #000;
    background: #f5f5f5;
    font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
    font-size: 1.2rem;
    font-weight: 900;
    letter-spacing: 0;
    line-height: 1;
  }
  .pwa-boot-text {
    color: #f5f5f5;
    font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
    font-size: 1.1rem;
    font-weight: 900;
    letter-spacing: 0.14em;
    /* Subtle text-shadow for depth against the radial glow. */
    text-shadow: 0 2px 16px rgba(0, 0, 0, 0.5);
  }

  /* ---- Progress bar (thin, indeterminate) ---- */
  .pwa-boot-progress {
    width: 140px;
    height: 2px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }
  .pwa-boot-progress-bar {
    width: 40%;
    height: 100%;
    border-radius: 999px;
    background: #f5f5f5;
    /* Indeterminate sweep: translateX from -100% to 350% over 1.1s. */
    animation: pwa-boot-progress-sweep 1.1s var(--ease-out, cubic-bezier(.22, 1, .36, 1)) infinite;
  }

  /* ---- Entrance animation ---- */
  @keyframes pwa-boot-enter {
    from {
      opacity: 0;
      transform: scale(0.94) translateY(6px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  /* ---- Progress sweep ---- */
  @keyframes pwa-boot-progress-sweep {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(350%);
    }
  }

  /* ---- Reduced motion: static wordmark + static progress bar ---- */
  @media (prefers-reduced-motion: reduce) {
    .pwa-boot {
      transition: none;
    }
    .pwa-boot-content {
      animation: none;
    }
    .pwa-boot-progress-bar {
      /* No sweep animation — show a static half-filled bar. */
      animation: none;
      width: 50%;
      transform: translateX(0);
    }
  }

  /* ---- Small screens: slightly smaller wordmark ---- */
  @media (max-width: 380px) {
    .pwa-boot-mark {
      width: 34px;
      height: 34px;
      font-size: 1.05rem;
    }
    .pwa-boot-text {
      font-size: 1rem;
    }
    .pwa-boot-progress {
      width: 120px;
    }
  }
</style>
