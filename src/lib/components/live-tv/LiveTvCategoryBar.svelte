<script lang="ts">
  // LT-4 — Live TV category bar (presentation only).
  //
  // Categories are ALWAYS data-derived by the page (LT-2
  // extractLiveTvCategories — never hardcoded, plan §8); this component only
  // renders the chip row: "All" plus one chip per category. Selection is a
  // semantic button with aria-pressed so keyboard and screen-reader users get
  // the same affordance as pointer users. The row scrolls horizontally inside
  // its own surface (never page-level overflow).
  import { LayoutGrid } from 'lucide-svelte';

  let {
    categories = [],
    selected = '',
    onselect = (category: string) => {}
  }: {
    /** Data-derived category list (page-owned, LT-2 extractLiveTvCategories). */
    categories?: string[];
    /** The active category; '' means "All" (no category filter). */
    selected?: string;
    /** Fired on chip activation with the category to apply ('' = All). */
    onselect?: (category: string) => void;
  } = $props();
</script>

<div class="ltv-category-bar" role="group" aria-label="Filter channels by category">
  <button
    type="button"
    class="ltv-chip"
    class:active={selected === ''}
    aria-pressed={selected === ''}
    onclick={() => onselect('')}
  >
    <LayoutGrid size={13} aria-hidden="true" />
    <span>All</span>
  </button>
  {#each categories as category (category)}
    <button
      type="button"
      class="ltv-chip"
      class:active={selected === category}
      aria-pressed={selected === category}
      onclick={() => onselect(category)}
    >{category}</button>
  {/each}
</div>

<style>
  .ltv-category-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    padding: 2px 2px 4px;
    -webkit-overflow-scrolling: touch;
  }
  .ltv-category-bar::-webkit-scrollbar { display: none; }

  .ltv-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text-muted);
    background: rgba(8, 11, 13, .55);
    font-size: .74rem;
    font-weight: 700;
    letter-spacing: .01em;
    white-space: nowrap;
    transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .ltv-chip:hover {
    color: var(--color-text);
    border-color: var(--color-border-strong);
    background: var(--color-surface-raised);
  }
  .ltv-chip.active {
    color: var(--color-primary);
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    box-shadow: var(--glow-primary);
  }
  .ltv-chip.active :global(svg) { color: var(--color-primary); }
  .ltv-chip:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
</style>
