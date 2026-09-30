<script lang="ts">
  /**
   * Admin 2.0 — AdminBreadcrumb
   *
   * Standalone breadcrumb navigation. Renders a minimal crumb trail
   * with optional links for all but the last item (the current page).
   *
   * Use AdminPage's `breadcrumbs` prop for the simple case. Use this
   * component directly when rendering breadcrumbs inside a sub-panel
   * or detail drawer.
   */
  type BreadcrumbItem = {
    label: string;
    href?: string;
  };

  let {
    items = [] as BreadcrumbItem[]
  }: {
    items: BreadcrumbItem[];
  } = $props();
</script>

{#if items.length > 0}
  <nav class="a2-breadcrumb" aria-label="Breadcrumb">
    <ol>
      {#each items as crumb, i}
        <li class="a2-crumb">
          {#if crumb.href && i < items.length - 1}
            <a href={crumb.href}>{crumb.label}</a>
          {:else}
            <span aria-current={i === items.length - 1 ? 'page' : undefined}>{crumb.label}</span>
          {/if}
          {#if i < items.length - 1}
            <span class="a2-crumb-sep" aria-hidden="true">/</span>
          {/if}
        </li>
      {/each}
    </ol>
  </nav>
{/if}

<style>
  .a2-breadcrumb {
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xs);
  }
  .a2-breadcrumb ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 0;
    flex-wrap: wrap;
  }
  .a2-crumb {
    display: inline-flex;
    align-items: center;
    color: var(--a2-text-muted);
  }
  .a2-crumb a {
    color: var(--a2-text-muted);
    text-decoration: none;
    transition: color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-crumb a:hover {
    color: var(--a2-cyan);
  }
  .a2-crumb span[aria-current="page"] {
    color: var(--a2-text);
    font-weight: 600;
  }
  .a2-crumb-sep {
    color: var(--a2-text-dim);
    margin: 0 var(--a2-space-2);
  }
</style>
