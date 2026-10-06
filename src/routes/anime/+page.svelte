<script lang="ts">
  import ExplorerPage from '$components/ExplorerPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<ExplorerPage
  type="anime"
  spotlight={data.spotlight}
  sections={data.sections}
  filteredItems={data.filteredItems}
  currentPage={data.page}
  hasNextPage={data.hasNextPage}
  totalPages={data.totalPages}
  filters={data.filters}
  errorMessage={data.errorMessage}
/>
