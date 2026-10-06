<script lang="ts">
  import '$lib/../app.css';
  import { onMount } from 'svelte';
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

  // Root layout snapshot — captures the window scroll position whenever
  // the user navigates away from any page in the app, and restores it
  // when the user navigates back via the browser Back/Forward button or
  // via `history.back()` (which is what the DetailPage back-arrow icon
  // uses when there's a valid internal `from` parameter).
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
  // The restore happens on `requestAnimationFrame` so the DOM has had
  // a chance to lay out — for pages whose height depends on async data
  // (e.g. My List loading from IndexedDB), restoring synchronously
  // could land at a position the page hasn't grown to yet.
  //
  // Note: this is the ROOT layout snapshot. It runs alongside any
  // per-page snapshots (e.g. the Search page's query/type/results
  // snapshot). SvelteKit captures and restores ALL component snapshots
  // (layout + page) atomically on navigation, so scroll + page state
  // always restore together.
  export const snapshot = {
    capture: (): { x: number; y: number } => {
      if (typeof window === 'undefined') return { x: 0, y: 0 };
      return { x: window.scrollX, y: window.scrollY };
    },
    restore: (value: { x: number; y: number }) => {
      if (typeof window === 'undefined') return;
      if (!value || typeof value !== 'object') return;
      const x = Number.isFinite(value.x) ? value.x : 0;
      const y = Number.isFinite(value.y) ? value.y : 0;
      requestAnimationFrame(() => {
        // Clamp to current document bounds — if the page hasn't grown to
        // the saved height yet (async data still loading), this still
        // scrolls as far as possible.
        const maxX = document.documentElement.scrollWidth - window.innerWidth;
        const maxY = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo(
          Math.max(0, Math.min(x, Math.max(0, maxX))),
          Math.max(0, Math.min(y, Math.max(0, maxY)))
        );
      });
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
  <AppShell currentPath={page.url.pathname} showMobileNav={!page.url.pathname.startsWith('/settings')} user={data.user} isAuthenticated={data.isAuthenticated}>
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
