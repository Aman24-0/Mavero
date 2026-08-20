<script lang="ts">
  import DetailPage from '$components/DetailPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<DetailPage id={data.item.id} type="series" dataItem={data.item} />
