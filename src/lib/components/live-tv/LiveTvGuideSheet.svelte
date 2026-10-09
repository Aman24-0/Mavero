<script lang="ts">
  // LT-18 — Live TV Guide sheet (presentation only); LT-19 — single list.
  //
  // ONE sheet holding the full guide experience: the FULL GUIDE schedule
  // (LiveTvGuide) is the SINGLE source of programme-card presentation —
  // its continuous list already contains the current programme as its first
  // entry (marked "On air" by real [start, stop) timing) followed by the
  // upcoming programmes. The former duplicate NOW PLAYING / UP NEXT cards
  // are gone (LT-19). The existing component is reused VERBATIM — the sheet
  // is pure chrome around it, so the existing guide loading/error/retry/
  // empty logic and the page's guide state are the single source of truth:
  //   * opening the sheet NEVER fetches anything (the page loads the guide
  //     with the channel selection, independent of playback — LT-4 §13);
  //   * closing the sheet never affects playback;
  //   * with no channel selected the page keeps the Guide button disabled,
  //     so no fake guide data can ever appear here.
  //
  // A11y: role="dialog" with aria-modal, a labelled heading, Escape closes
  // (a window-level listener while open — it must work no matter where focus
  // sits), focus MOVES INTO the dialog on open (the ARIA pattern), the
  // backdrop click closes, and the sheet never renders when closed.
  import { X } from 'lucide-svelte';
  import LiveTvGuide from '$components/live-tv/LiveTvGuide.svelte';
  import type { LiveTvChannel, LiveTvGuide as LiveTvGuideModel } from '$lib/client/live-tv/types';

  let {
    open = false,
    channel = null,
    guide = null,
    nowSeconds = 0,
    loading = false,
    errorMessage = null,
    onclose = () => {},
    onretry = () => {}
  }: {
    /** Whether the sheet is open (the page owns the state). */
    open?: boolean;
    /** The selected channel (display only — its name heads the sheet). */
    channel?: LiveTvChannel | null;
    /** The page's EXISTING guide state (never re-fetched by the sheet). */
    guide?: LiveTvGuideModel | null;
    /** Page-supplied current Unix seconds (drives the honest markers). */
    nowSeconds?: number;
    loading?: boolean;
    /** Safe message for a guide failure (page-owned). */
    errorMessage?: string | null;
    onclose?: () => void;
    /** The page's EXISTING guide retry (re-requests the guide only). */
    onretry?: () => void;
  } = $props();

  let sheetEl: HTMLElement | undefined = $state();

  // The ARIA dialog pattern: while open, focus lives inside the dialog and
  // Escape anywhere closes it (a window-level listener — the event target
  // may be outside the dialog subtree while focus transitions).
  $effect(() => {
    if (!open) return;
    queueMicrotask(() => sheetEl?.focus());
    const onWindowKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onclose();
      }
    };
    window.addEventListener('keydown', onWindowKeydown);
    return () => window.removeEventListener('keydown', onWindowKeydown);
  });
</script>

{#if open}
  <!-- Backdrop: click closes (playback is untouched). -->
  <button
    class="sheet-backdrop"
    type="button"
    aria-label="Close guide"
    onclick={onclose}
  ></button>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="ltv-sheet ltv-guide-sheet"
    role="dialog"
    aria-modal="true"
    aria-label="Channel guide"
    tabindex="-1"
    bind:this={sheetEl}
  >
    <header class="sheet-head">
      <div class="head-copy">
        <h2 class="sheet-title">Guide</h2>
        {#if channel}
          <span class="head-channel">{channel.name}</span>
        {/if}
      </div>
      <button class="sheet-close" type="button" aria-label="Close guide" onclick={onclose}>
        <X size={17} />
      </button>
    </header>

    <div class="sheet-body">
      <!-- FULL GUIDE — the existing schedule list, existing state; the
           single source of programme cards (current marked "On air"). -->
      <LiveTvGuide {guide} {nowSeconds} {loading} {errorMessage} {onretry} />
    </div>
  </div>
{/if}

<style>
  /* The same sheet chrome as the filter sheet: bottom sheet ≤640px,
     centered dialog above; the guide sheet is taller (full schedule). */
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    padding: 0;
    border: 0;
    background: rgba(2, 4, 5, .66);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    cursor: default;
  }
  .ltv-sheet {
    position: fixed;
    z-index: 61;
    display: flex;
    flex-direction: column;
    width: min(720px, 100%);
    max-height: min(88dvh, 860px);
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--color-surface);
    box-shadow: 0 -24px 64px rgba(0, 0, 0, .5);
    left: 0;
    right: 0;
    bottom: 0;
  }
  @media (min-width: 641px) {
    .ltv-sheet {
      top: 50%;
      bottom: auto;
      left: 50%;
      transform: translate(-50%, -50%);
      border-radius: var(--radius-lg);
      box-shadow: 0 32px 90px rgba(0, 0, 0, .6);
    }
  }

  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--color-border);
  }
  .head-copy { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex-wrap: wrap; }
  .sheet-title {
    margin: 0;
    color: var(--color-text);
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -.02em;
  }
  .head-channel {
    color: var(--color-text-muted);
    font-size: .78rem;
    font-weight: 700;
    letter-spacing: -.01em;
  }
  .sheet-close {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 1px solid var(--color-border);
    border-radius: 50%;
    color: var(--color-text-muted);
    background: transparent;
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  }
  .sheet-close:hover { color: var(--color-primary); background: var(--color-primary-soft); }
  .sheet-close:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .sheet-body {
    display: grid;
    gap: 22px;
    padding: 16px 18px calc(18px + env(safe-area-inset-bottom, 0px));
    overflow-y: auto;
    min-height: 0;
    -webkit-overflow-scrolling: touch;
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet-close { transition: none; }
  }
</style>
