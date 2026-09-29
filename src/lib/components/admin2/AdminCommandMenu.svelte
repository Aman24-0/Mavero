<script lang="ts" module>
  /**
   * Admin 2.0 — AdminCommandMenu
   *
   * Phase B foundation for the ⌘K / Ctrl+K command palette.
   *
   * Phase B scope:
   *   - Global ⌘K / Ctrl+K keyboard shortcut (handled in AdminAppShell).
   *   - Quick fuzzy search across every navigation destination.
   *   - Arrow-key navigation, Enter to activate, Esc to close.
   *   - Dialog semantics (role="dialog", aria-modal, focus trap, restore focus).
   *   - Glass surface with backdrop blur (per Admin 2.0 design system §9).
   *
   * Future phases (not Phase B):
   *   - Action commands (sync provider, retry upload, etc.)
   *   - Recent items
   *   - Media search via /api/admin/media/search
   *   - User search
   *   - Saved searches / favorites
   */
  export type CommandItem = {
    id: string;
    label: string;
    href: string;
    group: string;
    description?: string;
    phase?: string;
  };
</script>

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { Search, ArrowRight, CornerDownLeft } from 'lucide-svelte';
  import type { Snippet } from 'svelte';

  type NavGroup = {
    id: string;
    label: string;
    items: Array<{
      id: string;
      label: string;
      href: string;
      icon: typeof Search;
      phase?: string;
      placeholder?: boolean;
    }>;
  };

  type ConfigItem = {
    id: string;
    label: string;
    href: string;
    description: string;
  };

  let {
    open = $bindable(false),
    navGroups = [] as NavGroup[],
    configItems = [] as ConfigItem[],
    onclose = (() => {}) as () => void
  }: {
    open?: boolean;
    navGroups: NavGroup[];
    configItems: ConfigItem[];
    onclose?: () => void;
  } = $props();

  let query = $state('');
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let listEl = $state<HTMLElement | undefined>(undefined);
  let lastFocused: HTMLElement | null = null;

  // Flatten nav + config into a single searchable list.
  const allCommands = $derived.by(() => {
    const out: Array<{
      id: string;
      label: string;
      href: string;
      group: string;
      description?: string;
      phase?: string;
    }> = [];
    for (const g of navGroups) {
      for (const item of g.items) {
        out.push({
          id: `${g.id}.${item.id}`,
          label: item.label,
          href: item.href,
          group: g.label,
          phase: item.phase,
        });
      }
    }
    for (const c of configItems) {
      out.push({
        id: `config.${c.id}`,
        label: c.label,
        href: c.href,
        group: 'Configuration',
        description: c.description,
      });
    }
    return out;
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter(c => {
      const haystack = `${c.label} ${c.group} ${c.description ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  });

  $effect(() => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement | null;
      query = '';
      selectedIndex = 0;
      void tick().then(() => inputEl?.focus());
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-a2-cmd-open', '');
      }
    } else {
      if (typeof document !== 'undefined') {
        document.documentElement.removeAttribute('data-a2-cmd-open');
      }
    }
  });

  // Reset selection when query changes.
  $effect(() => {
    void query;
    selectedIndex = 0;
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.removeAttribute('data-a2-cmd-open');
    }
  });

  function close() {
    open = false;
    onclose();
    lastFocused?.focus();
  }

  function activate(index: number) {
    const item = filtered[index];
    if (!item) return;
    close();
    void goto(item.href);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
      scrollSelectedIntoView();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      scrollSelectedIntoView();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activate(selectedIndex);
      return;
    }
    if (event.key === 'Tab') {
      // Trap focus inside the dialog.
      event.preventDefault();
      const focusable = [...(listEl?.querySelectorAll<HTMLElement>('[data-cmd-item]') ?? [])];
      if (!focusable.length) return;
      const current = focusable.findIndex(el => el === document.activeElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current >= focusable.length - 1 ? 0 : current + 1);
      focusable[next]?.focus();
    }
  }

  function scrollSelectedIntoView() {
    void tick().then(() => {
      const el = listEl?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleOverlayClick() {
    close();
  }
</script>

{#if open}
  <div class="a2-cmd-overlay" onclick={handleOverlayClick} aria-hidden="true"></div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="a2-cmd-dialog"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Command palette"
    onkeydown={handleKeydown}
  >
    <div class="a2-cmd-input-row">
      <span class="a2-cmd-input-icon"><Search size={16} /></span>
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        class="a2-cmd-input"
        placeholder="Search workspaces, configuration, and actions…"
        aria-label="Search commands"
        autocomplete="off"
        spellcheck="false"
      />
      <kbd class="a2-cmd-esc">Esc</kbd>
    </div>

    <div class="a2-cmd-list a2-scroll" bind:this={listEl}>
      {#if filtered.length === 0}
        <div class="a2-cmd-empty">
          <div class="a2-cmd-empty-title">No matches</div>
          <div class="a2-cmd-empty-desc">Try a different search term.</div>
        </div>
      {:else}
        {#each filtered as item, i (item.id)}
          <button
            type="button"
            class="a2-cmd-item"
            class:selected={i === selectedIndex}
            data-index={i}
            data-cmd-item
            onclick={() => activate(i)}
            onmouseenter={() => (selectedIndex = i)}
          >
            <div class="a2-cmd-item-main">
              <div class="a2-cmd-item-label">{item.label}</div>
              <div class="a2-cmd-item-group">
                {item.group}
                {#if item.phase}
                  <span class="a2-cmd-item-phase">· Phase {item.phase}</span>
                {/if}
              </div>
            </div>
            {#if i === selectedIndex}
              <span class="a2-cmd-item-enter"><CornerDownLeft size={14} /></span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>

    <div class="a2-cmd-foot">
      <span class="a2-cmd-foot-hint">
        <kbd>↑</kbd><kbd>↓</kbd> to navigate
      </span>
      <span class="a2-cmd-foot-hint">
        <kbd>↵</kbd> to select
      </span>
      <span class="a2-cmd-foot-hint">
        <kbd>Esc</kbd> to close
      </span>
    </div>
  </div>
{/if}

<style>
  .a2-cmd-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(6px);
    animation: a2-cmd-fade var(--a2-motion-fast) var(--a2-ease-out);
  }
  .a2-cmd-dialog {
    position: fixed;
    top: 12dvh;
    left: 50%;
    transform: translateX(-50%);
    z-index: 101;
    width: min(640px, calc(100% - 32px));
    max-height: 70dvh;
    display: flex;
    flex-direction: column;
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-lg);
    box-shadow: var(--a2-shadow-lg), var(--a2-glow-cyan);
    overflow: hidden;
    animation: a2-cmd-pop var(--a2-motion-normal) var(--a2-ease-out);
  }
  @keyframes a2-cmd-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes a2-cmd-pop {
    from { opacity: 0; transform: translate(-50%, -8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  .a2-cmd-input-row {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-4) var(--a2-space-5);
    border-bottom: 1px solid var(--a2-border);
  }
  .a2-cmd-input-icon {
    display: inline-flex;
    align-items: center;
    color: var(--a2-text-dim);
    flex-shrink: 0;
  }
  .a2-cmd-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--a2-text-bright);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-base);
    font-weight: 500;
    outline: none;
  }
  .a2-cmd-input::placeholder {
    color: var(--a2-text-dim);
  }
  .a2-cmd-esc {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-2);
    color: var(--a2-text-dim);
    font-family: var(--a2-font-mono);
    font-size: 10px;
    font-weight: 600;
  }

  .a2-cmd-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--a2-space-2);
    max-height: 50dvh;
  }
  .a2-cmd-empty {
    padding: var(--a2-space-6);
    text-align: center;
  }
  .a2-cmd-empty-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }
  .a2-cmd-empty-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
  }

  .a2-cmd-item {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
    width: 100%;
    padding: var(--a2-space-3) var(--a2-space-4);
    border: none;
    border-radius: var(--a2-radius-sm);
    background: transparent;
    color: var(--a2-text-muted);
    text-align: left;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-cmd-item:hover,
  .a2-cmd-item.selected {
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }
  .a2-cmd-item-main {
    flex: 1;
    min-width: 0;
  }
  .a2-cmd-item-label {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: inherit;
  }
  .a2-cmd-item-group {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .a2-cmd-item-phase {
    text-transform: none;
    color: var(--a2-amber);
    margin-left: 4px;
  }
  .a2-cmd-item-enter {
    display: inline-flex;
    align-items: center;
    color: var(--a2-cyan);
    opacity: 0.7;
    flex-shrink: 0;
  }

  .a2-cmd-foot {
    display: flex;
    align-items: center;
    gap: var(--a2-space-5);
    padding: var(--a2-space-2) var(--a2-space-5);
    border-top: 1px solid var(--a2-border);
    background: var(--a2-surface-2);
  }
  .a2-cmd-foot-hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
  }
  .a2-cmd-foot-hint kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    font-family: var(--a2-font-mono);
    font-size: 9px;
    font-weight: 600;
  }

  @media (max-width: 640px) {
    .a2-cmd-dialog {
      top: 6dvh;
      width: calc(100% - 16px);
      max-height: 80dvh;
    }
    .a2-cmd-foot {
      gap: var(--a2-space-3);
      padding: var(--a2-space-2) var(--a2-space-3);
    }
    .a2-cmd-foot-hint:nth-child(3) {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-cmd-overlay,
    .a2-cmd-dialog { animation: none; }
  }
</style>
