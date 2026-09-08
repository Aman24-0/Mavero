<script lang="ts">
  import CollectionPage from '$components/CollectionPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<CollectionPage type="movie" contentItems={data.items} currentPage={data.page} hasNextPage={data.hasNextPage} totalPages={data.totalPages} collectionFilters={data.filters} errorMessage={data.errorMessage} />
