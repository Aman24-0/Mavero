<script lang="ts">
  import { page } from '$app/state';
  import ErrorState from '$components/ErrorState.svelte';

  const retry = () => window.location.reload();
</script>

<div class="container-wide route-error"><ErrorState eyebrow={`MAVERO / ${page.status || 'Error'}`} title="The signal dropped." message={page.error?.message || 'We could not load this part of the catalog. Try again or return to Discover.'} {retry} /></div>
