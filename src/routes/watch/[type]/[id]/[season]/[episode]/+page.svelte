<script lang="ts">
  /**
   * Canonical PATH-form watch page: /watch/[type]/[id]/[season]/[episode]
   *
   * Renders the SAME component as the query-form route — one player
   * implementation, two URL shapes. The shared server loader guarantees
   * identical data; the client reads season/episode reactively from
   * `page.params` (present on this route) with the legacy query fallback.
   */
  import WatchPage from '../../+page.svelte';
  import type { PageData } from './$types';

  export let data: PageData;
</script>

<WatchPage {data} />
