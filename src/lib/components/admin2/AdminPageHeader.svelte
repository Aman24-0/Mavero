<script lang="ts">
  /**
   * Admin 2.0 — AdminPageHeader
   * Premium page header with eyebrow, title, and optional actions.
   */
  import type { Snippet } from 'svelte';

  let {
    eyebrow = '',
    title = '',
    accent = 'cyan',
    actions
  }: {
    eyebrow?: string;
    title: string;
    accent?: 'cyan' | 'green' | 'amber' | 'red' | 'blue';
    actions?: Snippet;
  } = $props();
</script>

<header class="a2-page-header">
  <div class="a2-page-header-left">
    {#if eyebrow}
      <div class="a2-page-eyebrow a2-accent-{accent}">{eyebrow}</div>
    {/if}
    <h1 class="a2-page-title">{title}</h1>
  </div>
  {#if actions}
    <div class="a2-page-actions">
      {@render actions()}
    </div>
  {/if}
</header>

<style>
  .a2-page-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--a2-space-4);
    margin-bottom: var(--a2-space-6);
    padding-bottom: var(--a2-space-4);
    border-bottom: 1px solid var(--a2-border);
  }

  .a2-page-header-left {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
  }

  .a2-page-eyebrow {
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .a2-accent-cyan { color: var(--a2-cyan); }
  .a2-accent-green { color: var(--a2-green); }
  .a2-accent-amber { color: var(--a2-amber); }
  .a2-accent-red { color: var(--a2-red); }
  .a2-accent-blue { color: var(--a2-blue); }

  .a2-page-title {
    margin: 0;
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xl);
    font-weight: 700;
    color: var(--a2-text-bright);
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .a2-page-actions {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
  }

  @media (max-width: 640px) {
    .a2-page-header {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
