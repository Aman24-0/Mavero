<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Component } from 'svelte';
  // AdminPageHeader — shared page header for every /admin route.
  //
  // Renders the eyebrow / title / description / optional count chip / optional
  // actions snippet, with Phase B control-room typography. Pages stay in
  // control of their own data; this is purely a presentation primitive.
  let {
    eyebrow,
    title,
    accent = '',
    description = '',
    count = '',
    actions = undefined
  }: {
    eyebrow: string;
    title: string;
    accent?: string;
    description?: string;
    count?: string;
    actions?: Snippet;
  } = $props();
</script>

<header class="admin-header">
  <div class="admin-header-copy">
    <div class="eyebrow">{eyebrow}</div>
    <h1 class="admin-title">{title}{#if accent}<em>{accent}</em>{/if}</h1>
    {#if description}<p class="admin-intro">{description}</p>{/if}
  </div>
  <div class="admin-header-aside">
    {#if count}<span class="admin-count">{count}</span>{/if}
    {#if actions}{@render actions()}{/if}
  </div>
</header>

<style>
  .admin-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .admin-header-copy { min-width: 0; flex: 1 1 240px; }
  .admin-title {
    margin: 6px 0 0;
    color: var(--color-text);
    font-size: clamp(1.5rem, 4vw, 2.2rem);
    font-weight: 900;
    letter-spacing: -.02em;
    line-height: 1.08;
  }
  .admin-title em { color: var(--color-primary); font-style: normal; }
  .admin-intro {
    max-width: 640px;
    margin: 8px 0 0;
    color: var(--color-text-muted);
    font-size: .78rem;
    line-height: 1.55;
  }
  .admin-header-aside {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .admin-count {
    color: var(--color-text-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .56rem;
    letter-spacing: .04em;
    text-transform: uppercase;
    padding: 4px 9px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: rgba(0, 255, 156, .03);
  }
  /* Mobile — stack header vertically so Add button is directly below heading. */
  @media (max-width: 640px) {
    .admin-header { flex-direction: column; align-items: stretch; gap: 8px; }
    .admin-header-aside { justify-content: flex-start; }
  }
</style>
