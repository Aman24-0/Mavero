<script lang="ts">
  import { page } from '$app/state';
  import MaveroAddonDownload from '$components/MaveroAddonDownload.svelte';

  /**
   * MAVERO Downloader — standalone movie deep link (Phase 14).
   *
   * The same addon-downloader panel the DownloadSheet renders inline,
   * hosted as a real page so the built-in provider's URL template
   * (`/watch/mavero-downloader/movie/{tmdbId}`) is a valid, shareable,
   * back-button-friendly target. The panel fetches
   * `/api/downloader/mavero` itself and never renders addon configuration.
   */
  $: tmdbId = page.params.tmdbId ?? '';
</script>

<svelte:head>
  <title>MAVERO Downloader</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="downloader-page">
  <MaveroAddonDownload
    contentId={`movie-${tmdbId}`}
    mediaType="movie"
    {tmdbId}
    title="Download links"
  />
</div>

<style>
  .downloader-page {
    max-width: 720px;
    margin: 0 auto;
    padding: clamp(16px, 4vw, 32px);
    padding-bottom: 40px;
  }
</style>
