<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  onMount(() => { void goto('/admin/operations?tab=jobs', { replaceState: true }); });
</script>
<svelte:head>
  <title>Redirecting to Operations — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
  <meta http-equiv="refresh" content="0; url=/admin/operations?tab=jobs" />
</svelte:head>
<div style="padding: 2rem; text-align: center; color: var(--a2-text-muted);">Redirecting to Operations Center…</div>
