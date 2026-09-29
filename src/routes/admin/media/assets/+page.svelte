<script lang="ts">
  /**
   * Admin 2.0 — Hosting Assets placeholder (Phase B)
   *
   * Architectural destination for the "Assets" nav item under the
   * Hosting group. Full implementation arrives in Phase E.
   *
   * Backend API surface that Phase E will consume (already exists):
   *   - GET /api/admin/media/unlinked      (lists provider assets not linked to media)
   *   - GET /api/admin/media/health        (provider health summary)
   *   - /api/admin/media/assets/[id]/{rename,move,detach,delete,reconcile}
   *
   * The Assets workspace will be the primary surface for renaming,
   * moving, detaching, deleting, and reconciling provider assets —
   * operations that currently have NO UI at all.
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminPlaceholder from '$lib/components/admin2/AdminPlaceholder.svelte';
</script>

<svelte:head>
  <title>Assets — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Hosting" title="Assets" accent="cyan">
    {#snippet description()}
      <p>
        Provider-asset inventory with linked / unlinked status, search,
        filter, and contextual operations (rename, move, detach, delete,
        reconcile). Currently scheduled for Phase E.
      </p>
    {/snippet}
    <AdminPlaceholder
      phase="E"
      title="Hosting Assets workspace — arriving in Phase E"
      description="The Assets workspace gives administrators a single inventory over every asset across Vidara and Abyss — both assets linked to canonical media identities and unlinked provider assets that exist on the provider but have no Mavero record. Today, the backend supports rename, move, detach, delete, and reconcile operations, but none of these have a UI. Phase E fixes that."
      capabilities={[
        'Search assets by provider, filecode, canonical key, quality',
        'Filter by linked / unlinked status',
        'Filter by provider (Vidara / Abyss)',
        'Rename an asset on the provider (currently no UI)',
        'Move an asset to a different canonical media identity (currently no UI)',
        'Detach an asset from its canonical media identity (currently no UI)',
        'Delete an asset on the provider (currently no UI)',
        'Reconcile provider state with Mavero state (currently no UI)',
        'View unlinked provider assets and attach them to media',
        'Bulk operations (future — may extend beyond Phase E)'
      ]}
      relatedLinks={[
        { label: 'Providers', href: '/admin/providers', description: 'Configure provider credentials and capabilities' },
        { label: 'Sync', href: '/admin/media/sync', description: 'Phase E destination for provider sync UI' },
        { label: 'Upload / Import', href: '/admin/media/upload', description: 'Add a new asset to a provider' },
        { label: 'Operations (Jobs)', href: '/admin/media/operations', description: 'Phase F destination for job history including sync operations' }
      ]}
    />
  </AdminPage>
</AdminAppShell>
