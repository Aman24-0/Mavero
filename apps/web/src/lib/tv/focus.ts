/**
 * TV spatial focus manager — TV-UX pass (widget build only).
 *
 * SAMSUNG TIZEN NAVIGATION RULES (official — implemented here):
 *   1. ArrowLeft/Up/Right/Down, Enter and Back are MANDATORY and delivered
 *      AUTOMATICALLY — they are NOT registered via tvinputdevice. Registering
 *      a key BLOCKS its default delivery, which is exactly what broke the
 *      first D-PAD pass (registered arrows ⇒ unreliable key delivery and
 *      un-prevented page scrolls). Only EXTRA keys (media) are registered.
 *      Back on Tizen = keyCode 10009.
 *   2. Samsung provides NO built-in spatial navigation — the app manages
 *      focus itself with a GRID model: rows of items; Left/Right WITHIN a
 *      row; Up/Down to the NEIGHBOURING ROW KEEPING THE COLUMN (clamped to
 *      that row's length — never wrapping).
 *   3. Focus moves to the NEAREST item in the pressed direction (measured
 *      between element MIDDLES); the column anchor is REMEMBERED so the
 *      up/down route stays consistent while walking a page.
 *   4. Focus does NOT loop — it stops at the first/last item. ONE element
 *      is focused at a time with a THICK high-contrast outline.
 *   5. Content moves ONLY at a row's edge: a rail slides with a CSS
 *      TRANSFORM (never native rail scroll — the TV engine drops
 *      scrollIntoView), the vertical scroller animates via
 *      requestAnimationFrame, and the focused row rests ~40% from the top.
 *   6. Focus NEVER lands on nothing: on render the first sensible element
 *      is focused; entering a shorter row clamps to its last item.
 *   7. Consumed arrows are preventDefault()-ed (otherwise the page scrolls
 *      — the reported "Left/Right sometimes scrolls up/down" bug).
 *
 * REGION SCOPING (the reported focus chaos):
 *   sidebar | hero | rail/grid | filters | dialog | content are handled as
 *   REGIONS. Content Up/Down stays in content (vertical transitions to the
 *   hero are allowed at the top edge); only a deliberate Left at the
 *   leftmost content COLUMN reaches the sidebar; Right from the sidebar
 *   returns to the remembered content element. The hero's Left/Right keys
 *   only change slides when the hero's OWN controls (dots/arrows) are
 *   focused — a global Left/Right binding to the carousel is forbidden, and
 *   every other hero keypress is consumed so the section-level handler can
 *   never double-fire a slide change behind the manager.
 *
 * WIDGET BUILD ONLY — installTvFocusManager() is called from hooks.client.ts
 * behind the compile-time IS_WGT_BUILD flag; production never evaluates it.
 */

import { writable } from 'svelte/store';
import { IS_WGT_BUILD } from '$lib/shared/build-mode';
import { hasInAppHistoryEntry } from '$lib/shared/navigation';
import { hideTvStatus } from './status';

declare global {
  interface Window {
    __maveroTvFocusManager?: boolean;
    __maveroTvFocusDebug?: () => {
      region: string | null;
      columnAnchor: number | null;
      lastContentFocus: string | null;
      hasHero: boolean;
      rails: number;
    };
    tizen?: {
      tvinputdevice?: {
        registerKey?: (keyName: string) => void;
        registerKeyBatch?: (keyNames: string[]) => void;
      };
    };
  }
}

/** Observable focus state (the current focused element, or null). */
export const tvFocused = writable<Element | null>(null);

/* -------------------------------------------------------------------------
 * Key codes — Tizen TV key model. keyCode is the RELIABLE signal on the TV
 * engine (e.key strings differ across Tizen builds); the arrow/enter string
 * fallbacks exist only so the manager is exercisable in desktop browsers.
 * ----------------------------------------------------------------------- */
const KEY_UP = 38;
const KEY_DOWN = 40;
const KEY_LEFT = 37;
const KEY_RIGHT = 39;
const KEY_ENTER = 13;
const KEY_BACK = 10009;

/**
 * SAMSUNG RULE 1 — arrows/Enter/Back are delivered AUTOMATICALLY and must
 * NOT be registered (registration BLOCKS the key's default). Only EXTRA
 * media/colour keys are registered.
 */
const TV_KEY_NAMES = [
  'MediaPlay',
  'MediaPause',
  'MediaPlayPause',
  'MediaStop',
  'MediaFastForward',
  'MediaRewind'
];

/**
 * Everything a remote user can act on. Explicit engines (a[href], button,
 * form controls) plus the app's tabindex-0 interactive surfaces. [tabindex]
 * without a value is excluded — Svelte renders tabindex="0" only.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex="0"]',
  '[role="button"]',
  '[data-focusable="true"]'
].join(',');

/**
 * tabindex="0" CONTAINERS (the hero/spotlight sections, scroll shells) are
 * reachable destinations for a Tab user on the web, but on the TV they are
 * NOT activation targets: focusing the hero <section> would paint a ring
 * around the whole screen and — worse — fire its focusin pause, freezing
 * the 4s autoplay for as long as the seed focus sits there. Containers are
 * excluded from the focusable set; their INNER controls are the targets.
 */
const CONTAINER_TAGS = new Set([
  'SECTION',
  'DIV',
  'ARTICLE',
  'ASIDE',
  'NAV',
  'HEADER',
  'FOOTER',
  'MAIN',
  'UL',
  'OL',
  'LI',
  'FORM'
]);

function isInteractiveTarget(el: HTMLElement): boolean {
  if (!CONTAINER_TAGS.has(el.tagName)) return true;
  // A container is only a genuine target when it pretends to be one.
  const role = el.getAttribute('role');
  return role === 'button' || role === 'option' || role === 'tab' || role === 'menuitem';
}

const FOCUS_RING_CLASS = 'tv-focused';

/* -------------------------------------------------------------------------
 * Regions — the scoping unit of every spatial move
 * ----------------------------------------------------------------------- */

type Region = 'dialog' | 'sidebar' | 'hero' | 'rail' | 'grid' | 'filters' | 'content';

function regionOf(el: Element | null): Region {
  try {
    if (!el || typeof el.closest !== 'function') return 'content';
    if (el.closest('[role="dialog"]')) return 'dialog';
    if (el.closest('.app-sidebar')) return 'sidebar';
    if (el.closest('.hero, .spotlight')) return 'hero';
    if (el.closest('.rail')) return 'rail';
    if (el.closest('.explorer-grid')) return 'grid';
    // TV-UX pass 2: RAIL HEADING rows are focus stops too (the reported
    // "rail heading filter row not focusable"). Both the Discover section
    // heads (type chips + language/provider dropdown + View all) and the
    // Explorer filtered-results heading (title + Clear filters) join the
    // filters region: Left/Right walk the head's controls, Up/Down cross
    // to the hero or the rail cards below.
    if (el.closest('.section-head, .results-heading')) return 'filters';
    if (el.closest('.explorer-filters, .filter-row, .recent-searches, .filter-bar')) return 'filters';
    return 'content';
  } catch {
    return 'content';
  }
}

/** The horizontally-scrolling row container an element belongs to. */
function rowContainerOf(el: Element | null): HTMLElement | null {
  try {
    if (!el || typeof el.closest !== 'function') return null;
    // TV-UX pass 2: section-head / results-heading rows group their own
    // controls (chips, dropdown, links) into one horizontal walk.
    return el.closest<HTMLElement>('.rail, .explorer-grid, .chip-scroll, .section-head, .results-heading');
  } catch {
    return null;
  }
}

function isTextEntryTarget(el: Element | null): boolean {
  try {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = (el as HTMLInputElement).type;
      return type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === 'tel' || type === 'password' || type === 'number';
    }
    return false;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------
 * Focusable discovery
 * ----------------------------------------------------------------------- */

function isVisible(el: HTMLElement): boolean {
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // display:none subtrees produce zero rects (caught above); visibility
    // and opacity-zero overlays (PwaBootOverlay) still need a check.
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  } catch {
    return false;
  }
}

function collectFocusables(): HTMLElement[] {
  try {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    return nodes.filter((el) => {
      if (!isInteractiveTarget(el)) return false;
      if (!isCardFocusUnit(el)) return false;
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el.closest('[inert]')) return false;
      return isVisible(el);
    });
  } catch {
    return [];
  }
}

