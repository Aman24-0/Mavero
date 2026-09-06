<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, Info, ListVideo, Maximize2, PanelTopClose, PanelTopOpen, RotateCcw, Settings2, ShieldCheck, ShieldOff, X } from 'lucide-svelte';
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
  export let onDetails: () => void = () => {};
  export let onIframeReady: (iframe: HTMLIFrameElement) => void = () => {};
  export let resolving = false;
  export let resolutionError = '';
  export let resolutionMessage = '';
  export let resolutionKind: 'provider-error' | 'unsupported' | 'unavailable' = 'provider-error';

  let viewport: PlayerViewport;
  let videoElement: HTMLVideoElement | undefined;
  let iframeElement: HTMLIFrameElement | undefined;
  let playerRoot: HTMLElement;
  let currentTime = initialProgress;
  let duration = 0;
  let buffered = 0;
  let playing = false;
  let muted = false;
  let volume = 1;
  let playbackRate = 1;
  let fullscreen = false;
  let landscapeMode = false;
  let landscapeControlsExpanded = true;
  let landscapeControlsTimer: ReturnType<typeof setTimeout> | undefined;
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
  let sandboxEnabled = true;
  let sandboxSourceIdentity = '';
  const LANDSCAPE_CONTROLS_HIDE_MS = 5000;

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
  $: if (source?.sourceId && source.sourceId !== sandboxSourceIdentity) {
    sandboxSourceIdentity = source.sourceId;
    sandboxEnabled = source.sandboxPolicy !== 'unrestricted';
  }
  $: effectiveSandboxEnabled = source?.type === 'embed' ? sandboxEnabled : true;
  $: if (source?.sourceId && source.sourceId !== sourceIdentity) {
    sourceIdentity = source.sourceId;
    pendingSeek = currentTime;
    errorMessage = '';
    playing = false;
    state = source.type === 'embed' ? 'embed-loading' : 'preparing';
  }

  onMount(() => {
    pictureInPictureSupported = Boolean(document.pictureInPictureEnabled && videoElement && 'requestPictureInPicture' in videoElement);
    const handleFullscreen = () => {
      fullscreen = document.fullscreenElement === playerRoot;
      if (!fullscreen && landscapeMode) {
        landscapeMode = false;
        landscapeControlsExpanded = true;
        clearLandscapeControlsTimer();
        revealControls();
      }
    };
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
      if (playing && !landscapeMode) hideTimer = setTimeout(() => { controlsVisible = false; }, 2600);
    };
    document.addEventListener('fullscreenchange', handleFullscreen);
    document.addEventListener('enterpictureinpicture', handlePictureInPicture);
    document.addEventListener('leavepictureinpicture', handlePictureInPicture);
    window.addEventListener('keydown', handleKeydown);
    playerRoot?.addEventListener('pointermove', showControls);
    playerRoot?.addEventListener('touchstart', showControls, { passive: true });
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      if (landscapeControlsTimer) clearTimeout(landscapeControlsTimer);
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
  function handleEmbedLoad() {
    state = 'playing';
    errorMessage = '';
    // Phase 3 fix: forward the iframe element ref to the watch route so
    // provider adapters (CineSrc) can post commands to
    // iframe.contentWindow.postMessage(payload, origin) — the documented
    // CineSrc API target. Without this ref, commands cannot reach the
    // provider's player.
    if (iframeElement) onIframeReady(iframeElement);
  }

  function toggleSandbox() {
    if (source?.type !== 'embed') return;
    sandboxEnabled = !sandboxEnabled;
    state = 'embed-loading';
    errorMessage = '';
    revealControls();
  }

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

  type OrientationController = ScreenOrientation & { lock?: (value: 'landscape' | 'portrait' | 'any' | 'natural' | 'landscape-primary' | 'landscape-secondary' | 'portrait-primary' | 'portrait-secondary') => Promise<void>; unlock?: () => void };

  function orientationController() {
    return screen.orientation as OrientationController;
  }

  function clearLandscapeControlsTimer() {
    if (landscapeControlsTimer) clearTimeout(landscapeControlsTimer);
    landscapeControlsTimer = undefined;
  }

  function scheduleLandscapeControlsCollapse() {
    clearLandscapeControlsTimer();
    if (!landscapeMode || !landscapeControlsExpanded) return;
    landscapeControlsTimer = setTimeout(() => {
      landscapeControlsExpanded = false;
      landscapeControlsTimer = undefined;
    }, LANDSCAPE_CONTROLS_HIDE_MS);
  }

  function resetLandscapeControlsTimer() {
    if (!landscapeMode) return;
    landscapeControlsExpanded = true;
    scheduleLandscapeControlsCollapse();
  }

  function handleMaveroControlInteraction(event: Event) {
    if (!landscapeMode) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-landscape-controls-toggle]')) return;
    resetLandscapeControlsTimer();
  }

  function toggleLandscapeControls() {
    if (!landscapeMode) return;
    landscapeControlsExpanded = !landscapeControlsExpanded;
    if (landscapeControlsExpanded) scheduleLandscapeControlsCollapse();
    else clearLandscapeControlsTimer();
  }

  async function toggleLandscape() {
    const entering = !landscapeMode;
    revealControls();
    try {
      const orientation = orientationController();
      if (entering) {
        // Fullscreen belongs to MAVERO's shell. The provider iframe is never invoked or manipulated.
        await playerRoot?.requestFullscreen?.();
        try { await orientation?.lock?.('landscape'); } catch { /* device/browser declined; fullscreen layout remains active */ }
        landscapeMode = true;
        landscapeControlsExpanded = true;
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = undefined;
        scheduleLandscapeControlsCollapse();
      } else {
        try { orientation?.unlock?.(); } catch { /* unsupported */ }
        landscapeMode = false;
        landscapeControlsExpanded = true;
        clearLandscapeControlsTimer();
        if (document.fullscreenElement === playerRoot) await document.exitFullscreen?.();
        revealControls();
      }
    } catch {
      landscapeMode = false;
      landscapeControlsExpanded = true;
      clearLandscapeControlsTimer();
      errorMessage = 'Landscape mode is not available in this browser.';
    }
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await playerRoot?.requestFullscreen?.();
        try { await orientationController()?.lock?.('landscape'); } catch { /* device/browser declined */ }
      } else if (document.fullscreenElement === playerRoot) {
        await document.exitFullscreen?.();
        try { orientationController()?.unlock?.(); } catch { /* unsupported */ }
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

  function emitProgress(reason: PlayerProgressEvent['reason']) {
    onProgress({ currentTime, duration, completed: state === 'completed' || (duration > 0 && currentTime / duration >= 0.9), reason });
  }

  function revealControls() {
    controlsVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    if (playing && !landscapeMode) hideTimer = setTimeout(() => { controlsVisible = false; }, 2600);
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

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div bind:this={playerRoot} class="player-shell" class:landscape-mode={landscapeMode} class:controls-hidden={!controlsVisible} onclick={handleMaveroControlInteraction} onpointerdown={handleMaveroControlInteraction} role="application" aria-label="MAVERO video player">
  {#if landscapeMode}<button class="landscape-controls-toggle" data-landscape-controls-toggle type="button" aria-label={landscapeControlsExpanded ? 'Collapse MAVERO controls' : 'Expand MAVERO controls'} aria-expanded={landscapeControlsExpanded} onclick={toggleLandscapeControls}>{#if landscapeControlsExpanded}<PanelTopClose size={15} />{:else}<PanelTopOpen size={15} />{/if}</button>{/if}
  <header class="player-header" class:controls-collapsed={landscapeMode && !landscapeControlsExpanded}>
    <div class="header-title-row">
      <button class="header-button header-nav" type="button" aria-label="Close player" onclick={onClose}><ArrowLeft size={18} /><span>Back</span></button>
      <div class="header-title"><strong>{content.title}</strong>{#if currentEpisode}<span>S{String(currentEpisode.season).padStart(2, '0')} · E{String(currentEpisode.episode).padStart(2, '0')}{#if currentEpisode.title} · {currentEpisode.title}{/if}</span>{/if}</div>
      <button class="header-button compact orientation-button" class:active={landscapeMode} type="button" aria-label={landscapeMode ? 'Exit landscape player' : 'Toggle landscape player'} aria-pressed={landscapeMode} onclick={() => void toggleLandscape()}><Maximize2 size={17} /><span>{landscapeMode ? 'Portrait' : 'Landscape'}</span></button>
    </div>
  </header>

  <section class="stage-wrap" aria-label="Player viewport">
    <PlayerViewport bind:this={viewport} bind:videoElement bind:iframeElement {source} {mediaUrl} sandboxEnabled={effectiveSandboxEnabled} poster={content.backdrop ?? content.poster ?? ''} title={content.title} state={effectiveState} on:loadedmetadata={handleLoadedMetadata} on:timeupdate={handleTimeUpdate} on:play={handlePlay} on:pause={handlePause} on:waiting={handleWaiting} on:playing={handlePlaying} on:seeking={handleSeeking} on:seeked={handleSeeked} on:ended={handleEnded} on:error={handleMediaError} on:embedload={handleEmbedLoad} />

    {#if resolutionError || errorMessage || effectiveState === 'error' || effectiveState === 'provider-error' || effectiveState === 'source-unavailable' || effectiveState === 'unsupported-format' || effectiveState === 'embed-unavailable'}
      <div class="message-card" role="alert">
        <div class="message-icon"><AlertTriangle size={17} /></div>
        <div><strong>This source isn't available.</strong><p>{resolutionError || errorMessage || 'Choose another source or try again.'}</p></div>
        <div class="message-actions"><button class="small-button" type="button" aria-label="Try again" onclick={retry}><RotateCcw size={14} /> Try again</button>{#if sourceOptions.length}<button class="small-button secondary" type="button" aria-label="Switch source" onclick={() => { sourceMenuOpen = true; }}><Settings2 size={14} /> Switch source</button>{/if}</div>
      </div>
    {:else if state === 'completed'}
      <div class="completion-card" role="status"><Check size={18} /><span>Episode complete</span></div>
    {:else if effectiveState === 'preparing' || effectiveState === 'resolving' || effectiveState === 'switching-source' || effectiveState === 'embed-loading'}
      <div class="loading-card" role="status"><span class="loading-ring" aria-hidden="true"><span></span></span><span class="loading-copy"><strong>{effectiveState === 'switching-source' ? 'Switching source…' : effectiveState === 'embed-loading' ? 'Starting your stream…' : 'Loading player…'}</strong><small>{resolutionMessage || (effectiveState === 'embed-loading' ? 'Loading provider embed…' : 'Preparing playback…')}</small></span></div>
    {/if}

  </section>

  <!-- Bottom controls area: direct sources get full PlayerControls; embed sources get shell controls -->
  <div class="bottom-bar" class:visible={controlsVisible} class:landscape-controls-collapsed={landscapeMode && !landscapeControlsExpanded}>
    {#if source?.type === 'direct'}
      <PlayerControls playing={playing} {muted} {volume} {currentTime} {duration} {buffered} {playbackRate} {fullscreen} pictureInPicture={pictureInPictureSupported} subtitles={subtitles} selectedSubtitle={selectedSubtitle} qualities={qualities} selectedQuality={selectedQuality} sourceCount={sourceOptions.length} onTogglePlay={togglePlay} onSeek={seek} onVolume={setVolume} onToggleMute={toggleMute} onPlaybackRate={setPlaybackRate} onSubtitle={setSubtitle} onQuality={setQuality} onFullscreen={toggleFullscreen} onPictureInPicture={togglePictureInPicture} onStep={seekBy} onSources={() => { sourceMenuOpen = !sourceMenuOpen; }} />
    {:else if source?.type === 'embed' || effectiveState === 'embed-loading' || effectiveState === 'switching-source'}
      <!-- Phase 5: Embed source shell controls bar — Mavero-owned controls for embed playback -->
      <div class="embed-shell-controls" role="toolbar" aria-label="Embed playback controls">
        <div class="shell-info">
          <span class="shell-source-name">{sourceOptions.find((o) => o.id === source?.sourceId)?.name ?? 'Loading…'}</span>
        </div>
        <div class="shell-actions">
          {#if sourceOptions.length}<button class="shell-button" type="button" aria-label="Switch source" aria-expanded={sourceMenuOpen} onclick={() => { sourceMenuOpen = !sourceMenuOpen; episodeMenuOpen = false; }}><Settings2 size={16} /></button>{/if}
          {#if episodes.length}<button class="shell-button" type="button" aria-label="Open episode list" aria-expanded={episodeMenuOpen} onclick={() => { episodeMenuOpen = !episodeMenuOpen; sourceMenuOpen = false; }}><ListVideo size={16} /></button>{/if}
          <button class="shell-button" type="button" aria-label={`Open details for ${content.title}`} onclick={onDetails}><Info size={16} /></button>
          <button class="shell-button" type="button" aria-label={landscapeMode ? 'Exit landscape player' : 'Toggle landscape player'} aria-pressed={landscapeMode} onclick={() => void toggleLandscape()}><Maximize2 size={16} /></button>
          {#if source?.type === 'embed'}<button class="shell-button" class:active={effectiveSandboxEnabled} type="button" aria-label={`Turn sandbox ${effectiveSandboxEnabled ? 'off' : 'on'}`} aria-pressed={effectiveSandboxEnabled} onclick={toggleSandbox}>{#if effectiveSandboxEnabled}<ShieldCheck size={16} />{:else}<ShieldOff size={16} />{/if}</button>{/if}
        </div>
      </div>
    {/if}
  </div>

  {#if sourceMenuOpen}
    <!-- Phase 5: Compact source sheet — bottom-anchored sheet, not full-screen drawer -->
    <div class="sheet-overlay" role="presentation" onclick={() => sourceMenuOpen = false}></div>
    <div class="source-sheet" role="dialog" aria-label="Available playback sources">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-head"><span class="eyebrow">Source</span><button class="close-button" type="button" aria-label="Close source list" onclick={() => sourceMenuOpen = false}><X size={17} /></button></div>
      <div class="sheet-list">{#each sourceOptions as option}<button class="sheet-option" class:active={option.id === source?.sourceId} type="button" onclick={() => chooseSource(option.id)}><span class="option-mark">{#if option.id === source?.sourceId}<Check size={14} />{:else}<span></span>{/if}</span><span><strong>{option.name}</strong><small>{option.status ?? 'available'}{#if option.integrationType} · {option.integrationType}{/if}</small></span></button>{/each}</div>
    </div>
  {/if}

  {#if episodeMenuOpen}
    <!-- Phase 5: Compact episode sheet — matching the source sheet style -->
    <div class="sheet-overlay" role="presentation" onclick={() => episodeMenuOpen = false}></div>
    <div class="episode-sheet" role="dialog" aria-label="Episode list">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-head"><span class="eyebrow">Episodes · {episodes.length}</span><button class="close-button" type="button" aria-label="Close episode list" onclick={() => episodeMenuOpen = false}><X size={17} /></button></div>
      <div class="sheet-list">{#each episodes as episode}<button class="sheet-option" class:active={currentEpisode?.season === episode.season && currentEpisode?.episode === episode.number} type="button" onclick={() => chooseEpisode({ season: episode.season, episode: episode.number, title: episode.title })}><span class="episode-number">{String(episode.number).padStart(2, '0')}</span><span><strong>{episode.title}</strong><small>S{episode.season} · {episode.runtime ?? 'Episode'}</small></span></button>{/each}</div>
    </div>
  {/if}

</div>

<style>
  .player-shell { --player-bg: var(--base); position: relative; min-height: 100svh; min-height: 100dvh; overflow: hidden; color: var(--ink); background: var(--player-bg); display: flex; flex-direction: column; }
  .player-shell.landscape-mode { display: flex; flex-direction: column; height: 100dvh; min-height: 100svh; min-height: 100dvh; }
  .player-shell.landscape-mode .player-header { position: relative; display: flex; align-items: center; gap: 8px; height: calc(48px + env(safe-area-inset-top)); min-height: 48px; padding: env(safe-area-inset-top) max(8px, env(safe-area-inset-right)) 0 max(8px, env(safe-area-inset-left)); background: rgba(0,0,0,.92); transition: height 180ms var(--ease-out), min-height 180ms var(--ease-out), opacity 180ms var(--ease-out), transform 180ms var(--ease-out), padding 180ms var(--ease-out); }
  .player-shell.landscape-mode .player-header.controls-collapsed { height: 0; min-height: 0; padding-top: 0; padding-bottom: 0; opacity: 0; transform: translateY(-100%); pointer-events: none; }
  .landscape-controls-toggle { position: absolute; z-index: 14; top: max(8px, env(safe-area-inset-top)); right: max(8px, env(safe-area-inset-right)); display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(0,0,0,.74); cursor: pointer; box-shadow: var(--shadow-sm); backdrop-filter: blur(12px); }
  .landscape-controls-toggle:hover, .landscape-controls-toggle:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .landscape-controls-toggle:active { transform: scale(.96); }
  .player-shell.landscape-mode .header-title-row { display: contents; }
  .player-shell.landscape-mode .header-title { display: grid; flex: 1 1 auto; justify-items: start; min-width: 0; text-align: left; }
  .player-shell.landscape-mode .header-title strong { max-width: 28vw; }
  .player-shell.landscape-mode .header-button { min-width: 32px; min-height: 32px; padding: 0 7px; border-radius: var(--radius-sm); }
  .player-shell.landscape-mode .header-button span { display: none; }
  .player-shell.landscape-mode .header-actions { flex: 0 0 auto; flex-wrap: nowrap; gap: 4px; min-width: 0; margin-right: 38px; }
  .player-shell.landscape-mode .stage-wrap { display: flex; flex: 1 1 auto; align-items: stretch; justify-content: stretch; min-height: 0; padding: 0 max(0px, env(safe-area-inset-right)) max(0px, env(safe-area-inset-bottom)) max(0px, env(safe-area-inset-left)); }
  .player-shell.landscape-mode .stage-wrap :global(.viewport), .player-shell.landscape-mode .stage-wrap :global(.viewport.embed) { flex: 1 1 auto; width: 100%; max-width: none; height: 100%; max-height: none; min-height: 0; aspect-ratio: auto; border-radius: 0; }
  .player-shell.landscape-mode .stage-wrap :global(.viewport iframe), .player-shell.landscape-mode .stage-wrap :global(.viewport video) { min-height: 0; }
  .player-shell.landscape-mode .bottom-bar { position: relative; flex: 0 0 auto; padding: max(8px, env(safe-area-inset-bottom)) clamp(12px, 3vw, 42px) max(8px, env(safe-area-inset-left)); }
  .player-shell.landscape-mode .bottom-bar.landscape-controls-collapsed { opacity: 0; pointer-events: none; transform: translateY(100%); }
  .player-shell.landscape-mode .sheet-overlay, .player-shell.landscape-mode .source-sheet, .player-shell.landscape-mode .episode-sheet { top: calc(48px + env(safe-area-inset-top)); }
  /* Portrait header: compact top bar */
  .player-header { position: relative; z-index: 8; flex: 0 0 auto; display: flex; align-items: center; padding: calc(10px + env(safe-area-inset-top)) clamp(12px, 4vw, 32px) 10px; background: rgba(0,0,0,.6); backdrop-filter: blur(12px); }
  .header-title-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; width: 100%; min-height: 40px; }
  .header-title-row .header-nav { justify-self: start; }
  .header-title-row .orientation-button { justify-self: end; }
  .header-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 0 11px; color: var(--ink-soft); background: rgba(0,0,0,.5); cursor: pointer; font: inherit; font-size: .68rem; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .header-button:hover, .header-button:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .header-button:disabled { cursor: not-allowed; opacity: .3; }
  .header-button:active { transform: scale(.97); }
  .header-title { display: grid; justify-items: center; gap: 2px; min-width: 0; color: var(--ink); text-align: center; }
  .header-title strong { max-width: min(56vw, 600px); overflow: hidden; font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
  .header-title span { color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .56rem; }
  /* Stage: fills remaining space between header and bottom bar */
  .stage-wrap { position: relative; flex: 1 1 auto; display: grid; place-items: center; min-height: 0; padding: 0; overflow: hidden; }
  .stage-wrap :global(.viewport) { width: 100%; height: 100%; min-height: 0; max-height: none; border-radius: 0; box-shadow: none; }
  .stage-wrap :global(.viewport.embed) { width: 100%; }
  /* Bottom bar: always rendered for both direct and embed sources */
  .bottom-bar { position: relative; z-index: 6; flex: 0 0 auto; opacity: 1; transition: opacity var(--motion-normal) var(--ease-out); pointer-events: auto; padding-bottom: env(safe-area-inset-bottom); }
  .bottom-bar:not(.visible) { opacity: 0; pointer-events: none; }
  /* Embed shell controls */
  .embed-shell-controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px clamp(12px, 4vw, 32px); background: rgba(0,0,0,.6); backdrop-filter: blur(12px); border-top: 1px solid var(--line); }
  .shell-info { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .shell-source-name { color: var(--ink-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .68rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shell-actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
  .shell-button { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-soft); background: transparent; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .shell-button:hover, .shell-button:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .shell-button:active { transform: scale(.96); }
  .shell-button.active { border-color: var(--line-strong); color: var(--ink); }
  /* Overlay cards */
  .message-card, .completion-card, .loading-card { position: absolute; z-index: 7; right: 50%; bottom: 50%; display: flex; align-items: center; gap: 12px; max-width: min(590px, calc(100% - 36px)); transform: translate(50%, 50%); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 15px 16px; color: var(--ink); background: rgba(13,13,13,.92); box-shadow: var(--shadow-lg); backdrop-filter: blur(22px); }
  .message-card strong { display: block; font-size: .75rem; }
  .message-card p { margin: 5px 0 0; color: var(--muted); font-size: .66rem; line-height: 1.45; }
  .message-icon { display: grid; flex: 0 0 34px; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-sm); color: var(--ink-soft); background: var(--accent-soft); }
  .message-actions { display: flex; gap: 6px; margin-left: auto; }
  .small-button { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 0 12px; color: var(--ink); background: var(--accent-soft); cursor: pointer; font: inherit; font-size: .62rem; white-space: nowrap; }
  .small-button.secondary { border-color: var(--line); background: rgba(255,255,255,.04); }
  .completion-card { color: var(--ink-soft); }
  .loading-card { min-width: min(260px, calc(100% - 36px)); justify-content: center; color: var(--ink-soft); font-size: .68rem; }
  .loading-ring { display: grid; flex: 0 0 38px; place-items: center; width: 38px; height: 38px; border: 1px solid var(--line); border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 24%, var(--ink-soft) 42%, var(--accent-soft) 72%, transparent 100%); animation: spin 1.2s linear infinite; }
  .loading-ring > span { width: 28px; height: 28px; border-radius: 50%; background: var(--surface); }
  .loading-copy { display: grid; gap: 4px; text-align: left; }
  .loading-copy strong { color: var(--ink); font-size: .72rem; }
  .loading-copy small { color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .53rem; }
  :global(.spin) { animation: spin 1s linear infinite; }
  /* Phase 5: Compact source/episode sheets — bottom-anchored, not full-screen */
  .sheet-overlay { position: fixed; z-index: 20; inset: 0; background: rgba(0,0,0,.5); backdrop-filter: blur(2px); }
  .source-sheet, .episode-sheet { position: fixed; z-index: 21; bottom: 0; left: 0; right: 0; max-height: 60dvh; overflow: auto; border-top: 1px solid var(--line-strong); border-radius: var(--radius-lg) var(--radius-lg) 0 0; background: rgba(13,13,13,.98); box-shadow: var(--shadow-lg); backdrop-filter: blur(28px); padding-bottom: env(safe-area-inset-bottom); animation: sheet-up var(--motion-normal) var(--ease-out); }
  .episode-sheet { max-height: 65dvh; }
  .sheet-handle { width: 36px; height: 4px; margin: 8px auto 4px; border-radius: 999px; background: var(--line-strong); }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 18px 10px; }
  .sheet-head .eyebrow { color: var(--muted); }
  .close-button { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted); background: rgba(255,255,255,.04); cursor: pointer; }
  .sheet-list { display: grid; gap: 4px; padding: 0 12px 14px; }
  .sheet-option { display: flex; align-items: center; gap: 11px; min-height: 52px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 7px 12px; color: var(--ink-soft); background: transparent; cursor: pointer; text-align: left; }
  .sheet-option:hover, .sheet-option:focus-visible, .sheet-option.active { border-color: var(--line-strong); background: var(--accent-soft); }
  .sheet-option strong, .sheet-option small { display: block; }
  .sheet-option strong { color: var(--ink); font-size: .72rem; }
  .sheet-option small { margin-top: 4px; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  .option-mark { display: grid; flex: 0 0 24px; place-items: center; width: 24px; height: 24px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent); }
  .option-mark > span { width: 5px; height: 5px; border-radius: 50%; background: var(--muted-deep); }
  .episode-number { flex: 0 0 28px; color: var(--accent); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .65rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
  /* Desktop: source/episode sheets become centered popovers */
  @media (min-width: 769px) {
    .source-sheet, .episode-sheet { bottom: auto; top: 50%; left: 50%; right: auto; transform: translate(-50%, -50%); width: min(400px, calc(100% - 48px)); max-height: min(70dvh, 560px); border-radius: var(--radius-lg); border: 1px solid var(--line-strong); animation: none; }
    .episode-sheet { width: min(440px, calc(100% - 48px)); }
  }
  /* Mobile: compact header, no label text */
  @media (max-width: 640px) {
    .player-header { padding: calc(8px + env(safe-area-inset-top)) 8px 8px; }
    .header-title-row { gap: 8px; min-height: 38px; }
    .header-button span { display: none; }
    .header-button { min-width: 38px; min-height: 38px; padding: 0; }
    .header-title strong { max-width: 52vw; font-size: .72rem; }
    .header-title span { max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stage-wrap :global(.viewport), .stage-wrap :global(.viewport.embed) { width: 100%; max-height: none; border-radius: 0; }
    .message-card { bottom: 50%; flex-wrap: wrap; }
    .message-actions { width: 100%; margin-left: 46px; }
    .embed-shell-controls { padding: 6px 8px; }
    .shell-source-name { font-size: .62rem; }
  }
  /* Landscape phone */
  @media (orientation: landscape) and (max-height: 560px) {
    .player-header { padding-top: 6px; padding-bottom: 6px; }
    .header-title-row { min-height: 32px; gap: 8px; }
    .header-button { min-height: 32px; min-width: 34px; padding: 0 8px; }
    .header-button span { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .loading-ring, :global(.spin) { animation: none; } .header-button, .bottom-bar, .player-shell.landscape-mode .player-header { transition: none; } .source-sheet, .episode-sheet { animation: none; } }
</style>
