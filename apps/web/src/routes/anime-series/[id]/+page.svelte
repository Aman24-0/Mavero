<script lang="ts">
  /**
   * Phase 5 — Anime Series detail page.
   *
   * Renders the shared DetailPage component (same as /anime/[id]).
   * The server loader resolves the canonical content via getDetail('anime', id).
   */
  import DetailPage from '$components/DetailPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<DetailPage id={data.item.id} type="anime" dataItem={data.item} recommendationItems={data.recommendations} />
