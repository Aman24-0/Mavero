<script lang="ts">
  /**
   * Admin 2.0 — legacy Sync route redirect.
   *
   * The Sync workspace was consolidated into the Hosting Control Providers
   * tab (/admin/hosting) during the Hosting navigation consolidation:
   *   - Refresh health + Sync all providers → Providers tab action area
   *   - Per-provider Sync → each provider card
   *
   * The +page.server.ts load() performs the authoritative server-side 303
   * redirect; this client-side fallback only runs if the page ever renders
   * without it (defensive, mirrors the previous redirect-page pattern).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    void goto('/admin/hosting', { replaceState: true });
  });
</script>

<svelte:head>
  <title>Redirecting to Hosting — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
  <meta http-equiv="refresh" content="0; url=/admin/hosting" />
</svelte:head>

<div style="padding: 2rem; text-align: center; color: var(--a2-text-muted);">
  Redirecting to Hosting Control…
</div>
