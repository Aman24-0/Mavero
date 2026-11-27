<script lang="ts">
  // Player selection-sheet chrome (focused player fixes 2026-10 — Issue 3;
  // approved-concept redesign round 50: ANCHORED POPOVER).
  //
  // ONE shared surface for every in-player choice list (subtitles, quality,
  // speed, display mode, subtitle settings) — now a CONTEXT-MENU-STYLE
  // POPOVER anchored under (or above) the trigger chip instead of a
  // full-width bottom sheet:
  //   * `anchor` (the trigger chip) drives the placement via the
  //     popoverAnchor action (fixed positioning, viewport-clamped, flips
  //     above when there is no room below) — see popover-anchor.ts.
  //   * The overlay stays a click-catcher but is now TRANSPARENT (no dark
  //     scrim, no blur) — the video stays visible around the open menu,
  //     which is what makes it read as a context menu rather than a modal.
  //     The popover surface itself carries the single blur layer.
  //
  // CONTRACTS (mirroring the shell sheets):
  //   * Dismissal: selection (caller), outside click/tap on the overlay,
  //     Escape, and the close button.
  //   * Focus: on open, focus moves to the close button; on close, focus
  //     restores to the ANCHOR chip when it is still mounted (the popover
  //     is its context menu), else to the pre-open focused element.
  //   * Tab is TRAPPED inside the sheet while open; the shell's global
  //     shortcut handler stands down while a controls sheet is open (the
  //     shell receives the open state via onOpenChange).
  //   * Scrolling: the body scrolls independently; the popover fits the
  //     viewport (max-height clamps, safe-area-aware body padding).
  import { onDestroy, onMount } from 'svelte';
  import { X } from 'lucide-svelte';
  import { popoverAnchor } from './popover-anchor';

  /** Sheet title (eyebrow) + accessible dialog label. */
  export let title = '';
  /** Round 51 (server two-pane) — widen the popover to the two-pane width
   *  (min(560px, viewport-safe)); every other sheet keeps the compact width. */
  export let wide = false;
  /** The trigger chip the popover anchors to (round 50). */
  export let anchor: HTMLElement | null = null;
  /** True while the parent is running the 90ms exit animation (round 50) —
   *  the element stays mounted for the fade-out, then unmounts. */
  export let closing = false;
  /** Fires on every open-state change so the shell can gate shortcuts/gestures. */
  export let onOpenChange: (open: boolean) => void = () => {};
  export let onClose: () => void = () => {};

  let previousFocus: HTMLElement | null = null;
  let closeBtn: HTMLElement | undefined = undefined;

  onMount(() => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onOpenChange(true);
    // Focus the close button after the sheet enters the DOM.
    requestAnimationFrame(() => closeBtn?.focus());
  });
  onDestroy(() => {
    onOpenChange(false);
    // Round 50 — focus returns to the ANCHOR chip first (the popover is its
    // context menu — the user came from that chip); the pre-open focused
    // element is the fallback when the anchor is gone.
    const target = anchor && anchor.isConnected ? anchor : previousFocus;
    if (target && target.isConnected) {
      try { target.focus(); } catch { /* element not focusable */ }
    }
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Keep the shell's global handler out of this Escape (it stands down
      // on the open flag anyway — this makes the ordering irrelevant).
      event.stopImmediatePropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const sheet = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('.player-option-sheet') : null;
    if (!sheet) return;
    const focusables = Array.from(sheet.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
    if (!focusables.length) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !sheet.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !sheet.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Overlay: transparent click-catcher (round 50 — no dark scrim, no blur:
     the video stays visible around the popover; only the popover surface
     blurs). The sheet itself is a sibling, so clicks inside never bubble
     into the overlay. -->
<div class="option-sheet-overlay" role="presentation" onclick={onClose}></div>
<div class="player-option-sheet" class:wide class:closing use:popoverAnchor={{ anchor }} role="dialog" aria-label={title} tabindex="-1" onkeydown={handleKeydown}>
  <div class="sheet-head">
    <span class="eyebrow">{title}</span>
    <button bind:this={closeBtn} class="close-button" type="button" aria-label={`Close ${title || 'menu'}`} onclick={onClose}><X size={15} /></button>
  </div>
  <div class="sheet-body"><slot /></div>
</div>

<style>
  /* Same surface system as the shell's source/episode sheets (z-20/21).
     pointer-events: auto is REQUIRED here: the sheet renders inside the
     control layer (.controls), which is pointer-events:none — without the
     re-enable, every tap would fall through the sheet onto the video
     surface (the shell's own sheets hang off the shell and never had this
     problem). */
  .option-sheet-overlay { position: absolute; z-index: 20; inset: 0; background: transparent; pointer-events: auto; }
  .player-option-sheet { pointer-events: auto; }
  .player-option-sheet {
    /* Round 50 — the popoverAnchor action owns position/left/top (fixed,
       viewport-clamped); this rule owns the SURFACE only. */
    position: fixed;
    z-index: 21;
    width: min(420px, calc(100vw - 24px));
    max-height: min(70dvh, 560px);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    border: 1px solid rgba(255, 255, 255, 0.13);
    border-radius: 16px;
    background: rgba(18, 18, 20, 0.92);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 18px 48px rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(20px);
    transform-origin: var(--popover-origin, center);
    animation: option-sheet-pop 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  /* Exit (round 50): fade only — no scale, and `forwards` holds the faded
     state until the parent's 90ms delayed unmount lands. */
  .player-option-sheet.closing { animation: option-sheet-out 90ms ease-out forwards; }
  /* Round 51 (approved-concept fix C2) — the server sheet's two-pane width:
     the 132px group rail + the row list need more room than the compact
     420px popover. */
  .player-option-sheet.wide { width: min(560px, calc(100vw - 24px)); }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px 8px 16px; }
  .sheet-head .eyebrow { color: rgba(255, 255, 255, 0.45); font-size: 10.5px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; }
  .close-button { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 9px; color: rgba(255, 255, 255, 0.8); background: rgba(255, 255, 255, 0.06); cursor: pointer; }
  .close-button:hover, .close-button:focus-visible { background: rgba(255, 255, 255, 0.12); color: #fff; }
  /* Round 51 (Phase 4 — keyboard focus): the close control joins the focus
     ring system (2px solid white, 2px offset, the element's own radius). */
  .close-button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .sheet-body { min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 0 12px max(14px, env(safe-area-inset-bottom)); }
  @keyframes option-sheet-pop { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
  @keyframes option-sheet-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes option-sheet-out { to { opacity: 0; } }
  /* Round 51 (Phase 4 — preferences): reduced transparency → the popover
     becomes SOLID and DROPS its single blur layer; more contrast → the
     hairline border bumps. (The token-driven chip surfaces + ink follow the
     shell root's preference overrides.) */
  @media (prefers-reduced-transparency: reduce) {
    .player-option-sheet { background: rgba(20, 20, 23, 0.98); backdrop-filter: none; }
  }
  @media (prefers-contrast: more) {
    .player-option-sheet { border-color: rgba(255, 255, 255, 0.28); }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Round 51 (Phase 4): no SCALE under reduced motion — the open animation
       becomes an opacity-only fade; the exit is already opacity-only. */
    .player-option-sheet { animation: option-sheet-fade 120ms ease-out; }
    .player-option-sheet.closing { animation: option-sheet-out 90ms ease-out forwards; }
  }
</style>
