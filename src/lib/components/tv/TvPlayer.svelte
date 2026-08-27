<script lang="ts">
  import { onMount } from 'svelte';
  import TvError from './TvError.svelte';
  import TvLoading from './TvLoading.svelte';
  import type { TVRemoteAction } from '$lib/tv/remote';
  import type { PlayerProgressEvent, PlayerSource, PlayerSourceOption } from '$lib/shared/player';
  import { iframeSandboxAttribute } from '$lib/shared/sandbox-policy';

  let {
    source,
    sourceOptions,
    sourceLoading,
    resolutionState,
    resolutionMessage,
    initialProgress,
    title,
    onBack,
    onRetry,
    onSourceChange,
    onProgress
  }: {
    source: PlayerSource | null;
    sourceOptions: PlayerSourceOption[];
    sourceLoading: boolean;
    resolutionState: 'idle' | 'resolving' | 'ready' | 'provider-error' | 'unsupported' | 'unavailable' | 'network-error';
    resolutionMessage: string;
    initialProgress: number;
    title: string;
    onBack: () => void;
    onRetry: () => void;
    onSourceChange: (sourceId: string) => void;
    onProgress: (event: PlayerProgressEvent) => void;
  } = $props();

  let video = $state<HTMLVideoElement | undefined>(undefined);
  let isPlaying = $state(false);
  let duration = $state(0);
  let currentTime = $state(0);
  let controlsVisible = $state(true);
  let statusMessage = $state('Preparing authorized playback…');
  let hideControlsTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeAppliedForUrl = '';

  const isLoading = $derived(sourceLoading || resolutionState === 'resolving' || resolutionState === 'idle');
  const hasError = $derived(!isLoading && !source && Boolean(resolutionMessage));
  const isEmbed = $derived(source?.type === 'embed');
  const iframeSandbox = $derived(source?.sandboxPolicy ? iframeSandboxAttribute(source.sandboxPolicy) : undefined);

  onMount(() => {
    const handleRemote = (event: Event) => handleRemoteAction((event as CustomEvent<TVRemoteAction>).detail);
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') emitProgress('visibility');
    };
    window.addEventListener('tv-player-remote', handleRemote);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('tv-player-remote', handleRemote);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (hideControlsTimer) clearTimeout(hideControlsTimer);
      emitProgress('close');
    };
  });

  function emitProgress(reason: PlayerProgressEvent['reason'], completed = false) {
    if (!source || source.type !== 'direct') return;
    onProgress({
      currentTime: Number.isFinite(currentTime) ? currentTime : 0,
      duration: Number.isFinite(duration) ? duration : 0,
      completed,
      reason
    });
  }

  function handleLoadedMetadata() {
    if (!video || !source) return;
    duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (initialProgress > 0 && resumeAppliedForUrl !== source.url && initialProgress < duration) {
      video.currentTime = initialProgress;
      currentTime = initialProgress;
      resumeAppliedForUrl = source.url ?? '';
      statusMessage = `Resuming at ${formatTime(initialProgress)}.`;
    } else {
      currentTime = video.currentTime;
      statusMessage = 'Ready. Press Enter to play or pause.';
    }
    showControls();
  }

  function handleTimeUpdate() {
    if (!video) return;
    currentTime = video.currentTime;
    duration = Number.isFinite(video.duration) ? video.duration : duration;
    emitProgress('progress');
  }

  function handlePlay() {
    isPlaying = true;
    statusMessage = 'Playing.';
    scheduleHideControls();
  }

  function handlePause() {
    isPlaying = false;
    statusMessage = 'Paused.';
    emitProgress('pause');
    showControls();
  }

  function handleEnded() {
    isPlaying = false;
    currentTime = duration;
    statusMessage = 'Playback complete.';
    emitProgress('ended', true);
    showControls();
  }

  function handleVideoError() {
    isPlaying = false;
    statusMessage = 'Direct playback failed. Retry or choose another source.';
    emitProgress('pause');
    showControls();
  }

  function togglePlay() {
    if (!video || !source || source.type !== 'direct' || isLoading) return;
    showControls();
    if (video.paused) {
      void video.play().catch(() => {
        statusMessage = 'Playback could not start. Retry or choose another source.';
      });
    } else {
      video.pause();
    }
  }

  function seekBy(seconds: number) {
    if (!video || !source || source.type !== 'direct' || isLoading) return;
    const max = Number.isFinite(video.duration) ? video.duration : video.currentTime + seconds;
    video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), max);
    currentTime = video.currentTime;
    statusMessage = `${seconds < 0 ? 'Rewinded' : 'Fast-forwarded'} ${Math.abs(seconds)} seconds.`;
    emitProgress('progress');
    showControls();
  }

  function handleRemoteAction(action: TVRemoteAction) {
    if (action === 'back') return onBack();
    if (action === 'enter' || action === 'playPause') return togglePlay();
    if (action === 'left' || action === 'rewind') return seekBy(-10);
    if (action === 'right' || action === 'fastForward') return seekBy(10);
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
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0 ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function handleRetry() {
    statusMessage = 'Retrying authorized playback…';
    onRetry();
  }
</script>

<section class="tv-player" aria-label={`TV Player for ${title}`} aria-busy={isLoading}>
  <div class="player-stage">
    {#if source?.type === 'direct' && source.url}
      <video
        bind:this={video}
        src={source.url}
        preload="metadata"
        playsinline
        controls={false}
        onloadedmetadata={handleLoadedMetadata}
        ontimeupdate={handleTimeUpdate}
        onplay={handlePlay}
        onpause={handlePause}
        onended={handleEnded}
        onerror={handleVideoError}
      >
        <track kind="captions" src="data:text/vtt,WEBVTT%0A%0A" srclang="en" label="English" />
      </video>
    {:else if source?.type === 'embed' && source.url}
      <iframe
        class="provider-embed"
        src={source.url}
        title={`${title} provider playback`}
        allow="autoplay; fullscreen; picture-in-picture"
        allowfullscreen
        referrerpolicy="no-referrer"
        sandbox={iframeSandbox}
      ></iframe>
    {/if}

    {#if isLoading}
      <div class="player-state"><TvLoading label="Resolving a safe playback source…" /></div>
    {:else if hasError}
      <div class="player-state">
        <TvError message={resolutionMessage || 'This provider is currently unavailable.'} onRetry={handleRetry} />
      </div>
    {:else if isEmbed}
      <div class="embed-note" role="status">Provider controls are inside the secure embed. TV provider playback compatibility requires hardware verification.</div>
    {/if}
  </div>

  <div class:visible={controlsVisible || !isPlaying || isLoading || Boolean(resolutionMessage)} class="player-overlay">
    <div class="player-topline">
      <button class="tv-focusable player-back" data-tv-focusable="true" data-tv-focus-id="tv-player-back" data-tv-focus-group="tv-player-controls" data-tv-player-action="back" type="button" onclick={onBack}>← Back to detail</button>
      <div class="player-title" aria-live="polite">{title}</div>
    </div>

    {#if sourceOptions.length > 1}
      <div class="source-picker" aria-label="Playback sources">
        <span class="source-label">Choose server</span>
        <div class="source-options">
          {#each sourceOptions as option}
            <button
              class:selected={source?.sourceId === option.id}
              class="tv-focusable source-option"
              data-tv-focusable="true"
              data-tv-focus-id={`tv-player-source-${option.id}`}
              data-tv-focus-group="tv-player-sources"
              type="button"
              aria-pressed={source?.sourceId === option.id}
              onclick={() => onSourceChange(option.id)}
            >{option.name}</button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="player-controls" aria-label="Video controls">
      <button class="tv-focusable player-control" data-tv-focusable="true" data-tv-focus-id="tv-player-toggle" data-tv-focus-group="tv-player-controls" type="button" onclick={togglePlay} disabled={!source || source.type !== 'direct'}>{isPlaying ? 'Pause' : 'Play'}</button>
      <button class="tv-focusable player-control secondary" data-tv-focusable="true" data-tv-focus-id="tv-player-rewind" data-tv-focus-group="tv-player-controls" type="button" onclick={() => seekBy(-10)} disabled={!source || source.type !== 'direct'}>−10 sec</button>
      <button class="tv-focusable player-control secondary" data-tv-focusable="true" data-tv-focus-id="tv-player-fast-forward" data-tv-focus-group="tv-player-controls" type="button" onclick={() => seekBy(10)} disabled={!source || source.type !== 'direct'}>+10 sec</button>
      <div class="player-time" aria-label="Playback time">{formatTime(currentTime)} / {formatTime(duration)}</div>
    </div>
    <progress class="player-progress" max={duration || 1} value={Math.min(currentTime, duration || 1)} aria-label="Playback progress"></progress>
    <p class="player-status" role="status">{resolutionMessage || statusMessage}</p>
  </div>
</section>

<style>
  .tv-player { position: relative; min-height: calc(100dvh - 40px); overflow: hidden; color: var(--tv-ink, #fff); background: #030406; }
  .player-stage { position: absolute; inset: 0; display: grid; place-items: center; background: #030406; }
  video, .provider-embed { width: 100%; height: 100%; border: 0; object-fit: contain; background: #030406; }
  .player-state { position: absolute; inset: 0; display: grid; place-items: center; padding: 30px; background: rgba(3,4,6,.72); }
  .embed-note { position: absolute; right: 32px; bottom: 24px; max-width: 48rem; padding: 12px 16px; border: 1px solid rgba(255,255,255,.28); border-radius: 10px; color: #fff; background: rgba(8,10,15,.84); font-size: .9rem; font-weight: 750; }
  .player-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 32px 42px 28px; background: linear-gradient(180deg, rgba(3,4,6,.86), transparent 29%, transparent 58%, rgba(3,4,6,.94)); opacity: 0; pointer-events: none; transition: opacity 160ms ease-out; }
  .player-overlay.visible { opacity: 1; pointer-events: auto; }
  .player-topline { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
  .player-back, .player-control, .source-option { min-height: 58px; padding: 13px 20px; border: 2px solid rgba(255,255,255,.28); border-radius: 12px; color: #fff; background: rgba(8,10,15,.78); font-size: 1.08rem; font-weight: 900; cursor: pointer; }
  .player-control { min-width: 120px; border-color: var(--tv-accent, #ff5270); background: var(--tv-accent, #ff5270); }
  .player-control.secondary { border-color: rgba(255,255,255,.3); background: rgba(8,10,15,.82); }
  button:disabled { cursor: not-allowed; opacity: .48; }
  .player-title { max-width: 58%; overflow: hidden; color: #fff; font-size: clamp(1.3rem, 2.5vw, 2.2rem); font-weight: 950; text-overflow: ellipsis; white-space: nowrap; }
  .source-picker { display: grid; gap: 10px; max-width: 80%; }
  .source-label { color: #fff; font-size: 1rem; font-weight: 900; }
  .source-options { display: flex; flex-wrap: wrap; gap: 12px; }
  .source-option { min-height: 48px; padding: 10px 16px; font-size: .96rem; }
  .source-option.selected, .source-option:focus-visible, .player-back:focus-visible, .player-control:focus-visible { outline: 4px solid #fff; outline-offset: 3px; }
  .source-option.selected { border-color: var(--tv-accent, #ff5270); background: rgba(255,82,112,.82); }
  .player-controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .player-time { margin-left: auto; color: #fff; font-size: 1.08rem; font-weight: 850; }
  .player-progress { width: 100%; height: 12px; accent-color: var(--tv-accent, #ff5270); }
  .player-status { margin: 0; color: #fff; font-size: 1rem; font-weight: 750; }
  @media (prefers-reduced-motion: reduce) { .player-overlay { transition: none; } }
  @media (max-width: 760px) { .player-overlay { padding: 22px; } .player-topline { align-items: flex-start; flex-direction: column; } .player-title { max-width: 100%; } .player-time { margin-left: 0; } .source-picker { max-width: 100%; } }
</style>
