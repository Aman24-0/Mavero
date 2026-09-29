<script lang="ts">
  /**
   * Admin 2.0 — Operations Attention placeholder (Phase B)
   *
   * Architectural destination for the "Attention" nav item under the
   * Operations group. Full implementation arrives in Phase F.
   *
   * Backend API surface that Phase F will consume (already exists):
   *   - GET /api/admin/media/stale          (detects stale operations)
   *   - GET /api/admin/media/missing        (lists missing media demand)
   *   - GET /api/admin/media/health         (provider health summary)
   *   - GET /api/admin/media/operations?status=failed  (failed operations)
   *
   * Attention aggregates three queues per the approved plan:
   *   - Failed
   *   - Stale
   *   - Requires Action (missing media + provider issues)
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminPlaceholder from '$lib/components/admin2/AdminPlaceholder.svelte';
</script>

<svelte:head>
  <title>Attention — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Operations" title="Attention" accent="amber">
    {#snippet description()}
      <p>
        Aggregated queue of everything that requires administrator
        attention — failed operations, stale operations, missing media
        demand, and provider health issues. Currently scheduled for
        Phase F.
      </p>
    {/snippet}
    <AdminPlaceholder
      phase="F"
      title="Operations Attention workspace — arriving in Phase F"
      description="Attention is the operational console for things that need a human. The backend already knows about stale operations (long-running uploads that never progressed), failed operations, missing media demand (canonical keys that users tried to play but had no asset), and provider health degradation — but these are scattered across four different endpoints. Phase F consolidates them into a single triage queue."
      capabilities={[
        'Failed operations queue with retry / cancel actions',
        'Stale operations queue (uses existing /api/admin/media/stale)',
        'Missing media demand queue (uses existing /api/admin/media/missing)',
        'Provider health issues queue (uses existing /api/admin/media/health)',
        'Filter by queue, provider, severity',
        'Inline resolve / dismiss / retry actions',
        'Cross-link from attention row → media detail → operation detail'
      ]}
      relatedLinks={[
        { label: 'Jobs', href: '/admin/media/operations', description: 'Phase F destination for the live jobs view' },
        { label: 'Activity / History', href: '/admin/media/history', description: 'Phase F destination for the immutable audit trail' },
        { label: 'Missing Media', href: '/admin/media/missing', description: 'Existing missing-media demand queue (will be consolidated into Attention in Phase F)' },
        { label: 'Providers', href: '/admin/providers', description: 'Configure provider credentials' }
      ]}
    />
  </AdminPage>
</AdminAppShell>
