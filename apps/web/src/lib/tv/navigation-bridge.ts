/**
 * TV navigation bridge — STAGE 2/4 glue (widget build only).
 *
 * WHY: SvelteKit's hash router only intercepts `#/...` hrefs. With hash
 * routing ON, a PLAIN pathname link (`/movie/123`) is classified EXTERNAL by
 * kit's own click handler (is_external_url: url.pathname !==
 * location.pathname in hash mode), so the browser attempts a FULL page
 * navigation to `file:///movie/123` — impossible inside the widget — and
 * every click silently does nothing.
 *
 * THE FIX (href rewrite, not click hijacking): at capture phase — BEFORE kit
 * and every element handler see the event — rewrite root-relative app links
 * IN PLACE into their hash form (`/movie/123` → `#/movie/123`). Kit's own
 * click handler then classifies the link internal (same pathname, route in
 * the hash) and does ALL the work natively: beforeNavigate/afterNavigate,
 * snapshot/scroll restoration, hash history entries, preloading — with ZERO
 * interception of element handlers (the selection-mode card toggle keeps
 * preventDefault + stopPropagation semantics) and NO double-firing.
 *
 * Rewrites happen on BOTH `pointerdown` (covers mouse/touch taps ahead of
 * kit's mousedown preloader) and `click` (covers keyboard/D-pad Enter
 * activation, which synthesizes a click WITHOUT a preceding pointerdown —
 * the Stage 4 focus manager depends on this).
 *
 * Only ROOT-RELATIVE app paths are rewritten ('/movie/…', '/search?q=…'):
 * protocol-relative, absolute, hash-only and /api/ links pass untouched.
 *
 * IS_WGT_BUILD-gated: compile-time no-op in production (the web app keeps
 * kit's native pathname-router interception and its real hrefs).
 */

import { IS_WGT_BUILD } from '$lib/shared/build-mode';

declare global {
  interface Window {
    __maveroTvNavBridge?: boolean;
  }
}

/** `/movie/123?from=…` → `#/movie/123?from=…`; null for non-app links. */
function hashForm(href: string): string | null {
  if (!href || href.length < 2) return null;
  if (href.charAt(0) !== '/' || href.charAt(1) === '/') return null; // not root-relative
  if (href.startsWith('/api/')) return null; // API paths never navigate
  if (href.startsWith('#')) return null; // already hash-form
  return '#' + href;
}

function rewriteAnchor(anchor: Element): void {
  try {
    if (anchor.tagName !== 'A') return;
    const el = anchor as HTMLAnchorElement;
    if (el.hasAttribute('download')) return;
    const anchorTarget = el.getAttribute('target');
    if (anchorTarget && anchorTarget !== '_self') return;
    const current = el.getAttribute('href');
    const rewritten = hashForm(current ?? '');
    if (!rewritten || rewritten === current) return;
    el.setAttribute('href', rewritten);
  } catch {
    /* the bridge must never break an interaction */
  }
}

function findAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  try {
    if (!target || typeof (target as Element).closest !== 'function') return null;
    return (target as Element).closest('a');
  } catch {
    return null;
  }
}

export function installTvNavigationBridge(): void {
  if (!IS_WGT_BUILD) return; // production: dead branch (compile-time flag)
  if (typeof document === 'undefined') return;
  if (window.__maveroTvNavBridge) return;

  // Capture phase on document — runs before kit's documentElement listener
  // and before every element handler, for BOTH event kinds.
  const rewriteFor = (event: Event) => {
    try {
      if (event.defaultPrevented) return;
      if (event.type === 'click' && (event as MouseEvent).button !== 0) return;
      const anchor = findAnchor(event.target);
      if (!anchor) return;
      rewriteAnchor(anchor);
    } catch {
      /* never break an interaction */
    }
  };

  document.addEventListener('pointerdown', rewriteFor, true);
  document.addEventListener('click', rewriteFor, true);

  window.__maveroTvNavBridge = true;
}
