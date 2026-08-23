<script lang="ts">
  import '$lib/../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import AppShell from '$components/AppShell.svelte';
  import PwaExperience from '$components/PwaExperience.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';

  let { children: pageChildren, data }: { children: Snippet; data: LayoutData } = $props();
  const title = 'Mavero — Movies, series & anime';

  onMount(() => {
    if (!data.user) return;
    void syncAuthenticatedState();
    const retry = () => { if (navigator.onLine) void syncAuthenticatedState(); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  });
</script>

<svelte:head>
  <title>{title}</title>
  <meta property="og:title" content={title} />
  <meta property="og:description" content="A fast, modern home for your next watch." />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{#if page.url.pathname.startsWith('/watch/') || /^\/(movie|series|anime)\/[^/]+/.test(page.url.pathname)}
  {@render pageChildren()}
{:else}
  <AppShell currentPath={page.url.pathname}>
    {#snippet children()}
      {@render pageChildren()}
    {/snippet}
  </AppShell>
{/if}

<PwaExperience />
