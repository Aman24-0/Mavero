<script lang="ts">
  /**
   * Admin 2.0 — Overview (Phase B)
   *
   * Operational dashboard answering: "What is happening in Mavero right
   * now, and what requires my attention?"
   *
   * Phase B: migrated to the new AdminPage framework (header + body
   * slots), with a refined navigation that no longer needs an explicit
   * `active` prop — AdminAppShell now derives the active item from the
   * route via `page.url.pathname`.
   *
   * Sections:
   *   - SYSTEM STATUS — quick health overview
   *   - HOSTING & MEDIA — quick links to media/hosting management
   *   - INTEGRATIONS — secondary metric cards
   */
  import { Database, Download, Layers3, Puzzle, ShieldCheck, Wifi } from 'lucide-svelte';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Admin — Mavero</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Mavero / Control" title="Overview" accent="cyan">
    {#snippet description()}
      <p>
        Real-time operational view of Mavero — provider health, hosting
        activity, content inventory, and integration status at a glance.
      </p>
    {/snippet}

    <!-- ============================================================
         SYSTEM STATUS — quick health overview
         ============================================================ -->
    <section class="a2-section">
      <div class="a2-section-head">
        <h2 class="a2-section-title">System Status</h2>
        <AdminStatus label="Operational" tone="green" />
      </div>
      <div class="a2-metric-grid">
        <a class="a2-metric-card" href="/admin/system/api-sources">
          <div class="a2-metric-icon"><ShieldCheck size={18} /></div>
          <div class="a2-metric-value">{data.overview.providerCount}</div>
          <div class="a2-metric-label">Providers</div>
          <div class="a2-metric-status">{data.overview.activeProviderCount} enabled</div>
        </a>
        <a class="a2-metric-card" href="/admin/system/api-sources?tab=sources">
          <div class="a2-metric-icon"><Wifi size={18} /></div>
          <div class="a2-metric-value">{data.overview.sourceCount}</div>
          <div class="a2-metric-label">Sources</div>
          <div class="a2-metric-status">{data.overview.activeSourceCount} enabled</div>
        </a>
        <a class="a2-metric-card" href="/admin/system/content-rules">
          <div class="a2-metric-icon"><Layers3 size={18} /></div>
          <div class="a2-metric-value">{data.overview.categoryCount}</div>
          <div class="a2-metric-label">Categories</div>
          <div class="a2-metric-status">Custom ordering</div>
        </a>
        <div class="a2-metric-card">
          <div class="a2-metric-icon"><Database size={18} /></div>
          <div class="a2-metric-value">v{data.overview.configVersion}</div>
          <div class="a2-metric-label">Config Version</div>
          <div class="a2-metric-status">Invalidates on mutation</div>
        </div>
      </div>
    </section>

    <!-- ============================================================
         INTEGRATIONS — secondary metrics
         (Phase 2: the duplicate "Hosting & Media" quick-grid was removed;
         those destinations are already in the sidebar. The Overview now
         follows the brief — dashboard + summary + contextual shortcuts,
         not a second full admin menu.)
         ============================================================ -->
    {#if data.downloadersOverview || data.addonsOverview}
      <section class="a2-section">
        <div class="a2-section-head">
          <h2 class="a2-section-title">Integrations</h2>
        </div>
        <div class="a2-metric-grid a2-secondary">
          {#if data.downloadersOverview}
            <a class="a2-metric-card" href="/admin/system/downloads">
              <div class="a2-metric-icon"><Download size={18} /></div>
              <div class="a2-metric-value">{data.downloadersOverview.providerCount}</div>
              <div class="a2-metric-label">Downloaders</div>
              <div class="a2-metric-status">{data.downloadersOverview.enabledCount} enabled · {data.downloadersOverview.defaultCount} default</div>
            </a>
          {/if}
          {#if data.addonsOverview}
            <a class="a2-metric-card" href="/admin/system/integrations">
              <div class="a2-metric-icon"><Puzzle size={18} /></div>
              <div class="a2-metric-value">{data.addonsOverview.addonCount}</div>
              <div class="a2-metric-label">Stremio Addons</div>
              <div class="a2-metric-status">{data.addonsOverview.enabledCount} enabled</div>
            </a>
          {/if}
        </div>
      </section>
    {/if}
  </AdminPage>
</AdminAppShell>

<style>
  .a2-section {
    margin-bottom: var(--a2-space-8);
  }

  .a2-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--a2-space-4);
  }

  .a2-section-title {
    margin: 0;
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-lg);
    font-weight: 600;
    color: var(--a2-text);
    letter-spacing: -0.01em;
  }

  /* Metric grid */
  .a2-metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--a2-space-3);
  }
  .a2-metric-grid.a2-secondary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  /* Metric cards */
  .a2-metric-card {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
    padding: var(--a2-space-4);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    text-decoration: none;
    color: inherit;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out),
                transform var(--a2-motion-micro) var(--a2-ease-out);
  }
  a.a2-metric-card:hover {
    background: var(--a2-surface-4);
    border-color: var(--a2-border-strong);
    transform: translateY(-1px);
  }

  .a2-metric-icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    margin-bottom: var(--a2-space-2);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }

  .a2-metric-value {
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xl);
    font-weight: 700;
    color: var(--a2-text-bright);
    line-height: 1;
  }

  .a2-metric-label {
    font-size: var(--a2-text-xs);
    font-weight: 600;
    color: var(--a2-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .a2-metric-status {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    margin-top: var(--a2-space-1);
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .a2-metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  @media (max-width: 640px) {
    .a2-metric-grid,
    .a2-metric-grid.a2-secondary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--a2-space-2); }
    .a2-section { margin-bottom: var(--a2-space-6); }
  }

  @media (min-width: 1920px) {
    .a2-metric-grid { gap: var(--a2-space-4); }
  }
</style>
