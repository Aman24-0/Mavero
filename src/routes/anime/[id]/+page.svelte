<script lang="ts">
  import { page } from '$app/state';
  import DetailPage from '$components/DetailPage.svelte';
  $: id = page.params.id ?? 'paper-moons';
</script>

<DetailPage {id} type="anime" />
