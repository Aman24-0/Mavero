<script lang="ts">
  /**
   * Admin 2.0 — Hosting Sync placeholder (Phase B)
   *
   * Architectural destination for the "Sync" nav item under the
   * Hosting group. Full implementation arrives in Phase E.
   *
   * Backend API surface that Phase E will consume (already exists):
   *   - POST /api/admin/media/sync          (triggers provider sync)
   *   - GET  /api/admin/media/sync          (lists sync operations)
   *   - GET  /api/admin/media/operations    (sync operations are recorded here too)
   *
   * The Sync workspace shows: last sync time, discovered files,
   * deleted provider assets, and reconciliation state.
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminPlaceholder from '$lib/components/admin2/AdminPlaceholder.svelte';
</script>

<svelte:head>
  <title>Sync — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Hosting" title="Sync" accent="cyan">
    {#snippet description()}
      <p>
        Trigger and monitor provider sync — discover new provider
        assets, detect deletions, and reconcile state. Currently
        scheduled for Phase E.
      </p>
    {/snippet}
    <AdminPlaceholder
      phase="E"
      title="Hosting Sync workspace — arriving in Phase E"
      description="Sync reconciles Mavero's view of provider assets with the provider's own view. Phase E will surface this as a first-class workspace showing last sync time, newly discovered files, deleted provider assets, and reconciliation state — with one-click re-sync per provider."
      capabilities={[
        'View last sync time per provider',
        'Trigger a new sync for a single provider or all providers',
        'View discovered provider assets not yet linked to Mavero',
        'View provider assets that have been deleted since last sync',
        'Reconcile state — attach discovered assets, remove orphan references',
        'Live sync progress (uses existing POST /api/admin/media/sync endpoint)',
        'Sync history (cross-references /admin/media/operations)'
      ]}
      relatedLinks={[
        { label: 'Providers', href: '/admin/providers', description: 'Configure Vidara & Abyss provider credentials' },
        { label: 'Assets', href: '/admin/media/assets', description: 'Phase E destination for the asset inventory' },
        { label: 'Operations (Jobs)', href: '/admin/media/operations', description: 'Phase F destination for full job history including sync runs' },
        { label: 'Attention', href: '/admin/media/stale', description: 'Phase F destination for stuck / stale operations' }
      ]}
    />
  </AdminPage>
</AdminAppShell>
