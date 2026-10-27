<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  onMount(() => { void goto('/admin/system/feature-control', { replaceState: true }); });
</script>
<svelte:head><title>Redirecting… — Mavero Admin</title><meta http-equiv="refresh" content="0; url=/admin/system/feature-control" /></svelte:head>
<div style="padding:2rem;text-align:center;color:var(--a2-text-muted)">Redirecting…</div>
