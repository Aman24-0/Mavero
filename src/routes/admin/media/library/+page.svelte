<script lang="ts">
  /**
   * Admin 2.0 — Media Library — Canonical File Manager
   *
   * MAV-FOCUSED (2026-10): the "Link media" header button now opens the
   * shared AdminLinkMediaModal — a TMDB-FIRST search → provider-tabbed
   * file picker. The old AdminHostingAssets link modal (which searched
   * the local media_items table) is replaced by this shared component.
   *
   * The flow is:
   *   1. Admin clicks "Link media".
   *   2. AdminLinkMediaModal opens with TMDB search (Step A).
   *   3. Admin searches TMDB for a movie/series/anime title.
   *   4. Admin selects a TMDB result → modal transitions to Step B.
   *   5. Step B shows provider tabs (Vidara / Abyss) with isolated state.
   *   6. Admin selects a provider file + confirms.
   *   7. POST /api/admin/media/assets/link creates the association.
   *   8. On success, the modal closes and the page refreshes.
   */
  import { Upload, Link2 } from 'lucide-svelte';
  import { invalidateAll } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminHostingAssets from '$lib/components/admin2/AdminHostingAssets.svelte';
  import AdminLinkMediaModal from '$lib/components/admin2/AdminLinkMediaModal.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let linkModalOpen = $state(false);

  // Resolve provider sources for the shared link modal.
  const linkProviders = $derived(
    data.hostingSources
      ?.filter((s: any) => s.adapterId && s.capabilities)
      .map((s: any) => ({ adapterId: s.adapterId, name: s.providerName ?? s.name, sourceId: s.id })) ?? []
  );

  function openLinkModal() {
    linkModalOpen = true;
  }

  async function onLinkModalClose() {
    linkModalOpen = false;
    // Refresh the page data so the newly linked asset appears.
    await invalidateAll();
  }
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
      <button type="button" class="library-action library-action-link" onclick={openLinkModal} disabled={linkProviders.length === 0}>
        <Link2 size={13} /> Link media
      </button>
    {/snippet}

    <AdminHostingAssets
      initialFilters={data.initialFilters}
      providers={data.hostingSources
        ?.filter((s: any) => s.adapterId && s.capabilities)
        .map((s: any) => ({ adapterId: s.adapterId, name: s.providerName ?? s.name, capabilities: s.capabilities })) ?? []}
    />
  </AdminPage>
</AdminAppShell>

<AdminLinkMediaModal
  bind:open={linkModalOpen}
  providers={linkProviders}
  onclose={onLinkModalClose}
/>

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
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .library-action:hover {
    background: var(--a2-surface-3);
    border-color: var(--a2-cyan);
  }
  .library-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .library-action-link {
    border-color: var(--a2-border-strong);
    background: var(--a2-surface-3);
    color: var(--a2-text);
  }
  .library-action-link:hover {
    background: var(--a2-cyan-soft);
    border-color: var(--a2-cyan);
    color: var(--a2-cyan);
  }
</style>
