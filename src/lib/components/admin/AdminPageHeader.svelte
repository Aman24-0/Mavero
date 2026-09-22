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
  /* Mobile — stack header vertically: title block, then a row with
     count (left) + Add button (right). CRITICAL: override
     .admin-header-copy's flex-basis. The desktop rule `flex: 1 1 240px`
     uses 240px as a HORIZONTAL flex-basis (width in a row layout).
     When the parent switches to flex-direction: column on mobile,
     that 240px becomes a VERTICAL flex-basis — giving the copy div a
     240px tall basis even though its content is only ~60px tall.
     This was the root cause of the massive vertical gap on every
     admin page. The fix: set flex to `0 0 auto` on mobile so the
     copy sizes naturally to its content height.

     The aside (count + Add button) is laid out as a horizontal row
     with space-between so count stays left and the Add button goes
     to the far right. */
  @media (max-width: 640px) {
    .admin-header { flex-direction: column; align-items: stretch; gap: 8px; }
    .admin-header-copy { flex: 0 0 auto; width: 100%; }
    .admin-header-aside { justify-content: space-between; width: 100%; }
  }
</style>
