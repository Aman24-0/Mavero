<script lang="ts">
  // LT-18 — Live TV Filter sheet (presentation only); LT-19 — category-only.
  //
  // The /live-tv page's ONE filter surface, replacing the permanent category
  // chip row. Opens as a bottom sheet on mobile and a centered dialog on
  // larger screens (the same markup, one CSS switch at 640px).
  //
  // DATA TRUTHFULNESS (LT-19):
  //   * Category chips are the page's data-derived list (LT-2
  //     extractLiveTvCategories over the ORIGINAL provider `category` values)
  //     rendered through the existing LiveTvCategoryBar (wrap layout).
  //     Language-like values the provider supplies as categories (English,
  //     Tamil, Gujarati, …) appear as ordinary category options — the
  //     original taxonomy is never reinterpreted. The former separate
  //     Language section is gone.
  //   * The filter applies IMMEDIATELY (page-owned reactive state; local
  //     filtering only — no network, no URL params, no persistence).
  //     "Apply" acknowledges and closes; "Reset" clears the filter.
  //
  // A11y: role="dialog" with aria-modal, a labelled heading, Escape closes
  // (listened at the window level while open — it must work no matter where
  // focus sits), focus MOVES INTO the dialog on open (the ARIA pattern),
  // the backdrop click closes, and the sheet never renders when closed
  // (nothing focusable stays behind).
  import { X, RotateCcw, Check } from 'lucide-svelte';
  import LiveTvCategoryBar from '$components/live-tv/LiveTvCategoryBar.svelte';

  let {
    open = false,
    categories = [],
    selectedCategory = '',
    onclose = () => {},
    onselectcategory = (category: string) => {},
    onreset = () => {}
  }: {
    /** Whether the sheet is open (the page owns the state). */
    open?: boolean;
    /** Data-derived category list (page-owned; original provider values). */
    categories?: string[];
    /** The active category; '' = All. */
    selectedCategory?: string;
    /** Close the sheet (backdrop, Escape, Apply, X). */
    onclose?: () => void;
    /** Apply a category IMMEDIATELY ('' = All). */
    onselectcategory?: (category: string) => void;
    /** Reset every filter back to All (stays open for a fresh pick). */
    onreset?: () => void;
  } = $props();

  const filtersActive = $derived(Boolean(selectedCategory));

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
  <!-- Backdrop: click closes. Below the sheet, above the page. -->
  <button
    class="sheet-backdrop"
    type="button"
    aria-label="Close filters"
    onclick={onclose}
  ></button>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="ltv-sheet ltv-filter-sheet"
    role="dialog"
    aria-modal="true"
    aria-label="Filter channels"
    tabindex="-1"
    bind:this={sheetEl}
  >
    <header class="sheet-head">
      <h2 class="sheet-title">Filter channels</h2>
      <button class="sheet-close" type="button" aria-label="Close filters" onclick={onclose}>
        <X size={17} />
      </button>
    </header>

    <div class="sheet-body">
      <section class="sheet-section" aria-label="Filter by category">
        <h3 class="section-label">Category</h3>
        <LiveTvCategoryBar
          {categories}
          selected={selectedCategory}
          wrap
          onselect={onselectcategory}
        />
      </section>
    </div>

    <footer class="sheet-foot">
      <button class="sheet-reset" type="button" onclick={onreset} disabled={!filtersActive}>
        <RotateCcw size={14} /> Reset
      </button>
      <span class="foot-spacer" aria-hidden="true"></span>
      <button class="sheet-apply" type="button" onclick={onclose}>
        <Check size={15} /> Apply
      </button>
    </footer>
  </div>
{/if}

<style>
  /* Shared sheet chrome: fixed overlay pair, bottom sheet ≤640px, centered
     dialog above. z-index sits above the app shell's navigation. */
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
    width: min(560px, 100%);
    max-height: min(82dvh, 720px);
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--color-surface);
    box-shadow: 0 -24px 64px rgba(0, 0, 0, .5);
    /* bottom sheet on mobile */
    left: 0;
    right: 0;
    bottom: 0;
  }
  @media (min-width: 641px) {
    .ltv-sheet {
      /* centered dialog on larger screens */
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
  .sheet-title {
    margin: 0;
    color: var(--color-text);
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -.02em;
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
    gap: 18px;
    padding: 16px 18px;
    overflow-y: auto;
    min-height: 0;
    -webkit-overflow-scrolling: touch;
  }
  .sheet-section { display: grid; gap: 8px; min-width: 0; }
  .section-label {
    margin: 0;
    color: var(--color-text-deep);
    font-size: .66rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  .sheet-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 18px calc(12px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--color-border);
  }
  .foot-spacer { flex: 1 1 auto; }
  .sheet-reset {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    color: var(--color-text-muted);
    background: transparent;
    font-size: .74rem;
    font-weight: 800;
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .sheet-reset:hover:not(:disabled) { color: var(--color-text); border-color: var(--color-text-muted); }
  .sheet-reset:disabled { opacity: .4; cursor: default; }
  .sheet-reset:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .sheet-apply {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 44px;
    padding: 0 20px;
    border: 1px solid var(--color-primary-border);
    border-radius: 999px;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    font-size: .74rem;
    font-weight: 800;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .sheet-apply:hover { background: rgba(0, 255, 156, .16); border-color: var(--color-primary); }
  .sheet-apply:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .sheet-reset, .sheet-apply, .sheet-close { transition: none; }
  }
</style>
