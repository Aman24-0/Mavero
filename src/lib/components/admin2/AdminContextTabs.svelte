<script lang="ts">
  /**
   * Admin 2.0 — AdminContextTabs
   *
   * Standalone contextual tab navigation. Use inside AdminPage's `tabs` prop
   * for the simple case, or use this component directly when you need tabs
   * rendered in a non-standard location (e.g., inside a drawer or sub-panel).
   *
   * Tab items can be:
   *   - links (href) — for URL-driven tabs (preserves shareable URLs)
   *   - buttons (onclick) — for state-driven tabs (no URL change)
   *   - static labels — for placeholder tabs that have no action yet
   */
  type TabItem = {
    id: string;
    label: string;
    href?: string;
    onclick?: () => void;
    active?: boolean;
    count?: number;
  };

  let {
    tabs = [] as TabItem[],
    label = 'Context tabs'
  }: {
    tabs: TabItem[];
    label?: string;
  } = $props();
</script>

{#if tabs.length > 0}
  <nav class="a2-context-tabs" aria-label={label}>
    {#each tabs as tab}
      {#if tab.href}
        <a
          class="a2-tab"
          class:active={tab.active}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
        >
          {tab.label}
          {#if tab.count != null}
            <span class="a2-tab-count">{tab.count}</span>
          {/if}
        </a>
      {:else if tab.onclick}
        <button
          type="button"
          class="a2-tab"
          class:active={tab.active}
          onclick={tab.onclick}
          aria-current={tab.active ? 'page' : undefined}
        >
          {tab.label}
          {#if tab.count != null}
            <span class="a2-tab-count">{tab.count}</span>
          {/if}
        </button>
      {:else}
        <span class="a2-tab" class:active={tab.active}>
          {tab.label}
          {#if tab.count != null}
            <span class="a2-tab-count">{tab.count}</span>
          {/if}
        </span>
      {/if}
    {/each}
  </nav>
{/if}

<style>
  .a2-context-tabs {
    display: flex;
    align-items: center;
    gap: var(--a2-space-1);
    border-bottom: 1px solid var(--a2-border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .a2-context-tabs::-webkit-scrollbar { display: none; }

  .a2-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-4);
    border: none;
    background: transparent;
    color: var(--a2-text-muted);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    border-radius: var(--a2-radius-sm) var(--a2-radius-sm) 0 0;
    border-bottom: 2px solid transparent;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
    white-space: nowrap;
  }
  .a2-tab:hover {
    color: var(--a2-text);
    background: var(--a2-surface-2);
  }
  .a2-tab.active {
    color: var(--a2-cyan);
    border-bottom-color: var(--a2-cyan);
  }
  .a2-tab-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 16px;
    padding: 0 5px;
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    font-family: var(--a2-font-mono);
    font-size: 9px;
    font-weight: 600;
  }
  .a2-tab.active .a2-tab-count {
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-tab { transition: none; }
  }
</style>
