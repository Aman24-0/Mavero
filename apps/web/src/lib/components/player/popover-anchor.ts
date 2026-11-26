/**
 * popoverAnchor — Svelte action (approved-concept player redesign, round 50):
 * anchors a floating popover surface to its TRIGGER element, the way a native
 * context menu anchors to its target.
 *
 * Contract:
 *   * Measures the anchor's viewport rect (getBoundingClientRect) and the
 *     popover's LAYOUT box (offsetWidth/offsetHeight — deliberately NOT
 *     getBoundingClientRect, which would pick up the open animation's scale
 *     transform and shift the placement by a few px on the very first frame).
 *   * Default placement is BELOW the anchor with `gap` (default 10px). If the
 *     popover would overflow the viewport bottom AND there is more room above
 *     the anchor than below it, it flips ABOVE the anchor instead.
 *   * Horizontal: clamped inside the viewport with a 12px margin. With
 *     align 'auto' the popover's RIGHT edge aligns to the anchor's RIGHT edge
 *     when the anchor's centre sits in the right half of the viewport, else
 *     the LEFT edges align. align 'start'/'end' force the left/right-edge
 *     alignment explicitly.
 *   * Sets node.style.left/top (px) and position: fixed, and sets
 *     `--popover-origin` to the corner nearest the anchor (e.g. 'top right')
 *     — the open animation scales from that corner via transform-origin.
 *   * Recomputes on the initial placement (the action runs when the popover
 *     opens), on window resize, and on a ResizeObserver of the popover itself
 *     (content changes / the max-height clamp); everything is torn down in
 *     destroy().
 *   * NEVER throws: a null/detached anchor falls back to centring the
 *     popover in the viewport; any measurement failure is swallowed the same
 *     way. The action is a no-op server-side (Svelte never runs actions in
 *     SSR).
 */

export interface PopoverAnchorParams {
  /** The trigger element to anchor to (null → centre fallback). */
  anchor: HTMLElement | null;
  /** Gap between anchor and popover in px (default 10). */
  gap?: number;
  /** Horizontal alignment: 'auto' | 'start' | 'end' (default 'auto'). */
  align?: 'auto' | 'start' | 'end';
}

/** Keep this far from every viewport edge when clamping. */
const VIEWPORT_MARGIN_PX = 12;
/** Default gap between the anchor and the popover. */
const DEFAULT_GAP_PX = 10;

export function popoverAnchor(
  node: HTMLElement,
  params: PopoverAnchorParams,
): { update(next: PopoverAnchorParams): void; destroy(): void } {
  let current = params;

  /** Centre fallback — used when there is no (usable) anchor. */
  function centre(): void {
    node.style.position = 'fixed';
    const left = Math.max(VIEWPORT_MARGIN_PX, (window.innerWidth - node.offsetWidth) / 2);
    const top = Math.max(VIEWPORT_MARGIN_PX, (window.innerHeight - node.offsetHeight) / 2);
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
    node.style.setProperty('--popover-origin', 'center');
  }

  function place(): void {
    node.style.position = 'fixed';
    const anchor = current.anchor;
    const gap = typeof current.gap === 'number' && Number.isFinite(current.gap) ? current.gap : DEFAULT_GAP_PX;
    const align = current.align ?? 'auto';
    if (!anchor || !anchor.isConnected) {
      centre();
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Vertical: below by default; flip above only when the below placement
    // would overflow the viewport bottom AND more room sits above the anchor.
    let top = anchorRect.bottom + gap;
    let above = false;
    const overflowsBottom = top + height > viewportHeight - VIEWPORT_MARGIN_PX;
    const moreRoomAbove = anchorRect.top > viewportHeight - anchorRect.bottom;
    if (overflowsBottom && moreRoomAbove) {
      top = anchorRect.top - gap - height;
      above = true;
    }
    top = Math.min(
      Math.max(VIEWPORT_MARGIN_PX, top),
      Math.max(VIEWPORT_MARGIN_PX, viewportHeight - height - VIEWPORT_MARGIN_PX),
    );

    // Horizontal: 'auto' follows the anchor's half of the viewport.
    const alignEnd = align === 'end' || (align === 'auto' && anchorRect.left + anchorRect.width / 2 >= viewportWidth / 2);
    let left = alignEnd ? anchorRect.right - width : anchorRect.left;
    left = Math.min(
      Math.max(VIEWPORT_MARGIN_PX, left),
      Math.max(VIEWPORT_MARGIN_PX, viewportWidth - width - VIEWPORT_MARGIN_PX),
    );

    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
    // The corner nearest the anchor — the open animation scales from here.
    node.style.setProperty('--popover-origin', `${above ? 'bottom' : 'top'} ${alignEnd ? 'right' : 'left'}`);
  }

  /** Never let a measurement failure surface (the popover still shows). */
  const safePlace = (): void => {
    try {
      place();
    } catch {
      centre();
    }
  };

  const onResize = (): void => safePlace();
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => safePlace()) : null;
  observer?.observe(node);
  window.addEventListener('resize', onResize);
  // Initial placement — the action runs the moment the popover opens.
  safePlace();

  return {
    update(next: PopoverAnchorParams): void {
      current = next;
      safePlace();
    },
    destroy(): void {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
    },
  };
}