/**
 * One media card = ONE focus stop (the TV contract: "every media card" is a
 * single focusable). A card's DOM carries 3-4 anchors (poster link, play
 * circle, title link, Details link) — stepping through all of them per card
 * would make a rail feel like 4x the work and trap the spatial walk in
 * vertical micro-hops. The POSTER LINK is the stop; Enter opens the detail
 * page (where Play and everything else is reachable). My List selection mode
 * keeps its own .mc-select button as the stop.
 */
function isCardFocusUnit(el: HTMLElement): boolean {
  try {
    const card = el.closest('.mc-wrap');
    if (!card) return true;
    if (el.classList.contains('mc-card-link')) return true;
    if (el.classList.contains('mc-select')) return true; // selection mode owns the card
    return false;
  } catch {
    return true;
  }
}

/* -------------------------------------------------------------------------
 * Geometry helpers
 * ----------------------------------------------------------------------- */

type Rect = { left: number; top: number; right: number; bottom: number; cx: number; cy: number };

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2
  };
}

/** Distance between the two rects along ONE axis (0 when they overlap). */
function axisGap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
  return overlap > 0 ? 0 : Math.max(0, Math.max(aMin, bMin) - Math.min(aMax, bMax));
}

/** The content area's left edge — the deliberate-Left boundary to the sidebar. */
function contentLeftEdge(): number {
  try {
    const main = document.querySelector('.app-main main') || document.querySelector('.app-main') || document.body;
    return (main as HTMLElement).getBoundingClientRect().left;
  } catch {
    return 0;
  }
}

/** The current page zoom (body.tv-mode zooms 1.2 — scroll math must divide). */
function zoomFactor(): number {
  try {
    const zoom = parseFloat(getComputedStyle(document.body).zoom || '1');
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  } catch {
    return 1;
  }
}

/* -------------------------------------------------------------------------
 * Rail sliding — content moves ONLY at a row's edge, via CSS transform
 * (Samsung rule 5; the TV engine silently drops scrollIntoView, which is
 * the reported "focus disappears at the rail's end" bug).
 * ----------------------------------------------------------------------- */

const railOffset = new WeakMap<HTMLElement, number>();

function shiftOfRail(rail: HTMLElement): number {
  return railOffset.get(rail) ?? 0;
}

function applyRailShift(rail: HTMLElement, shift: number): void {
  try {
    const maxShift = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const clamped = Math.min(Math.max(0, Math.round(shift)), maxShift);
    railOffset.set(rail, clamped);
    rail.style.transform = clamped > 0 ? `translateX(${-clamped}px)` : '';
  } catch {
    /* cosmetic — never break navigation on a failed slide */
  }
}

function resetRailShift(rail: HTMLElement): void {
  applyRailShift(rail, 0);
}

/** Card positions in the rail's LAYOUT coordinate space (transform-agnostic). */
function cardLayoutRect(el: HTMLElement, shift: number): Rect {
  const visual = rectOf(el);
  // The rail is translated by -shift: layout = visual + shift (x axis only).
  return { ...visual, left: visual.left + shift, right: visual.right + shift, cx: visual.cx + shift };
}

/**
 * Is the card inside its rail's VISIBLE window (used by up/down banding)?
 * TV-UX pass 3 (bug 8): the check reads the card's VISUAL rect (the CSS
 * transform already applied) against the untransformed wrapper — after a
 * rail has slid, the layout-coordinate version mis-counted both edges
 * (cards visually off-screen counted as visible, and vice versa), so
 * vertical walks and the "first visible card" resolution drifted.
 */
function isCardInRailWindow(el: HTMLElement): boolean {
  try {
    const rail = rowContainerOf(el);
    if (!rail) return true;
    const wrap = rail.parentElement;
    if (!wrap) return true;
    const card = rectOf(el); // VISUAL rect — includes the applied transform
    const windowLeft = wrap.getBoundingClientRect().left;
    const windowRight = wrap.getBoundingClientRect().right;
    return card.left >= windowLeft - 4 && card.right <= windowRight + 4;
  } catch {
    return true;
  }
}

/**
 * Slide the rail so the focused card is fully inside the visible window.
 * Called after EVERY in-rail focus move (Samsung rule 5).
 *
 * TV-UX pass 3 (bug 8 — "Right scrolls but no new cards; Left never slides
 * back"): the previous math added the CURRENT shift to the target a second
 * time (card.left here is the LAYOUT coordinate = visual + shift, so the
 * target shift must be derived from it DIRECTLY). Every slide-after-first
 * over-shot by exactly the current shift — Right saturated at the rail's
 * max shift (past the real cards) and Left moved the rail the WRONG WAY
 * (deeper left instead of back). The corrected targets:
 *   right edge: shift' = cardLayoutRight − windowRight + gap
 *   left edge:  shift' = cardLayoutLeft  − windowLeft  − gap
 * (both clamped to [0, maxShift] by applyRailShift).
 */
function ensureRailCardVisible(el: HTMLElement): void {
  try {
    const rail = rowContainerOf(el);
    if (!rail || !rail.classList.contains('rail')) return; // grid rows scroll vertically, not horizontally
    const wrap = rail.parentElement;
    if (!wrap) return;
    const shift = shiftOfRail(rail);
    const card = cardLayoutRect(el, shift); // LAYOUT rect (transform-agnostic)
    const wrapRect = wrap.getBoundingClientRect();
    const style = getComputedStyle(rail);
    const padLeft = parseFloat(style.paddingLeft || '0') || 0;
    const padRight = parseFloat(style.paddingRight || '0') || 0;
    const windowLeft = wrapRect.left + padLeft;
    const windowRight = wrapRect.right - padRight;
    const gap = 12; // peek margin so the next card's edge hints at more content
    let next = shift;
    if (card.right > windowRight) next = card.right - windowRight + gap;
    else if (card.left < windowLeft) next = card.left - windowLeft - gap;
    if (Math.abs(next - shift) > 1) applyRailShift(rail, next);
  } catch {
    /* cosmetic */
  }
}

/* -------------------------------------------------------------------------
 * Vertical reveal — rAF-animated scrollTop (never native scrollIntoView),
 * focused row rests ~40% from the top (Samsung rule 5).
 * ----------------------------------------------------------------------- */

let scrollAnimation: number | undefined;

function nearestScrollableAncestor(el: HTMLElement): HTMLElement | null {
  try {
    let node: HTMLElement | null = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const scrollableY = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (scrollableY && node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }
  } catch {
    /* fall through to window scrolling */
  }
  return null;
}

