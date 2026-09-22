<script lang="ts">
  import type { Snippet } from 'svelte';
  // AdminSection — bordered surface for grouped content within an admin page.
  //
  // Renders an optional header (eyebrow + title + description) followed by
  // the body snippet. Use this for registry panels, form groups, status
  // panels — anything that benefits from a clear visual container without
  // being a card grid.
  let {
    eyebrow = '',
    title = '',
    accent = '',
    description = '',
    actions = undefined,
    variant = 'default',
    children
  }: {
    eyebrow?: string;
    title?: string;
    accent?: string;
    description?: string;
    actions?: Snippet;
    variant?: 'default' | 'danger' | 'info';
    children: Snippet;
  } = $props();
</script>

<section class="admin-section variant-{variant}">
  {#if eyebrow || title || actions}
    <header class="admin-section-head">
      <div class="admin-section-copy">
        {#if eyebrow}<div class="eyebrow">{eyebrow}</div>{/if}
        {#if title}<h2 class="admin-section-title">{title}{#if accent}<em>{accent}</em>{/if}</h2>{/if}
        {#if description}<p class="admin-section-desc">{description}</p>{/if}
      </div>
      {#if actions}<div class="admin-section-actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="admin-section-body">
    {@render children()}
  </div>
</section>

<style>
  .admin-section {
    margin-top: 14px;
    padding: 16px 18px 18px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .variant-danger {
    border-color: rgba(255, 77, 109, .35);
    background: rgba(255, 77, 109, .03);
  }
  .variant-info {
    border-color: rgba(0, 217, 255, .3);
    background: rgba(0, 217, 255, .025);
  }
  .admin-section-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 10px;
  }
  .admin-section-copy { min-width: 0; }
  .admin-section-title {
    margin: 6px 0 0;
    color: var(--color-text);
    font-size: 1.05rem;
    font-weight: 800;
    letter-spacing: -.01em;
  }
  .admin-section-title em { color: var(--color-primary); font-style: normal; }
  .admin-section-desc {
    margin: 6px 0 0;
    color: var(--color-text-muted);
    font-size: .72rem;
    line-height: 1.55;
    max-width: 640px;
  }
  .admin-section-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  @media (max-width: 640px) {
    .admin-section-head { flex-direction: column; align-items: flex-start; }
  }
</style>
