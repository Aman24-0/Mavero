<script lang="ts">
  import { page } from '$app/state';
  import DetailPage from '$components/DetailPage.svelte';
  $: id = page.params.id ?? 'afterlight';
</script>

<DetailPage {id} type="movie" />
