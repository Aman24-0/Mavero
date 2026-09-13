<script lang="ts">
  import { onMount } from 'svelte';

  // ============================================================
  // Mavero Branded Boot / Launch Overlay
  // ============================================================
  //
  // Purpose:
  //   A premium Mavero-branded loading screen shown on EVERY initial
  //   app load — both normal browser tabs AND installed PWA launches.
  //   The native Android/Chrome PWA splash (controlled by the manifest
  //   icons — NOT touchable from HTML/CSS) transitions into this HTML
  //   boot screen, which then transitions into the Discover/app
  //   content.
  //
  //   Android native splash (browser controlled)
  //         ↓
  //   Mavero branded HTML boot screen (THIS overlay)
  //         ↓
  //   Discover/app
  //
  //   Normal Chrome:
  //   Mavero branded HTML boot screen (THIS overlay)
  //         ↓
  //   Discover/app
  //
  // Why the previous version was invisible:
  //   1. It was gated behind standalone detection — normal browser
  //      tabs never saw it.
  //   2. It used a 2-requestAnimationFrame lifecycle (~32ms), which
  //      is imperceptible to the human eye. The overlay flashed and
  //      disappeared before the user could see it.
  //
  // Lifecycle (minimum presentation window + real ready signal):
  //   1. The overlay renders immediately on mount (visible = true).
  //   2. The Mavero wordmark + thin progress bar paint.
  //   3. We track TWO conditions:
  //      a. "app ready" = onMount has fired (SvelteKit hydration
  //         complete) + 1 requestAnimationFrame (first paint after
  //         hydration). This is the real "the app shell is rendering
  //         and can take over" signal.
  //      b. "minimum presentation elapsed" = MIN_PRESENTATION_MS
  //         (600ms) since mount. This guarantees the branded screen
  //         is visible long enough to be perceived as a deliberate
  //         launch experience, not a 32ms flash.
  //   4. The overlay fades out ONLY when BOTH conditions are met:
  //        - If the app is ready in <600ms (the common case —
  //          SvelteKit hydrates fast), the overlay waits for the
  //          remaining minimum time, then fades.
  //        - If the app takes >600ms to ready (slow connection,
  //          cold start), the overlay stays visible until ready,
  //          then fades immediately.
  //   5. Defensive max fallback: MAX_FALLBACK_MS (3s). If something
  //      goes wrong (rAF never fires, JS error during hydration),
  //      the overlay is force-removed so the user is never trapped.
  //      This is a SAFETY NET — it never fires in normal usage.
  //
  // Root-level, once-per-load:
  //   The overlay is mounted once in the root +layout.svelte. It does
  //   NOT re-appear on SvelteKit client-side navigations (only on a
  //   fresh page load / hard refresh / PWA cold launch).
  //
  // No navigation interference:
  //   No popstate, no history.back, no goto, no disableScrollHandling,
  //   no beforeNavigate/afterNavigate. The overlay is a pure visual
  //   layer with pointer-events: none so it never blocks interaction.
  //
  // Accessibility:
  //   - aria-hidden="true" on the entire overlay (decorative boot UI).
  //   - No focusable elements inside the overlay.
  //   - prefers-reduced-motion: static wordmark + static progress bar
  //     (no animation). The overlay still disappears via the same
  //     lifecycle — reduced-motion only affects the visual animation.

  // Minimum presentation window: 600ms. Within the 500–800ms target.
  // Long enough to be perceived as a deliberate branded launch; short
  // enough that the app still feels fast.
  const MIN_PRESENTATION_MS = 600;
  // Defensive max fallback: 3s. Only fires if the ready signal never
  // arrives (JS error, rAF never fires in a throttled background tab).
  const MAX_FALLBACK_MS = 3000;

  let visible = true;
  let fading = false;

  onMount(() => {
    const startTime = Date.now();
    let appReady = false;
    let minElapsed = false;
    let done = false;
    let rafId = 0;
    let minTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;

    function tryFinish() {
      if (done) return;
      if (appReady && minElapsed) {
        finish();
      }
    }

    function finish() {
      if (done) return;
      done = true;
      cancelAnimationFrame(rafId);
      if (minTimer) clearTimeout(minTimer);
      if (maxTimer) clearTimeout(maxTimer);
      // Start the fade-out, then remove from DOM after it completes.
      fading = true;
      setTimeout(() => { visible = false; }, 200);
    }

    // --- Ready signal: onMount (hydration complete) + 1 rAF (first
    //     paint after hydration). This is the real "the app shell is
    //     rendering and can take over" signal. ---
    rafId = requestAnimationFrame(() => {
      appReady = true;
      tryFinish();
    });

    // --- Minimum presentation window: 600ms since mount. ---
    minTimer = setTimeout(() => {
      minElapsed = true;
      tryFinish();
    }, MIN_PRESENTATION_MS);

    // --- Defensive max fallback: 3s. Safety net only. ---
    maxTimer = setTimeout(finish, MAX_FALLBACK_MS);

    return () => {
      done = true;
      cancelAnimationFrame(rafId);
      if (minTimer) clearTimeout(minTimer);
      if (maxTimer) clearTimeout(maxTimer);
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
    transition: opacity 200ms var(--ease-out, cubic-bezier(.22, 1, .36, 1));
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
