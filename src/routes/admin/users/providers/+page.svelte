<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  // Phase 3: redirect stub to canonical Analytics Providers tab.
  $effect(() => {
    const params = new URLSearchParams(page.url.searchParams);
    params.set('tab', 'providers');
    void goto(`/admin/analytics?${params.toString()}`, { replaceState: true });
  });
</script>
<svelte:head><title>Redirecting… — Mavero Admin</title><meta http-equiv="refresh" content="0; url=/admin/analytics?tab=providers" /></svelte:head>
<div style="padding:2rem;text-align:center;color:var(--a2-text-muted)">Redirecting…</div>
