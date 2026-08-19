<script lang="ts">
  import { page } from '$app/state';
  import DetailPage from '$components/DetailPage.svelte';
  $: id = page.params.id ?? 'nocturne-city';
</script>

<DetailPage {id} type="series" />
