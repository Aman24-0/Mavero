<script lang="ts">
  /**
   * Admin 2.0 — Overview (Phase A)
   * Redesigned with the new AdminAppShell, AdminPageHeader, and AdminStatus.
   * Uses the new design tokens and layered surface system.
   */
  import { Database, Download, Layers3, Puzzle, ShieldCheck, SlidersHorizontal, Wifi, Server, HardDrive, Activity } from 'lucide-svelte';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPageHeader from '$lib/components/admin2/AdminPageHeader.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import AdminMetricCard from '$lib/components/admin/AdminMetricCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Admin — Mavero</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="overview">
  <AdminPageHeader eyebrow="Mavero / Control" title="Overview" accent="cyan" />

  <!-- ============================================================
       SYSTEM STATUS — quick health overview
       ============================================================ -->
  <section class="a2-section">
    <div class="a2-section-head">
      <h2 class="a2-section-title">System Status</h2>
      <AdminStatus label="Operational" tone="green" />
    </div>
    <div class="a2-metric-grid">
      <a class="a2-metric-card" href="/admin/providers">
        <div class="a2-metric-icon"><ShieldCheck size={18} /></div>
        <div class="a2-metric-value">{data.overview.providerCount}</div>
        <div class="a2-metric-label">Providers</div>
        <div class="a2-metric-status">{data.overview.activeProviderCount} enabled</div>
      </a>
      <a class="a2-metric-card" href="/admin/sources">
        <div class="a2-metric-icon"><Wifi size={18} /></div>
        <div class="a2-metric-value">{data.overview.sourceCount}</div>
        <div class="a2-metric-label">Sources</div>
        <div class="a2-metric-status">{data.overview.activeSourceCount} enabled</div>
      </a>
      <a class="a2-metric-card" href="/admin/categories">
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
       HOSTING — quick links to media/hosting management
       ============================================================ -->
  <section class="a2-section">
    <div class="a2-section-head">
      <h2 class="a2-section-title">Hosting & Media</h2>
    </div>
    <div class="a2-quick-grid">
      <a class="a2-quick-card" href="/admin/media/upload">
        <div class="a2-quick-icon"><HardDrive size={20} /></div>
        <div class="a2-quick-text">
          <div class="a2-quick-title">Upload Media</div>
          <div class="a2-quick-desc">Add content to Vidara or Abyss</div>
        </div>
      </a>
      <a class="a2-quick-card" href="/admin/media/missing">
        <div class="a2-quick-icon"><Activity size={20} /></div>
        <div class="a2-quick-text">
          <div class="a2-quick-title">Missing Media</div>
          <div class="a2-quick-desc">Demand requests from playback</div>
        </div>
      </a>
      <a class="a2-quick-card" href="/admin/providers">
        <div class="a2-quick-icon"><Server size={20} /></div>
        <div class="a2-quick-text">
          <div class="a2-quick-title">Providers</div>
          <div class="a2-quick-desc">Vidara & Abyss management</div>
        </div>
      </a>
      <a class="a2-quick-card" href="/admin/media/operations">
        <div class="a2-quick-icon"><Activity size={20} /></div>
        <div class="a2-quick-text">
          <div class="a2-quick-title">Operations</div>
          <div class="a2-quick-desc">Upload/processing history</div>
        </div>
      </a>
    </div>
  </section>

  <!-- ============================================================
       SECONDARY METRICS
       ============================================================ -->
  {#if data.downloadersOverview || data.addonsOverview}
    <section class="a2-section">
      <div class="a2-section-head">
        <h2 class="a2-section-title">Integrations</h2>
      </div>
      <div class="a2-metric-grid a2-secondary">
        {#if data.downloadersOverview}
          <a class="a2-metric-card" href="/admin/downloaders">
            <div class="a2-metric-icon"><Download size={18} /></div>
            <div class="a2-metric-value">{data.downloadersOverview.providerCount}</div>
            <div class="a2-metric-label">Downloaders</div>
            <div class="a2-metric-status">{data.downloadersOverview.enabledCount} enabled · {data.downloadersOverview.defaultCount} default</div>
          </a>
        {/if}
        {#if data.addonsOverview}
          <a class="a2-metric-card" href="/admin/addons">
            <div class="a2-metric-icon"><Puzzle size={18} /></div>
            <div class="a2-metric-value">{data.addonsOverview.addonCount}</div>
            <div class="a2-metric-label">Stremio Addons</div>
            <div class="a2-metric-status">{data.addonsOverview.enabledCount} enabled</div>
          </a>
        {/if}
      </div>
    </section>
  {/if}
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

  /* Quick action grid */
  .a2-quick-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--a2-space-3);
  }

  .a2-quick-card {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    text-decoration: none;
    color: inherit;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-quick-card:hover {
    background: var(--a2-surface-3);
    border-color: var(--a2-cyan-border);
  }

  .a2-quick-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--a2-radius-md);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
    flex-shrink: 0;
  }

  .a2-quick-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }

  .a2-quick-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .a2-metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .a2-quick-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  @media (max-width: 640px) {
    .a2-metric-grid,
    .a2-metric-grid.a2-secondary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--a2-space-2); }
    .a2-quick-grid { grid-template-columns: 1fr; gap: var(--a2-space-2); }
    .a2-section { margin-bottom: var(--a2-space-6); }
  }

  @media (min-width: 1920px) {
    .a2-metric-grid { gap: var(--a2-space-4); }
    .a2-quick-grid { gap: var(--a2-space-4); }
  }
</style>
