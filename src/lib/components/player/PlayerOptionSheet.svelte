<script lang="ts">
  // Player selection-sheet chrome (focused player fixes 2026-10 — Issue 3).
  //
  // ONE shared surface for every in-player choice list (subtitles, quality,
  // speed, display mode, subtitle settings). Replaces the browser-default
  // <select> popups with Mavero's own cinematic player styling — the same
  // surface system the shell's source/episode sheets established (dark
  // translucent panel, blurred backdrop, handle, eyebrow title, close
  // button, accent selected-state).
  //
  // CONTRACTS (mirroring the shell sheets):
  //   * Dismissal: selection (caller), outside click/tap on the overlay,
  //     Escape, and the close button.
  //   * Focus: on open, focus moves to the close button; on close, focus
  //     restores to the element focused before opening (trigger restore).
  //   * Tab is TRAPPED inside the sheet while open; the shell's global
  //     shortcut handler stands down while a controls sheet is open (the
  //     shell receives the open state via onOpenChange).
  //   * Scrolling: the body scrolls independently; the sheet fits the
  //     viewport with safe-area insets (Android navigation bar included).
  import { onDestroy, onMount } from 'svelte';
  import { X } from 'lucide-svelte';

  /** Sheet title (eyebrow) + accessible dialog label. */
  export let title = '';
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
    const target = previousFocus;
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

<!-- Overlay: outside click/tap dismisses. The sheet itself is a sibling,
     so clicks inside never bubble into the overlay. -->
<div class="option-sheet-overlay" role="presentation" onclick={onClose}></div>
<div class="player-option-sheet" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onkeydown={handleKeydown}>
  <div class="sheet-handle" aria-hidden="true"></div>
  <div class="sheet-head">
    <span class="eyebrow">{title}</span>
    <button bind:this={closeBtn} class="close-button" type="button" aria-label={`Close ${title || 'menu'}`} onclick={onClose}><X size={17} /></button>
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
  .option-sheet-overlay { position: absolute; z-index: 20; inset: 0; background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(2px); pointer-events: auto; }
  .player-option-sheet { pointer-events: auto; }
  .player-option-sheet {
    position: absolute;
    z-index: 21;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    width: min(420px, 100%);
    max-height: min(62dvh, 560px);
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    border: 1px solid var(--line-strong);
    border-bottom: 0;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: rgba(13, 13, 13, 0.98);
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(28px);
    padding-bottom: env(safe-area-inset-bottom);
    animation: option-sheet-up var(--motion-normal, 200ms) var(--ease-out, ease-out);
  }
  .sheet-handle { width: 36px; height: 4px; margin: 8px auto 4px; border-radius: 999px; background: var(--line-strong); }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 18px 10px; }
  .sheet-head .eyebrow { color: var(--muted); }
  .close-button { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted); background: rgba(255, 255, 255, 0.04); cursor: pointer; }
  .close-button:hover, .close-button:focus-visible { border-color: var(--line-strong); color: var(--ink); }
  .sheet-body { min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 0 12px max(14px, env(safe-area-inset-bottom)); }
  @keyframes option-sheet-up { from { transform: translate(-50%, 100%); } to { transform: translate(-50%, 0); } }
  @media (prefers-reduced-motion: reduce) {
    .player-option-sheet { animation: none; }
  }
</style>
