<script lang="ts">
  /**
   * Admin 2.0 — Phase D — Upload / Import workspace.
   *
   * Replaces the 755-line legacy wizard with a guided, contextual
   * upload workflow built around the Admin 2.0 architecture.
   *
   * The page is a thin wrapper around AdminUploadFlow — the orchestrator
   * component handles all step state, polling, retry, and subtitle logic.
   *
   * Entry points (all flow into the same workflow):
   *   - Global "Upload / Import" nav link → starts at search step
   *   - Media Library detail drawer → prefills tmdbId/contentType/season/episode
   *   - Missing Media "Upload" action → prefills tmdbId/contentType/season/episode
   *   - Direct deep-link → prefills from URL params
   *
   * The server loader (+page.server.ts) reads URL params and fetches
   * provider capabilities, then passes them to the flow.
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminUploadFlow from '$lib/components/admin2/AdminUploadFlow.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Upload / Import — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Content" title="Upload / Import" accent="cyan">
    {#snippet description()}
      <p>
        Guided media-ingestion workflow. Search TMDB, confirm metadata,
        select a provider, and upload — with progress, processing status,
        and subtitle support.
      </p>
    {/snippet}

    <AdminUploadFlow
      hostingSources={data.hostingSources}
      initialContext={data.initialContext}
      adminUserId={data.adminUserId}
    />
  </AdminPage>
</AdminAppShell>
