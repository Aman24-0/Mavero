<script lang="ts">
  import CollectionPage from '$components/CollectionPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<CollectionPage type="anime" contentItems={data.items} />
