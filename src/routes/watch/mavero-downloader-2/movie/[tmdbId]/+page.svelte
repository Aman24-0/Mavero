<script lang="ts">
  import { page } from '$app/state';
  import MaveroCloudStreamDownload from '$components/MaveroCloudStreamDownload.svelte';

  /**
   * MAVERO DOWNLOADER 2 — standalone movie deep link (CS-5).
   *
   * `/watch/mavero-downloader-2/movie/{tmdbId}` — the movie URL template of
   * the 'mavero-downloader-2' registry row (rewritten to the request origin
   * by the public config reader). The SAME CloudStream panel the
   * DownloadSheet renders inline, hosted as a real page so the built-in
   * provider's URL template is a valid, shareable, back-button-friendly
   * target. The panel fetches `/api/downloader/mavero2` itself (tabs → one
   * batch resolve) and never renders extension configuration.
   *
   * Movies carry NO season/episode context — the CS-3 request contract
   * rejects movie requests with episode params, and this page passes none.
   */
  $: tmdbId = page.params.tmdbId ?? '';
</script>

<svelte:head>
  <title>MAVERO Downloader 2</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="downloader-page">
  <MaveroCloudStreamDownload
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
