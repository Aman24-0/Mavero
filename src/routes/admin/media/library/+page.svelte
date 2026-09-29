<script lang="ts">
  /**
   * Admin 2.0 — Media Library placeholder (Phase B)
   *
   * Architectural destination for the "Media Library" nav item.
   * Full implementation arrives in Phase C. This placeholder makes
   * the destination's state explicit rather than 404ing.
   *
   * Backend API surface that Phase C will consume (all already exist):
   *   - GET /api/admin/media/search       (used by upload wizard)
   *   - GET /api/admin/media/missing       (used by missing media page)
   *   - GET /api/admin/media/unlinked      (no UI consumer yet)
   *   - GET /api/admin/media/health        (no UI consumer yet)
   *   - GET /api/admin/media/operations    (no UI consumer yet)
   *   - GET /api/admin/media/stale         (no UI consumer yet)
   *   - GET /api/admin/media/sync          (no UI consumer yet)
   *   - /api/admin/media/assets/[id]/{rename,move,detach,delete,reconcile}
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminPlaceholder from '$lib/components/admin2/AdminPlaceholder.svelte';
</script>

<svelte:head>
  <title>Media Library — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Content" title="Media Library" accent="cyan">
    {#snippet description()}
      <p>
        Central workspace for browsing, searching, filtering, and acting on every
        hosted movie, series, episode, and anime title across all providers.
        Currently scheduled for Phase C.
      </p>
    {/snippet}
    <AdminPlaceholder
      phase="C"
      title="Media Library workspace — arriving in Phase C"
      description="The Media Library will be the heart of Admin 2.0 — a unified control surface over every canonical media identity in Mavero, with master-detail layout, content-tree navigation (Movies by year, Series by season/episode, Anime), provider-availability breakdowns, and contextual actions (rename, move, detach, delete, reconcile, sync)."
      capabilities={[
        'Search by title, TMDB ID, IMDb ID, canonical key',
        'Filter by type (movie / series / anime), year, provider, status',
        'Content tree: Movies → Year → Title; Series → Season → Episode; Anime → Season → Episode',
        'Master-detail layout with detail drawer for asset info',
        'Provider availability per asset (Vidara status, Abyss status, quality, audio, subtitles)',
        'Inline operations: rename, move, detach, delete, reconcile, sync',
        'Responsive data views: dense table on desktop, card list on mobile',
        'URL-driven filters for shareable views'
      ]}
      relatedLinks={[
        { label: 'Upload / Import', href: '/admin/media/upload', description: 'Add new media to Vidara or Abyss' },
        { label: 'Missing Media', href: '/admin/media/missing', description: 'Demand requests awaiting media' },
        { label: 'Providers', href: '/admin/providers', description: 'Configure Vidara & Abyss provider credentials' },
        { label: 'Operations (Jobs)', href: '/admin/media/operations', description: 'Phase F destination for upload/processing job history' }
      ]}
    />
  </AdminPage>
</AdminAppShell>
