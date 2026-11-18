/**
 * TV spatial focus manager — STAGE 4 D-PAD navigation (widget build only).
 *
 * The Tizen remote has NO pointer: arrow keys must MOVE DOM FOCUS between
 * interactive elements by screen geometry, Enter must activate, and Back
 * must pop one screen. Nothing in the web app did any of this (the remote's
 * up/down only produced native page scrolling and left/right did nothing —
 * the exact Stage-4 TV feedback), so this module installs the missing
 * layer ONCE at client-hook boot.
 *
 * ARCHITECTURE
 *   - ONE window keydown handler (capture phase — it must run before every
 *     component handler; handled keys are stopped so the hero carousel's own
 *     ArrowLeft/Right handler never double-fires behind us).
 *   - A Svelte writable store (`tvFocused`) exposes the focused element for
 *     observers (the CSS focus ring is applied via a `.tv-focused` class —
 *     the TV engine's programmatic focus() does not reliably match
 *     :focus-visible, and :has() does not exist on its Chromium < 88).
 *   - Focusable discovery is PER KEYPRESS (querySelectorAll): rails,
 *     chips and sheets mount/unmount constantly, so no cache and no
 *     MutationObserver can stay correct.
 *   - Back keeps ONE policy: the shared hasInAppHistoryEntry() contract.
 *     history.back() drives the SvelteKit hash router natively (snapshot +
 *     scroll restore), and a hashchange listener restores the focus that was
 *     saved for the route we land on (per-route focus map). The boot-error
 *     overlay and the TV status strip consume Back first — they sit above
 *     the app.
 *
 * SPATIAL ALGORITHM (bounding-rect geometry only — no DOM walk order):
 *   Candidates are scored per direction. In-lane candidates (whose rect
 *   overlaps the focused rect on the perpendicular axis) use the GAP along
 *   the pressed axis; diagonal candidates pay a perpendicular penalty. This
 *   makes Left/Right travel ALONG a horizontal rail (and Right past the last
 *   visible card reaches the offscreen one — scrollIntoView brings it in),
 *   while Up/Down hops BETWEEN rails picking the card most aligned with the
 *   current column. No dead zones by construction: whenever any candidate
 *   exists in the pressed direction (in-lane OR diagonal), focus moves.
 *
 * WIDGET BUILD ONLY — installTvFocusManager() is called from hooks.client.ts
 * behind the compile-time IS_WGT_BUILD flag; production never evaluates it
 * (dead-code eliminated in the Netlify build, which keeps its mouse/hover
 * interactions untouched).
 */

import { writable } from 'svelte/store';
import { IS_WGT_BUILD } from '$lib/shared/build-mode';
import { hasInAppHistoryEntry } from '$lib/shared/navigation';
import { hideTvStatus } from './status';

declare global {
  interface Window {
    __maveroTvFocusManager?: boolean;
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

/** TV media keys — registered so future player wiring receives them. */
const TV_KEY_NAMES = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'Back',
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
 * One media card = ONE focus stop (the Stage-4 contract: "every media card"
 * is a single focusable). A card's DOM carries 3-4 anchors (poster link,
 * play circle, title link, Details link) — stepping through all of them
 * per card would make a rail feel like 4x the work and trap the spatial
 * walk in vertical micro-hops. The POSTER LINK is the stop; Enter opens
 * the detail page (where Play and everything else is reachable). My List
 * selection mode keeps its own .mc-select button as the stop.
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
 * Spatial movement — bounding-rect geometry
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

/**
 * Distance from the perpendicular edges of `from` to the candidate rect —
 * 0 when the candidate overlaps that axis of the focused element ("in lane").
 */
function perpendicularOverlap(from: Rect, to: Rect, axis: 'x' | 'y'): number {
  if (axis === 'x') {
    // vertical overlap of the two rects (for horizontal movement)
    const overlap = Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top);
    return overlap > 0 ? 0 : Math.max(0, Math.max(from.top, to.top) - Math.min(from.bottom, to.bottom));
  }
  const overlap = Math.min(from.right, to.right) - Math.max(from.left, to.left);
  return overlap > 0 ? 0 : Math.max(0, Math.max(from.left, to.left) - Math.min(from.right, to.right));
}

/**
 * Pick the best candidate for a direction. Positive dot-product gate (the
 * candidate must actually lie in the pressed direction), in-lane candidates
 * first (perpendicular distance 0), diagonals allowed with a penalty —
 * this is what guarantees NO dead zones between rails while keeping
 * Left/Right faithful to a rail's own row.
 */
