<script lang="ts">
  import { onMount } from 'svelte';
  import TvError from './TvError.svelte';
  import TvLoading from './TvLoading.svelte';
  import type { TVRemoteAction } from '$lib/tv/remote';

  let {
    src,
    title,
    onBack,
    onRetry
  }: {
    src: string;
    title: string;
    onBack: () => void;
    onRetry: () => void;
  } = $props();

  let video = $state<HTMLVideoElement | undefined>(undefined);
  let loading = $state(true);
  let errorMessage = $state('');
  let isPlaying = $state(false);
  let duration = $state(0);
  let currentTime = $state(0);
  let controlsVisible = $state(true);
  let statusMessage = $state('Preparing video…');
  let hideControlsTimer: ReturnType<typeof setTimeout> | undefined;

  const hasSource = () => Boolean(src.trim());

  onMount(() => {
    if (!hasSource()) {
      loading = false;
      errorMessage = 'No playback source is available for this title.';
      statusMessage = 'Playback source unavailable.';
      return;
    }

    const handleRemote = (event: Event) => {
      const action = (event as CustomEvent<TVRemoteAction>).detail;
      handleRemoteAction(action);
    };

    window.addEventListener('tv-player-remote', handleRemote);
    return () => {
      window.removeEventListener('tv-player-remote', handleRemote);
      if (hideControlsTimer) clearTimeout(hideControlsTimer);
    };
  });

  function handleLoadedMetadata() {
    if (!video) return;
    loading = false;
    errorMessage = '';
    duration = Number.isFinite(video.duration) ? video.duration : 0;
    currentTime = video.currentTime;
    statusMessage = 'Ready. Press Enter to play or pause.';
    showControls();
  }

  function handleTimeUpdate() {
    if (!video) return;
    currentTime = video.currentTime;
  }

  function handlePlay() {
    isPlaying = true;
    statusMessage = 'Playing.';
    scheduleHideControls();
  }

  function handlePause() {
    isPlaying = false;
    statusMessage = 'Paused.';
    showControls();
  }

  function handleVideoError() {
    loading = false;
    isPlaying = false;
    errorMessage = 'This video could not be loaded. Check the source and retry.';
    statusMessage = 'Playback failed. Retry is available.';
    showControls();
  }

  function togglePlay() {
    if (!video || errorMessage || loading) return;
    showControls();
    if (video.paused) {
      void video.play().catch(() => {
        errorMessage = 'Playback could not start in this browser.';
        statusMessage = 'Playback could not start. Retry is available.';
      });
    } else {
      video.pause();
    }
  }

  function seekBy(seconds: number) {
    if (!video || errorMessage || loading) return;
    const nextTime = Math.min(Math.max(video.currentTime + seconds, 0), Number.isFinite(video.duration) ? video.duration : video.currentTime + seconds);
    video.currentTime = nextTime;
    currentTime = nextTime;
    statusMessage = `${seconds < 0 ? 'Rewinded' : 'Fast-forwarded'} ${Math.abs(seconds)} seconds.`;
    showControls();
  }

  function handleRemoteAction(action: TVRemoteAction) {
    if (action === 'back') {
      onBack();
      return;
    }
    if (action === 'enter' || action === 'playPause') {
      togglePlay();
      return;
    }
    if (action === 'left' || action === 'rewind') {
      seekBy(-10);
      return;
    }
    if (action === 'right' || action === 'fastForward') {
      seekBy(10);
      return;
    }
    showControls();
  }

  function showControls() {
    controlsVisible = true;
    if (hideControlsTimer) clearTimeout(hideControlsTimer);
    if (isPlaying) scheduleHideControls();
  }

  function scheduleHideControls() {
    if (hideControlsTimer) clearTimeout(hideControlsTimer);
    hideControlsTimer = setTimeout(() => {
      if (isPlaying) controlsVisible = false;
    }, 4000);
  }

  function formatTime(value: number) {
    if (!Number.isFinite(value) || value < 0) return '00:00';
    const total = Math.floor(value);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function handleRetry() {
    errorMessage = '';
    loading = true;
    statusMessage = 'Retrying video…';
    onRetry();
  }
</script>

<section class="tv-player" aria-label={`TV Player for ${title}`} aria-busy={loading}>
  {#if !hasSource()}
    <TvError message={errorMessage} onRetry={handleRetry} />
  {:else}
    <div class="player-stage">
      <video
        bind:this={video}
        src={src}
        preload="metadata"
        playsinline
        onloadedmetadata={handleLoadedMetadata}
        ontimeupdate={handleTimeUpdate}
        onplay={handlePlay}
        onpause={handlePause}
        onerror={handleVideoError}
      >
        <track kind="captions" src="data:text/vtt,WEBVTT%0A%0A" srclang="en" label="English" />
      </video>
      {#if loading}
        <div class="player-state"><TvLoading label="Loading video…" /></div>
      {:else if errorMessage}
        <div class="player-state"><TvError message={errorMessage} onRetry={handleRetry} /></div>
      {/if}
    </div>

    <div class:visible={controlsVisible || !isPlaying || Boolean(errorMessage)} class="player-overlay">
      <div class="player-topline">
        <button class="tv-focusable player-back" data-tv-focusable="true" data-tv-focus-id="tv-player-back" data-tv-focus-group="tv-player-controls" data-tv-player-action="back" type="button" onclick={onBack}>← Back to detail</button>
        <div class="player-title" aria-live="polite">{title}</div>
      </div>
      <div class="player-controls" aria-label="Video controls">
        <button class="tv-focusable player-control" data-tv-focusable="true" data-tv-focus-id="tv-player-toggle" data-tv-focus-group="tv-player-controls" data-tv-player-action="toggle" type="button" onclick={togglePlay}>{isPlaying ? 'Pause' : 'Play'}</button>
        <button class="tv-focusable player-control secondary" data-tv-focusable="true" data-tv-focus-id="tv-player-rewind" data-tv-focus-group="tv-player-controls" data-tv-player-action="rewind" type="button" onclick={() => seekBy(-10)}>−10 sec</button>
        <button class="tv-focusable player-control secondary" data-tv-focusable="true" data-tv-focus-id="tv-player-fast-forward" data-tv-focus-group="tv-player-controls" data-tv-player-action="fast-forward" type="button" onclick={() => seekBy(10)}>+10 sec</button>
        <div class="player-time" aria-label="Playback time">{formatTime(currentTime)} / {formatTime(duration)}</div>
      </div>
      <progress class="player-progress" max={duration || 1} value={Math.min(currentTime, duration || 1)} aria-label="Playback progress"></progress>
      <p class="player-status" role="status">{statusMessage}</p>
    </div>
  {/if}
</section>

<style>
  .tv-player { position: relative; min-height: calc(100dvh - 40px); overflow: hidden; color: var(--tv-ink, #fff); background: #030406; }
  .player-stage { position: absolute; inset: 0; display: grid; place-items: center; background: #030406; }
  video { width: 100%; height: 100%; object-fit: contain; background: #030406; }
  .player-state { position: absolute; inset: 0; display: grid; place-items: center; padding: 30px; background: rgba(3,4,6,.7); }
  .player-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 32px 42px 28px; background: linear-gradient(180deg, rgba(3,4,6,.86), transparent 32%, transparent 58%, rgba(3,4,6,.94)); opacity: 0; pointer-events: none; transition: opacity 160ms ease-out; }
  .player-overlay.visible { opacity: 1; pointer-events: auto; }
  .player-topline { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
  .player-back, .player-control { min-height: 58px; padding: 13px 20px; border: 2px solid rgba(255,255,255,.28); border-radius: 12px; color: #fff; background: rgba(8,10,15,.78); font-size: 1.08rem; font-weight: 900; cursor: pointer; }
  .player-control { min-width: 120px; border-color: var(--tv-accent, #ff5270); background: var(--tv-accent, #ff5270); }
  .player-control.secondary { border-color: rgba(255,255,255,.3); background: rgba(8,10,15,.82); }
  .player-title { max-width: 58%; overflow: hidden; color: #fff; font-size: clamp(1.3rem, 2.5vw, 2.2rem); font-weight: 950; text-overflow: ellipsis; white-space: nowrap; }
  .player-controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .player-time { margin-left: auto; color: #fff; font-size: 1.08rem; font-weight: 850; }
  .player-progress { width: 100%; height: 12px; accent-color: var(--tv-accent, #ff5270); }
  .player-status { margin: 0; color: #fff; font-size: 1rem; font-weight: 750; }
  @media (prefers-reduced-motion: reduce) { .player-overlay { transition: none; } }
  @media (max-width: 760px) { .player-overlay { padding: 22px; } .player-topline { align-items: flex-start; flex-direction: column; } .player-title { max-width: 100%; } .player-time { margin-left: 0; } }
</style>
