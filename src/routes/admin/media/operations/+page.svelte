<script lang="ts">
  /**
   * Admin 2.0 — Operations Jobs placeholder (Phase B)
   *
   * Architectural destination for the "Jobs" nav item under the
   * Operations group. Full implementation arrives in Phase F.
   *
   * Backend API surface that Phase F will consume (already exists):
   *   - GET /api/admin/media/operations    (lists all operations)
   *   - POST /api/admin/media/upload        (creates upload jobs)
   *   - /api/admin/media/upload/[id]/{status,cancel,retry,complete,upload-server,subtitle,proxy-upload}
   *   - GET /api/admin/media/stale          (detects stale operations)
   *   - POST /api/admin/media/sync          (creates sync operations)
   *
   * The Jobs workspace aggregates: uploads, processing, sync,
   * reconciliation, subtitle upload, and management operations
   * (rename / move / detach / delete).
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminPlaceholder from '$lib/components/admin2/AdminPlaceholder.svelte';
</script>

<svelte:head>
  <title>Jobs — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Operations" title="Jobs" accent="cyan">
    {#snippet description()}
      <p>
        Live and historical view of every background operation — uploads,
        processing, sync, reconciliation, subtitle uploads, and management
        operations. Currently scheduled for Phase F.
      </p>
    {/snippet}
    <AdminPlaceholder
      phase="F"
      title="Operations Jobs workspace — arriving in Phase F"
      description="Jobs aggregates every long-running operation in Mavero into a single live view. Today the backend records operations across multiple tables (media_operations, upload state machine) but there is no unified UI to see what's running, what completed, what failed, and what's stale."
      capabilities={[
        'Live job list with status (queued / uploading / processing / ready / failed)',
        'Filter by job type (upload / processing / sync / reconcile / subtitle / management)',
        'Filter by provider, status, time range',
        'Job detail drawer with operation history',
        'Cancel running jobs (uses existing /api/admin/media/upload/[id]/cancel)',
        'Retry failed jobs (uses existing /api/admin/media/upload/[id]/retry)',
        'Detect and surface stale operations (uses existing /api/admin/media/stale)',
        'Link from job → media detail → provider asset (cross-navigation)'
      ]}
      relatedLinks={[
        { label: 'Activity / History', href: '/admin/media/history', description: 'Phase F destination for completed operation history' },
        { label: 'Attention', href: '/admin/media/stale', description: 'Phase F destination for failed / stale / requires-action operations' },
        { label: 'Upload / Import', href: '/admin/media/upload', description: 'Start a new upload job' },
        { label: 'Sync', href: '/admin/media/sync', description: 'Phase E destination for sync UI' }
      ]}
    />
  </AdminPage>
</AdminAppShell>
