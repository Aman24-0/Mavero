<script lang="ts">
  /**
   * Phase 5 — Anime Movie detail page.
   *
   * Renders the shared DetailPage component. The server loader resolves
   * the canonical content via getDetail('movie', id) — anime movies use
   * the movie TMDB endpoint, distinguished by isAnime + animeFormat='movie'.
   */
  import DetailPage from '$components/DetailPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<DetailPage id={data.item.id} type="movie" dataItem={data.item} recommendationItems={data.recommendations} />
