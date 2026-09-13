<script lang="ts">
  import { page } from '$app/state';
  import MaveroAddonDownload from '$components/MaveroAddonDownload.svelte';

  /**
   * MAVERO Downloader — standalone episode deep link (Phase 14).
   *
   * `/watch/mavero-downloader/tv/{tmdbId}/{season}/{episode}` — the TV
   * counterpart of the built-in provider's URL template. The panel fetches
   * `/api/downloader/mavero` with the bounded season/episode context; the
   * canonical content pipeline (getDetail + identifier normalization)
   * decides the actual addon ids — the URL params are only inputs.
   */
  $: tmdbId = page.params.tmdbId ?? '';
  $: season = Number(page.params.season ?? '0');
  $: episode = Number(page.params.episode ?? '0');
</script>

<svelte:head>
  <title>MAVERO Downloader</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="downloader-page">
  <MaveroAddonDownload
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
