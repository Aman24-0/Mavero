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
    align-items: flex-end;
    justify-content: space-between;
    gap: clamp(16px, 3vw, 32px);
    flex-wrap: wrap;
  }
  .admin-header-copy { min-width: 0; flex: 1 1 380px; }
  .admin-title {
    margin: 8px 0 0;
    color: var(--color-text);
    font-size: clamp(1.7rem, 3.2vw, 2.4rem);
    font-weight: 900;
    letter-spacing: -.02em;
    line-height: 1.08;
  }
  .admin-title em { color: var(--color-primary); font-style: normal; }
  .admin-intro {
    max-width: 640px;
    margin: 10px 0 0;
    color: var(--color-text-muted);
    font-size: .82rem;
    line-height: 1.65;
  }
  .admin-header-aside {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .admin-count {
    color: var(--color-text-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .58rem;
    letter-spacing: .04em;
    text-transform: uppercase;
    padding: 4px 9px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: rgba(0, 255, 156, .03);
  }
  @media (max-width: 640px) {
    .admin-header { align-items: flex-start; flex-direction: column; gap: 12px; }
  }
</style>
