<script lang="ts">
  /**
   * Admin 2.0 — AdminPage
   *
   * Phase B page framework. Wraps every Admin 2.0 workspace page in
   * a consistent composition:
   *
   *   ┌──────────────────────────────────────────────┐
   *   │  Page Header                                  │
   *   │    eyebrow · title · actions                  │
   *   ├──────────────────────────────────────────────┤
   *   │  Breadcrumb (optional)                        │
   *   ├──────────────────────────────────────────────┤
   *   │  Context Tabs (optional)                      │
   *   ├──────────────────────────────────────────────┤
   *   │  Toolbar / Filters / Actions (slot, optional)  │
   *   ├──────────────────────────────────────────────┤
   *   │  Main Workspace (children)                    │
   *   └──────────────────────────────────────────────┘
   *
   * Page Header is rendered by this component using the same
   * visual language as `AdminPageHeader` (eyebrow / title / actions),
   * but integrated with breadcrumb + tabs + toolbar as one block.
   *
   * Slots:
   *   - `actions`    optional, renders in the page header on the right
   *   - `toolbar`    optional, renders below the context tabs
   *
   * Slots for advanced pages:
   *   - `header`     replaces the built-in header entirely
   *   - `tabs`       replaces the built-in context tabs (rare)
   *
   * `tabs` prop (preferred over slot for simple cases):
   *   [{ id, label, href?, onclick?, active? }]
   *
   * `breadcrumbs` prop:
   *   [{ label, href? }]
   */
  import type { Snippet } from 'svelte';

  type TabItem = {
    id: string;
    label: string;
    href?: string;
    onclick?: () => void;
    active?: boolean;
  };

  type BreadcrumbItem = {
    label: string;
    href?: string;
  };

  let {
    eyebrow = '',
    title = '',
    accent = 'cyan',
    description,
    breadcrumbs = [] as BreadcrumbItem[],
    tabs = [] as TabItem[],
    actions,
    toolbar,
    header,
    children
  }: {
    eyebrow?: string;
    title: string;
    accent?: 'cyan' | 'green' | 'amber' | 'red' | 'blue';
    /** Optional snippet rendered under the title. Use `<p slot="description">…</p>`. */
    description?: Snippet;
    breadcrumbs?: BreadcrumbItem[];
    tabs?: TabItem[];
    actions?: Snippet;
    toolbar?: Snippet;
    header?: Snippet;
    children: Snippet;
  } = $props();
</script>

<section class="a2-page">
  {#if header}
    {@render header()}
  {:else}
    <header class="a2-page-header">
      <div class="a2-page-header-left">
        {#if eyebrow}
          <div class="a2-page-eyebrow a2-accent-{accent}">{eyebrow}</div>
        {/if}
        <h1 class="a2-page-title">{title}</h1>
        {#if description}
          <div class="a2-page-desc">
            {@render description()}
          </div>
        {/if}
      </div>
      {#if actions}
        <div class="a2-page-actions">
          {@render actions()}
        </div>
      {/if}
    </header>
  {/if}

  {#if breadcrumbs.length > 0}
    <nav class="a2-breadcrumb" aria-label="Breadcrumb">
      <ol>
        {#each breadcrumbs as crumb, i}
          <li class="a2-crumb">
            {#if crumb.href && i < breadcrumbs.length - 1}
              <a href={crumb.href}>{crumb.label}</a>
            {:else}
              <span aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}>{crumb.label}</span>
            {/if}
            {#if i < breadcrumbs.length - 1}
              <span class="a2-crumb-sep" aria-hidden="true">/</span>
            {/if}
          </li>
        {/each}
      </ol>
    </nav>
  {/if}

  {#if tabs.length > 0}
    <nav class="a2-context-tabs" aria-label="Context tabs">
      {#each tabs as tab}
        {#if tab.href}
          <a
            class="a2-tab"
            class:active={tab.active}
            href={tab.href}
            aria-current={tab.active ? 'page' : undefined}
          >
            {tab.label}
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
          </button>
        {:else}
          <span class="a2-tab" class:active={tab.active}>{tab.label}</span>
        {/if}
      {/each}
    </nav>
  {/if}

  {#if toolbar}
    <div class="a2-toolbar">
      {@render toolbar()}
    </div>
  {/if}

  <div class="a2-page-body">
    {@render children()}
  </div>
</section>

<style>
  .a2-page {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-4);
  }

  .a2-page-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--a2-space-4);
    padding-bottom: var(--a2-space-4);
    border-bottom: 1px solid var(--a2-border);
  }

  .a2-page-header-left {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
    min-width: 0;
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

  .a2-page-desc {
    margin: var(--a2-space-1) 0 0;
    max-width: 640px;
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
    line-height: 1.55;
  }
  .a2-page-desc :global(p) {
    margin: 0;
  }

  .a2-page-actions {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    flex-shrink: 0;
  }

  /* ---- Breadcrumb ---- */
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

  /* ---- Context Tabs ---- */
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

  /* ---- Toolbar ---- */
  .a2-toolbar {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-3) 0;
    flex-wrap: wrap;
  }

  /* ---- Body ---- */
  .a2-page-body {
    flex: 1;
    min-height: 0;
  }

  @media (max-width: 640px) {
    .a2-page-header {
      flex-direction: column;
      align-items: flex-start;
    }
    .a2-page-actions {
      width: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-tab,
    .a2-crumb a { transition: none; }
  }
</style>
