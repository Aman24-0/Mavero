/**
 * Shared horizontal rail navigation — edge state + stepped scrolling.
 *
 * MAV-25 WS1/WS5: the Discover content rails and the Mavero Downloader
 * source-chip rail gained the SAME left/right navigation affordance the
 * ContentRail carousels have shipped since Follow-up task 2 §11. This
 * module extracts that ESTABLISHED behaviour (the ContentRail inline
 * implementation) into ONE shared helper so the new consumers reuse the
 * exact same semantics — edge state from the rail's own live scroll
 * metrics, a stepped multi-card scroll, and reduced-motion awareness —
 * instead of growing conflicting duplicate abstractions.
 *
 * ContentRail.svelte keeps its (already shipped, test-covered) inline
 * implementation; its behaviour is byte-identical to the helpers below.
 *
 * DESIGN CONTRACT (mirrors ContentRail §11):
 *   * Edge state is derived from scrollLeft/scrollWidth/clientWidth —
 *     values the browser already maintains. No layout measurement on
 *     scroll, no getBoundingClientRect in the scroll handler.
 *   * `atStart` / `atEnd` use a 1px tolerance so sub-pixel rounding can
 *     never leave a dead arrow clickable at either scroll end.
 *   * `scrollRailByCards` scrolls ONLY the element it is given — never
 *     an ancestor scrollport, never another rail, never the page.
 *   * Step length = first child's measured width + the container's
 *     computed column gap (the real card pitch), × the requested number
 *     of cards (default 2). Falls back to a fraction of the visible
 *     width when the rail has no children yet.
 *   * Reduced motion: `prefers-reduced-motion: reduce` switches the
 *     scroll to instant (`behavior: 'auto'`) — the jump is immediate
 *     and no smooth animation runs.
 */

export type RailEdgeState = { atStart: boolean; atEnd: boolean };

/**
 * Edge state for a horizontal scroll container, from its live metrics.
 * Pure DOM math — no side effects; safe to call from scroll handlers,
 * observers and effects.
 */
export function railEdgeState(el: HTMLElement): RailEdgeState {
  const max = el.scrollWidth - el.clientWidth;
  const current = el.scrollLeft;
  return { atStart: current <= 1, atEnd: max - current <= 1 };
}

/**
 * Scroll a rail container by ~`cards` card-widths (default 2) in the
 * requested direction. Measures the first ELEMENT child (the real card
 * pitch including the grid/flex gap) and never scrolls anything except
 * `el` itself. Honors prefers-reduced-motion by scrolling instantly.
 */
export function scrollRailByCards(el: HTMLElement, direction: 1 | -1, cards = 2): void {
  const firstChild = el.querySelector<HTMLElement>(':scope > *');
  const gap = parseFloat(getComputedStyle(el).columnGap || getComputedStyle(el).gap || '0') || 0;
  const step = firstChild
    ? firstChild.getBoundingClientRect().width + gap
    : el.clientWidth * 0.6;
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollBy({ left: direction * step * cards, behavior: reducedMotion ? 'auto' : 'smooth' });
}
