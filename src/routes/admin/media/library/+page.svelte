<script lang="ts">
  /**
   * Admin 2.0 — Media Library — Compact List (Phase 2, 2026-10).
   *
   * Replaces the old AdminHostingAssets (2262 lines) with a simple compact
   * list + Add File wizard. The admin manually links Vidara/Abyss references
   * to TMDB titles — no provider API calls, no inventory sync, no upload.
   *
   * Three-dot menu: Delete (Mavero-side only) + Update link.
   */
  import { Plus } from 'lucide-svelte';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminMediaList from '$lib/components/admin2/AdminMediaList.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Provider sources for the new list component.
  const providers = $derived(
    data.hostingSources
      ?.filter((s: any) => s.adapterId === 'vidara' || s.adapterId === 'abyss')
      .map((s: any) => ({ adapterId: s.adapterId, name: s.providerName ?? s.name ?? s.adapterId, sourceId: s.id })) ?? []
  );

  // Expose the add-file trigger from the list component.
  let addFileTrigger: (() => void) | null = $state(null);

  function registerAddFile(fn: (() => void) | null) {
    addFileTrigger = fn;
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
        Manually linked media files across Vidara and Abyss. Click "Add file"
        to link a new title, or use the three-dot menu to update or remove an
        existing association.
      </p>
    {/snippet}

    {#snippet actions()}
      <button type="button" class="library-action" onclick={() => addFileTrigger?.()} disabled={!addFileTrigger}>
        <Plus size={13} /> Add file
      </button>
    {/snippet}

    <AdminMediaList {providers} {registerAddFile} initialFilters={data.initialFilters} />
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
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .library-action:hover {
    background: var(--a2-surface-3);
    border-color: var(--a2-cyan);
  }
  .library-action:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
