<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, ListVideo, Maximize2, RotateCcw, Settings2, X } from 'lucide-svelte';
  import PlayerControls from './PlayerControls.svelte';
  import PlayerViewport from './PlayerViewport.svelte';
  import type { PlayerContentContext, PlayerEpisode, PlayerEpisodeTarget, PlayerPlaybackState, PlayerProgressEvent, PlayerQualityOption, PlayerSource, PlayerSourceOption } from '$lib/shared/player';
  import { sourceIsExpired, isEmbedOriginAllowed, isPlayablePlayerSource } from '$lib/shared/player-guards';
  import { adjacentEpisode, adjacentSource, clampSeek } from '$lib/shared/player-state';

  export let source: PlayerSource | null = null;
  export let content: PlayerContentContext;
  export let initialProgress = 0;
  export let sourceOptions: PlayerSourceOption[] = [];
  export let episodes: PlayerEpisode[] = [];
  export let currentEpisode: PlayerEpisodeTarget | null = null;
  export let onProgress: (event: PlayerProgressEvent) => void = () => {};
  export let onSourceChange: (sourceId: string) => void = () => {};
  export let onEpisodeChange: (target: PlayerEpisodeTarget) => void = () => {};
  export let onClose: () => void = () => {};
  export let resolving = false;
  export let resolutionError = '';
  export let resolutionMessage = '';
  export let resolutionKind: 'provider-error' | 'unsupported' | 'unavailable' = 'provider-error';

  let viewport: PlayerViewport;
  let videoElement: HTMLVideoElement | undefined;
  let playerRoot: HTMLElement;
  let currentTime = initialProgress;
  let duration = 0;
  let buffered = 0;
  let playing = false;
  let muted = false;
  let volume = 1;
  let playbackRate = 1;
  let fullscreen = false;
  let pictureInPicture = false;
  let pictureInPictureSupported = false;
  let state: PlayerPlaybackState = source ? 'preparing' : 'source-unavailable';
  let errorMessage = '';
  let selectedQuality = '';
  let selectedSubtitle = '';
  let sourceMenuOpen = false;
  let episodeMenuOpen = false;
  let controlsVisible = true;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSeek = initialProgress;
  let lastProgressReport = 0;
  let sourceIdentity = '';

  $: qualities = source?.qualities ?? [];
  $: subtitles = source?.subtitles ?? [];
  $: selectedQualityOption = qualities.find((quality) => quality.url === selectedQuality) as PlayerQualityOption | undefined;
  $: mediaUrl = selectedQualityOption?.url ?? source?.url ?? null;
  $: sourceReady = Boolean(source && isPlayablePlayerSource(source) && !sourceIsExpired(source));
  $: sourceIndex = source ? sourceOptions.findIndex((option) => option.id === source.sourceId) : -1;
  $: previousSourceId = adjacentSource(sourceOptions, source?.sourceId, -1);
  $: nextSourceId = adjacentSource(sourceOptions, source?.sourceId, 1);
  $: hasPreviousSource = Boolean(previousSourceId);
  $: hasNextSource = Boolean(nextSourceId);
  $: effectiveState = resolving ? 'switching-source' : resolutionError ? resolutionKind : state;
  $: embedReady = Boolean(source?.type === 'embed' && isEmbedOriginAllowed(source) && !sourceIsExpired(source));
  $: episodeIndex = currentEpisode ? episodes.findIndex((episode) => episode.season === currentEpisode?.season && episode.number === currentEpisode?.episode) : -1;
  $: hasPreviousEpisode = episodeIndex > 0;
  $: hasNextEpisode = episodeIndex >= 0 && episodeIndex < episodes.length - 1;
  $: if (source?.sourceId && source.sourceId !== sourceIdentity) {
    sourceIdentity = source.sourceId;
    pendingSeek = currentTime;
    errorMessage = '';
    playing = false;
    state = source.type === 'embed' ? 'embed-loading' : 'preparing';
  }

  onMount(() => {
    pictureInPictureSupported = Boolean(document.pictureInPictureEnabled && videoElement && 'requestPictureInPicture' in videoElement);
    const handleFullscreen = () => { fullscreen = document.fullscreenElement === playerRoot; };
    const handlePictureInPicture = () => { pictureInPicture = document.pictureInPictureElement === videoElement; };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, button, [contenteditable="true"]')) return;
      if (source?.type !== 'direct') return;
      if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); void togglePlay(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-10); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(10); }
      else if (event.key.toLowerCase() === 'm') { event.preventDefault(); toggleMute(); }
      else if (event.key.toLowerCase() === 'f') { event.preventDefault(); void toggleFullscreen(); }
      else if (event.key === 'Escape') { sourceMenuOpen = false; episodeMenuOpen = false; }
    };
    const showControls = () => {
      controlsVisible = true;
      if (hideTimer) clearTimeout(hideTimer);
      if (playing) hideTimer = setTimeout(() => { controlsVisible = false; }, 2600);
    };
    document.addEventListener('fullscreenchange', handleFullscreen);
    document.addEventListener('enterpictureinpicture', handlePictureInPicture);
    document.addEventListener('leavepictureinpicture', handlePictureInPicture);
    window.addEventListener('keydown', handleKeydown);
    playerRoot?.addEventListener('pointermove', showControls);
    playerRoot?.addEventListener('touchstart', showControls, { passive: true });
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      document.removeEventListener('fullscreenchange', handleFullscreen);
      document.removeEventListener('enterpictureinpicture', handlePictureInPicture);
      document.removeEventListener('leavepictureinpicture', handlePictureInPicture);
      window.removeEventListener('keydown', handleKeydown);
      playerRoot?.removeEventListener('pointermove', showControls);
      playerRoot?.removeEventListener('touchstart', showControls);
    };
  });

  async function togglePlay() {
    if (!sourceReady || source?.type !== 'direct' || !videoElement) {
      errorMessage = source?.type === 'embed' ? 'This source uses its own provider controls.' : 'Choose an available source to begin playback.';
      state = source?.type === 'embed' ? 'embed-loading' : 'source-unavailable';
      return;
    }
    try {
      if (videoElement.paused) await videoElement.play();
      else videoElement.pause();
    } catch {
      playing = false;
      state = 'paused';
      errorMessage = 'Playback is ready. Tap Play to start it.';
    }
  }

  function handleLoadedMetadata() {
    if (!videoElement) return;
    pictureInPictureSupported = Boolean(document.pictureInPictureEnabled && 'requestPictureInPicture' in videoElement);
    duration = Number.isFinite(videoElement.duration) ? videoElement.duration : duration;
    videoElement.volume = volume;
    videoElement.muted = muted;
    videoElement.playbackRate = playbackRate;
    state = 'paused';
    if (pendingSeek > 0 && pendingSeek < duration) {
      videoElement.currentTime = pendingSeek;
      currentTime = pendingSeek;
    }
    pendingSeek = 0;
  }

  function handleTimeUpdate(event: CustomEvent<{ currentTime: number; duration: number }>) {
    currentTime = event.detail.currentTime;
    duration = event.detail.duration || duration;
    if (videoElement?.buffered.length) buffered = videoElement.buffered.end(videoElement.buffered.length - 1);
    if (currentTime - lastProgressReport >= 5) {
      lastProgressReport = currentTime;
      emitProgress('progress');
    }
  }

  function handlePlay() {
    playing = true;
    state = 'playing';
    errorMessage = '';
    revealControls();
  }

  function handlePause() {
    playing = false;
    if (state !== 'completed') state = 'paused';
    emitProgress('pause');
    revealControls();
  }

  function handleWaiting() { state = 'buffering'; }
  function handlePlaying() { state = 'playing'; errorMessage = ''; }
  function handleSeeking() { state = 'seeking'; }
  function handleSeeked() { state = playing ? 'playing' : 'paused'; }
  function handleEnded() { playing = false; state = 'completed'; emitProgress('ended'); revealControls(); }
  function handleMediaError() { playing = false; state = 'error'; errorMessage = 'Playback could not be started. Try again or choose another source.'; revealControls(); }
  function handleEmbedLoad() { state = 'playing'; errorMessage = ''; }

  function seek(time: number) {
    if (!videoElement || !Number.isFinite(time)) return;
    currentTime = clampSeek(time, duration);
    videoElement.currentTime = currentTime;
    emitProgress('progress');
  }

  function seekBy(delta: number) { seek(currentTime + delta); }
  function toggleMute() { muted = !muted; if (videoElement) videoElement.muted = muted; }
  function setVolume(value: number) { volume = Math.min(1, Math.max(0, value)); muted = volume === 0; if (videoElement) { videoElement.volume = volume; videoElement.muted = muted; } }
  function setPlaybackRate(value: number) { playbackRate = value; if (videoElement) videoElement.playbackRate = value; }

  function setSubtitle(url: string) {
    selectedSubtitle = url;
    if (!videoElement) return;
    Array.from(videoElement.textTracks).forEach((track) => { track.mode = 'disabled'; });
    if (!url) return;
    const trackIndex = Array.from(videoElement.querySelectorAll('track')).findIndex((track) => track.getAttribute('src') === url);
    const track = trackIndex >= 0 ? Array.from(videoElement.textTracks)[trackIndex] : Array.from(videoElement.textTracks).find((candidate) => candidate.label === url || candidate.language === url);
    if (track) track.mode = 'showing';
  }

  function setQuality(url: string) {
    if (url === selectedQuality) return;
    pendingSeek = currentTime;
    selectedQuality = url;
    state = 'preparing';
    playing = false;
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await playerRoot?.requestFullscreen?.();
        const orientation = screen.orientation as ScreenOrientation & { lock?: (value: 'landscape' | 'portrait' | 'any' | 'natural' | 'landscape-primary' | 'landscape-secondary' | 'portrait-primary' | 'portrait-secondary') => Promise<void>; unlock?: () => void };
        try { await orientation.lock?.('landscape'); } catch { /* device/browser declined */ }
      } else {
        await document.exitFullscreen?.();
        const orientation = screen.orientation as ScreenOrientation & { lock?: (value: 'landscape' | 'portrait' | 'any' | 'natural' | 'landscape-primary' | 'landscape-secondary' | 'portrait-primary' | 'portrait-secondary') => Promise<void>; unlock?: () => void };
        try { orientation.unlock?.(); } catch { /* unsupported */ }
      }
    } catch {
      errorMessage = 'Fullscreen is not available in this browser.';
    }
  }

  async function togglePictureInPicture() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture?.();
      else await viewport.requestPictureInPicture();
    } catch {
      errorMessage = 'Picture-in-Picture is not available for this source.';
    }
  }

  function chooseSource(sourceId: string) {
    sourceMenuOpen = false;
    if (sourceId !== source?.sourceId) {
      state = 'switching-source';
      errorMessage = '';
      onSourceChange(sourceId);
    }
  }

  function chooseAdjacentSource(delta: -1 | 1) {
    const nextId = adjacentSource(sourceOptions, source?.sourceId, delta);
    if (nextId) chooseSource(nextId);
  }

  function chooseEpisode(target: PlayerEpisodeTarget) {
    episodeMenuOpen = false;
    onEpisodeChange(target);
  }

  function chooseAdjacentEpisode(delta: -1 | 1) {
    const next = adjacentEpisode(episodes, currentEpisode, delta);
    if (next) chooseEpisode(next);
  }

  function emitProgress(reason: PlayerProgressEvent['reason']) {
    onProgress({ currentTime, duration, completed: state === 'completed' || (duration > 0 && currentTime / duration >= 0.9), reason });
  }

  function revealControls() {
    controlsVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    if (playing) hideTimer = setTimeout(() => { controlsVisible = false; }, 2600);
  }

  function retry() {
    errorMessage = '';
    if (source?.sourceId) {
      state = 'switching-source';
      onSourceChange(source.sourceId);
      return;
    }
    if (videoElement) { videoElement.load(); pendingSeek = currentTime; }
    state = source?.type === 'embed' ? 'embed-loading' : 'preparing';
  }
