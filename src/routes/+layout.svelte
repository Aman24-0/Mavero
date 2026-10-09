<script lang="ts">
  import '$lib/../app.css';
  import { onMount } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { page, navigating } from '$app/state';
  import AppShell from '$components/AppShell.svelte';
  import PwaExperience from '$components/PwaExperience.svelte';
  import PwaBootOverlay from '$components/PwaBootOverlay.svelte';
  import Toast from '$components/Toast.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { syncDevtoolProtection } from '$lib/client/devtool-protection';
  import { isLibraryAwareRoute } from '$lib/shared/route-policy';
  import { recordInAppNavigation } from '$lib/shared/navigation';
  import { analytics } from '$lib/client/analytics/dispatcher';

  let { children: pageChildren, data }: { children: Snippet; data: LayoutData } = $props();
  const title = 'Mavero — Movies, TV shows & anime';

  // Phase 2-F (audit PERF-006) — Account sync gating.
  //
  // `syncAuthenticatedState()` makes 2 cloud HTTP roundtrips (read + write)
  // plus several IndexedDB reads + writes. The previous implementation
  // fired it on EVERY root layout mount for EVERY authenticated user,
  // even on routes where no library state is shown (e.g. /auth/sign-in,
  // /search, /upcoming, /admin/*).
  //
  // We now gate the initial sync to library-aware routes (see
  // src/lib/shared/route-policy.ts for the full list). The online-retry
  // handler also checks the CURRENT route before firing — so a user who
  // comes back online while on /search doesn't pay the sync cost.
  //
  // Routes that still need sync (my-list, discover, watch, account,
  // movie/series/anime detail) still fire it. Library-aware sub-pages
  // (e.g. /my-list, /discover, /watch/[id]) also call syncAuthenticatedState()
  // from their OWN onMount, which is idempotent (de-duplicated by
  // `syncInFlight`) — so this layout-level gate doesn't break them.
  //
  // Guests remain local-only — the `data.user` guard below already
  // short-circuits for unauthenticated users.
  onMount(() => {
    // Phase 1 Analytics Foundation — initialize the client dispatcher
    // with the server-projected anonymous_id. The dispatcher no-ops
    // track() calls if analyticsEnabled is false (used as a kill switch)
    // or if anonymous_id is null (SSR safety). The dispatcher itself
    // emits app_open and session_start on first configure().
    analytics.configure({
      anonymousId: data.anonymousId,
      enabled: data.analyticsEnabled !== false,
      deviceType: data.deviceType,
    });
    if (!data.user) return;
    if (!isLibraryAwareRoute(page.url.pathname)) return;
    void syncAuthenticatedState();
    const retry = () => {
      if (!navigator.onLine) return;
      if (!isLibraryAwareRoute(page.url.pathname)) return;
      void syncAuthenticatedState();
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  });

  // MAV-20 Phase D — in-app navigation tracking for the shared back
  // policy (shared/navigation.ts). Every COMPLETED client-side
  // navigation reports its origin URL; the initial load reports null.
  // The flag is the deterministic "an in-app history entry exists before
  // the current one" signal the back controls rely on — history.back()
  // then provably stays inside the app. (SvelteKit's own
  // history.state['sveltekit:history'] index cannot prove this: it is
  // seeded with Date.now() on first load, so it is non-zero even for a
  // deep-linked first entry.)
  afterNavigate(({ from }) => {
    recordInAppNavigation(from ? `${from.url.pathname}${from.url.search}` : null);
  });

  // DevTools protection (disable-devtool integration) — client-only.
  //
  // $effect never runs during SSR, and the protection module has no
  // top-level browser access, so this is hydration-safe and
  // SSR-safe. The root layout mounts exactly once per document and
  // never unmounts during SPA navigation, so the detector's lifecycle
  // matches the document: initialized at most once (the module
  // singleton + the library's own isRunning guard make duplicate
  // initialization impossible) and never torn down on route changes —
  // SPA navigation cannot disable the protection.
  //
  // The effect re-runs when the server layout data refreshes. Sign-in
  // and sign-out are full-page navigations (fresh data); the QR
  // big-screen login calls invalidateAll(). A detector that is already
  // active in a document that becomes admin-owned is suspended, and
  // resumed when the exemption disappears — no stale state on either
  // side of a login/logout transition.
  //
  // `exempt` is the server-resolved devtoolExempt capability
  // (authenticated admin -> true; guest/normal user -> false) — the
  // ONLY input. There is no client-side bypass by construction.
  $effect(() => {
    syncDevtoolProtection(data.devtoolExempt === true);
  });

  // Root layout snapshot — captures the scroll position whenever the
  // user navigates away from any page in the app, and restores it when
  // the user navigates back via the browser Back/Forward button or via
  // `history.back()` (which is what the in-app back controls use
  // through the shared navigateBackOr policy).
  //
  // Why a snapshot instead of a custom scroll Map
  // ============================================
  // SvelteKit already restores scroll on `popstate` navigations via its
  // own `scroll_positions[history_index]` map (persisted to sessionStorage
  // on `visibilitychange` / `beforeunload`). That handles the browser
  // Back/Forward case directly.
  //
  // This snapshot exists as a complementary mechanism: it captures the
  // scroll position at the moment of navigation (via the snapshot
  // `capture()` lifecycle) and restores it on `popstate` (via `restore()`).
  // Using the snapshot model means we don't need a custom beforeNavigate /
  // afterNavigate / disableScrollHandling orchestration — SvelteKit's
  // router already wires the capture/restore lifecycle to the right
  // moments in the navigation flow.
  //
  // The snapshot is keyed by navigation index (SvelteKit manages that
  // internally) — so it correctly distinguishes between fresh forward
  // navigations (which should start at the top) and back-like popstate
  // navigations (which should restore the previous scroll position).
  //
  // Forward navigation (link click, fresh goto) does NOT trigger
  // `restore()` — only `popstate` does. So clicking Discover in the
  // bottom nav while on a deep-scroll Search page correctly starts at
  // the top of Discover rather than inheriting Search's scroll.
  //
  // MAV-20 Phase D — BOTH scrollers, INSTANT, content-driven:
  //   * BOTH scrollers: on viewports ≤1024px the WINDOW scrolls; on
  //     desktop (≥1025px) the real scroller is the AppShell's
  //     `.app-main` container (height:100dvh; overflow-y:auto — the
  //     window never moves there). The old snapshot captured/restored
  //     window scroll only, so back navigation on desktop ALWAYS landed
  //     at the top. The snapshot now captures BOTH positions and
  //     restores BOTH — the inactive scroller's value is always 0 and
  //     its container is not scrollable at that breakpoint, so the
  //     extra restore is a guaranteed no-op.
  //   * INSTANT: `html { scroll-behavior: smooth }` animates programmatic
  //     scrolls — a restored position would glide instead of snapping,
  //     and mid-flight user interaction could leave it short. Restores
  //     use scrollTo({ behavior: 'instant' }) to bypass the animation.
  //   * CONTENT-DRIVEN: restoring before the destination's async content
  //     exists (Explorer re-seeding its grid, My List reading IndexedDB)
  //     would clamp to the not-yet-grown height. The restore waits on a
  //     rAF loop UNTIL the target scroller's scrollHeight covers the
  //     saved offset (or a bounded frame budget passes), then clamps —
  //     restoring as soon as the layout exists, never after an
  //     arbitrary fixed timeout.
  //
  // Note: this is the ROOT layout snapshot. It runs alongside any
  // per-page snapshots (e.g. the Search page's query/type/results
  // snapshot). SvelteKit captures and restores ALL component snapshots
  // (layout + page) atomically on navigation, so scroll + page state
  // always restore together.
  export const snapshot = {
    capture: (): { x: number; y: number; mainTop: number } => {
      if (typeof window === 'undefined') return { x: 0, y: 0, mainTop: 0 };
      // Capture BOTH scrollers — one of them is always 0; capturing
      // both means the correct one is always present regardless of the
      // viewport the page was viewed at (and viewport changes between
      // capture and restore are handled by restoring both).
      const main = document.querySelector<HTMLElement>('.app-main');
      return {
        x: window.scrollX,
        y: window.scrollY,
        mainTop: main?.scrollTop ?? 0
      };
    },
    restore: (value: { x: number; y: number; mainTop: number }) => {
      if (typeof window === 'undefined') return;
      if (!value || typeof value !== 'object') return;
      const x = Number.isFinite(value.x) ? value.x : 0;
      const y = Number.isFinite(value.y) ? value.y : 0;
      const mainTop = Number.isFinite(value.mainTop) ? value.mainTop : 0;

      // Bounded, content-driven restore: wait (rAF loop) until the
      // target scroller's content covers the saved offset, then clamp
      // and restore INSTANTLY. The frame budget (40 frames ≈ 650ms at
      // 60Hz) only bounds the pathological case (content never arrives);
      // the normal case restores as soon as the layout exists.
      const FRAME_BUDGET = 40;
      let frames = 0;
      const restoreNow = () => {
        // Window scroller (mobile/tablet) — instant, clamped to bounds.
        const maxX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo({ left: Math.max(0, Math.min(x, maxX)), top: Math.max(0, Math.min(y, maxY)), behavior: 'instant' } as ScrollToOptions);
        // Desktop scroller (.app-main) — instant, clamped to bounds. On
        // viewports where .app-main is not the scroll container it is
        // either absent or overflow-visible, making this a no-op.
        const main = document.querySelector<HTMLElement>('.app-main');
        if (main) {
          const maxTop = Math.max(0, main.scrollHeight - main.clientHeight);
          main.scrollTo({ top: Math.max(0, Math.min(mainTop, maxTop)), behavior: 'instant' } as ScrollToOptions);
        }
      };
      const waitForContent = () => {
        frames += 1;
        const main = document.querySelector<HTMLElement>('.app-main');
        const mainReady = !main || mainTop <= 0 || main.scrollHeight - main.clientHeight >= mainTop - 1;
        const windowReady = y <= 0 || document.documentElement.scrollHeight - window.innerHeight >= y - 1;
        if (mainReady && windowReady || frames >= FRAME_BUDGET) {
          restoreNow();
          return;
        }
        requestAnimationFrame(waitForContent);
      };
      requestAnimationFrame(waitForContent);
    }
  };
</script>

<svelte:head>
  <title>{title}</title>
  <meta property="og:title" content={title} />
  <meta property="og:description" content="A fast, modern home for your next watch." />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{#if page.url.pathname.startsWith('/watch/') || /^\/(movie|series|anime)\/[^/]+/.test(page.url.pathname) || page.url.pathname.startsWith('/auth/') || page.url.pathname.startsWith('/admin') || page.url.pathname.startsWith('/tv-login') || page.url.pathname.startsWith('/authorize') || page.url.pathname.startsWith('/settings/scan-tv')}
  <!-- /admin/* renders bare too: admin pages use AdminAppShell, a
       self-contained administrative layout with its OWN navigation.
       The consumer AppShell (side rail + mobile bottom nav) must not
       render there at all — not hidden, not covered — so admin never
       shows the normal Discover/Movies/TV Shows/Anime/Upcoming/Search
       navigation. -->
  <!-- /movies, /tv-shows and /anime are FIRST-CLASS destinations and
       render inside the consumer AppShell (Navigation & Settings
       Redesign, Phase 1). The legacy /discover/movies|series|anime paths
       are server-side 308 redirects and never reach this layout. -->
  {@render pageChildren()}
{:else}
  <!-- MAV-21 Workstream D — AppShell renders global navigation on
       EVERY consumer route (mobile bottom pill + topbar ≤1024px,
       desktop sidebar ≥1025px). The former /settings mobile-nav
       opt-out is removed together with the Settings/My List
       page-specific Back buttons: global navigation alone provides
       navigation on those pages, at every breakpoint. -->
  <AppShell currentPath={page.url.pathname} user={data.user} isAuthenticated={data.isAuthenticated}>
    {#snippet children()}
      {@render pageChildren()}
    {/snippet}
  </AppShell>
{/if}

<!-- Navigation loading indicators — appear during SPA navigation and
     disappear when it completes. Non-blocking (pointer-events: none),
     respects reduced-motion.

     CRITICAL: in SvelteKit's `$app/state` API, `navigating` is an
     always-truthy OBJECT (a plain reference with `from`, `to`, `type`,
     `willUnload`, `delta`, `complete` getters). When no navigation is
     active, every getter returns `null` — but the object itself is
     never null. Therefore `{#if navigating}` is ALWAYS truthy and the
     spinner would never disappear.

     The correct "is a navigation currently in progress?" check is
     `navigating.to !== null` (or equivalently `navigating.complete`
     being null + a non-null `to`). SvelteKit sets `navigating.to` to
     the destination route's navigation target the instant a SPA
     navigation begins, and resets it to `null` the instant the
     navigation completes (success OR error — SvelteKit's router
     clears the navigating state on both). So:

       idle                  → navigating.to === null  → no spinner
       navigation in flight  → navigating.to !== null  → spinner visible
       navigation completes  → navigating.to === null  → spinner gone

     No setTimeout, no minimum duration, no manual "hide" call — the
     spinner lifecycle is driven entirely by SvelteKit's navigation
     state.

     Two elements, ONE animation (no competing motion):
       1. .nav-spinner  — compact circular spinner, the PRIMARY visible
                          feedback. Fixed top-center, below the mobile
                          status bar / notch via env(safe-area-inset-top).
                          Dark translucent background + Mavero-green
                          accent ring + subtle glow. This is the clear
                          "navigation is loading" signal the user sees.
       2. .nav-progress  — thin static accent line at the very top edge
                          (no animation). Secondary peripheral cue only;
                          the sweep animation was removed so the spinner
                          is the sole animated element. -->
{#if navigating.to !== null}
  <div class="nav-spinner" role="status" aria-label="Loading">
    <div class="nav-spinner-ring"></div>
  </div>
  <div class="nav-progress" aria-hidden="true"></div>
{/if}

<!-- Mavero branded boot overlay — shown on EVERY initial app load
     (both normal browser tabs AND installed PWA launches). The overlay
     is a pure visual layer: pointer-events: none, aria-hidden, no
     navigation interference. It disappears automatically once the app
     has hydrated + a minimum presentation window has elapsed (~600ms).
     See PwaBootOverlay.svelte for the full lifecycle. -->
<PwaBootOverlay />

<PwaExperience />
<Toast />

<style>
  /* ============================================================
     Navigation spinner — PRIMARY loading feedback.
     Compact circular spinner, fixed top-center, below the mobile
     status bar / notch. Dark translucent background + Mavero green
     rotating ring + subtle glow. This is the clear "navigation is
     loading" signal the user sees immediately on tap.

     This spinner lives in the ROOT layout and serves ALL routes
     (both user-facing and admin). It uses the consumer brand token
     --color-primary (Mavero green #00ff9c), NOT the admin-scoped
     --a2-cyan token. Admin pages that want a cyan spinner should
     scope an override inside AdminAppShell, not here.
     ============================================================ */
  .nav-spinner {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    pointer-events: none;
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: rgba(5, 7, 8, .72);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(0, 255, 156, .22);
    box-shadow: 0 0 14px rgba(0, 255, 156, .3), 0 2px 8px rgba(0, 0, 0, .4);
  }
  .nav-spinner-ring {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid rgba(242, 255, 248, .12);
    border-top-color: var(--color-primary, #00ff9c);
    animation: nav-spinner-rotate 0.7s linear infinite;
  }
  @keyframes nav-spinner-rotate {
    to { transform: rotate(360deg); }
  }

  /* ============================================================
     Navigation progress bar — SECONDARY peripheral cue.
     Thin static accent line at the very top edge. Uses the consumer
     brand color (--color-primary, Mavero green) — NOT the admin
     cyan token. See the nav-spinner comment above for rationale.
     ============================================================ */
  .nav-progress {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px));
    left: 0;
    right: 0;
    height: 3px;
    z-index: 9999;
    pointer-events: none;
    background: linear-gradient(90deg, var(--color-primary, #00ff9c), var(--color-primary-hover, #00e88c));
    opacity: .55;
  }

  /* Reduced motion: stop the spinner rotation; show a static ring
     instead. The bar is already static. No continuous motion. */
  @media (prefers-reduced-motion: reduce) {
    .nav-spinner-ring {
      animation: none;
      border-color: rgba(242, 255, 248, .12);
      border-top-color: var(--color-primary, #00ff9c);
      border-right-color: var(--color-primary, #00ff9c);
    }
  }
</style>
