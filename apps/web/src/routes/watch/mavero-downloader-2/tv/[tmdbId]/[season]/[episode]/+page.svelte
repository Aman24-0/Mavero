<script lang="ts">
  import { page } from '$app/state';
  import MaveroCloudStreamDownload from '$components/MaveroCloudStreamDownload.svelte';

  /**
   * MAVERO DOWNLOADER 2 — standalone episode deep link (CS-5).
   *
   * `/watch/mavero-downloader-2/tv/{tmdbId}/{season}/{episode}` — the TV
   * counterpart of the 'mavero-downloader-2' registry row's URL template.
   * The panel fetches `/api/downloader/mavero2` with the bounded
   * season/episode context (REQUIRED for series requests by the CS-3
   * contract); the canonical content pipeline (getDetail + identifier
   * normalization) decides the actual content identity server-side — the
   * URL params are only inputs.
   */
  $: tmdbId = page.params.tmdbId ?? '';
  $: season = Number(page.params.season ?? '0');
  $: episode = Number(page.params.episode ?? '0');
</script>

<svelte:head>
  <title>MAVERO Downloader 2</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="downloader-page">
  <MaveroCloudStreamDownload
    contentId={`series-${tmdbId}`}
    mediaType="series"
    {tmdbId}
    {season}
    {episode}
    title={season > 0 && episode > 0 ? `Episode S${season}:E${episode}` : 'Download links'}
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
