<script lang="ts">
  /**
   * Admin 2.0 — Media Library — Compact List (Phase 2, 2026-10).
   *
   * Replaces the old AdminHostingAssets (2262 lines) with a simple compact
   * list + Add File wizard. The admin manually links Vidara/Abyss references
   * to TMDB titles — no provider API calls, no inventory sync, no upload.
   *
   * Three-dot menu: Delete (Mavero-side only) + Update link.
   *
   * TASK 2 (2026-10-15) — LAYOUT REDESIGN:
   *   * The page-level heading + explanatory paragraph are REMOVED — the
   *     Admin Panel shell header stays, the content region starts at the
   *     toolbar (search row, then Add File / view toggle / filter row).
   *   * The Add File button moved INTO the toolbar's controls row (left
   *     side) — no page-level action button.
   */
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
</script>

<svelte:head>
  <title>Media Library — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="media-library" fill>
  <!-- Task 2 — no page header: no eyebrow/title/description/actions. The
       Add File button lives in AdminMediaList's toolbar controls row.
       FILL MODE (2026-10-16 layout round) — the page owns an internal
       cards scroller; see the shell's `fill` prop. -->
  <AdminPage fill>
    <AdminMediaList {providers} initialFilters={data.initialFilters} />
  </AdminPage>
</AdminAppShell>