function pickCandidate(
  from: Rect,
  fromEl: HTMLElement | null,
  candidates: HTMLElement[],
  direction: 'up' | 'down' | 'left' | 'right'
): HTMLElement | null {
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'right' || direction === 'down' ? 1 : -1;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (el === fromEl) continue;
    let to: Rect;
    try {
      to = rectOf(el);
    } catch {
      continue;
    }
    const delta = horizontal ? to.cx - from.cx : to.cy - from.cy;
    if (delta * sign <= 0) continue; // wrong direction (or same position)
    const perp = perpendicularOverlap(from, to, horizontal ? 'x' : 'y');
    const primary = Math.abs(delta);
    // In-lane candidates score by gap; diagonals add the perpendicular
    // distance so an aligned-but-far element beats a misaligned-near one.
    const score = primary + perp * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------
 * Focus application
 * ----------------------------------------------------------------------- */

function applyFocus(el: HTMLElement, options?: { scroll?: boolean }): void {
  const scrollIntoView = options?.scroll !== false;
  try {
    const previous = document.querySelectorAll('.' + FOCUS_RING_CLASS);
    for (const node of previous) {
      if (node !== el) node.classList.remove(FOCUS_RING_CLASS);
    }
  } catch {
    /* ring cleanup is cosmetic */
  }
  try {
    el.focus({ preventScroll: true });
  } catch {
    // Older engines ignore preventScroll — focus may scroll; the
    // scrollIntoView below re-aligns to the nearest edge anyway.
    try {
      el.focus();
    } catch {
      return;
    }
  }
  try {
    el.classList.add(FOCUS_RING_CLASS);
  } catch {
    /* cosmetic */
  }
  tvFocused.set(el);
  if (!scrollIntoView) return; // silent seed: never move the page on boot
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    el.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: reduced ? 'auto' : 'smooth'
    } as ScrollIntoViewOptions);
  } catch {
    // Engines without options support: plain scrollIntoView is instant.
    try {
      el.scrollIntoView(false);
    } catch {
      /* ignore */
    }
  }
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
 * Boot focus target: the first CONTENT control (a rail card / empty-state
 * action) — deliberately OUTSIDE the hero. Seeding inside the hero would
 * fire the carousel's focusin pause and freeze the 4s autoplay exactly at
 * boot (the Stage-4 TV feedback's "does NOT auto-slide" would survive the
 * timer fix). Falls back to the first sidebar link, then any main control.
 */
function seedFocusTarget(): HTMLElement | null {
  const inMain = firstMainFocusable();
  if (inMain) return inMain;
  try {
    const sidebarLink = document.querySelector<HTMLElement>('.app-sidebar .sidebar-link');
    if (sidebarLink && isVisible(sidebarLink)) return sidebarLink;
  } catch {
    /* fall through */
  }
  const any = collectFocusables();
  return any.length ? any[0] : null;
}

/** Restore (or seed) focus after a route render. */
function restoreRouteFocus(): void {
  const key = routeKeyNow();
  const saved = focusByRoute.get(key);
  if (saved && saved.isConnected && isVisible(saved)) {
    applyFocus(saved);
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
          return;
        }
      }
    } catch {
      /* identity matching is best-effort */
    }
  }
  const first = seedFocusTarget();
  if (first) applyFocus(first);
}

function onHashChange(): void {
  const prevKey = currentRouteKey;
  const nextKey = routeKeyNow();
  if (prevKey === nextKey) return;
  currentRouteKey = nextKey;
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
      restoreRouteFocus();
      return;
    }
    // The saved element is still attached — wait for the swap, then restore.
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
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

function isCarouselTrackChild(target: EventTarget | null): boolean {
  try {
    if (!target || typeof (target as Element).closest !== 'function') return false;
    const el = target as Element;
    return Boolean(
      el.closest('.hero-track') ||
        el.closest('.spotlight-track') ||
        el.closest('.hero-nav') ||
        el.closest('.spotlight-nav')
    );
  } catch {
    return false;
  }
}

/** The scroll-snap slide track an element belongs to (hero or spotlight). */
function closestSlideTrack(target: EventTarget | null): HTMLElement | null {
  try {
    if (!target || typeof (target as Element).closest !== 'function') return null;
    return (target as Element).closest<HTMLElement>('.hero-track, .spotlight-track');
  } catch {
    return null;
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

function handleKeydown(event: KeyboardEvent): void {
  const code = typeof event.keyCode === 'number' ? event.keyCode : 0;
  const key = event.key || '';

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

    // Carousel slides: the component's own ArrowLeft/Right handler is the
    // slide navigation (manualNav + autoplay reset). Let it run untouched —
    // including its preventDefault. Up/Down and all other focus contexts
    // stay spatial.
    if (
      (direction === 'left' || direction === 'right') &&
      isCarouselTrackChild(document.activeElement)
    ) {
      return;
    }

    const active =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const from = active && isVisible(active) ? rectOf(active) : null;
    const candidates = collectFocusables();
    if (candidates.length === 0) return;

    let target: HTMLElement | null = null;
    if (from && active) {
      target = pickCandidate(from, active, candidates, direction);
    } else {
      // Nothing focused yet (boot state): seed the content-first target.
      target = seedFocusTarget();
    }
    if (target) {
      applyFocus(target);
      event.preventDefault();
      event.stopPropagation();
    }
  } catch {
    /* navigation must never throw into the app */
  }
}

/* -------------------------------------------------------------------------
 * Installation
 * ----------------------------------------------------------------------- */

function registerTvKeys(): void {
  try {
    const device = window.tizen && window.tizen.tvinputdevice;
    if (!device) return;
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

/** Seed focus once the shell has rendered (bounded polling — boot is async). */
function seedInitialFocus(): void {
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    if (attempts > 120) return; // ~30s ceiling; never poll forever
    if (isWatchRoute()) return; // the player surface owns focus there
    const anyFocused = document.activeElement && document.activeElement !== document.body;
    if (anyFocused) return;
    const first = seedFocusTarget();
    if (first) {
      // SILENT seed: focus lands without scrolling so the TV boots showing
      // the hero at the top (scrolling to the seeded rail card would yank
      // the page past the carousel — the boot screenshot showed exactly
      // that). The first arrow press scrolls + reveals the ring.
      applyFocus(first, { scroll: false });
      return;
    }
    setTimeout(tick, 250);
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

  // Capture phase: ahead of the hero carousel's own arrow handler and every
  // component handler; handled keys are stopped so nothing double-fires.
  window.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('scroll', onDocumentScrollCapture, true);

  seedInitialFocus();
}