function animateScrollTo(scroller: HTMLElement | null, targetTop: number): void {
  try {
    const zoom = zoomFactor();
    const isWindow = !scroller;
    const current = isWindow ? window.scrollY : scroller.scrollTop;
    // Scroll positions live in the scroller's LOCAL units; element rects are
    // in ZOOMED root units — divide the visual target by the zoom factor.
    const target = Math.max(0, targetTop / zoom);
    if (Math.abs(target - current) < 2) return;
    if (scrollAnimation) cancelAnimationFrame(scrollAnimation);
    const start = current;
    const delta = target - current;
    const duration = 260;
    let startTime: number | undefined;
    const step = (ts: number) => {
      if (startTime === undefined) startTime = ts;
      const t = Math.min(1, (ts - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const value = start + delta * eased;
      if (isWindow) window.scrollTo(0, value);
      else scroller.scrollTop = value;
      if (t < 1) scrollAnimation = requestAnimationFrame(step);
      else scrollAnimation = undefined;
    };
    scrollAnimation = requestAnimationFrame(step);
  } catch {
    /* scrolling is a comfort fix — never break navigation on it */
  }
}

/** The visible band of the scroller that owns `el`, in ROOT (visual) units. */
function bandFor(el: HTMLElement): { top: number; bottom: number } {
  try {
    const scroller = nearestScrollableAncestor(el);
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
    return { top: 0, bottom: window.innerHeight };
  } catch {
    return { top: 0, bottom: window.innerHeight };
  }
}

/**
 * Reveal the focused element vertically: fully visible elements are left
 * alone; content below the fold scrolls so the focused ROW sits ~40% from
 * the top; content above the top edge scrolls back into view.
 */
function revealVertical(el: HTMLElement): void {
  try {
    const rect = rectOf(el);
    const band = bandFor(el);
    const headerClearance = 110;
    const bottomClearance = 90;
    const bandHeight = band.bottom - band.top;
    let target: number | null = null;
    const currentScroll = nearestScrollableAncestor(el) ? (nearestScrollableAncestor(el) as HTMLElement).scrollTop : window.scrollY;
    if (rect.top < band.top + headerClearance) {
      // Above the fold: bring the element to the top clearance line.
      target = currentScroll + (rect.top - band.top - headerClearance);
    } else if (rect.bottom > band.bottom - bottomClearance) {
      // Below the fold: rest the focused row ~40% from the top of the band.
      target = currentScroll + (rect.cy - band.top - bandHeight * 0.4);
    }
    if (target !== null) {
      const scroller = nearestScrollableAncestor(el);
      animateScrollTo(scroller, target);
    }
  } catch {
    /* cosmetic */
  }
}

/* -------------------------------------------------------------------------
 * Focus application
 * ----------------------------------------------------------------------- */

function paintRing(el: HTMLElement): void {
  try {
    const previous = document.querySelectorAll('.' + FOCUS_RING_CLASS);
    for (const node of previous) {
      if (node !== el) node.classList.remove(FOCUS_RING_CLASS);
    }
  } catch {
    /* ring cleanup is cosmetic */
  }
  try {
    el.classList.add(FOCUS_RING_CLASS);
  } catch {
    /* cosmetic */
  }
}

/** Focus + reveal WITHOUT the spatial side effects (seed / restore path). */
function applyFocusSilent(el: HTMLElement): void {
  try {
    el.focus({ preventScroll: true });
  } catch {
    try {
      el.focus();
    } catch {
      return;
    }
  }
  paintRing(el);
  tvFocused.set(el);
}

/** Focus + row-edge sliding + vertical reveal (the spatial-move path). */
function applyFocus(el: HTMLElement): void {
  applyFocusSilent(el);
  ensureRailCardVisible(el);
  revealVertical(el);
}

/** Focus helper for TV-aware components (ContentRail's Show More handoff). */
export function focusTvElement(el: HTMLElement | null): void {
  if (!IS_WGT_BUILD) return; // production: dead branch (compile-time flag)
  if (!el) return;
  try {
    applyFocus(el);
  } catch {
    /* never break a component on focus */
  }
}

/* -------------------------------------------------------------------------
 * Sidebar auto-expand / auto-collapse (icon rail ↔ full navigation)
 * ----------------------------------------------------------------------- */

const SIDEBAR_EVENT = 'mavero:tv-sidebar';

function setTvSidebarCollapsed(collapsed: boolean): void {
  try {
    window.dispatchEvent(new CustomEvent(SIDEBAR_EVENT, { detail: { collapsed } }));
  } catch {
    /* cosmetic */
  }
}

/* -------------------------------------------------------------------------
 * Column anchor — "remember the start point so the route stays consistent"
 * (Samsung rule 3): Up/Down keep the column of the last horizontal move.
 * ----------------------------------------------------------------------- */

let columnAnchor: number | null = null;
let lastContentFocus: HTMLElement | null = null;

function resetSpatialMemory(): void {
  columnAnchor = null;
  lastContentFocus = null;
}

/* -------------------------------------------------------------------------
 * Candidate selection — the GRID model
 * ----------------------------------------------------------------------- */

/** Region candidates: all focusables inside the SAME region container. */
function regionCandidates(region: Region, excludeEl: HTMLElement | null): HTMLElement[] {
  const all = collectFocusables();
  return all.filter((el) => {
    if (el === excludeEl) return false;
    if (region === 'rail') return rowContainerOf(el) === rowContainerOf(excludeEl);
    if (region === 'grid') return el.closest('.explorer-grid') === (excludeEl as Element).closest?.('.explorer-grid');
    if (region === 'hero') return el.closest('.hero, .spotlight') === (excludeEl as Element).closest?.('.hero, .spotlight');
    if (region === 'filters') return el.closest('.explorer-filters, .filter-row, .recent-searches, .filter-bar') === (excludeEl as Element).closest?.('.explorer-filters, .filter-row, .recent-searches, .filter-bar');
    if (region === 'sidebar') return Boolean(el.closest('.app-sidebar'));
    if (region === 'dialog') return Boolean(el.closest('[role="dialog"]'));
    // content: everything that is NOT a scoped region (rails/grids/filters/
    // sidebar/hero/dialog are scoped by their own rules).
    return regionOf(el) === 'content';
  });
}

/** Content-region candidates for vertical moves: visible cards only. */
function contentCandidates(): HTMLElement[] {
  return collectFocusables().filter((el) => {
    const region = regionOf(el);
    if (region === 'sidebar' || region === 'dialog') return false;
    if (region === 'rail' || region === 'grid') return isCardInRailWindow(el);
    return true;
  });
}

/**
 * Horizontal pick within a row container: nearest element by MIDDLE distance
 * in the pressed direction (Samsung rule 3), perpendicular penalty keeps the
 * walk inside the row.
 */
function pickHorizontal(from: Rect, candidates: HTMLElement[], direction: 'left' | 'right'): HTMLElement | null {
  const sign = direction === 'right' ? 1 : -1;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    let to: Rect;
    try {
      to = rectOf(el);
    } catch {
      continue;
    }
    const delta = (to.cx - from.cx) * sign;
    if (delta <= 2) continue; // wrong direction / same position
    const perp = axisGap(from.top, from.bottom, to.top, to.bottom);
    const score = delta + perp * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------
 * STRUCTURAL ROW GROUPS — the TV-UX pass 2 rewrite of the vertical move.
 *
 * The previous pass picked the vertical target with a geometric tolerance
 * band around the nearest candidate; on the real rails that band leaked
 * into the CURRENT row (the reported "pressing UP switches between the
 * left/right cards instead of going to the row ABOVE"). The model is now
 * STRUCTURAL: every focusable belongs to a ROW GROUP (a rail, an explorer
 * grid row, a section-head/filter row, the hero, the sidebar list, a
 * dialog, or a banded content row). Up/Down move BETWEEN groups — same-
 * group elements are structurally unreachable vertically — then the member
 * whose middle is closest to the remembered COLUMN wins (clamped, Samsung
 * rules 2+3).
 * ----------------------------------------------------------------------- */

type RowGroup = { container: HTMLElement | null; isGrid: boolean; top: number; bottom: number; members: HTMLElement[] };

/** Containers that are exactly ONE horizontal row of focus stops. */
const ROW_CONTAINER_SELECTOR = [
  '.rail',
  '.section-head',
  '.results-heading',
  '.chip-row',
  '.filter-row',
  '.recent-searches',
  '.filter-bar',
  '.hero-nav',
  '.spotlight-nav',
  '.app-sidebar .sidebar-nav',
  '[role="dialog"]'
].join(', ');

/** Band ungrouped candidates into visual rows (top coordinate bands). */
function bandByTop(elements: HTMLElement[]): RowGroup[] {
  const sorted = [...elements].sort((a, b) => rectOf(a).top - rectOf(b).top);
  const groups: RowGroup[] = [];
  let current: RowGroup | null = null;
  for (const el of sorted) {
    const rect = rectOf(el);
    const height = Math.max(24, rect.bottom - rect.top);
    // TV-UX pass 3 (bug 9 — search Down stopped at the chips): the old
    // tolerance (height * 0.6) scaled with the PREVIOUS element's height —
    // a tall media card (~400px) contributed a ~240px tolerance that
    // SWALLOWED the next visual row (the search results grid banded into
    // ONE group, so the chip row's Down found no group below and stopped).
    // The tolerance is now capped at 48px: same-band controls still group,
    // a tall card can no longer bridge two grid rows.
    const tolerance = Math.min(height * 0.6, 48);
    if (!current || rect.top > current.bottom + tolerance) {
      current = { container: null, isGrid: false, top: rect.top, bottom: rect.bottom, members: [el] };
      groups.push(current);
      continue;
    }
    current.members.push(el);
    current.top = Math.min(current.top, rect.top);
    current.bottom = Math.max(current.bottom, rect.bottom);
  }
  return groups;
}

/**
 * Group the candidates into structural row groups. Grids (.explorer-grid)
 * and ungrouped content band by their rendered row tops; everything else
 * groups by its nearest row container. The HERO is always ONE group whose
 * members are ONLY the active slide's controls (heroTargets — offscreen
 * slides must never win a spatial pick).
 */
function buildRowGroups(candidates: HTMLElement[]): RowGroup[] {
  const groups: RowGroup[] = [];
  const banded: HTMLElement[] = [];
  const heroSet = new Set(heroTargets());
  let heroGroup: RowGroup | null = null;
  const byContainer = new Map<HTMLElement, RowGroup>();
  for (const el of candidates) {
    try {
      const heroSection = el.closest('.hero, .spotlight');
      if (heroSection && heroSet.size > 0 && heroSection.querySelector('.hero-track, .spotlight-track')) {
        // CAROUSEL hero: the active slide's actions + the visible nav cluster
        // form ONE group; offscreen slides are never members.
        if (!heroSet.has(el)) continue;
        const rect = rectOf(el);
        if (!heroGroup) {
          heroGroup = { container: null, isGrid: false, top: rect.top, bottom: rect.bottom, members: [el] };
          groups.push(heroGroup);
        } else {
          heroGroup.members.push(el);
          heroGroup.top = Math.min(heroGroup.top, rect.top);
          heroGroup.bottom = Math.max(heroGroup.bottom, rect.bottom);
        }
        continue;
      }
      const container = el.closest<HTMLElement>(ROW_CONTAINER_SELECTOR);
      if (!container) {
        banded.push(el);
        continue;
      }
      const rect = rectOf(el);
      let group = byContainer.get(container);
      if (!group) {
        group = {
          container,
          isGrid: container.classList.contains('explorer-grid'),
          top: rect.top,
          bottom: rect.bottom,
          members: [el]
        };
        byContainer.set(container, group);
        groups.push(group);
      } else {
        group.members.push(el);
        group.top = Math.min(group.top, rect.top);
        group.bottom = Math.max(group.bottom, rect.bottom);
      }
    } catch {
      /* an ungroupable candidate is simply skipped */
    }
  }
  // Grid containers hold MULTIPLE visual rows — sub-band their members by
  // their rendered row tops. The banded sub-groups replace the grid group
  // wholesale (the container Map is rebuilt on every call, so a DOM swap
  // never carries stale group state).
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group.isGrid && group.container) {
      groups.splice(i, 1);
      for (const sub of bandByTop(group.members)) groups.push(sub);
    }
  }
  for (const sub of bandByTop(banded)) groups.push(sub);
  return groups;
}

/**
 * Flat vertical pick (geometric nearest in direction, column tiebreak) for
 * surfaces where the structural row model does NOT apply: the sidebar's
 * single-column nav list and dialogs/sheets whose controls mix rows and
 * columns. The grouped pickVertical stays the model for page content.
 */
function pickVerticalFlat(from: Rect, candidates: HTMLElement[], direction: 'up' | 'down'): HTMLElement | null {
  const sign = direction === 'down' ? 1 : -1;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  const anchor = columnAnchor ?? from.cx;
  for (const el of candidates) {
    let to: Rect;
    try {
      to = rectOf(el);
    } catch {
      continue;
    }
    const primary = (to.cy - from.cy) * sign;
    if (primary <= 2) continue; // wrong direction / same row
    const score = primary + Math.abs(to.cx - anchor) * 0.4;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/**
 * Vertical pick — the NEAREST ROW GROUP in the pressed direction, then the
 * member whose middle is closest to the remembered column (Samsung rules
 * 2+3; no wrap; same-group members are structurally unreachable).
 */
function pickVertical(from: Rect, candidates: HTMLElement[], direction: 'up' | 'down'): HTMLElement | null {
  const groups = buildRowGroups(candidates);
  if (groups.length === 0) return null;
  type Scored = { group: RowGroup; distance: number };
  const scored: Scored[] = [];
  for (const group of groups) {
    // RAW distance (group edge to the focused element's opposite edge) —
    // smaller IS nearer in BOTH directions. (Multiplying by the direction
    // sign inverted the ordering for Up: the FARTHEST group above sorted
    // first and every Up move overshot to the hero.)
    const distance = direction === 'down' ? group.top - from.bottom : from.top - group.bottom;
    if (distance <= -Math.max(4, (from.bottom - from.top) * 0.5)) continue; // wrong direction / overlapping same row
    scored.push({ group, distance });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.distance - b.distance);
  // The nearest group in the pressed direction; among its members the one
  // closest to the column anchor (remembered start point — Samsung rule 3).
  const anchor = columnAnchor ?? from.cx;
  const target = scored[0].group.members.reduce(
    (best, el) => (Math.abs(rectOf(el).cx - anchor) < Math.abs(rectOf(best).cx - anchor) ? el : best),
    scored[0].group.members[0]
  );
  return target;
}

/* -------------------------------------------------------------------------
 * Region transitions
 * ----------------------------------------------------------------------- */

function heroSection(): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>('.app-main .hero, .app-main .spotlight');
  } catch {
    return null;
  }
}

/** Hero controls: the ACTIVE slide's actions row + the visible nav cluster
 *  (dots/arrows). Offscreen slides' buttons are layout-visible but must
 *  never win a spatial pick — Enter/geometry must reference the slide the
 *  user is actually looking at. */
function heroTargets(): HTMLElement[] {
  try {
    const hero = heroSection();
    if (!hero) return [];
    const selector = [
      '.hero-slide.active .hero-actions a',
      '.hero-slide.active .hero-actions button',
      '.spotlight-slide.active .slide-actions a',
      '.spotlight-slide.active .slide-actions button',
      '.hero-nav button',
      '.spotlight-nav button'
    ].join(', ');
    return Array.from(hero.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => isInteractiveTarget(el) && isVisible(el) && !el.closest('[aria-hidden="true"]')
    );
  } catch {
    return [];
  }
}

/**
 * The hero's ENTRY target (TV-UX pass 3, bugs 1+3): the ACTIVE slide's
 * PRIMARY control — the Play link, first in the actions row's DOM order.
 * heroTargets() also contains the nav cluster (dots/arrows), and a column
 * anchored mid-screen used to resolve Up/Right entries to the DOTS — the
 * reported "entering the hero lands on the slide dots". Every ENTRY into
 * the hero (boot seed, sidebar Right, Up from content) must land on Play;
 * the dots stay reachable only by deliberately walking Right past the
 * slide's own buttons — never as the default landing.
 */
function heroPrimaryTarget(): HTMLElement | null {
  try {
    const actions = heroTargets().filter((el) => !el.closest('.hero-nav, .spotlight-nav'));
    if (actions.length) return actions[0];
    const peers = heroTargets();
    return peers.length ? peers[0] : null;
  } catch {
    return null;
  }
}

/** The FIRST card (leftmost, column-aligned) of the FIRST rail below the hero. */
function firstCardOfFirstRailBelowHero(): HTMLElement | null {
  try {
    const hero = heroSection();
    const heroBottom = hero ? hero.getBoundingClientRect().bottom : window.innerHeight * 0.5;
    const rails = Array.from(document.querySelectorAll<HTMLElement>('.rail'));
    let targetRail: HTMLElement | null = null;
    let targetTop = Infinity;
    for (const rail of rails) {
      const top = rail.getBoundingClientRect().top;
      if (top >= heroBottom - 60 && top < targetTop) {
        targetTop = top;
        targetRail = rail;
      }
    }
    if (!targetRail) return null;
    const cards = Array.from(targetRail.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => isInteractiveTarget(el) && isCardFocusUnit(el) && isVisible(el)
    );
    if (cards.length === 0) return null;
    // The first VISIBLE card in the rail's current window; when nothing is
    // visible (fresh rail), the layout-first card.
    const visible = cards.filter((el) => isCardInRailWindow(el));
    const pool = visible.length ? visible : cards;
    return pool.reduce((leftmost, el) => (rectOf(el).cx < rectOf(leftmost).cx ? el : leftmost), pool[0]);
  } catch {
    return null;
  }
}

function firstSidebarLink(): HTMLElement | null {
  try {
    const links = Array.from(document.querySelectorAll<HTMLElement>('.app-sidebar .sidebar-link, .app-sidebar .sidebar-account'));
    return links.find((el) => isVisible(el)) ?? null;
  } catch {
    return null;
  }
}

function activeSidebarLink(): HTMLElement | null {
  try {
    const active = document.querySelector<HTMLElement>('.app-sidebar .sidebar-link.active');
    if (active && isVisible(active)) return active;
  } catch {
    /* fall through */
  }
  return firstSidebarLink();
}

function firstMainFocusable(): HTMLElement | null {
  try {
    const main = document.querySelector('.app-main main') || document.querySelector('.app-main') || document.body;
    const nodes = Array.from((main as HTMLElement).querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    return (
      nodes.find(
        (el) =>
          isInteractiveTarget(el) &&
          isCardFocusUnit(el) &&
          isVisible(el) &&
          !el.closest('[aria-hidden="true"]') &&
          // Seed/restore must NOT land inside a carousel slide track — see
          // seedFocusTarget() for the autoplay rationale.
          !el.closest('.hero-track, .spotlight-track')
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Content entry point for "Right from the sidebar" (bugs 1/7 + pass-3 bug
 * 10): the PAGE'S TOP element — the hero carousel's primary control (the
 * active slide's Play) when the page has one; on pages WITHOUT a hero the
 * TOPMOST focusable in the content area (the top-most rail heading/filter
 * control, the search input, the detail Back button — never a mid-page
 * element). The remembered lastContentFocus is deliberately NOT consulted:
 * the entry target is the top of the content, not its vertical centre.
 */
function contentEntryTarget(): HTMLElement | null {
  try {
    const primary = heroPrimaryTarget();
    if (primary) return primary;
  } catch {
    /* fall through */
  }
  try {
    // Top-most content element (bug 10): the smallest rect.top wins; ties
    // (a horizontal row) resolve to the LEFTMOST member. Off-screen rails
    // contribute only their in-window cards; a rail heading row above the
    // cards is nearer the top and wins for exactly the "top-most rail
    // heading" contract.
    const candidates = collectFocusables().filter((el) => {
      const region = regionOf(el);
      if (region === 'sidebar' || region === 'dialog') return false;
      if (region === 'rail' || region === 'grid') return isCardInRailWindow(el);
      return true;
    });
    if (candidates.length) {
      let best = candidates[0];
      let bestRect = rectOf(best);
      for (const el of candidates) {
        const rect = rectOf(el);
        if (rect.top < bestRect.top - 8 || (Math.abs(rect.top - bestRect.top) <= 8 && rect.cx < bestRect.cx)) {
          best = el;
          bestRect = rect;
        }
      }
      return best;
    }
  } catch {
    /* fall through */
  }
  return firstMainFocusable();
}

/* -------------------------------------------------------------------------
 * Route-keyed focus restoration (Back / forward navigation)
 * ----------------------------------------------------------------------- */

let currentRouteKey = '#/';
const focusByRoute = new Map<string, HTMLElement>();
const ROUTE_MEMORY_MAX = 32;

function routeKeyNow(): string {
  try {
    const hash = window.location.hash;
    return hash && hash.length > 1 ? hash : '#/';
  } catch {
    return '#/';
  }
}

/**
 * Boot focus target (bugs 1/7 + pass-3 bug 3): the HERO carousel's PRIMARY
 * control (the active slide's Play — never the dots) when the page has one
 * — every page entry lands on the hero first (the exact sidebar → hero →
 * filters → first rail order the TV feedback demands) — then the first
 * rail card, the first main control, the sidebar's active item, the first
 * sidebar link, anything. Seeded SILENTLY (no scroll — the TV boots
 * showing the hero).
 */
function seedFocusTarget(): HTMLElement | null {
  const heroPrimary = (() => {
    try {
      return heroPrimaryTarget();
    } catch {
      return null;
    }
  })();
  if (heroPrimary) return heroPrimary;
  const firstRail = firstCardOfFirstRailBelowHero();
  if (firstRail) return firstRail;
  const inMain = firstMainFocusable();
  if (inMain) return inMain;
  const sidebarActive = activeSidebarLink();
  if (sidebarActive) return sidebarActive;
  const sidebarLink = firstSidebarLink();
  if (sidebarLink) return sidebarLink;
  const any = collectFocusables();
  return any.length ? any[0] : null;
}

/** Restore (or seed) focus after a route render. */
function restoreRouteFocus(): void {
  const key = routeKeyNow();
  const saved = focusByRoute.get(key);
  if (saved && saved.isConnected && isVisible(saved)) {
    applyFocusSilent(saved);
    revealVertical(saved);
    ensureRailCardVisible(saved);
    columnAnchor = rectOf(saved).cx;
    if (regionOf(saved) !== 'sidebar') lastContentFocus = saved;
    setTvSidebarCollapsed(regionOf(saved) === 'sidebar');
    return;
  }
  // The saved element was unmounted (kit rebuilds page trees on navigation).
  // Match it by IDENTITY so Back from a detail page restores the CARD the
  // user left from, not the top of the page: first by exact href (every
  // card link carries a unique ?from= origin), then by tag + aria-label.
  if (saved) {
    try {
      if (saved.tagName === 'A') {
        const href = saved.getAttribute('href');
        if (href) {
          const match = document.querySelector<HTMLElement>(`a[href="${href.replace(/"/g, '\\"')}"]`);
          if (match && isVisible(match)) {
            applyFocus(match);
            columnAnchor = rectOf(match).cx;
            if (regionOf(match) !== 'sidebar') lastContentFocus = match;
            setTvSidebarCollapsed(false);
            return;
          }
        }
      }
      const label = saved.getAttribute('aria-label');
      if (label) {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(`${saved.tagName.toLowerCase()}[aria-label="${label.replace(/"/g, '\\"')}"]`));
        const match = candidates.find((el) => isVisible(el));
        if (match) {
          applyFocus(match);
          columnAnchor = rectOf(match).cx;
          if (regionOf(match) !== 'sidebar') lastContentFocus = match;
          setTvSidebarCollapsed(false);
          return;
        }
      }
    } catch {
      /* identity matching is best-effort */
    }
  }
  const first = seedFocusTarget();
  if (first) {
    applyFocusSilent(first);
    columnAnchor = rectOf(first).cx;
    if (regionOf(first) !== 'sidebar') lastContentFocus = first;
    // DETERMINISTIC SIDEBAR CONTRACT (bug 5): a route change always lands
    // focus in the content area (the hero on pages that have one) — the
    // sidebar collapses back to the icon rail with the navigation itself.
    setTvSidebarCollapsed(regionOf(first) === 'sidebar');
  }
}

/**
 * Direction of the last hash change. Browsers deliver popstate BEFORE
 * hashchange for history.back() — a forward hash navigation (link click /
 * goto) fires hashchange alone. The flag drives the FORWARD-ONLY scroll
 * reset below (Back keeps the root layout's own scroll restoration).
 */
let popstateSeen = false;

function onHashChange(): void {
  const prevKey = currentRouteKey;
  const nextKey = routeKeyNow();
  if (prevKey === nextKey) return;
  const wasBackNavigation = popstateSeen;
  popstateSeen = false;
  currentRouteKey = nextKey;
  resetSpatialMemory();
  try {
    railOffsetsReset();
  } catch {
    /* cosmetic */
  }
  // The old page is still rendered when hashchange fires (kit's own
  // hashchange handler re-renders after us) — capture its focus now.
  try {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      focusByRoute.set(prevKey, active);
      if (focusByRoute.size > ROUTE_MEMORY_MAX) {
        const oldest = focusByRoute.keys().next().value;
        if (oldest !== undefined) focusByRoute.delete(oldest);
      }
    }
  } catch {
    /* focus memory is best-effort */
  }
  // Restore after kit renders the destination (two frames is reliably past
  // the hash-router's synchronous render; the bounded retries cover slower
  // async loads).
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    const target = focusByRoute.get(nextKey);
    const ready = !target || !target.isConnected;
    if (ready || attempts >= 12) {
      // THE HERO-CUT-OFF FIX (bug 3): a FORWARD navigation must open the
      // destination at the very top of BOTH scrollers. The app's desktop
      // scroller (.app-main) is SvelteKit-invisible — kit only resets the
      // window — so a page entered after scrolling a previous page kept the
      // stale offset and the new page's hero sat 30-50% above the viewport.
      // Back navigations keep the root layout's own (correct) restore.
      if (!wasBackNavigation) resetPageScroll();
      restoreRouteFocus();
      // TV-UX pass 2: the freshly-rendered page's lazy images must not
      // depend on the engine's scroll-proximity heuristics — rails slide by
      // CSS transform (their scroll position never changes), so posters
      // below/right of the initial window never load on the TV engine.
      eagerLoadImages();
      return;
    }
    // The saved element is still attached — wait for the swap, then restore.
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Reset both scrollers to the top (forward navigation opens at the top). */
function resetPageScroll(): void {
  try {
    window.scrollTo(0, 0);
  } catch {
    /* cosmetic */
  }
  try {
    const main = document.querySelector<HTMLElement>('.app-main');
    if (main && main.scrollTop > 0) main.scrollTop = 0;
  } catch {
    /* cosmetic */
  }
}

/**
 * TV image loading policy (the reported "rails show BLANK poster areas").
 * The TV engine's native lazy-loading keys on scroll proximity, but the TV
 * rails never scroll (they slide by CSS transform) — cards right of the
 * initial window never intersect and their <img loading="lazy"> never
 * fetches. Every image the widget renders is forced eager; the posters are
 * small (w342 ≈ 30-50KB) so the bandwidth cost is bounded.
 */
function eagerLoadImages(): void {
  try {
    const images = document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]');
    for (const img of images) {
      img.loading = 'eager';
    }
  } catch {
    /* cosmetic — a failed sweep must never break navigation */
  }
}

function railOffsetsReset(): void {
  try {
    document.querySelectorAll<HTMLElement>('.rail').forEach((rail) => resetRailShift(rail));
  } catch {
    /* cosmetic */
  }
}

/* -------------------------------------------------------------------------
 * Key handling — ONE window capture listener
 * ----------------------------------------------------------------------- */

function isWatchRoute(): boolean {
  try {
    return window.location.hash.startsWith('#/watch/');
  } catch {
    return false;
  }
}

function closestSlideTrack(target: EventTarget | null): HTMLElement | null {
  try {
    if (!target || typeof (target as Element).closest !== 'function') return null;
    return (target as Element).closest<HTMLElement>('.hero-track, .spotlight-track');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * LONG-PRESS slide change (bug 7): a HELD arrow hands the key to the
 * carousel's own keydown handler. Both carousels own ArrowLeft/Right
 * navigation on their <section> (DiscoverPage's .hero, ExplorerPage's
 * .spotlight) — a synthetic keydown dispatched AT the section runs their
 * manualNav + their own preventDefault with zero shared-file edits. The
 * guard flag stops the manager's capture listener from re-processing the
 * synthetic event (dispatchEvent runs listeners synchronously).
 * ----------------------------------------------------------------------- */

let dispatchingHeroSlideNav = false;

function dispatchHeroSlideNav(direction: 'left' | 'right'): void {
  try {
    if (dispatchingHeroSlideNav) return;
    const hero = heroSection();
    if (!hero) return;
    dispatchingHeroSlideNav = true;
    const synthetic = new KeyboardEvent('keydown', {
      key: direction === 'left' ? 'ArrowLeft' : 'ArrowRight',
      bubbles: true,
      cancelable: true
    });
    hero.dispatchEvent(synthetic);
  } catch {
    /* the slide change is a comfort fix — never break navigation on it */
  } finally {
    dispatchingHeroSlideNav = false;
  }
}

/* -------------------------------------------------------------------------
 * Hero focus realignment
 *
 * The carousels navigate by SCROLLING the slide track (arrows, dots and the
 * 4s autoplay all end in track.scrollTo). DOM focus does not follow: a
 * button focused on slide 0 stays focused while slide 2 is showing — and
 * Enter would then activate an OFFSCREEN title's control. After every track
 * scroll settles, focus is re-pointed at the SAME control of the ACTIVE
 * slide (index-matched inside the actions container), so the visible ring,
 * the spatial geometry and Enter always reference the slide actually on
 * screen. No-op when focus is elsewhere or already on the active slide.
 * ----------------------------------------------------------------------- */

let realignTimer: ReturnType<typeof setTimeout> | undefined;

function realignTrackFocus(track: HTMLElement | null): void {
  try {
    if (!track) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const fromSlide = active.closest<HTMLElement>('.hero-slide, .spotlight-slide');
    if (!fromSlide || !track.contains(fromSlide)) return;
    const activeSlide = track.querySelector<HTMLElement>('.hero-slide.active, .spotlight-slide.active');
    if (!activeSlide || activeSlide === fromSlide) return;
    const actions = fromSlide.querySelector('.hero-actions, .slide-actions');
    if (!actions) return;
    const index = Array.prototype.indexOf.call(actions.children, active);
    const targetActions = activeSlide.querySelector('.hero-actions, .slide-actions');
    if (!targetActions) return;
    const counterpart =
      (index >= 0 && index < targetActions.children.length
        ? (targetActions.children[index] as HTMLElement)
        : null) ?? targetActions.querySelector<HTMLElement>('a, button');
    if (counterpart) applyFocus(counterpart);
  } catch {
    /* realignment is a TV comfort fix — never break on it */
  }
}

function onDocumentScrollCapture(event: Event): void {
  try {
    const track = closestSlideTrack(event.target);
    if (!track) return;
    if (realignTimer) clearTimeout(realignTimer);
    // The carousels debounce their own scroll handling at 150ms — mirror
    // that so realignment lands after the final scroll position is set.
    realignTimer = setTimeout(() => {
      realignTimer = undefined;
      realignTrackFocus(track);
    }, 180);
  } catch {
    /* ignore */
  }
}

function bootOverlayVisible(): boolean {
  try {
    const el = document.getElementById('mavero-wgt-boot-overlay');
    return Boolean(el && el.style.display !== 'none' && el.offsetWidth > 0);
  } catch {
    return false;
  }
}

function hideBootOverlay(): void {
  try {
    const el = document.getElementById('mavero-wgt-boot-overlay');
    if (el) el.style.display = 'none';
  } catch {
    /* diagnostics only */
  }
}

function statusStripVisible(): boolean {
  try {
    const el = document.getElementById('mavero-tv-status');
    return Boolean(el && el.style.display !== 'none');
  } catch {
    return false;
  }
}

/** The app's open modal layer, if any (sheets render only while open). */
function openDialog(): HTMLElement | null {
  try {
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    for (const el of dialogs) {
      if (isVisible(el)) return el;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function activate(active: Element | null): boolean {
  if (!active) return false;
  const tag = active.tagName;
  if (tag === 'A' || tag === 'BUTTON' || tag === 'SELECT') {
    (active as HTMLElement).click();
    return true;
  }
  if (tag === 'INPUT') {
    const type = (active as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') {
      (active as HTMLInputElement).click();
      return true;
    }
    return false; // text inputs keep native behavior
  }
  const role = active.getAttribute('role');
  if (role === 'button' || role === 'tab' || role === 'option') {
    (active as HTMLElement).click();
    return true;
  }
  return false;
}

/** The spatial move resolution for one arrow press. */
function moveFocus(direction: 'up' | 'down' | 'left' | 'right', repeat = false): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const candidates = collectFocusables();
  if (candidates.length === 0) return false;

  // Nothing focused yet (boot state): seed the content-first target.
  if (!active || !isVisible(active)) {
    const seed = seedFocusTarget();
    if (seed) {
      applyFocus(seed);
      columnAnchor = rectOf(seed).cx;
      if (regionOf(seed) !== 'sidebar') lastContentFocus = seed;
      setTvSidebarCollapsed(regionOf(seed) === 'sidebar');
      return true;
    }
    return false;
  }

  const from = rectOf(active);
  const region = regionOf(active);
  let target: HTMLElement | null = null;

  if (region === 'dialog') {
    // Everything stays inside the open sheet (flat list — sheets mix rows
    // and columns; the geometric nearest-neighbour walk stays predictable).
    const peers = regionCandidates('dialog', active);
    target =
      direction === 'left' || direction === 'right'
        ? pickHorizontal(from, peers, direction)
        : pickVerticalFlat(from, peers, direction);
  } else if (region === 'sidebar') {
    if (direction === 'left') {
      target = null; // no wrap, no exit to the left
    } else if (direction === 'right') {
      // BUG 10 (pass 3): entering content lands on the PAGE'S TOP element
      // (hero Play / top-most rail heading) — open the destination at the
      // very top of both scrollers first, so the entry reads as "the top of
      // the page", never the vertical centre of a scrolled page.
      resetPageScroll();
      target = contentEntryTarget();
    } else {
      target = pickVerticalFlat(from, regionCandidates('sidebar', active), direction);
    }
  } else if (region === 'hero') {
    if (direction === 'left' || direction === 'right') {
      if (repeat) {
        // LONG-PRESS (bug 7): a HELD arrow hands the key to the carousel —
        // the slide changes for every auto-repeat, while a TAP keeps
        // walking the hero's own buttons. The synthetic keydown lands on
        // the carousel section whose own handler runs manualNav + its own
        // preventDefault (no shared-file edits, no duplicated nav logic).
        dispatchHeroSlideNav(direction);
        return true;
      }
      target = pickHorizontal(from, heroTargets(), direction);
      if (!target && direction === 'left' && from.left <= contentLeftEdge() + 140) {
        // Deliberate Left at the hero's left edge → the sidebar.
        target = activeSidebarLink();
        if (target) setTvSidebarCollapsed(false);
      }
    } else if (direction === 'down') {
      // Down from ANY hero control → the NEXT ROW below the hero: the rail
      // heading/filter row when one exists (bug 7's "Down → the rail filter
      // row"), else the first card of the first rail below the hero.
      target = pickVertical(from, contentCandidates(), 'down') ?? firstCardOfFirstRailBelowHero();
      if (target) {
        const rail = rowContainerOf(target);
        if (rail && rail.classList.contains('rail')) resetRailShift(rail);
      }
    } else if (
      direction === 'up' &&
      Boolean(active.closest && active.closest('.hero-nav, .spotlight-nav'))
    ) {
      // Up from the carousel's dots/arrows cluster → the slide's action row
      // (Play first): "Play/Details must be reachable with Up/Down".
      const actions = heroTargets().filter((el) => !el.closest('.hero-nav, .spotlight-nav'));
      target = actions.length ? actions[0] : null;
    } else {
      target = null; // nothing above the hero
    }
  } else if (region === 'rail' || region === 'grid') {
    if (direction === 'left' || direction === 'right') {
      const rowPeers = regionCandidates(region, active).filter((el) => rowContainerOf(el) === rowContainerOf(active));
      target = pickHorizontal(from, rowPeers, direction);
      if (!target && direction === 'left') {
        // Deliberate Left at the leftmost content COLUMN → the sidebar.
        const card = cardLayoutRect(active, shiftOfRail(rowContainerOf(active) as HTMLElement));
        const edge = contentLeftEdge();
        if (card.left <= edge + 140) {
          target = activeSidebarLink();
          if (target) setTvSidebarCollapsed(false);
        }
      }
      // Right past the row's end: no wrap. A rail's trailing Show More
      // button (when present) is a natural row peer and wins first.
    } else {
      // Up MUST NOT resolve INTO the hero group (bug 3): the hero's own
      // controls (dots/arrows at the far right) are members of a geometric
      // group, and a right-side column anchor used to resolve Up to the
      // NAV CLUSTER instead of the entry Play. Exclude the hero from the
      // candidates and use the ENTRY control directly when the content
      // above is exhausted.
      const above = direction === 'up'
        ? contentCandidates().filter((el) => regionOf(el) !== 'hero')
        : contentCandidates();
      target = pickVertical(from, above, direction);
      if (!target && direction === 'up') {
        // Topmost content row → the hero's ENTRY control (bug 3): the active
        // slide's Play — NEVER the dots cluster.
        const heroPrimary = heroPrimaryTarget();
        if (heroPrimary) {
          target = heroPrimary;
        } else {
          const heroPeers = heroTargets();
          if (heroPeers.length) {
            const anchor = columnAnchor ?? from.cx;
            target = heroPeers.reduce(
              (best, el) => (Math.abs(rectOf(el).cx - anchor) < Math.abs(rectOf(best).cx - anchor) ? el : best),
              heroPeers[0]
            );
          }
        }
      }
    }
  } else if (region === 'filters') {
    if (direction === 'left' || direction === 'right') {
      const rowPeers = regionCandidates('filters', active).filter((el) => rowContainerOf(el) === rowContainerOf(active));
      target = pickHorizontal(from, rowPeers, direction);
      if (!target && direction === 'left') {
        const edge = contentLeftEdge();
        if (from.left <= edge + 140) {
          target = activeSidebarLink();
          if (target) setTvSidebarCollapsed(false);
        }
      }
    } else {
      // Up from the filter row: the hero group is excluded (see the rail
      // branch — the entry contract is Play, never the dots cluster).
      const above = direction === 'up'
        ? contentCandidates().filter((el) => regionOf(el) !== 'hero')
        : contentCandidates();
      target = pickVertical(from, above, direction);
      if (!target && direction === 'up') {
        // Filters → hero (bug 3): the active slide's Play is the entry
        // control; the dots are never the default landing.
        const heroPrimary = heroPrimaryTarget();
        if (heroPrimary) {
          target = heroPrimary;
        } else {
          const heroPeers = heroTargets();
          if (heroPeers.length) {
            const anchor = columnAnchor ?? from.cx;
            target = heroPeers.reduce(
              (best, el) => (Math.abs(rectOf(el).cx - anchor) < Math.abs(rectOf(best).cx - anchor) ? el : best),
              heroPeers[0]
            );
          }
        }
      }
    }
  } else {
    // Generic content (detail page body, empty states, footer, recs rows).
    const peers = contentCandidates().filter((el) => el !== active);
    if (direction === 'left' || direction === 'right') {
      target = pickHorizontal(from, peers, direction);
      if (!target && direction === 'left' && from.left <= contentLeftEdge() + 140) {
        target = activeSidebarLink();
        if (target) setTvSidebarCollapsed(false);
      }
    } else {
      target = pickVertical(from, peers, direction);
    }
  }

  if (!target) return true; // the edge is a STOP (no loop) — but the key IS consumed

  applyFocus(target);
  columnAnchor = rectOf(target).cx;
  const targetRegion = regionOf(target);
  if (targetRegion === 'sidebar') {
    setTvSidebarCollapsed(false); // auto-expand on entry
    // Remember the CONTENT element we came FROM (the Right-hand return
    // target). Only a genuine region transition may write it — moving
    // WITHIN the sidebar would otherwise pollute the memory with a sidebar
    // link and Right from the sidebar would then "return" to the sidebar.
    if (region !== 'sidebar') lastContentFocus = active;
  } else if (region === 'sidebar') {
    setTvSidebarCollapsed(true); // auto-collapse back to the icon rail
  }
  if (targetRegion !== 'sidebar' && targetRegion !== 'hero') {
    lastContentFocus = target;
  }
  return true;
}

function handleKeydown(event: KeyboardEvent): void {
  const code = typeof event.keyCode === 'number' ? event.keyCode : 0;
  const key = event.key || '';

  // The boot seed may only UPGRADE (bug 1) while the user has not acted;
  // every real key press hands focus ownership to the user.
  if (!userInteracted && (code === KEY_UP || code === KEY_DOWN || code === KEY_LEFT || code === KEY_RIGHT || code === KEY_ENTER || code === KEY_BACK || key === 'Enter' || key.startsWith('Arrow'))) {
    userInteracted = true;
  }

  // --- Back: overlay → status strip → open sheet → in-app history.back() --
  if (code === KEY_BACK || key === 'Back' || key === 'GoBack' || (key === 'Escape' && code === 0)) {
    try {
      if (bootOverlayVisible()) {
        hideBootOverlay();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (statusStripVisible()) {
        hideTvStatus();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // An open sheet/dialog consumes Back FIRST (AccountSheet, downloader
      // sheets, confirms — every one of them closes on Escape). Replaying a
      // synthetic Escape at the dialog reuses each sheet's OWN close
      // semantics — no shared-file edits, no duplicated close logic.
      const dialog = openDialog();
      if (dialog) {
        // KeyboardEventInit's legacy keyCode member is not in the DOM TS
        // lib — cast; every real engine honors it.
        const escapeInit = {
          key: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true
        } as KeyboardEventInit & { keyCode: number };
        dialog.dispatchEvent(new KeyboardEvent('keydown', escapeInit));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (hasInAppHistoryEntry()) {
        window.history.back();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Deep-linked first entry: nothing in-app to pop. The event keeps its
      // default (the platform may exit the widget — correct for a root Back).
    } catch {
      /* never break on Back */
    }
    return;
  }

  // --- Enter: activate the focused element --------------------------------
  if (code === KEY_ENTER || (key === 'Enter' && code === 0)) {
    try {
      const active = document.activeElement;
      // Stale hero focus safety net: if the focused control belongs to a
      // NON-active carousel slide (realign not yet applied), activate the
      // active slide's counterpart instead of the offscreen one.
      const track = closestSlideTrack(active);
      if (track) {
        const slide = (active as HTMLElement).closest<HTMLElement>('.hero-slide, .spotlight-slide');
        const activeSlide = track.querySelector<HTMLElement>('.hero-slide.active, .spotlight-slide.active');
        if (slide && activeSlide && slide !== activeSlide) {
          realignTrackFocus(track);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (activate(active)) {
        event.preventDefault();
        event.stopPropagation();
      }
    } catch {
      /* activation is best-effort */
    }
    return;
  }

  // --- Arrows: spatial movement -------------------------------------------
  let direction: 'up' | 'down' | 'left' | 'right' | null = null;
  if (code === KEY_UP || (key === 'ArrowUp' && code === 0)) direction = 'up';
  else if (code === KEY_DOWN || (key === 'ArrowDown' && code === 0)) direction = 'down';
  else if (code === KEY_LEFT || (key === 'ArrowLeft' && code === 0)) direction = 'left';
  else if (code === KEY_RIGHT || (key === 'ArrowRight' && code === 0)) direction = 'right';
  if (!direction) return;

  try {
    // The LONG-PRESS synthetic keydown (dispatched at the carousel section)
    // passes through this capture listener on its way to the section's own
    // handler — the manager must never re-process it.
    if (dispatchingHeroSlideNav) return;

    // Watch routes: the player owns arrow semantics (future TV player work);
    // Back/Enter above already work. Do not fight the player surface.
    if (isWatchRoute()) return;

    // ARIA listbox widgets (the discover dropdowns) own ArrowUp/Down/Enter
    // as OPTION navigation — spatial focus must not steal them. Delegate
    // untouched (the component's own handlers act + preventDefault).
    try {
      const activeNow = document.activeElement;
      if (
        activeNow &&
        typeof (activeNow as Element).closest === 'function' &&
        ((activeNow as Element).closest('[role="listbox"]') || (activeNow as Element).closest('[role="option"]'))
      ) {
        return;
      }
    } catch {
      /* fall through to spatial movement */
    }

    // Text entry keeps its native caret arrows (typing surface); Up/Down
    // still move focus spatially (search input → results, never sidebar).
    const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (isTextEntryTarget(activeEl) && (direction === 'left' || direction === 'right')) {
      return;
    }

    // Samsung rule 7: EVERY consumed arrow is preventDefault()-ed so the
    // page can never scroll behind the manager (the reported "Left/Right
    // sometimes scrolls the page up/down" bug). moveFocus() returns false
    // ONLY when it deliberately delegates (hero nav slide change) — in that
    // case the carousel's own handler preventDefaults.
    const consumed = moveFocus(direction, event.repeat === true);
    if (consumed) {
      event.preventDefault();
      event.stopPropagation();
    }
  } catch {
    /* navigation must never throw into the app */
    event.preventDefault();
    event.stopPropagation();
  }
}

/* -------------------------------------------------------------------------
 * Installation
 * ----------------------------------------------------------------------- */

function registerTvKeys(): void {
  try {
    const device = window.tizen && window.tizen.tvinputdevice;
    if (!device) return;
    // Samsung rule 1: ONLY extra media keys are registered. Arrows, Enter
    // and Back are MANDATORY platform keys — registering them BLOCKS their
    // default delivery (the exact regression of the first D-PAD pass).
    if (typeof device.registerKeyBatch === 'function') {
      try {
        device.registerKeyBatch(TV_KEY_NAMES);
        return;
      } catch {
        /* fall through to per-key registration */
      }
    }
    if (typeof device.registerKey === 'function') {
      for (const name of TV_KEY_NAMES) {
        try {
          device.registerKey(name);
        } catch {
          /* a single unsupported key name must not stop the rest */
        }
      }
    }
  } catch {
    /* tizen object unavailable outside the TV — ignore */
  }
}

/**
 * Has the user ACTED on the remote since boot? The boot seed (bug 1) may
 * land on a provisional target BEFORE the page's hero renders (the TV
 * payload arrives asynchronously; the footer's links are the only
 * focusables while the skeleton shows). Until the user touches a key, the
 * seed is allowed to UPGRADE to the hero's Play the moment it mounts —
 * after the first keypress the seed never moves again (the user owns it).
 */
let userInteracted = false;

function seedInitialFocus(): void {
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    if (attempts > 240) return; // ~60s ceiling at 250ms; never poll forever
    if (isWatchRoute()) return; // the player surface owns focus there
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!active || !isVisible(active)) {
      // Nothing focused yet: seed the content-first target and KEEP polling
      // (the payload may still be in flight — the hero replaces this seed
      // via the upgrade path below the moment it renders).
      const first = seedFocusTarget();
      if (first) {
        // SILENT seed: focus lands without scrolling so the TV boots showing
        // the hero at the top (scrolling to the seeded element would yank
        // the page). The first arrow press scrolls + reveals the ring.
        applyFocusSilent(first);
        try {
          columnAnchor = rectOf(first).cx;
          if (regionOf(first) !== 'sidebar') lastContentFocus = first;
        } catch {
          /* cosmetic */
        }
      }
      setTimeout(tick, 250);
      return;
    }
    // BUG 1 (pass 3 — "pressing Down jumps to a far-down rail"): the seed
    // landed on a provisional element (footer link / rail card) while the
    // hero payload was still loading, and the old poller STOPPED at the
    // first focus. While the user has not interacted yet, keep watching:
    // the moment the page's hero mounts, the seed UPGRADES to its Play.
    if (!userInteracted && regionOf(active) !== 'hero') {
      const primary = seedFocusTarget();
      if (primary && primary !== active && regionOf(primary) === 'hero') {
        applyFocusSilent(primary);
        try {
          columnAnchor = rectOf(primary).cx;
          lastContentFocus = primary;
        } catch {
          /* cosmetic */
        }
      }
      setTimeout(tick, 250);
      return;
    }
    // Focus sits on the hero (or the user interacted): the seed is final.
  };
  setTimeout(tick, 250);
}

export function installTvFocusManager(): void {
  if (!IS_WGT_BUILD) return; // production: dead branch (compile-time flag)
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__maveroTvFocusManager) return;
  window.__maveroTvFocusManager = true;

  try {
    document.body.classList.add('tv-mode');
  } catch {
    /* the class also arrives from the shell patcher — cosmetic duplicate */
  }

  registerTvKeys();

  currentRouteKey = routeKeyNow();
  window.addEventListener('hashchange', onHashChange);
  // Back/forward detection: popstate fires BEFORE hashchange for in-app
  // history.back() — the flag tells the forward-only scroll reset apart
  // from the root layout's own back-restore.
  window.addEventListener(
    'popstate',
    () => {
      popstateSeen = true;
    },
    true
  );

  // Late-mounted images (load-more appends, filtered grids, detail recs)
  // also drop their native lazy-load attribute — the TV rails never scroll,
  // so the engine's proximity heuristic would never fetch their posters.
  try {
    let eagerTimer: ReturnType<typeof setTimeout> | undefined;
    const eagerObserver = new MutationObserver(() => {
      if (eagerTimer) clearTimeout(eagerTimer);
      eagerTimer = setTimeout(() => {
        eagerTimer = undefined;
        eagerLoadImages();
      }, 200);
    });
    eagerObserver.observe(document.body, { childList: true, subtree: true });
  } catch {
    /* MutationObserver is a comfort fix — polling fallback below covers it */
  }
  // Bounded polling fallback for engines without MutationObserver.
  try {
    let sweeps = 0;
    const sweep = () => {
      sweeps += 1;
      if (sweeps > 240) return; // ~2 min at 500ms; never poll forever
      eagerLoadImages();
      setTimeout(sweep, 500);
    };
    setTimeout(sweep, 500);
  } catch {
    /* cosmetic */
  }
  eagerLoadImages();

  // TV diagnostics: a retail set has no devtools — the on-screen overlays
  // cover boot failures, and this hook lets a remote-driven probe print the
  // manager's view of the world (region model + spatial memory). Harmless in
  // production builds (the whole module is compile-time wgt-only).
  try {
    window.__maveroTvFocusDebug = () => {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return {
        region: active ? regionOf(active) : null,
        columnAnchor,
        lastContentFocus: lastContentFocus ? String(lastContentFocus.className).slice(0, 40) : null,
        hasHero: Boolean(heroSection()),
        rails: document.querySelectorAll('.rail').length
      };
    };
  } catch {
    /* diagnostics are best-effort */
  }

  // Capture phase: ahead of the hero carousel's own arrow handler and every
  // component handler; consumed keys are stopped so nothing double-fires.
  window.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('scroll', onDocumentScrollCapture, true);

  // The sidebar boots COLLAPSED (icon rail) on the TV — content gets the
  // full width and focus entering the sidebar auto-expands it.
  setTvSidebarCollapsed(true);

  seedInitialFocus();
}
