<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  // Phase 3: redirect stub. Forwards all applicable params to the canonical
  // Analytics Users tab. The server +page.server.ts also issues a 303 redirect;
  // this client-side goto() is a hydration-safe fallback.
  $effect(() => {
    const params = new URLSearchParams(page.url.searchParams);
    params.set('tab', 'users');
    params.delete('pageSize');
    void goto(`/admin/analytics?${params.toString()}`, { replaceState: true });
  });
</script>
<svelte:head><title>Redirecting… — Mavero Admin</title><meta http-equiv="refresh" content="0; url=/admin/analytics?tab=users" /></svelte:head>
<div style="padding:2rem;text-align:center;color:var(--a2-text-muted)">Redirecting…</div>
