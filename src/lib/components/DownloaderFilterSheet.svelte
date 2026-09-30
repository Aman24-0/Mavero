<script lang="ts">
  /**
   * Mavero Downloader Filter Sheet (Phase E V2 final).
   *
   * A grouped, multi-dimensional filter sheet with clear section headings,
   * per-dimension chip selection, Apply/Clear actions, and keyboard/touch
   * accessibility. Replaces the flat single-selection SelectionSheet that
   * was used for filters in the initial Phase E V2.
   *
   * The sheet is a Mavero-styled bottom-sheet (mobile) / centered modal
   * (desktop) with grouped sections for TYPE, QUALITY, AUDIO, SIZE.
   * Multiple dimensions can be configured in one open session without
   * closing the sheet.
   */

  type FilterOption = { value: string; label: string; count: number };
  type FilterSection = { dimension: 'type' | 'quality' | 'language' | 'size'; heading: string; options: FilterOption[]; visible: boolean };

  let {
    open = false,
    sections = [] as FilterSection[],
    selected = {} as Record<string, string>,
    onApply = (_filters: Record<string, string>) => {},
    onClear = () => {},
    onClose = () => {},
  }: {
    open?: boolean;
    sections?: FilterSection[];
    selected?: Record<string, string>;
    onApply?: (filters: Record<string, string>) => void;
    onClear?: () => void;
    onClose?: () => void;
  } = $props();

  // Local copy of selected state — allows multi-select without closing.
  // $derived would reset on every parent change; we want a snapshot on open.
  let localSelected = $state<Record<string, string>>({});

  // Reset local state when the sheet opens.
  $effect(() => {
    if (open) localSelected = { ...selected };
  });

  let sheetEl = $state<HTMLDivElement>();
  let lastOpen = false;
  let previouslyFocused: HTMLElement | null = null;

  $effect(() => {
    if (open && !lastOpen) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      requestAnimationFrame(() => sheetEl?.querySelector<HTMLElement>('.filter-close')?.focus());
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
    const focusable = [...sheetEl.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
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

  function toggle(dimension: string, value: string) {
    localSelected = { ...localSelected, [dimension]: localSelected[dimension] === value ? 'all' : value };
  }

  function handleApply() {
    onApply(localSelected);
    onClose();
  }

  function handleClear() {
    localSelected = {};
    onClear();
  }

  const visibleSections = $derived(sections.filter((s) => s.visible && s.options.length > 0));
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="filter-layer" role="presentation">
    <button class="filter-backdrop" aria-label="Close filters" onclick={onClose}></button>
    <div class="filter-sheet" bind:this={sheetEl} role="dialog" aria-modal="true" aria-labelledby="filter-sheet-title" tabindex="-1">
      <div class="filter-handle" aria-hidden="true"></div>
      <header class="filter-header">
        <div>
          <div class="filter-eyebrow">MAVERO / FILTER</div>
          <h2 id="filter-sheet-title">Filters</h2>
        </div>
        <button class="filter-close" type="button" aria-label="Close filters" onclick={onClose}>×</button>
      </header>
      <div class="filter-body">
        {#each visibleSections as section (section.dimension)}
          <div class="filter-section" role="group" aria-label={section.heading}>
            <h3 class="filter-section-heading">{section.heading}</h3>
            <div class="filter-chips">
              {#each section.options as opt (opt.value)}
                <button
                  class="filter-chip"
                  class:active={localSelected[section.dimension] === opt.value}
                  type="button"
                  aria-pressed={localSelected[section.dimension] === opt.value}
                  aria-label={`${opt.label} (${opt.count})`}
                  onclick={() => toggle(section.dimension, opt.value)}
                >
                  <span class="filter-chip-label">{opt.label}</span>
                  <span class="filter-chip-count" aria-hidden="true">{opt.count}</span>
                </button>
              {/each}
            </div>
          </div>
        {/each}
        {#if visibleSections.length === 0}
          <div class="filter-empty">No filter options available for this addon.</div>
        {/if}
      </div>
      <footer class="filter-footer">
        <button type="button" class="filter-clear-btn" onclick={handleClear} aria-label="Clear all filters">
          Clear
        </button>
        <button type="button" class="filter-apply-btn" onclick={handleApply} aria-label="Apply filters">
          Apply
        </button>
      </footer>
      <div class="filter-safe-area" aria-hidden="true"></div>
    </div>
  </div>
{/if}

<style>
  .filter-layer { position: fixed; inset: 0; z-index: 85; display: grid; align-items: end; }
  .filter-backdrop { position: absolute; inset: 0; border: 0; background: rgba(3, 6, 7, .76); backdrop-filter: blur(10px); cursor: default; }
  .filter-sheet { position: relative; width: min(100%, 560px); max-height: min(78dvh, 680px); margin: 0 auto; overflow: hidden auto; border: 1px solid var(--line-strong); border-bottom: 0; border-radius: var(--radius-xl) var(--radius-xl) 0 0; background: var(--surface-2); box-shadow: var(--shadow-lg); animation: filter-in 220ms var(--ease-out); }
  .filter-handle { width: 38px; height: 4px; margin: 10px auto 0; border-radius: 99px; background: rgba(245, 246, 250,.25); }
  .filter-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 18px 20px 15px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--surface-2); z-index: 1; }
  .filter-eyebrow { color: var(--accent); font-size: .65rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 4px; }
  .filter-header h2 { margin: 0; color: var(--ink); font-size: 1.2rem; font-weight: 800; }
  .filter-close { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--muted); background: rgba(245, 246, 250,.04); font-size: 1.35rem; cursor: pointer; }
  .filter-close:hover, .filter-close:focus-visible { color: var(--ink); border-color: rgba(255,255,255,.3); outline: 0; box-shadow: 0 0 0 3px rgba(255,255,255,.08); }
  .filter-body { padding: 8px 16px 0; }
  .filter-section { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .filter-section:last-child { border-bottom: 0; }
  .filter-section-heading { margin: 0 0 8px; color: var(--ink-soft); font-size: .72rem; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .filter-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 5px 10px; font: inherit; font-size: .66rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .filter-chip:hover { border-color: var(--line-strong); color: var(--ink); }
  .filter-chip:focus-visible { border-color: var(--accent); outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }
  .filter-chip.active { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
  .filter-chip-label { line-height: 1.3; }
  .filter-chip-count { display: inline-flex; min-width: 16px; height: 15px; align-items: center; justify-content: center; border-radius: 999px; background: var(--color-border-strong); color: var(--muted); padding: 0 4px; font-size: .5rem; font-weight: 700; }
  .filter-chip.active .filter-chip-count { background: var(--accent); color: var(--color-bg); }
  .filter-empty { padding: 24px; text-align: center; color: var(--muted); font-size: .8rem; }
  .filter-footer { display: flex; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--line); position: sticky; bottom: 0; background: var(--surface-2); }
  .filter-clear-btn { flex: 1; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: transparent; color: var(--ink-soft); padding: 10px; font: inherit; font-size: .78rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .filter-clear-btn:hover, .filter-clear-btn:focus-visible { border-color: var(--color-warning); color: var(--color-warning); outline: none; }
  .filter-apply-btn { flex: 2; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--ink); padding: 10px; font: inherit; font-size: .78rem; font-weight: 800; cursor: pointer; transition: background var(--motion-fast) var(--ease-out); }
  .filter-apply-btn:hover, .filter-apply-btn:focus-visible { background: var(--accent); color: var(--color-bg); outline: none; }
  .filter-safe-area { height: max(16px, env(safe-area-inset-bottom)); }
  @keyframes filter-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
  @media (min-width: 700px) { .filter-layer { align-items: center; padding: 20px; } .filter-sheet { border-bottom: 1px solid var(--line-strong); border-radius: var(--radius-xl); } }
  @media (prefers-reduced-motion: reduce) { .filter-sheet { animation: none; } .filter-chip { transition: none; } }
</style>
