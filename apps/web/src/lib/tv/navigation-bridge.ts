/**
 * TV navigation bridge — STAGE 2/4 glue (widget build only).
 *
 * WHY: SvelteKit's hash router only intercepts `#/...` hrefs — with hash
 * routing ON, a PLAIN pathname link (`/movie/123`) is classified EXTERNAL
 * by kit's own click handler (is_external_url: url.pathname !==
 * location.pathname), so the browser attempts a FULL page navigation to
 * `file:///movie/123` which cannot exist inside the widget — the click
 * silently does nothing and every route change on the TV is dead.
 *
 * Rewriting the whole app's href generators into hash form would touch
 * every shared component; instead this bridge restores the interception
 * at ONE point: a bubble-phase document click handler that
 *
 *   - waits for the element-level handlers first (bubble phase — the
 *     selection-mode card toggle preventDefaults + stops propagation, so
 *     selection never navigates),
 *   - ignores already-handled / modified / non-left clicks, targets,
 *     downloads, hash-only links and API paths,
 *   - preventDefaults the (otherwise-dead) full navigation and
 *   - routes through kit's OWN `goto()` — native router semantics
 *     (beforeNavigate/afterNavigate, snapshot/scroll restoration, hash
 *     history entries the TV Back key can pop in Stage 4).
 *
 * IS_WGT_BUILD-gated: compile-time no-op in production (the web app keeps
 * kit's native pathname-router interception).
 */

import { goto } from '$app/navigation';
import { IS_WGT_BUILD } from '$lib/shared/build-mode';

declare global {
  interface Window {
    __maveroTvNavBridge?: boolean;
  }
}

export function installTvNavigationBridge(): void {
  if (!IS_WGT_BUILD) return; // production: dead branch (compile-time flag)
  if (typeof document === 'undefined') return;
  if (window.__maveroTvNavBridge) return;

  document.addEventListener(
    'click',
    (event) => {
      try {
        // Element-level handlers first: a selection-mode card toggle already
        // preventDefaulted + stopped propagation; any other handled click
        // (dialog overlays, custom controls) must keep its own behaviour.
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const target = event.target;
        if (!target || typeof (target as Element).closest !== 'function') return;
        const anchor = (target as Element).closest('a');
        if (!anchor) return;

        const href = anchor.getAttribute('href');
        if (!href || href.length < 2) return;
        // Root-relative APP paths only ('/movie/…', '/discover', '/search?…').
        // Protocol-relative, absolute (https://), hash-only and API links are
        // untouched (API paths never navigate).
        if (href.charAt(0) !== '/' || href.charAt(1) === '/') return;
        if (href.startsWith('/api/')) return;
        if (anchor.hasAttribute('download')) return;
        const anchorTarget = anchor.getAttribute('target');
        if (anchorTarget && anchorTarget !== '_self') return;

        // The full file:// navigation kit would allow here can never exist
        // inside the widget — cancel it and route through the router.
        // NOTE: in hash-routing mode kit derives the ROUTE from
        // location.hash, so goto() must receive the HASH FORM ('#/movie/…')
        // — a pathname URL has an empty hash, resolves to no route and
        // triggers kit's server_fallback full page reload (a dead end on a
        // file:// origin).
        event.preventDefault();
        void goto('#' + href, { keepFocus: false, noScroll: false, replaceState: false });
      } catch {
        /* the bridge must never break a click */
      }
    },
    false
  );

  window.__maveroTvNavBridge = true;
}
