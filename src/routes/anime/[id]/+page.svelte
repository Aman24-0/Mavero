<script lang="ts">
  import DetailPage from '$components/DetailPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<!-- The type prop is derived from the loaded item (always 'series' for
     TMDB-backed anime) so the DetailPage renders the canonical series UI
     and links to /watch/series/{id} rather than the legacy /watch/anime/
     path that no longer resolves correctly through the strict resolver. -->
<DetailPage id={data.item.id} type={data.item.type} dataItem={data.item} recommendationItems={data.recommendations} />
