<script lang="ts">
  /**
   * Admin 2.0 — AdminFilterSheet
   *
   * The Mavero-native filter UI for mobile/narrow viewports — a chip-based
   * grouped bottom sheet (centered modal on desktop widths). This follows
   * the established Mavero filter pattern (DownloaderFilterSheet: grouped
   * sections, per-dimension chip selection, Apply/Clear, focus trap,
   * scroll-lock, safe-area) rendered with the Admin 2.0 design tokens
   * (--a2-* variables, cyan admin theme) so admin styling stays scoped
   * and never leaks into user-facing pages.
   *
   * REPLACES native browser <select> controls in the Jobs / Activity /
   * Attention / Media Library mobile filter experiences. Each section is
   * single-select (chip toggle) — matching the underlying query filters.
   *
   * Props:
   *   open        — sheet visibility
   *   title       — sheet heading (default "Filters")
   *   sections    — grouped chip sections (dimension + heading + options)
   *   selected    — current filter state, Record<dimension, value>
   *   onApply     — receives the chosen Record<dimension, value>
   *   onClear     — clear-all action
   *   onClose     — sheet dismissal
   */

  type FilterOption = { value: string; label: string; count?: number };
  type FilterSection = { dimension: string; heading: string; options: FilterOption[] };

  let {
    open = false,
    title = 'Filters',
    sections = [] as FilterSection[],
    selected = {} as Record<string, string>,
    onApply = (_filters: Record<string, string>) => {},
    onClear = () => {},
    onClose = () => {},
  }: {
    open?: boolean;
    title?: string;
    sections?: FilterSection[];
    selected?: Record<string, string>;
    onApply?: (filters: Record<string, string>) => void;
    onClear?: () => void;
    onClose?: () => void;
  } = $props();

  // Local copy of the selection — allows changing dimensions without
  // closing the sheet; reset from the parent state each time it opens.
  let localSelected = $state<Record<string, string>>({});

  $effect(() => {
    if (open) localSelected = { ...selected };
  });

  // Focus management + body scroll lock (same contract as the Mavero
  // DownloaderFilterSheet).
  let sheetEl = $state<HTMLDivElement>();
  let lastOpen = false;
  let previouslyFocused: HTMLElement | null = null;

  $effect(() => {
    if (open && !lastOpen) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      requestAnimationFrame(() => sheetEl?.querySelector<HTMLElement>('.a2-fs-close')?.focus());
      document.body.style.overflow = 'hidden';
    } else if (!open && lastOpen) {
      document.body.style.overflow = '';
      previouslyFocused?.focus();
    }
    lastOpen = open;
  });

  function handleKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !sheetEl) return;
    const focusable = [...sheetEl.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function select(dimension: string, value: string) {
    // Single-select per dimension: tapping the active chip clears it back
    // to 'all' (every section's first option is the 'all' value).
    localSelected = { ...localSelected, [dimension]: localSelected[dimension] === value ? 'all' : value };
  }

  function handleApply() {
    onApply(localSelected);
    onClose();
  }

  function handleClear() {
    localSelected = {};
    onClear();
    onClose();
  }

  const visibleSections = $derived(sections.filter((s) => s.options.length > 0));
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="a2-fs-layer" role="presentation">
    <button class="a2-fs-backdrop" type="button" aria-label="Close filters" onclick={onClose}></button>
    <div class="a2-fs-sheet" bind:this={sheetEl} role="dialog" aria-modal="true" aria-labelledby="a2-fs-title" tabindex="-1">
      <div class="a2-fs-handle" aria-hidden="true"></div>
      <header class="a2-fs-head">
        <div>
          <div class="a2-fs-eyebrow">MAVERO ADMIN</div>
          <h2 id="a2-fs-title">{title}</h2>
        </div>
        <button class="a2-fs-close" type="button" aria-label="Close filters" onclick={onClose}>×</button>
      </header>
      <div class="a2-fs-body">
        {#each visibleSections as section (section.dimension)}
          <div class="a2-fs-section" role="group" aria-label={section.heading}>
            <h3 class="a2-fs-section-heading">{section.heading}</h3>
            <div class="a2-fs-chips">
              {#each section.options as opt (opt.value)}
                <button
                  class="a2-fs-chip"
                  class:active={localSelected[section.dimension] === opt.value}
                  type="button"
                  aria-pressed={localSelected[section.dimension] === opt.value}
                  onclick={() => select(section.dimension, opt.value)}
                >
                  <span class="a2-fs-chip-label">{opt.label}</span>
                  {#if opt.count !== undefined}
                    <span class="a2-fs-chip-count" aria-hidden="true">{opt.count}</span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/each}
        {#if visibleSections.length === 0}
          <div class="a2-fs-empty">No filter options available.</div>
        {/if}
      </div>
      <footer class="a2-fs-footer">
        <button type="button" class="a2-fs-clear" onclick={handleClear} aria-label="Clear all filters">
          Clear
        </button>
        <button type="button" class="a2-fs-apply" onclick={handleApply} aria-label="Apply filters">
          Apply
        </button>
      </footer>
      <div class="a2-fs-safe-area" aria-hidden="true"></div>
    </div>
  </div>
{/if}

<style>
  .a2-fs-layer { position: fixed; inset: 0; z-index: 90; display: grid; align-items: end; }
  .a2-fs-backdrop {
    position: absolute; inset: 0; border: 0; padding: 0;
    background: rgba(2, 6, 8, 0.78);
    backdrop-filter: blur(10px);
    cursor: default;
    -webkit-tap-highlight-color: transparent;
  }
  .a2-fs-sheet {
    position: relative; width: min(100%, 560px); max-height: min(80dvh, 680px);
    margin: 0 auto; overflow: hidden auto;
    border: 1px solid var(--a2-line, rgba(148, 163, 184, 0.24)); border-bottom: 0;
    border-radius: var(--a2-radius-lg, 14px) var(--a2-radius-lg, 14px) 0 0;
    background: var(--a2-surface-1, #0b1114);
    box-shadow: 0 -18px 48px rgba(0, 0, 0, 0.5);
    animation: a2-fs-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .a2-fs-handle { width: 38px; height: 4px; margin: 10px auto 0; border-radius: 99px; background: rgba(148, 163, 184, 0.3); }
  .a2-fs-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 18px;
    padding: 16px 20px 14px;
    border-bottom: 1px solid var(--a2-line, rgba(148, 163, 184, 0.16));
    position: sticky; top: 0; background: var(--a2-surface-1, #0b1114); z-index: 1;
  }
  .a2-fs-eyebrow {
    color: var(--a2-cyan, #22d3ee);
    font-family: var(--a2-font-sans); font-size: 0.62rem; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 4px;
  }
  .a2-fs-head h2 { margin: 0; color: var(--a2-text-bright, #e8f2f5); font-family: var(--a2-font-sans); font-size: 1.1rem; font-weight: 700; }
  .a2-fs-close {
    display: grid; place-items: center; width: 34px; height: 34px;
    border: 1px solid var(--a2-line-strong, rgba(148, 163, 184, 0.35));
    border-radius: 50%; color: var(--a2-text-muted, #8ca3ad);
    background: transparent; font-size: 1.3rem; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .a2-fs-close:hover, .a2-fs-close:focus-visible {
    color: var(--a2-text-bright, #e8f2f5);
    border-color: var(--a2-cyan, #22d3ee);
    outline: 0; box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.18);
  }
  .a2-fs-body { padding: 6px 16px 0; }
  .a2-fs-section { padding: 12px 0; border-bottom: 1px solid var(--a2-line, rgba(148, 163, 184, 0.12)); }
  .a2-fs-section:last-child { border-bottom: 0; }
  .a2-fs-section-heading {
    margin: 0 0 10px; color: var(--a2-text-dim, #7d99a4);
    font-family: var(--a2-font-sans); font-size: 0.68rem; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .a2-fs-chips { display: flex; flex-wrap: wrap; gap: 7px; }
  .a2-fs-chip {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--a2-line, rgba(148, 163, 184, 0.22));
    border-radius: 999px; background: var(--a2-surface-2, #10181c);
    color: var(--a2-text-muted, #8ca3ad);
    padding: 7px 12px; font-family: var(--a2-font-sans); font-size: 0.72rem; font-weight: 600;
    cursor: pointer; white-space: nowrap; touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: border-color 140ms ease-out, background 140ms ease-out, color 140ms ease-out;
  }
  .a2-fs-chip:hover { border-color: var(--a2-line-strong, rgba(148, 163, 184, 0.4)); color: var(--a2-text-bright, #e8f2f5); }
  .a2-fs-chip:focus-visible {
    border-color: var(--a2-cyan, #22d3ee); outline: none;
    box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.18);
  }
  .a2-fs-chip.active {
    border-color: var(--a2-cyan, #22d3ee);
    background: var(--a2-cyan-soft, rgba(34, 211, 238, 0.12));
    color: var(--a2-cyan, #22d3ee);
  }
  .a2-fs-chip-count {
    display: inline-flex; min-width: 17px; height: 16px;
    align-items: center; justify-content: center;
    border-radius: 999px; padding: 0 5px;
    background: rgba(148, 163, 184, 0.18); color: var(--a2-text-dim, #7d99a4);
    font-size: 0.56rem; font-weight: 700;
  }
  .a2-fs-chip.active .a2-fs-chip-count { background: var(--a2-cyan, #22d3ee); color: #04140f; }
  .a2-fs-empty { padding: 24px; text-align: center; color: var(--a2-text-dim, #7d99a4); font-size: var(--a2-text-sm, 0.8rem); }
  .a2-fs-footer {
    display: flex; justify-content: space-between; gap: 12px;
    padding: 12px 16px; border-top: 1px solid var(--a2-line, rgba(148, 163, 184, 0.16));
    position: sticky; bottom: 0; background: var(--a2-surface-1, #0b1114);
  }
  .a2-fs-clear {
    flex: 1; border: 1px solid var(--a2-line-strong, rgba(148, 163, 184, 0.35));
    border-radius: var(--a2-radius-sm, 8px); background: transparent;
    color: var(--a2-text-muted, #8ca3ad); padding: 10px;
    font-family: var(--a2-font-sans); font-size: 0.78rem; font-weight: 700; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .a2-fs-clear:hover, .a2-fs-clear:focus-visible { border-color: var(--a2-amber, #f59e0b); color: var(--a2-amber, #f59e0b); outline: none; }
  .a2-fs-apply {
    flex: 2; border: 1px solid var(--a2-cyan, #22d3ee);
    border-radius: var(--a2-radius-sm, 8px);
    background: var(--a2-cyan-soft, rgba(34, 211, 238, 0.14));
    color: var(--a2-cyan, #22d3ee); padding: 10px;
    font-family: var(--a2-font-sans); font-size: 0.78rem; font-weight: 700; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .a2-fs-apply:hover, .a2-fs-apply:focus-visible {
    background: var(--a2-cyan, #22d3ee); color: #04140f; outline: none;
  }
  .a2-fs-safe-area { height: max(16px, env(safe-area-inset-bottom)); }

  @keyframes a2-fs-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }

  /* Desktop: the same component renders as a centered modal. */
  @media (min-width: 768px) {
    .a2-fs-layer { align-items: center; padding: 20px; }
    .a2-fs-sheet { border-bottom: 1px solid var(--a2-line-strong, rgba(148, 163, 184, 0.35)); border-radius: var(--a2-radius-lg, 14px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-fs-sheet { animation: none; }
    .a2-fs-chip { transition: none; }
  }
</style>
