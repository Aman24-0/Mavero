<script lang="ts">
  /**
   * Admin 2.0 — Media Library — Canonical File Manager
   *
   * ARCHITECTURE: Media Library is a single asset-centric file manager.
   * It shows active provider files (media_assets, default status='active'
   * — terminal deleted files are EXCLUDED) with their associated canonical
   * media metadata.
   *
   * No more "Media" / "Provider Files" dual-view split.
   * The AdminHostingAssets component is the sole file manager — it
   * handles search, filters, facet counts, sorting, pagination, file
   * details, provider metadata, and all lifecycle actions (reconcile,
   * rename, move, detach, delete, reactivate, link).
   *
   * The page server passes initialFilters parsed from the canonical URL
   * params (provider / q / contentType / status / linked / sort /
   * mediaItem) — Hosting Control's provider deep-link and the
   * Jobs/Activity/Attention media deep-links land here and initialize
   * the file manager in exactly the requested state.
   *
   * Deleted files are excluded from the active inventory.
   * Canonical media identities (media_items) are preserved for
   * Missing Media, demand tracking, and future re-upload.
   */
  import { Upload } from 'lucide-svelte';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminHostingAssets from '$lib/components/admin2/AdminHostingAssets.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Media Library — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="media-library">
  <AdminPage eyebrow="Content" title="Media Library" accent="cyan">
    {#snippet description()}
      <p>
        Active provider file inventory — search, filter, and manage every hosted
        file across Vidara and Abyss. Deleted files are excluded from this view
        but remain in Hosting Control → Activity.
      </p>
    {/snippet}

    {#snippet actions()}
      <a class="library-action" href="/admin/media/upload">
        <Upload size={13} /> Upload / Import
      </a>
    {/snippet}

    <AdminHostingAssets
      initialFilters={data.initialFilters}
      providers={data.hostingSources
        ?.filter((s: any) => s.adapterId && s.capabilities)
        .map((s: any) => ({ adapterId: s.adapterId, name: s.providerName ?? s.name, capabilities: s.capabilities })) ?? []}
    />
  </AdminPage>
</AdminAppShell>

<style>
  .library-action {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-4);
    border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    text-decoration: none;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .library-action:hover {
    background: var(--a2-surface-3);
    border-color: var(--a2-cyan);
  }
</style>
