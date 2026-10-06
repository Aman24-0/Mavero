<script lang="ts">
  import DestinationPage from '$components/DestinationPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<DestinationPage
  type="movie"
  heroItem={data.heroItem}
  rails={data.rails}
  contentItems={data.items}
  currentPage={data.page}
  hasNextPage={data.hasNextPage}
  totalPages={data.totalPages}
  collectionFilters={data.filters}
  errorMessage={data.errorMessage}
/>
