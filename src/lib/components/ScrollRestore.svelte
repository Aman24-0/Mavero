<script lang="ts">
  // ScrollRestore — centralized back-navigation scroll restoration.
  //
  // Background
  // ==========
  // SvelteKit's built-in scroll handling keys scroll positions by browser
  // history index and only restores them on `popstate` (browser Back/Forward).
  // It does NOT restore scroll when a `goto(...)` navigation is used as a
  // "back" affordance (e.g. the DetailPage back-arrow icon, which calls
  // `goto(returnTo, { replaceState: true, keepFocus: true })`). For `goto`
  // navigations SvelteKit's autoscroll code falls through to `scrollTo(0, 0)`
  // because `popped` is undefined and `noScroll` defaults to false — so the
  // listing page snaps back to the top, losing the user's place.
  //
  // This module keys saved scroll positions by URL (pathname + search +
  // hash) rather than by history index. That way both popstate-driven Back
  // navigation AND `goto`-driven in-page Back buttons can restore the
  // previously-saved scroll position for the destination URL.
  //
  // Forward navigation (link clicks, fresh `goto` to a brand-new URL) is
  // intentionally left alone — SvelteKit's default `scrollTo(0, 0)` is the
  // correct behavior for new navigations.
  //
  // Lifecycle
  // =========
  // - `beforeNavigate` fires before EVERY client-side navigation. We save
  //   the current scroll for the URL we're leaving.
  // - `onNavigate` fires immediately before the navigation is committed
  //   (BEFORE SvelteKit's autoscroll runs, while `updating === true`). If
  //   the destination URL has a saved scroll position AND the navigation
  //   type is back-like (`popstate` or `goto`), we call
  //   `disableScrollHandling()` so SvelteKit does NOT fire its own
  //   `scrollTo(0, 0)` and overwrite our restore.
  // - `afterNavigate` fires after the new page has rendered. We perform
  //   the actual scroll restore — synchronously (DOM has settled by now
  //   because `afterNavigate` runs after Svelte's `tick()`) and again on
  //   the next animation frame as a safety net for pages whose height
  //   grows after async data loads.
  //
  // Boundaries
  // ==========
  // - Hash links (`/discover#section`) are left to SvelteKit's native
  //   `scrollIntoView` behavior — we don't restore scroll when the
  //   destination has a hash.
  // - Forward navigations (`link`, `form`, `enter`) fall through to
  //   SvelteKit's default `scrollTo(0, 0)`.
  // - Detail-page playback routes (`/watch/...`) opt out via
  //   `SKIP_RESTORE_PREFIXES` — they have their own scroll/viewport
  //   semantics and shouldn't be auto-restored.
  // - The saved-positions map is bounded to `MAX_ENTRIES` to avoid
  //   unbounded growth across a long session. Oldest entries are evicted
  //   (LRU).

  import { onMount } from 'svelte';
  import { beforeNavigate, onNavigate, afterNavigate, disableScrollHandling } from '$app/navigation';

  // Saved scroll positions keyed by URL (pathname + search + hash).
  // The Map preserves insertion order, so we can LRU-evict the oldest entry
  // when the bound is reached.
  const scrollMap = new Map<string, { x: number; y: number }>();
  const MAX_ENTRIES = 80;

  // Routes where restoring a saved scroll position would interfere with
  // the page's own viewport handling (e.g. the fullscreen watch route).
  const SKIP_RESTORE_PREFIXES = ['/watch/'];

  function keyOf(url: { pathname: string; search: string; hash: string }): string {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function isSkipRoute(url: { pathname: string }): boolean {
    return SKIP_RESTORE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  }

  function saveScroll(url: { pathname: string; search: string; hash: string }) {
    if (isSkipRoute(url)) return;
    const key = keyOf(url);
    // Re-insert so the entry moves to the end (most recently used) for LRU.
    scrollMap.delete(key);
    scrollMap.set(key, { x: window.scrollX, y: window.scrollY });
    while (scrollMap.size > MAX_ENTRIES) {
      const oldest = scrollMap.keys().next().value;
      if (oldest === undefined) break;
      scrollMap.delete(oldest);
    }
  }

  function getScroll(url: { pathname: string; search: string; hash: string }): { x: number; y: number } | undefined {
    if (isSkipRoute(url)) return undefined;
    return scrollMap.get(keyOf(url));
  }

  // True when the navigation is back-like (browser Back/Forward OR
  // programmatic back via `goto` — e.g. DetailPage back-arrow icon).
  function isBackLikeNavigation(type: string): boolean {
    return type === 'popstate' || type === 'goto';
  }

  function restoreScroll(target: { x: number; y: number }) {
    // Clamp to the current document bounds — if the page hasn't grown to
    // the saved height yet (e.g. async data still loading), we still
    // scroll as far as possible and re-try on the next animation frame.
    const maxX = document.documentElement.scrollWidth - window.innerWidth;
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    const x = Math.max(0, Math.min(target.x, Math.max(0, maxX)));
    const y = Math.max(0, Math.min(target.y, Math.max(0, maxY)));
    window.scrollTo(x, y);
  }

  // Exposed for regression tests.
  export const __scrollRestoreInternals = {
    scrollMap,
    keyOf,
    saveScroll,
    getScroll,
    MAX_ENTRIES,
    SKIP_RESTORE_PREFIXES,
    isBackLikeNavigation
  };

  // `beforeNavigate` / `onNavigate` / `afterNavigate` only fire in the
  // browser and only while the component is mounted. We mount this
  // component exactly once in the root +layout.svelte so the lifecycle
  // covers every client-side navigation in the app.
  onMount(() => {
    beforeNavigate((navigation) => {
      // Save the scroll position of the URL we are leaving so a later
      // back-navigation to that URL can restore it.
      if (navigation.from) {
        saveScroll(navigation.from.url);
      }
    });

    onNavigate((navigation) => {
      if (!navigation.to) return;
      const toUrl = navigation.to.url;

      // Don't fight SvelteKit's hash-link `scrollIntoView` behavior.
      if (toUrl.hash) return;

      // Only restore for back-like navigation types:
      //  - `popstate`  → browser Back/Forward
      //  - `goto`      → programmatic back (e.g. DetailPage back-arrow icon)
      // `link`, `form`, `enter` are forward navigations and should fall
      // through to SvelteKit's default `scrollTo(0, 0)`.
      if (!isBackLikeNavigation(navigation.type)) return;

      const saved = getScroll(toUrl);
      if (!saved) return;

      // Disable SvelteKit's autoscroll for THIS navigation so it does
      // not `scrollTo(0, 0)` and overwrite our restore. `onNavigate`
      // runs inside the navigation update phase (after `updating = true`
      // is set, before SvelteKit's autoscroll code), so this call takes
      // effect for the current navigation.
      disableScrollHandling();
    });

    afterNavigate((navigation) => {
      if (!navigation.to) return;
      const toUrl = navigation.to.url;

      if (toUrl.hash) return;
      if (!isBackLikeNavigation(navigation.type)) return;

      const saved = getScroll(toUrl);
      if (!saved) return;

      // Restore synchronously — `afterNavigate` fires after Svelte's
      // `tick()`, so the DOM has settled for server-rendered pages.
      restoreScroll(saved);

      // Safety-net re-restore on the next animation frame. Some pages
      // (e.g. My List) load data client-side after mount and grow taller
      // after `afterNavigate`. Without this re-restore, the saved scroll
      // position would land at the bottom of the (still-short) page.
      requestAnimationFrame(() => {
        // Guard: the page may have navigated again before the rAF fires.
        // If so, skip the restore — the new navigation's afterNavigate
        // will handle its own scroll.
        const currentToUrl = navigation.to?.url;
        if (currentToUrl && keyOf(currentToUrl) !== keyOf(toUrl)) return;
        restoreScroll(saved);
      });
    });
  });
</script>

<!-- No DOM output — this component is behavior-only. -->
