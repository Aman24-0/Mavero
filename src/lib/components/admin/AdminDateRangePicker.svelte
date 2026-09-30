<script lang="ts">
  /**
   * AdminDateRangePicker — shared date-range selector for analytics dashboards.
   *
   * Renders a pill-button row of preset periods + a Custom popover with
   * two date inputs. The selected period is encoded in the URL search
   * params (the parent page owns the URL), so this component is
   * presentational: it calls `onSelect` with the chosen period and
   * (for custom) the from/to dates.
   *
   * Reuses the existing admin pill-button aesthetic (see AdminStatusBadge,
   * .mini-btn) and the cyber-green design tokens.
   */
  import { Calendar, ChevronDown } from 'lucide-svelte';

  let {
    preset,
    from = '',
    to = '',
    onSelect
  }: {
    preset: string;
    from?: string;
    to?: string;
    onSelect: (next: { preset: string; from?: string; to?: string }) => void;
  } = $props();

  let customOpen = $state(false);

  const presets: Array<{ id: string; label: string }> = [
    { id: '24h', label: '24h' },
    { id: '7d', label: '7d' },
    { id: '30d', label: '30d' },
    { id: '3m', label: '3m' },
    { id: '6m', label: '6m' },
    { id: '1y', label: '1y' },
  ];

  function selectPreset(id: string) {
    customOpen = false;
    onSelect({ preset: id });
  }

  function toggleCustom() {
    customOpen = !customOpen;
  }

  // Local state for the custom date inputs. Initialized empty; the
  // `$effect` below syncs from the `from`/`to` props whenever they
  // change (e.g. on URL navigation). Using empty-string init avoids
  // the "captures only the initial value" warning from svelte-check.
  let customFrom = $state('');
  let customTo = $state('');

  // Sync local state when props change (e.g. URL navigation).
  $effect(() => {
    customFrom = from;
    customTo = to;
  });

  function applyCustom() {
    if (!customFrom || !customTo) return;
    onSelect({ preset: 'custom', from: customFrom, to: customTo });
    customOpen = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      customOpen = false;
    }
  }
</script>

<div class="date-range-picker" role="group" aria-label="Date range selector">
  <div class="preset-row">
    {#each presets as p}
      <button
        type="button"
        class="preset-pill"
        class:active={preset === p.id}
        onclick={() => selectPreset(p.id)}
        aria-pressed={preset === p.id}
      >
        {p.label}
      </button>
    {/each}
    <button
      type="button"
      class="preset-pill custom-pill"
      class:active={preset === 'custom'}
      onclick={toggleCustom}
      aria-pressed={preset === 'custom'}
      aria-expanded={customOpen}
      aria-label="Custom date range"
    >
      <Calendar size={13} />
      <span>Custom</span>
      <ChevronDown size={12} class="chevron" />
    </button>
  </div>

  {#if customOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="custom-popover" role="dialog" aria-label="Custom date range" tabindex="-1" onkeydown={onKeydown}>
      <div class="custom-row">
        <label class="custom-field">
          <span class="custom-label">From</span>
          <input
            type="date"
            bind:value={customFrom}
            max={customTo || undefined}
            aria-label="Start date"
          />
        </label>
        <label class="custom-field">
          <span class="custom-label">To</span>
          <input
            type="date"
            bind:value={customTo}
            min={customFrom || undefined}
            aria-label="End date"
          />
        </label>
      </div>
      <div class="custom-actions">
        <button type="button" class="custom-btn" onclick={() => customOpen = false}>Cancel</button>
        <button
          type="button"
          class="custom-btn primary"
          onclick={applyCustom}
          disabled={!customFrom || !customTo}
        >
          Apply
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .date-range-picker {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    gap: 8px;
  }
  .preset-row {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .preset-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .62rem;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: border-color var(--motion-fast) var(--ease-out),
                background var(--motion-fast) var(--ease-out),
                color var(--motion-fast) var(--ease-out);
  }
  .preset-pill:hover {
    border-color: var(--color-primary-border);
    color: var(--color-text);
  }
  .preset-pill.active {
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    color: var(--color-primary);
    box-shadow: var(--glow-primary);
  }
  .preset-pill:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
  .custom-pill :global(.chevron) {
    transition: transform var(--motion-fast) var(--ease-out);
  }
  .custom-pill[aria-expanded="true"] :global(.chevron) {
    transform: rotate(180deg);
  }
  .custom-popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    min-width: 320px;
    padding: 14px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface-elevated);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .5), var(--glow-primary);
  }
  .custom-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .custom-field {
    display: grid;
    gap: 4px;
  }
  .custom-label {
    color: var(--color-text-deep);
    font-size: .53rem;
    font-weight: 800;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .custom-field input {
    min-height: 36px;
    padding: 6px 10px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-surface-raised);
    color: var(--color-text);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .72rem;
  }
  .custom-field input:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 1px;
    border-color: var(--color-primary-border);
  }
  .custom-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .custom-btn {
    min-height: 32px;
    padding: 0 14px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-size: .64rem;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: border-color var(--motion-fast) var(--ease-out),
                color var(--motion-fast) var(--ease-out);
  }
  .custom-btn:hover {
    border-color: var(--color-primary-border);
    color: var(--color-text);
  }
  .custom-btn.primary {
    border-color: var(--color-primary-border);
    background: var(--color-primary);
    color: #050708;
  }
  .custom-btn.primary:disabled {
    opacity: .4;
    cursor: not-allowed;
  }
  .custom-btn:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  @media (max-width: 640px) {
    .custom-popover {
      right: auto;
      left: 0;
      min-width: unset;
      width: calc(100vw - 56px);
      max-width: 360px;
    }
  }
</style>
