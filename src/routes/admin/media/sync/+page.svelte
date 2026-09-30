<script lang="ts">
  /**
   * Admin 2.0 — Phase E redirect.
   *
   * The Sync workspace is now a tab inside the unified Hosting Control
   * workspace at /admin/hosting?tab=sync. This page redirects there.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    void goto('/admin/hosting?tab=sync', { replaceState: true });
  });
</script>

<svelte:head>
  <title>Redirecting to Hosting — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
  <meta http-equiv="refresh" content="0; url=/admin/hosting?tab=sync" />
</svelte:head>

<div style="padding: 2rem; text-align: center; color: var(--a2-text-muted);">
  Redirecting to Hosting Control…
</div>
