<script lang="ts">
  /**
   * Phase 5 — TV Series detail page.
   *
   * Renders the shared DetailPage component (same as /series/[id]).
   * The server loader resolves the canonical content via getDetail('series', id).
   */
  import DetailPage from '$components/DetailPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<DetailPage id={data.item.id} type="series" dataItem={data.item} recommendationItems={data.recommendations} />
