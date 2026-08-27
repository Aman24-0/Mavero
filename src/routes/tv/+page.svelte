<script lang="ts">
  import TvShell from '$components/tv/TvShell.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData | null } = $props();
</script>

<svelte:head>
  <title>Mavero TV — Discover</title>
  <meta name="description" content="Mavero Discover for Samsung Tizen TV." />
</svelte:head>

<TvShell discover={data} form={form} />
