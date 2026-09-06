<script lang="ts">
  import { page } from '$app/state';
  import ErrorState from '$components/ErrorState.svelte';

  export let kind = 'title';
  const retry = () => window.location.reload();
</script>

<div class="container-wide detail-error-page"><ErrorState eyebrow={`MAVERO / ${kind} unavailable`} title="This story is out of frame." message={page.error?.message || 'The catalog could not find this title right now. Try again or return to Discover.'} {retry} /></div>
