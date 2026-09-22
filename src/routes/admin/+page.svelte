<script lang="ts">
  import { Database, Download, Layers3, Puzzle, ShieldCheck, SlidersHorizontal, Wifi } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminMetricCard from '$lib/components/admin/AdminMetricCard.svelte';
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
  />

  <!-- ============================================================
       TOP METRIC TILES — primary registry counts + live state.
       Renders only what the backend actually provides; no invented metrics.
       Removed in this iteration: the duplicate registry navigation cards
       (Providers/Sources/Categories/Downloaders/Stremio Addons) and the
       boundary cards (Sanitized public contract / No playback activation).
       The admin drawer/sidebar already provides route navigation; the
       boundary contracts belong in the developer docs, not the dashboard.
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
</AdminShell>

<style>
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-top: 12px;
  }
  .metric-grid.secondary { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 12px; }

  /* Tablet — 2-column metric grid. */
  @media (max-width: 1024px) {
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  /* Mobile — 2-column metric grid so stats are compact and scannable.
     Cards use min-width to prevent overflow at 320px. */
  @media (max-width: 640px) {
    .metric-grid,
    .metric-grid.secondary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 10px;
      gap: 8px;
    }
  }

  /* Large desktop / TV — wider metric grid; secondary grid goes 4-wide so
     every tile stays readable without becoming oversized. */
  @media (min-width: 1920px) {
    .metric-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
    .metric-grid.secondary { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
  }
</style>
