<script lang="ts">
  import '$lib/../app.css';
  import { page } from '$app/state';
  import AppShell from '$components/AppShell.svelte';
  import type { Snippet } from 'svelte';

  let { children: pageChildren }: { children: Snippet } = $props();
  const title = 'Mavero — Discover. Watch.';
</script>

<svelte:head>
  <title>{title}</title>
  <meta property="og:title" content={title} />
  <meta property="og:description" content="A cinematic home for your next story." />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<AppShell currentPath={page.url.pathname}>
  {#snippet children()}
    {@render pageChildren()}
  {/snippet}
</AppShell>
