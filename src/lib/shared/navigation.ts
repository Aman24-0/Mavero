export function appendReturnTo(href: string, returnTo: string) {
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return href;
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}from=${encodeURIComponent(returnTo)}`;
}

export function safeReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

// ============================================================
// MAV-20 Phase D — the single coherent back-navigation policy.
//
// Every in-app Back control uses REAL browser history when a valid
// in-app history entry exists, and falls back to an explicit goto only
// for deep links (no in-app origin). This is the ONE policy for the
// detail page's back button, the player's back control, and any future
// back affordance — no competing custom history stacks.
//
// Why history.back() and not goto(returnTo):
//   * back() returns to the ACTUAL previous entry — the real origin
//     page with its own history entry, query state and SvelteKit
//     snapshot (scroll + page state restoration only fires on
//     popstate).
//   * goto(..., { replaceState: true }) REPLACES the current entry —
//     the old implementation created duplicate detail entries after
//     closing the player (Back from the detail page returned to the
//     SAME detail page) and destroyed forward history.
//
// In-app origin detection — the app tracks its OWN navigations:
//   The root layout reports every completed client-side navigation to
//   recordInAppNavigation (via afterNavigate). The module-level flag is
//   per-document state: it is only set when THIS document instance
//   actually performed an in-app pushState navigation, which PROVES an
//   in-app history entry exists immediately before the current one —
//   exactly the case where history.back() must stay inside the app.
//   A deep-linked first entry (fresh tab, shared URL) never sets the
//   flag → the explicit fallback runs (never a blind back() that could
//   leave the app entirely).
//
//   (SvelteKit's own history.state['sveltekit:history'] index is NOT
//   usable for this: it is seeded with Date.now() on first load, so
//   "index > 0" is true even for the FIRST entry — verified against
//   @sveltejs/kit 2.70.3's client router source and live behavior.)
//
// The popstate watchdog: window.history.back() is fire-and-forget and
// SILENTLY does nothing when there is no previous entry. Browsers fire
// popstate as a macrotask — if it has not fired by the next macrotask
// (setTimeout 0), back() provably did nothing and the fallback runs.
// The watchdog also cleans itself up when popstate DOES fire.
// ============================================================

/**
 * The URL this document last navigated FROM via a client-side (in-app)
 * navigation, or null when no in-app navigation has occurred in this
 * document's lifetime. Maintained by the root layout's afterNavigate
 * hook. Module state — dies with the document (a reload starts fresh).
 */
let lastInAppNavigationFrom: string | null = null;

/**
 * Record (or clear) the in-app navigation origin. Called by the root
 * layout's afterNavigate hook: `from` is null for the initial load and
 * the origin URL for every completed client-side navigation.
 */
export function recordInAppNavigation(fromUrl: string | null): void {
  lastInAppNavigationFrom = fromUrl;
}

/**
 * Whether a real IN-APP previous history entry exists — i.e. whether
 * history.back() would stay inside the app. True only when this
 * document has performed a client-side navigation (which pushed the
 * current entry on top of an in-app origin entry).
 */
export function hasInAppHistoryEntry(): boolean {
  if (typeof window === 'undefined') return false;
  return lastInAppNavigationFrom !== null;
}

/**
 * The origin URL of the last in-app navigation in this document (the
 * page the current entry was pushed from), or null. Informational —
 * the `from` query parameter remains the authoritative origin hint.
 */
export function lastInAppOrigin(): string | null {
  return lastInAppNavigationFrom;
}

/**
 * Navigate back through REAL browser history, with a provable no-op
 * detection and an explicit fallback.
 *
 * `onFallback` runs ONLY when no in-app history entry exists (deep
 * link / first entry) or when history.back() provably did nothing (no
 * popstate within the next macrotask). The fallback owns its navigation
 * (e.g. goto with replaceState so a deep-linked page's entry is
 * replaced by the destination).
 *
 * Repeated taps are safe: the watchdog cleans up after the first
 * popstate, and a second tap while a back navigation is already in
 * flight simply re-runs back() against the same history state (the
 * browser coalesces same-direction traversals; the fallback's goto is
 * idempotent for the same destination).
 */
export function navigateBackOr(onFallback: () => void): void {
  if (typeof window === 'undefined' || typeof window.history.back !== 'function') {
    onFallback();
    return;
  }
  if (!hasInAppHistoryEntry()) {
    // No in-app previous entry (deep link / first entry) — do not even
    // attempt back(): an external-document back traversal would leave
    // the app (and never fire the in-app popstate the watchdog waits
    // for).
    onFallback();
    return;
  }
  let navigated = false;
  const onPopState = () => {
    navigated = true;
    cleanup();
  };
  const timer = setTimeout(() => {
    cleanup();
    if (!navigated) onFallback();
  }, 0);
  function cleanup() {
    window.removeEventListener('popstate', onPopState);
    clearTimeout(timer);
  }
  window.addEventListener('popstate', onPopState, { once: true });
  window.history.back();
}
