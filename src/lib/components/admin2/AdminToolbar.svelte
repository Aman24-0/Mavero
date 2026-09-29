<script lang="ts">
  /**
   * Admin 2.0 — AdminToolbar
   *
   * Sticky toolbar for filters, search, view switchers, and
   * page-level actions. Use inside AdminPage's `toolbar` slot
   * for the simple case, or use this component directly when
   * you need a toolbar outside the page framework.
   *
   * Slots:
   *   - `search`    search input (left side)
   *   - `filters`   filter controls (left side, after search)
   *   - `actions`    action buttons (right side)
   *   - `view`       view switcher (right side, after actions)
   *
   * Default slot renders in the middle if you need something custom.
   */
  import type { Snippet } from 'svelte';

  let {
    search,
    filters,
    actions,
    view,
    children
  }: {
    search?: Snippet;
    filters?: Snippet;
    actions?: Snippet;
    view?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<div class="a2-toolbar">
  <div class="a2-toolbar-left">
    {#if search}
      <div class="a2-toolbar-search">
        {@render search()}
      </div>
    {/if}
    {#if filters}
      <div class="a2-toolbar-filters">
        {@render filters()}
      </div>
    {/if}
    {#if children}
      {@render children()}
    {/if}
  </div>
  <div class="a2-toolbar-right">
    {#if actions}
      <div class="a2-toolbar-actions">
        {@render actions()}
      </div>
    {/if}
    {#if view}
      <div class="a2-toolbar-view">
        {@render view()}
      </div>
    {/if}
  </div>
</div>

<style>
  .a2-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-3);
    padding: var(--a2-space-3) 0;
    flex-wrap: wrap;
  }
  .a2-toolbar-left {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }
  .a2-toolbar-right {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .a2-toolbar {
      flex-direction: column;
      align-items: stretch;
    }
    .a2-toolbar-left,
    .a2-toolbar-right {
      width: 100%;
      justify-content: flex-start;
    }
  }
</style>
