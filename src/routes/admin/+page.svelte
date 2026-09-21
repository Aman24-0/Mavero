<script lang="ts">
  import { ArrowUpRight, Database, Download, Layers3, Puzzle, ShieldCheck, SlidersHorizontal, Wifi } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminMetricCard from '$lib/components/admin/AdminMetricCard.svelte';
  import AdminSection from '$lib/components/admin/AdminSection.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Admin Registry — Mavero</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminShell active="overview">
  <AdminPageHeader
    eyebrow="MAVERO / Control room"
    title="System"
    accent="status."
    description="Provider, source, downloader, default, category, and Stremio addon configuration stored in Supabase — versioned independently of the public application. Live operational view; mutations propagate to the public config after invalidation."
  />

  <!-- ============================================================
       TOP METRIC TILES — primary registry counts + live state.
       Renders only what the backend actually provides; no invented metrics.
       ============================================================ -->
  <div class="metric-grid">
    <AdminMetricCard
      label="Providers"
      value={data.overview.providerCount}
      status={`${data.overview.activeProviderCount} enabled`}
      statusTone={data.overview.activeProviderCount > 0 ? 'good' : 'neutral'}
      icon={ShieldCheck}
      href="/admin/providers"
    />
    <AdminMetricCard
      label="Sources"
      value={data.overview.sourceCount}
      status={`${data.overview.activeSourceCount} enabled`}
      statusTone={data.overview.activeSourceCount > 0 ? 'good' : 'neutral'}
      icon={Wifi}
      href="/admin/sources"
    />
    <AdminMetricCard
      label="Categories"
      value={data.overview.categoryCount}
      status="custom ordering"
      statusTone="info"
      icon={Layers3}
      href="/admin/categories"
    />
    <AdminMetricCard
      label="Config version"
      value={`v${data.overview.configVersion}`}
      status="invalidates on mutation"
      statusTone="neutral"
      icon={Database}
    />
  </div>

  {#if data.downloadersOverview}
    <div class="metric-grid secondary">
      <AdminMetricCard
        label="Downloaders"
        value={data.downloadersOverview.providerCount}
        status={`${data.downloadersOverview.enabledCount} enabled · ${data.downloadersOverview.defaultCount} default`}
        statusTone={data.downloadersOverview.enabledCount > 0 ? 'good' : 'neutral'}
        icon={Download}
        href="/admin/downloaders"
      />
      {#if data.addonsOverview}
        <AdminMetricCard
          label="Stremio Addons"
          value={data.addonsOverview.addonCount}
          status={`${data.addonsOverview.enabledCount} enabled`}
          statusTone={data.addonsOverview.enabledCount > 0 ? 'good' : 'neutral'}
          icon={Puzzle}
          href="/admin/addons"
        />
      {/if}
    </div>
  {:else if data.addonsOverview}
    <div class="metric-grid secondary">
      <AdminMetricCard
        label="Stremio Addons"
        value={data.addonsOverview.addonCount}
        status={`${data.addonsOverview.enabledCount} enabled`}
        statusTone={data.addonsOverview.enabledCount > 0 ? 'good' : 'neutral'}
        icon={Puzzle}
        href="/admin/addons"
      />
    </div>
  {/if}

  <!-- ============================================================
       REGISTRY NAVIGATION CARDS — primary links into each sub-page.
       ============================================================ -->
  <AdminSection eyebrow="Registry foundation" title="Manage the streaming" accent="catalog.">
    <div class="registry-cards">
      <a class="registry-card" href="/admin/providers">
        <span class="card-icon"><ShieldCheck size={18} /></span>
        <div class="card-body">
          <h3>Providers</h3>
          <p>Define integrations, states, capabilities, and safe display metadata.</p>
        </div>
        <ArrowUpRight size={16} />
      </a>
      <a class="registry-card" href="/admin/sources">
        <span class="card-icon"><SlidersHorizontal size={18} /></span>
        <div class="card-body">
          <h3>Sources</h3>
          <p>Configure selectable source metadata and inert media templates.</p>
        </div>
        <ArrowUpRight size={16} />
      </a>
      <a class="registry-card" href="/admin/categories">
        <span class="card-icon"><Layers3 size={18} /></span>
        <div class="card-body">
          <h3>Categories</h3>
          <p>Organize public sources with category-specific ordering.</p>
        </div>
        <ArrowUpRight size={16} />
      </a>
      {#if data.downloadersOverview}
        <a class="registry-card" href="/admin/downloaders">
          <span class="card-icon"><Download size={18} /></span>
          <div class="card-body">
            <h3>Downloaders</h3>
            <p>{data.downloadersOverview.providerCount} providers · {data.downloadersOverview.enabledCount} enabled · {data.downloadersOverview.defaultCount} default</p>
          </div>
          <ArrowUpRight size={16} />
        </a>
      {/if}
      {#if data.addonsOverview}
        <a class="registry-card" href="/admin/addons">
          <span class="card-icon"><Puzzle size={18} /></span>
          <div class="card-body">
            <h3>Stremio Addons</h3>
            <p>{data.addonsOverview.addonCount} addons · {data.addonsOverview.enabledCount} enabled</p>
          </div>
          <ArrowUpRight size={16} />
        </a>
      {/if}
    </div>
  </AdminSection>

  <!-- ============================================================
       SECURITY / BOUNDARY — non-negotiable contracts surfaced so the
       admin always remembers what the panel DOES NOT do.
       ============================================================ -->
  <div class="boundary-grid">
    <AdminSection eyebrow="Configuration status" title="Sanitized public contract">
      <p class="boundary-text">The public service exposes only enabled, visible records and safe capabilities. Credentials, templates, internal notes, and admin-only metadata remain server-side.</p>
      <span class="security-line"><ShieldCheck size={15} /> RLS and server authorization active</span>
    </AdminSection>
    <AdminSection eyebrow="Deferred by design" title="No playback activation">
      <p class="boundary-text">Phase 7A stores configuration only. It does not resolve URLs, call providers, activate embeds, or implement the MAVERO Player.</p>
      <span class="security-line"><Database size={15} /> Phase 7A boundary intact</span>
    </AdminSection>
  </div>
</AdminShell>

<style>
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-top: 24px;
  }
  .metric-grid.secondary { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 12px; }

  .registry-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }
  .registry-card {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 110px;
    padding: 16px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-text);
    text-decoration: none;
    transition: border-color var(--motion-fast) var(--ease-out),
                background var(--motion-fast) var(--ease-out),
                transform var(--motion-fast) var(--ease-out);
  }
  .registry-card:hover {
    border-color: var(--color-primary-border);
    background: rgba(0, 255, 156, .03);
    transform: translateY(-2px);
  }
  .registry-card:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 3px;
  }
  .registry-card > .card-body { flex: 1; min-width: 0; }
  .card-icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary-border);
    flex: 0 0 auto;
  }
  .registry-card h3 {
    margin: 0 0 6px;
    font-size: .92rem;
    font-weight: 700;
    letter-spacing: -.01em;
  }
  .registry-card p {
    margin: 0;
    color: var(--color-text-muted);
    font-size: .7rem;
    line-height: 1.55;
  }
  .registry-card > :global(svg) {
    color: var(--color-text-deep);
    flex: 0 0 auto;
    transition: transform var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  }
  .registry-card:hover > :global(svg) {
    color: var(--color-primary);
    transform: translate(2px, -2px);
  }

  .boundary-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 24px;
  }
  .boundary-text {
    margin: 0;
    color: var(--color-text-muted);
    font-size: .76rem;
    line-height: 1.6;
  }
  .security-line {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 14px;
    color: var(--color-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .56rem;
    font-weight: 700;
    letter-spacing: .04em;
  }

  /* Responsive — tablet drops to 2-column metric grid; mobile to 1-column. */
  @media (max-width: 1024px) {
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .metric-grid,
    .metric-grid.secondary,
    .boundary-grid { grid-template-columns: 1fr; }
  }

  /* Large desktop / TV — wider metric grid; secondary grid goes 4-wide so
     every tile stays readable without becoming oversized. */
  @media (min-width: 1920px) {
    .metric-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
    .metric-grid.secondary { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
    .registry-cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  }
</style>
