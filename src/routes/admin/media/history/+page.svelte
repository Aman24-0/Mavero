<script lang="ts">
  /**
   * Admin 2.0 — Operations History placeholder (Phase B)
   *
   * Architectural destination for the "History" nav item under the
   * Operations group. Full implementation arrives in Phase F.
   *
   * Backend API surface that Phase F will consume (already exists):
   *   - GET /api/admin/media/operations    (full operation history)
   *
   * History layout (per approved plan):
   *   TIME | ACTION | MEDIA | PROVIDER | STATUS | ACTOR
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminPlaceholder from '$lib/components/admin2/AdminPlaceholder.svelte';
</script>

<svelte:head>
  <title>History — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Operations" title="Activity / History" accent="cyan">
    {#snippet description()}
      <p>
        Immutable audit trail of every operation ever performed across
        uploads, processing, sync, reconciliation, and management
        actions. Currently scheduled for Phase F.
      </p>
    {/snippet}
    <AdminPlaceholder
      phase="F"
      title="Operations History workspace — arriving in Phase F"
      description="History is the audit surface for every admin operation — past uploads, processing completions, sync runs, reconciliations, subtitle uploads, and management actions (rename / move / detach / delete). The backend already records all of this in media_operations; Phase F surfaces it as a dense, filterable timeline."
      capabilities={[
        'Timeline of all operations (newest first)',
        'Columns: TIME | ACTION | MEDIA | PROVIDER | STATUS | ACTOR',
        'Filter by action type, status, provider, actor',
        'Date range filter',
        'Search by operation id, canonical key, filecode',
        'Export to CSV / JSON (future — may extend beyond Phase F)',
        'Cross-link from history row → media detail → provider asset'
      ]}
      relatedLinks={[
        { label: 'Jobs', href: '/admin/media/operations', description: 'Phase F destination for live + recent jobs' },
        { label: 'Attention', href: '/admin/media/stale', description: 'Phase F destination for failed / stale operations' },
        { label: 'Upload / Import', href: '/admin/media/upload', description: 'Start a new upload (recorded in history)' }
      ]}
    />
  </AdminPage>
</AdminAppShell>