</script>

<svelte:window onbeforeunload={() => emitProgress('close')} onvisibilitychange={() => { if (document.hidden) emitProgress('visibility'); }} />

  <div bind:this={playerRoot} class="player-shell" class:controls-hidden={!controlsVisible} role="application" aria-label="MAVERO video player">
  <header class="player-header">
    <button class="header-button" type="button" aria-label="Close player" onclick={onClose}><ArrowLeft size={18} /><span>Back</span></button>
    <div class="header-title"><strong>{content.title}</strong>{#if currentEpisode}<span>S{String(currentEpisode.season).padStart(2, '0')} · E{String(currentEpisode.episode).padStart(2, '0')}{#if currentEpisode.title} · {currentEpisode.title}{/if}</span>{/if}</div>
    <div class="header-actions">
      {#if episodes.length}<button class="header-button compact" type="button" aria-label="Open episode list" aria-expanded={episodeMenuOpen} onclick={() => { episodeMenuOpen = !episodeMenuOpen; sourceMenuOpen = false; }}><ListVideo size={17} /><span>Episodes</span></button>{/if}
      {#if sourceOptions.length}<button class="header-button compact step-button" type="button" aria-label="Previous server" disabled={!hasPreviousSource} onclick={() => chooseAdjacentSource(-1)}><ChevronLeft size={17} /><span>Previous</span></button><button class="header-button compact" type="button" aria-label="Open source list" aria-expanded={sourceMenuOpen} onclick={() => { sourceMenuOpen = !sourceMenuOpen; episodeMenuOpen = false; }}><Settings2 size={17} /><span>Sources</span></button><button class="header-button compact step-button" type="button" aria-label="Next server" disabled={!hasNextSource} onclick={() => chooseAdjacentSource(1)}><ChevronRight size={17} /><span>Next</span></button>{/if}
      <button class="header-button compact orientation-button" type="button" aria-label="Toggle landscape player" onclick={() => void toggleFullscreen()}><Maximize2 size={17} /><span>Landscape</span></button>
    </div>
  </header>

  <section class="stage-wrap" aria-label="Player viewport">
    <PlayerViewport bind:this={viewport} bind:videoElement {source} {mediaUrl} poster={content.backdrop ?? content.poster ?? ''} title={content.title} state={effectiveState} on:loadedmetadata={handleLoadedMetadata} on:timeupdate={handleTimeUpdate} on:play={handlePlay} on:pause={handlePause} on:waiting={handleWaiting} on:playing={handlePlaying} on:seeking={handleSeeking} on:seeked={handleSeeked} on:ended={handleEnded} on:error={handleMediaError} on:embedload={handleEmbedLoad} />

    {#if resolutionError || errorMessage || effectiveState === 'error' || effectiveState === 'provider-error' || effectiveState === 'source-unavailable' || effectiveState === 'unsupported-format' || effectiveState === 'embed-unavailable'}
      <div class="message-card" role="alert">
        <div class="message-icon"><AlertTriangle size={17} /></div>
        <div><strong>{effectiveState === 'provider-error' ? 'Provider unavailable' : effectiveState === 'unsupported' ? 'Unsupported title type' : effectiveState === 'unavailable' ? 'Server unavailable' : effectiveState === 'source-unavailable' ? 'Source unavailable' : effectiveState === 'embed-unavailable' ? 'Embed unavailable' : 'Playback could not be started'}</strong><p>{resolutionError || errorMessage || 'Choose another authorized source and try again.'}</p></div>
        <div class="message-actions"><button class="small-button" type="button" onclick={retry}><RotateCcw size={14} /> Retry</button>{#if sourceOptions.length}<button class="small-button secondary" type="button" onclick={() => { sourceMenuOpen = true; }}><Settings2 size={14} /> Change source</button>{/if}</div>
      </div>
    {:else if state === 'completed'}
      <div class="completion-card" role="status"><Check size={18} /><span>Episode complete</span>{#if hasNextEpisode}<button class="small-button" type="button" onclick={() => chooseAdjacentEpisode(1)}>Next episode <ChevronRight size={14} /></button>{/if}</div>
    {:else if effectiveState === 'preparing' || effectiveState === 'resolving' || effectiveState === 'switching-source' || effectiveState === 'embed-loading'}
      <div class="loading-card" role="status"><span class="loading-ring" aria-hidden="true"><span></span></span><span class="loading-copy"><strong>{effectiveState === 'switching-source' ? 'Switching server' : effectiveState === 'embed-loading' ? 'Starting your stream' : 'Loading player'}</strong><small>{resolutionMessage || (effectiveState === 'embed-loading' ? 'Loading provider embed…' : 'Preparing playback…')}</small></span></div>
    {/if}

    {#if currentEpisode && (hasPreviousEpisode || hasNextEpisode)}
      <div class="episode-stepper"><button class="round-step" type="button" disabled={!hasPreviousEpisode} aria-label="Previous episode" onclick={() => chooseAdjacentEpisode(-1)}><ChevronLeft size={18} /></button><span>{currentEpisode.title ?? `Episode ${currentEpisode.episode}`}</span><button class="round-step" type="button" disabled={!hasNextEpisode} aria-label="Next episode" onclick={() => chooseAdjacentEpisode(1)}><ChevronRight size={18} /></button></div>
    {/if}
  </section>

  {#if source?.type === 'direct'}
    <div class="controls-layer" class:visible={controlsVisible}>
      <PlayerControls playing={playing} {muted} {volume} {currentTime} {duration} {buffered} {playbackRate} {fullscreen} pictureInPicture={pictureInPictureSupported} subtitles={subtitles} selectedSubtitle={selectedSubtitle} qualities={qualities} selectedQuality={selectedQuality} sourceCount={sourceOptions.length} onTogglePlay={togglePlay} onSeek={seek} onVolume={setVolume} onToggleMute={toggleMute} onPlaybackRate={setPlaybackRate} onSubtitle={setSubtitle} onQuality={setQuality} onFullscreen={toggleFullscreen} onPictureInPicture={togglePictureInPicture} onStep={seekBy} onSources={() => { sourceMenuOpen = !sourceMenuOpen; }} />
    </div>
  {/if}

  {#if sourceMenuOpen}
    <div class="drawer source-drawer" role="dialog" aria-label="Available playback sources">
      <div class="drawer-head"><div><span class="eyebrow">Source resolver</span><h2>Choose a source</h2></div><button class="close-button" type="button" aria-label="Close source list" onclick={() => sourceMenuOpen = false}><X size={17} /></button></div>
      <div class="drawer-list">{#each sourceOptions as option}<button class="drawer-option" class:active={option.id === source?.sourceId} type="button" onclick={() => chooseSource(option.id)}><span class="option-mark">{#if option.id === source?.sourceId}<Check size={14} />{:else}<span></span>{/if}</span><span><strong>{option.name}</strong><small>{option.status ?? 'available'}{#if option.integrationType} · {option.integrationType}{/if}{#if option.sandboxPolicy} · sandbox: {option.sandboxPolicy}{/if}</small></span></button>{/each}</div>
      <p class="drawer-note">Every source is resolved and validated by MAVERO before it reaches this player. A provider may still reject the configured iframe permissions; MAVERO cannot inspect or bypass that cross-origin decision.</p>
    </div>
  {/if}

  {#if episodeMenuOpen}
    <div class="drawer episode-drawer" role="dialog" aria-label="Episode list">
      <div class="drawer-head"><div><span class="eyebrow">Episode guide</span><h2>{episodes.length} available</h2></div><button class="close-button" type="button" aria-label="Close episode list" onclick={() => episodeMenuOpen = false}><X size={17} /></button></div>
      <div class="drawer-list">{#each episodes as episode}<button class="drawer-option" class:active={currentEpisode?.season === episode.season && currentEpisode?.episode === episode.number} type="button" onclick={() => chooseEpisode({ season: episode.season, episode: episode.number, title: episode.title })}><span class="episode-number">{String(episode.number).padStart(2, '0')}</span><span><strong>{episode.title}</strong><small>S{episode.season} · {episode.runtime ?? 'Episode'}</small></span></button>{/each}</div>
    </div>
  {/if}


</div>

<style>
  .player-shell { --player-bg: #050506; position: relative; min-height: 100dvh; overflow: hidden; color: var(--ink); background: var(--player-bg); }
  .player-header { position: absolute; z-index: 8; top: 0; right: 0; left: 0; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: calc(16px + env(safe-area-inset-top)) clamp(16px, 4vw, 48px) 16px; background: linear-gradient(180deg, rgba(4,4,6,.92), rgba(4,4,6,.32) 70%, transparent); }
  .header-button { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; border: 1px solid rgba(255,255,255,.09); border-radius: 11px; padding: 0 11px; color: rgba(255,255,255,.82); background: rgba(12,11,17,.58); cursor: pointer; font: inherit; font-size: .68rem; transition: background 160ms ease-out, border-color 160ms ease-out, transform 160ms ease-out; }
  .header-button:hover, .header-button:focus-visible { border-color: rgba(194,181,255,.52); background: rgba(40,32,60,.82); }
  .header-button:disabled { cursor: not-allowed; opacity: .3; }
  .header-button:active { transform: scale(.97); }
  .header-title { display: grid; justify-items: center; gap: 4px; min-width: 0; color: #fff; text-align: center; text-shadow: 0 1px 14px #000; }
  .header-title strong { max-width: min(48vw, 600px); overflow: hidden; font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
  .header-title span { color: rgba(255,255,255,.53); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .header-actions { display: flex; gap: 5px; }
  .stage-wrap { position: relative; display: grid; min-height: 100dvh; place-items: center; padding: calc(72px + env(safe-area-inset-top)) clamp(12px, 3vw, 42px) calc(30px + env(safe-area-inset-bottom)); }
  .stage-wrap :global(.viewport) { width: min(100%, calc((100dvh - 112px) * 1.7778)); aspect-ratio: 16 / 9; min-height: 0; max-height: calc(100dvh - 112px); border-radius: 14px; box-shadow: 0 22px 80px rgba(0,0,0,.38); }
  .stage-wrap :global(.viewport.embed) { width: min(100%, calc((100dvh - 112px) * 1.7778)); }
  .controls-layer { position: absolute; z-index: 6; right: clamp(12px, 3vw, 42px); bottom: calc(28px + env(safe-area-inset-bottom)); left: clamp(12px, 3vw, 42px); opacity: 1; transition: opacity 220ms ease-out; pointer-events: auto; }
  .controls-layer:not(.visible) { opacity: 0; pointer-events: none; }
  .message-card, .completion-card, .loading-card { position: absolute; z-index: 7; right: 50%; bottom: 50%; display: flex; align-items: center; gap: 12px; max-width: min(590px, calc(100% - 36px)); transform: translate(50%, 50%); border: 1px solid rgba(194,181,255,.26); border-radius: 15px; padding: 15px 16px; color: #fff; background: rgba(12,11,18,.88); box-shadow: 0 20px 60px rgba(0,0,0,.34); backdrop-filter: blur(22px); }
  .message-card strong { display: block; font-size: .75rem; }
  .message-card p { margin: 5px 0 0; color: rgba(255,255,255,.58); font-size: .66rem; line-height: 1.45; }
  .message-icon { display: grid; flex: 0 0 34px; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #f2c4ac; background: rgba(242,196,172,.1); }
  .message-actions { display: flex; gap: 6px; margin-left: auto; }
  .small-button { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; border: 1px solid rgba(194,181,255,.35); border-radius: 8px; padding: 0 9px; color: #fff; background: rgba(155,135,245,.16); cursor: pointer; font: inherit; font-size: .61rem; white-space: nowrap; }
  .small-button.secondary { border-color: rgba(255,255,255,.16); background: rgba(255,255,255,.06); }
  .completion-card { color: #d8ccff; }
  .loading-card { min-width: min(260px, calc(100% - 36px)); justify-content: center; color: rgba(255,255,255,.78); font-size: .68rem; }
  .loading-ring { display: grid; flex: 0 0 38px; place-items: center; width: 38px; height: 38px; border: 1px solid rgba(255,255,255,.12); border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 24%, rgba(194,181,255,.95) 42%, rgba(155,135,245,.2) 72%, transparent 100%); animation: spin 1.2s linear infinite; }
  .loading-ring > span { width: 28px; height: 28px; border-radius: 50%; background: #0c0b12; }
  .loading-copy { display: grid; gap: 4px; text-align: left; }
  .loading-copy strong { color: #fff; font-size: .72rem; }
  .loading-copy small { color: rgba(255,255,255,.48); font-family: 'DM Mono', monospace; font-size: .53rem; }
  :global(.spin) { animation: spin 1s linear infinite; }
  .episode-stepper { position: absolute; z-index: 5; right: 50%; bottom: 125px; display: flex; align-items: center; gap: 12px; transform: translateX(50%); color: rgba(255,255,255,.63); font-family: 'DM Mono', monospace; font-size: .58rem; }
  .round-step { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid rgba(255,255,255,.15); border-radius: 50%; color: #fff; background: rgba(7,7,10,.62); cursor: pointer; }
  .round-step:disabled { cursor: not-allowed; opacity: .25; }
  .drawer { position: absolute; z-index: 12; top: 76px; right: clamp(16px, 4vw, 48px); width: min(360px, calc(100% - 32px)); max-height: min(70dvh, 620px); overflow: auto; border: 1px solid rgba(194,181,255,.22); border-radius: 16px; background: rgba(13,12,19,.95); box-shadow: 0 24px 90px rgba(0,0,0,.5); backdrop-filter: blur(28px); }
  .episode-drawer { width: min(420px, calc(100% - 32px)); }
  .drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 19px 18px 13px; }
  .drawer-head h2 { margin: 5px 0 0; font-size: 1.1rem; letter-spacing: -.05em; }
  .close-button { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid rgba(255,255,255,.12); border-radius: 9px; color: rgba(255,255,255,.72); background: rgba(255,255,255,.06); cursor: pointer; }
  .drawer-list { display: grid; gap: 4px; padding: 0 10px 13px; }
  .drawer-option { display: flex; align-items: center; gap: 11px; min-height: 52px; border: 1px solid transparent; border-radius: 11px; padding: 7px 9px; color: rgba(255,255,255,.76); background: transparent; cursor: pointer; text-align: left; }
  .drawer-option:hover, .drawer-option:focus-visible, .drawer-option.active { border-color: rgba(194,181,255,.32); background: rgba(155,135,245,.1); }
  .drawer-option strong, .drawer-option small { display: block; }
  .drawer-option strong { color: #fff; font-size: .7rem; }
  .drawer-option small { margin-top: 4px; color: rgba(255,255,255,.45); font-family: 'DM Mono', monospace; font-size: .53rem; }
  .option-mark { display: grid; flex: 0 0 24px; place-items: center; width: 24px; height: 24px; border: 1px solid rgba(255,255,255,.15); border-radius: 50%; color: var(--accent); }
  .option-mark > span { width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,.25); }
  .episode-number { flex: 0 0 28px; color: var(--accent); font-family: 'DM Mono', monospace; font-size: .65rem; }
  .drawer-note { margin: 0; padding: 0 18px 18px; color: rgba(255,255,255,.4); font-size: .61rem; line-height: 1.5; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 640px) { .player-header { padding-top: calc(10px + env(safe-area-inset-top)); padding-bottom: 10px; } .header-button span, .header-button.compact span { display: none; } .header-button { min-width: 38px; justify-content: center; padding: 0; } .header-title strong { max-width: 42vw; font-size: .69rem; } .stage-wrap { padding: calc(62px + env(safe-area-inset-top)) 0 calc(24px + env(safe-area-inset-bottom)); } .stage-wrap :global(.viewport), .stage-wrap :global(.viewport.embed) { width: 100%; max-height: none; border-radius: 0; } .message-card { bottom: 50%; flex-wrap: wrap; } .message-actions { width: 100%; margin-left: 46px; } .episode-stepper { bottom: calc(34px + env(safe-area-inset-bottom)); } .drawer { top: calc(62px + env(safe-area-inset-top)); right: 12px; width: calc(100% - 24px); max-height: 72dvh; } }
  @media (orientation: landscape) and (max-height: 560px) { .player-header { padding-top: 8px; padding-bottom: 8px; } .stage-wrap { padding-top: 56px; padding-bottom: 16px; } .stage-wrap :global(.viewport), .stage-wrap :global(.viewport.embed) { width: min(100%, calc((100dvh - 72px) * 1.7778)); max-height: calc(100dvh - 72px); } }
  @media (prefers-reduced-motion: reduce) { .loading-ring, :global(.spin) { animation: none; } .header-button, .controls-layer { transition: none; } }
</style>
