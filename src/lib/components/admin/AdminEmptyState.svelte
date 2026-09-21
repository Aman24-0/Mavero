<script lang="ts">
  import type { Snippet } from 'svelte';
  // AdminEmptyState — centered empty-state block for admin registries.
  //
  // Used when a registry has no records (no providers, no sources, no
  // categories, no addons). Renders an icon + title + message + optional
  // action snippet (e.g. "Add the first downloader").
  let {
    icon: Icon = undefined,
    title,
    message,
    actions = undefined
  }: {
    icon?: any;
    title: string;
    message: string;
    actions?: Snippet;
  } = $props();
</script>

<div class="admin-empty">
  {#if Icon}<span class="empty-icon" aria-hidden="true"><Icon size={22} /></span>{/if}
  <h2>{title}</h2>
  <p>{message}</p>
  {#if actions}<div class="empty-actions">{@render actions()}</div>{/if}
</div>

<style>
  .admin-empty {
    margin-top: 16px;
    padding: 42px 22px;
    text-align: center;
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-md);
    background: rgba(0, 255, 156, .012);
  }
  .empty-icon {
    display: inline-grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: 10px;
    border: 1px solid var(--color-primary-border);
    border-radius: 50%;
    color: var(--color-primary);
    background: var(--color-primary-soft);
  }
  .admin-empty h2 {
    margin: 8px 0 6px;
    color: var(--color-text);
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -.015em;
  }
  .admin-empty p {
    margin: 0 auto;
    max-width: 420px;
    color: var(--color-text-muted);
    font-size: .74rem;
    line-height: 1.6;
  }
  .empty-actions {
    margin-top: 14px;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
</style>
