<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Clapperboard, Info, ListVideo, Maximize2, RotateCcw, Settings2, ShieldCheck, ShieldOff, X } from 'lucide-svelte';
  import PlayerControls from './PlayerControls.svelte';
  import PlayerViewport from './PlayerViewport.svelte';
  import MaveroStreamCard from './MaveroStreamCard.svelte';
  import type { PlayerContentContext, PlayerEpisode, PlayerEpisodeTarget, PlayerInternalQualityOption, PlayerPlaybackState, PlayerProgressEvent, PlayerQualityOption, PlayerSource, PlayerSourceOption } from '$lib/shared/player';
  import { PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';
  import { MAVERO_PLAYER_SOURCE_ID, MAVERO_PLAYER_SOURCE_NAME } from '$lib/shared/mavero-player';
  import { sourceIsExpired, isEmbedOriginAllowed, isPlayablePlayerSource } from '$lib/shared/player-guards';
  import { adjacentEpisode, adjacentSource, clampSeek } from '$lib/shared/player-state';
  // Phase 6: MAVERO Player stream presentation (addon grouping, labels,
  // dedupe, current-stream identity) — pure helpers, no second source model.
  import { dedupeMaveroStreams, groupMaveroStreams, isMaveroAggregateSource, maveroStreamFormatLabel, maveroStreamQualityLabel } from '$lib/client/player/mavero-streams';
  // Phase 9: robust pending-seek state machine (streaming VOD seeking) — pure,
  // unit-tested; the shell feeds it media snapshots and applies the result.
  import { applyPendingSeek, capturePendingSeek, createPendingSeek, type PendingSeekState } from '$lib/client/player/pending-seek';

  export let source: PlayerSource | null = null;
  export let content: PlayerContentContext;
  export let initialProgress = 0;
  export let sourceOptions: PlayerSourceOption[] = [];
  export let episodes: PlayerEpisode[] = [];
  export let currentEpisode: PlayerEpisodeTarget | null = null;
  export let onProgress: (event: PlayerProgressEvent) => void = () => {};
  export let onSourceChange: (sourceId: string, variant?: string) => void = () => {};
  export let onEpisodeChange: (target: PlayerEpisodeTarget) => void = () => {};
  export let onClose: () => void = () => {};
  export let onDetails: () => void = () => {};
  export let onIframeReady: (iframe: HTMLIFrameElement) => void = () => {};
  // Phase 6 audit fix 2: embed playback event sink. The watch route sets this
  // prop to { type, _seq, sourceId } whenever the PlaybackManager receives a
  // normalized provider playback event from an embed adapter. PlayerShell
  // watches this prop reactively and acquires/releases the Wake Lock
  // accordingly. The `sourceId` field lets PlayerShell reject stale events
  // from an old source after a source switch — the PlaybackManager has its
  // own session guards, but a stale postMessage could still arrive between
  // the source switch and the adapter destroy. The `embedPlaying` state is
  // driven ONLY by these normalized events (never by iframe DOM load), so
  // black-box embed providers that never post play/pause events never
  // acquire a wake lock — which is correct (iframe load ≠ actual playback).
  export let embedPlaybackEvent: { type: 'play' | 'pause' | 'ended'; _seq?: number; sourceId?: string } | null = null;
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
  let landscapeToggleInFlight = false;
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
  // Phase 9: the pending seek is a STATE MACHINE, not a bare number. It is
  // retained until the media has a usable seekable range/duration (adaptive VOD
  // readiness), retried from bounded media lifecycle events, and stamped
  // with a monotonic token so a stale seek from a previous source can never
  // land on a newly selected stream. See `pending-seek.ts`.
  let pendingSeekState: PendingSeekState = createPendingSeek(initialProgress, Date.now());
  let lastProgressReport = 0;
  let sourceIdentity = '';
  let sandboxEnabled = true;
  let sandboxSourceIdentity = '';
  // Phase 6: episode identity tracker for the episode-switch reactive block.
  let episodeIdentity = '';
  // Phase 6 audit fix: sequence counter for embed playback events. Used by
  // the reactive watcher to detect new events even when the type is the same.
  let lastEmbedPlaybackSeq = 0;
  // Phase 9 fix: removed landscape controls hide timer — landscape header is always visible.
  // Phase 8: embed iframe load timeout. If the iframe doesn't fire `on:load`
  // within this window, we transition to the error state instead of leaving
  // the player stuck in `embed-loading` indefinitely.
  const EMBED_LOAD_TIMEOUT_MS = 18000;
  let embedLoadTimer: ReturnType<typeof setTimeout> | undefined;
  // Phase 8: identity guard for the embed load timeout. A stale timeout from
  // source A must NOT affect source B. This is checked in the timeout
  // callback — if the source identity has changed, the timeout is a no-op.
  let embedLoadTimeoutSourceId = '';

  // Phase 6: Wake Lock state — shell-local, never exposed as a provider capability.
  let wakeLockSupported = false;
  let wakeLockSentinel: WakeLockSentinelHandle | null = null;
  let wasPlayingBeforeHidden = false;
  // Phase 6 audit fix: request-generation mechanism. Each acquireWakeLock()
  // call increments wakeLockRequestId and captures the new value. After the
  // async request resolves, we verify the current request id still matches.
  // If releaseWakeLock() or any other invalidating event fired during the
  // await, the id will have changed (or destroyed will be true), and the
  // resolved sentinel is released immediately rather than installed.
  let wakeLockRequestId = 0;
  let wakeLockDestroyed = false;
  // Phase 6 audit fix 2: separate embed playback state. Driven ONLY by
  // normalized provider play/pause/ended events (NOT by iframe DOM load).
  // Used by the visibility handler to decide whether to re-acquire the wake
  // lock when the document becomes visible again. The direct `playing` flag
  // cannot be reused for embed sources because handleEmbedLoad sets state to
  // 'playing' but that does not reflect actual provider playback.
  let embedPlaying = false;
  // Phase 6 audit fix 2: the sourceId that the current embedPlaybackEvent
  // was emitted for. Used to reject stale events from an old source after a
  // source switch. Set in the source-switch reactive block, checked in
  // handleEmbedPlaybackEvent.
  let embedPlaybackSourceId = '';

  // Phase 6: Media Session state — direct playback only.
  let mediaSessionSupported = false;
  let mediaSessionActive = false;

  // Phase 8: focus management for source/episode/streams sheets. When a
  // sheet opens, we save the trigger element so we can restore focus when it
  // closes.
  let sourceSheetTrigger: HTMLElement | null = null;
  let episodeSheetTrigger: HTMLElement | null = null;
  // Phase 9: the dedicated MAVERO streams sheet (separate from the source
  // sheet — provider selection and stream selection are different acts).
  let streamsSheetOpen = false;
  let streamsSheetTrigger: HTMLElement | null = null;
  // True when the streams sheet was entered FROM the source sheet, so its
  // back button returns there (GOAL 16 flow) instead of closing outright.
  let streamsSheetReturnToSource = false;
  // Phase 9: stream failure isolation — URLs that failed playback in THIS
  // session. A failed stream never removes any other stream; its card shows
  // a failed marker and every other card stays selectable.
  let failedStreamUrls: string[] = [];

  // Phase 6: internal quality state of the ACTIVE engine-driven streaming source
  // (AUTO + manifest levels). Populated ONLY by the viewport's generic
  // `enginequality` events — the shell never sees engine-library types. `null` when the
  // current playback is not engine-driven (MP4, native streaming, embeds) —
  // the quality UI then falls back to the existing per-stream select.
  let engineQuality: { options: PlayerInternalQualityOption[]; selected: string | null } | null = null;

  // Phase 6: local WakeLockSentinel type. lib.dom.d.ts may not include this on
  // older TS versions, so we declare the minimal shape we use, matching the
  // existing OrientationController optional-method pattern.
  type WakeLockSentinelHandle = {
    released?: boolean;
    addEventListener?: (type: 'release', listener: () => void) => void;
    removeEventListener?: (type: 'release', listener: () => void) => void;
    release?: () => Promise<void>;
  };
  type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelHandle> } };
  type MediaSessionNavigator = Navigator & { mediaSession?: { playbackState?: string; metadata?: MediaMetadata | null; setActionHandler?: (action: string, handler: (() => void) | null) => void; setPositionState?: (state: { duration?: number; playbackRate?: number; position?: number }) => void } };

  $: qualities = source?.qualities ?? [];
  $: subtitles = source?.subtitles ?? [];
  $: selectedQualityOption = qualities.find((quality) => quality.url === selectedQuality) as PlayerQualityOption | undefined;
  $: mediaUrl = selectedQualityOption?.url ?? source?.url ?? null;
  // Phase 6: MAVERO Player addon-stream presentation — derived ONLY when the
  // active source IS the aggregate MAVERO Player source. Provider sources
  // never enter this path (their UX is untouched), the resolver's
  // deterministic order is preserved, and duplicates are removed at the
  // presentation layer by stable URL identity.
  $: maveroStreams = isMaveroAggregateSource(source) ? dedupeMaveroStreams(qualities) : [];
  $: maveroStreamGroups = groupMaveroStreams(maveroStreams);
  // Phase 9: the MAVERO Player source option (provider selection) — the
  // source sheet shows ONE "X Streams →" entry point for it.
  $: maveroSourceOption = sourceOptions.find((option) => option.id === MAVERO_PLAYER_SOURCE_ID);
  // Phase 9: per-stream subtitle tracks — the SELECTED stream's addon-
  // provided tracks win, the aggregate source's tracks are the fallback.
  $: effectiveSubtitles = selectedQualityOption?.subtitles?.length ? selectedQualityOption.subtitles : source?.subtitles ?? [];
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
  // Phase 6 audit fix: reactive watcher for embed playback events. The watch
  // route pushes { type, _seq } into the embedPlaybackEvent prop whenever the
  // PlaybackManager receives a normalized provider play/pause/ended event.
  // The _seq counter forces Svelte to re-trigger the reactive block even if
  // the same event type fires twice in a row. PlayerShell acquires/releases
  // the Wake Lock conservatively — only when a reliable provider event arrives.
  $: if (embedPlaybackEvent?._seq && embedPlaybackEvent._seq !== lastEmbedPlaybackSeq) {
    lastEmbedPlaybackSeq = embedPlaybackEvent._seq;
    handleEmbedPlaybackEvent(embedPlaybackEvent);
  }
  $: if (source?.sourceId && source.sourceId !== sourceIdentity) {
    sourceIdentity = source.sourceId;
    // Phase 9: capture (re-stamp) the pending seek for the NEW source —
    // position-preserving switches keep working, and the new token makes
    // any older capture inapplicable.
    capturePendingSeek(pendingSeekState, currentTime, Date.now());
    errorMessage = '';
    playing = false;
    state = source.type === 'embed' ? 'embed-loading' : 'preparing';
    // Phase 9: failure markers are per-source-session — a stream that failed
    // for a previous source/aggregate must not mark the new one.
    failedStreamUrls = [];
    // Phase 6: a genuinely new source session starts with the engine's
    // internal quality state cleared (the viewport re-dispatches fresh
    // levels once the new manifest is parsed). The AUTO default never
    // leaks a manual selection across sources.
    engineQuality = null;
    // Phase 8: clear any previous embed load timeout, then start a new one
    // for embed sources. Direct sources don't need this — the <video> element
    // fires `error` on failure.
    clearEmbedLoadTimeout();
    if (source.type === 'embed') startEmbedLoadTimeout(source.sourceId);
    // Phase 6 audit fix 2: reset embed playback state on source switch. The
    // new source's embedPlaying will be set only if a reliable normalized
    // 'play' event arrives. Also stamp the sourceId so stale events from
    // the old source can be rejected in handleEmbedPlaybackEvent.
    embedPlaying = false;
    embedPlaybackSourceId = source.sourceId;
    // Phase 6: release wake lock + clear Media Session on source switch.
    // Wake lock is re-acquired when the new source starts playing (handlePlay
    // for direct, handleEmbedPlaybackEvent for embeds). Media Session metadata
    // is re-set in handleLoadedMetadata.
    void releaseWakeLock();
    clearMediaSession();
    // Phase 6: exit PiP if the active PiP element was Mavero's video. This
    // prevents the PiP window from showing stale video after a source switch.
    if (document.pictureInPictureElement === videoElement) {
      try { void document.exitPictureInPicture?.(); } catch { /* already exited */ }
    }
  }
  // Phase 6: episode switch cleanup. PlayerShell stays mounted across episode
  // changes (only props change), so we must release wake lock + clear Media
  // Session + exit PiP here. The new episode's source will re-acquire them.
  $: if (currentEpisode && `${currentEpisode.season}:${currentEpisode.episode}` !== episodeIdentity) {
    episodeIdentity = `${currentEpisode.season}:${currentEpisode.episode}`;
    // Phase 8: clear embed load timeout on episode switch — the new episode
    // will start its own timeout when its source loads.
    clearEmbedLoadTimeout();
    // Phase 9: episode switch resets the per-session failure markers too.
    failedStreamUrls = [];
    // Phase 6 audit fix 2: reset embed playback state on episode switch.
    embedPlaying = false;
    if (source?.sourceId) embedPlaybackSourceId = source.sourceId;
    void releaseWakeLock();
    clearMediaSession();
    if (document.pictureInPictureElement === videoElement) {
      try { void document.exitPictureInPicture?.(); } catch { /* already exited */ }
    }
  }

  // Phase 6 audit fix: PiP events fire on the HTMLVideoElement, NOT on
  // document. The handler and listener attachment are at the top level of the
  // instance script (NOT inside onMount) so that the reactive block
  // `$: attachPipListeners(videoElement)` can track the actual videoElement
  // lifecycle. This correctly handles:
  //   - embed → direct (videoElement goes from undefined → <video>)
  //   - direct → embed (videoElement goes from <video> → undefined)
  //   - embed → direct → embed → direct (no duplicate listeners)
  // The reactive block detaches from the old element and attaches to the
  // new element whenever the identity of videoElement changes.
  let lastPipVideoElement: HTMLVideoElement | undefined = undefined;
  function handlePictureInPicture() { pictureInPicture = document.pictureInPictureElement === videoElement; }
  function attachPipListeners(current: HTMLVideoElement | undefined) {
    if (current === lastPipVideoElement) return; // no change — avoid duplicates
    // Detach from the previous video element (if any).
    if (lastPipVideoElement) {
      try {
        lastPipVideoElement.removeEventListener('enterpictureinpicture', handlePictureInPicture);
        lastPipVideoElement.removeEventListener('leavepictureinpicture', handlePictureInPicture);
      } catch { /* already removed */ }
    }
    // Attach to the new video element (if any).
    if (current) {
      current.addEventListener('enterpictureinpicture', handlePictureInPicture);
      current.addEventListener('leavepictureinpicture', handlePictureInPicture);
      // Sync active state immediately — the new video might already be in PiP.
      pictureInPicture = document.pictureInPictureElement === current;
    } else {
      pictureInPicture = false;
    }
    lastPipVideoElement = current;
  }
  // Reactive attachment: runs whenever videoElement identity changes.
  $: attachPipListeners(videoElement);
  function detachPictureInPictureListeners() {
    if (lastPipVideoElement) {
      try {
        lastPipVideoElement.removeEventListener('enterpictureinpicture', handlePictureInPicture);
        lastPipVideoElement.removeEventListener('leavepictureinpicture', handlePictureInPicture);
      } catch { /* already removed */ }
      lastPipVideoElement = undefined;
    }
  }

  onMount(() => {
    pictureInPictureSupported = Boolean(document.pictureInPictureEnabled && videoElement && 'requestPictureInPicture' in videoElement);
    // Phase 6: detect Wake Lock + Media Session support at mount, matching the
    // existing pictureInPictureSupported pattern (Boolean coercion, no try/catch,
    // optional chaining on every API call).
    wakeLockSupported = Boolean('wakeLock' in navigator && (navigator as WakeLockNavigator).wakeLock?.request);
    mediaSessionSupported = Boolean('mediaSession' in navigator && (navigator as MediaSessionNavigator).mediaSession);
    // Phase 6: register Media Session action handlers for DIRECT playback only.
    // Embed sources cannot be commanded reliably (except CineSrc, but the
    // postMessage round-trip makes Media Session state updates unreliable).
    if (mediaSessionSupported) registerMediaSessionHandlers();
    const handleFullscreen = () => {
      fullscreen = document.fullscreenElement === playerRoot;
      if (!fullscreen && landscapeMode) {
        // Phase 6: browser-initiated fullscreen exit (Esc / F11 / navigation)
        // must release the orientation lock explicitly. The Screen Orientation
        // API spec says the browser auto-releases the lock when the document
        // exits fullscreen, but some browsers leave a stale lock — calling
        // unlock() is safe (it's a no-op if the lock was already released).
        try { orientationController()?.unlock?.(); } catch { /* unsupported */ }
        landscapeMode = false;
        revealControls();
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      // Phase 8: sheet focus trap + Escape takes priority over player shortcuts.
      if (sourceMenuOpen || episodeMenuOpen || streamsSheetOpen) {
        handleSheetKeydown(event);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, button, [contenteditable="true"]')) return;
      if (source?.type !== 'direct') return;
      if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); void togglePlay(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-10); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(10); }
      else if (event.key.toLowerCase() === 'm') { event.preventDefault(); toggleMute(); }
      else if (event.key.toLowerCase() === 'f') { event.preventDefault(); void toggleFullscreen(); }
      else if (event.key === 'Escape') { sourceMenuOpen = false; episodeMenuOpen = false; streamsSheetOpen = false; }
    };
    const showControls = () => {
      controlsVisible = true;
      if (hideTimer) clearTimeout(hideTimer);
      if (playing && !landscapeMode) hideTimer = setTimeout(() => { controlsVisible = false; }, 2600);
    };
    document.addEventListener('fullscreenchange', handleFullscreen);
    window.addEventListener('keydown', handleKeydown);
    playerRoot?.addEventListener('pointermove', showControls);
    playerRoot?.addEventListener('touchstart', showControls, { passive: true });
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      // Phase 8: clear embed load timeout on destroy.
      clearEmbedLoadTimeout();
      document.removeEventListener('fullscreenchange', handleFullscreen);
      detachPictureInPictureListeners();
      window.removeEventListener('keydown', handleKeydown);
      playerRoot?.removeEventListener('pointermove', showControls);
      playerRoot?.removeEventListener('touchstart', showControls);
      // Phase 6: explicit teardown of shell-level playback features. The browser
      // auto-exits fullscreen/PiP when playerRoot leaves the DOM, but explicit
      // calls are deterministic and prevent stale state across SPA navigation.
      if (document.pictureInPictureElement === videoElement) { try { void document.exitPictureInPicture?.(); } catch { /* already exited */ } }
      if (document.fullscreenElement === playerRoot) { try { void document.exitFullscreen?.(); } catch { /* already exited */ } }
      // Phase 6 audit fix: set the destroyed flag BEFORE releaseWakeLock() so
      // any in-flight acquireWakeLock() request that resolves after this
      // cleanup will see wakeLockDestroyed === true and release its sentinel
      // immediately instead of installing a stale wake lock.
      wakeLockDestroyed = true;
      releaseWakeLock();
      clearMediaSession();
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
    // Phase 9: attempt the pending seek, but NEVER discard it here. For streaming
    // VOD the seekable range/duration may not be final at loadedmetadata —
    // the controller retains the target until a range actually covers it,
    // and the durationchange/loadeddata/canplay/progress handlers retry.
    applyPendingSeekToElement();
    // Phase 6: set Media Session metadata + initial position state once the
    // direct source has loaded. Safe to call for embed sources too —
    // setupMediaSession is a no-op when mediaSessionSupported is false.
    setupMediaSession();
    syncMediaSessionPositionState();
  }

  // ----- Phase 9: reliable pending-seek application -----
  //
  // The pending seek survives `loadedmetadata` and is retried from the
  // media lifecycle events the viewport now forwards (durationchange,
  // loadeddata, canplay, progress) — event-driven, no timers, bounded by
  // the controller's attempt cap + wall-clock window (no infinite loops).
  // The DOM write happens ONLY in this shell (the controller is pure).

  function applyPendingSeekToElement() {
    if (!videoElement) return;
    const applied = applyPendingSeek(
      pendingSeekState,
      { readyState: videoElement.readyState, duration: videoElement.duration, seekable: videoElement.seekable },
      Date.now(),
    );
    if (applied === null) return;
    try {
      videoElement.currentTime = applied;
      currentTime = applied;
    } catch {
      // The element rejected the write (rare teardown race) — the target is
      // already cleared; a user seek remains fully functional.
    }
  }

  /** Retry sink for durationchange/loadeddata/canplay/progress. */
  function handleSeekOpportunity() {
    if (!pendingSeekState.token) return;
    applyPendingSeekToElement();
  }

  function handleTimeUpdate(event: CustomEvent<{ currentTime: number; duration: number }>) {
    currentTime = event.detail.currentTime;
    duration = event.detail.duration || duration;
    if (videoElement?.buffered.length) buffered = videoElement.buffered.end(videoElement.buffered.length - 1);
    if (currentTime - lastProgressReport >= 5) {
      lastProgressReport = currentTime;
      emitProgress('progress');
    }
    // Phase 6: keep Media Session position state in sync. setPositionState is
    // only called for direct sources (mediaSessionActive gate) and only when
    // values are finite/positive. Called on every timeupdate (throttled by the
    // 5-second progress gate above is too coarse for position state — the OS
    // media controls should update more frequently).
    syncMediaSessionPositionState();
  }

  function handlePlay() {
    playing = true;
    state = 'playing';
    errorMessage = '';
    revealControls();
    // Phase 6: acquire wake lock when playback starts. Safe for both direct
    // and embed sources — for embeds, `state === 'playing'` is set by
    // handleEmbedLoad, and the wake lock keeps the screen awake while the
    // provider plays inside the iframe.
    acquireWakeLock();
    syncMediaSessionPlaybackState('playing');
  }

  function handlePause() {
    playing = false;
    if (state !== 'completed') state = 'paused';
    emitProgress('pause');
    revealControls();
    // Phase 6: release wake lock on pause. Wake Lock must NOT remain active
    // indefinitely while playback is paused.
    releaseWakeLock();
    syncMediaSessionPlaybackState('paused');
  }

  function handleWaiting() { state = 'buffering'; }
  function handlePlaying() { state = 'playing'; errorMessage = ''; }
  function handleSeeking() { state = 'seeking'; }
  function handleSeeked() { state = playing ? 'playing' : 'paused'; }
  function handleEnded() {
    playing = false;
    state = 'completed';
    emitProgress('ended');
    revealControls();
    // Phase 6: release wake lock on end.
    releaseWakeLock();
    syncMediaSessionPlaybackState('paused');
  }
  // Phase 9: stream failure isolation. Inside the MAVERO aggregate the
  // failed URL is marked (its card shows a failed marker in the streams
  // sheet) while every other stream stays available. The message names the
  // realistic browser-compatibility causes without exposing internals —
  // no URLs, no stack, no addon detail.
  const MAVERO_STREAM_FAILURE_MESSAGE =
    'This stream could not be played. It may use a format your browser cannot play (for example MKV or HEVC), or its source may be expired or unavailable. Try another stream.';

  function handleMediaError() {
    playing = false;
    state = 'error';
    if (isMaveroAggregateSource(source) && mediaUrl) {
      failedStreamUrls = failedStreamUrls.includes(mediaUrl) ? failedStreamUrls : [...failedStreamUrls, mediaUrl];
      errorMessage = MAVERO_STREAM_FAILURE_MESSAGE;
    } else {
      errorMessage = 'Playback could not be started. Try again or choose another source.';
    }
    revealControls();
    // Phase 6: release wake lock on error.
    releaseWakeLock();
    syncMediaSessionPlaybackState('paused');
  }
  function handleEmbedLoad() {
    state = 'playing';
    errorMessage = '';
    // Phase 8: the iframe loaded successfully — clear the load timeout so
    // it cannot fire and override the 'playing' state.
    clearEmbedLoadTimeout();
    // Phase 3 fix: forward the iframe element ref to the watch route so
    // provider adapters (CineSrc) can post commands to
    // iframe.contentWindow.postMessage(payload, origin) — the documented
    // CineSrc API target. Without this ref, commands cannot reach the
    // provider's player.
    if (iframeElement) onIframeReady(iframeElement);
    // Phase 6 audit fix: do NOT acquire the wake lock here. iframe load only
    // means the provider's player UI is displayed — it does NOT mean the
    // user has pressed Play or that actual playback has started. Wake Lock
    // is acquired only when a reliable 'play' event arrives from the provider
    // via the onEmbedPlaybackEvent callback (wired by the watch route to
    // manager.onEvent). For black-box embed providers that never post
    // play/pause events, the wake lock is never acquired — which is the
    // correct conservative behavior.
    // Media Session playbackState is synced here only to reflect the
    // shell-level 'embed-loading → playing' state transition; this does not
    // claim the provider is actually playing audio/video.
    syncMediaSessionPlaybackState('playing');
  }

  // Phase 6 audit fix: handle normalized embed playback events forwarded by
  // the watch route from the PlaybackManager. Only these events (not iframe
  // load) indicate actual provider playback state. Used to acquire/release
  // the wake lock conservatively — if the provider never posts these events,
  // no wake lock is acquired. Also maintains the `embedPlaying` state which
  // the visibility handler uses to decide whether to re-acquire the wake lock
  // when the document becomes visible again.
  function handleEmbedPlaybackEvent(event: { type: 'play' | 'pause' | 'ended'; sourceId?: string }) {
    if (source?.type !== 'embed') return;
    // Phase 6 audit fix 2: reject stale events from an old source. The watch
    // route stamps the sourceId at emit time. If a source switch happened
    // between emit and this reactive handler firing, the event's sourceId
    // will not match the current embedPlaybackSourceId. This is a safety net
    // — the PlaybackManager already has session guards — but it prevents a
    // stale postMessage from activating the wake lock for the wrong source.
    if (event.sourceId && embedPlaybackSourceId && event.sourceId !== embedPlaybackSourceId) return;
    if (event.type === 'play') {
      embedPlaying = true;
      acquireWakeLock();
    } else if (event.type === 'pause' || event.type === 'ended') {
      embedPlaying = false;
      releaseWakeLock();
    }
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
  function setPlaybackRate(value: number) {
    playbackRate = value;
    if (videoElement) videoElement.playbackRate = value;
    // Phase 6: position state includes playbackRate — re-sync on change.
    syncMediaSessionPositionState();
  }

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
    // Phase 9: capture (re-stamp) the position for the next stream — the
    // token invalidates any earlier pending capture.
    capturePendingSeek(pendingSeekState, currentTime, Date.now());
    selectedQuality = url;
    state = 'preparing';
    playing = false;
  }

  // ----- Phase 6: MAVERO Player stream & internal-quality selection -----

  /**
   * Viewport `enginequality` event sink: the ONLY writer of `engineQuality`.
   * An empty options list means the engine is gone (source switch to
   * MP4/native, teardown) — the quality UI falls back to the stream list.
   */
  function handleEngineQuality(event: CustomEvent<{ options: PlayerInternalQualityOption[]; selected: string | null }>) {
    engineQuality = event.detail.options.length ? event.detail : null;
  }

  /**
   * Internal quality selection (AUTO or one manifest level). Delegates to
   * the viewport's generic controller — the engine is NOT recreated, the
   * switch is seamless, and playback position is untouched.
   */
  function setInternalQuality(id: string) {
    viewport?.selectEngineQuality(id);
  }

  /**
   * Switch to another resolved addon stream WITHIN the same MAVERO Player
   * source. The player view NEVER navigates away: this rides the existing
   * quality-switch mechanism (`setQuality`) which captures the position
   * into the pending-seek controller, keeps the player mounted and lets the
   * existing generation/race protection invalidate the previous stream.
   * Selecting the current stream is a no-op (sheet just closes).
   */
  function selectMaveroStream(stream: PlayerQualityOption) {
    closeStreamsSheet();
    if (!stream.url || stream.url === mediaUrl) return;
    setQuality(stream.url);
  }

  type OrientationController = ScreenOrientation & { lock?: (value: 'landscape' | 'portrait' | 'any' | 'natural' | 'landscape-primary' | 'landscape-secondary' | 'portrait-primary' | 'portrait-secondary') => Promise<void>; unlock?: () => void };

  function orientationController() {
    return screen.orientation as OrientationController;
  }

  async function toggleLandscape() {
    // Phase 6: rapid double-toggle guard. Without this, two rapid taps could
    // both read the same `landscapeMode` value, both await requestFullscreen(),
    // and the second await could resolve after the first exit has already
    // cleared landscapeMode — producing inconsistent state.
    if (landscapeToggleInFlight) return;
    const entering = !landscapeMode;
    revealControls();
    landscapeToggleInFlight = true;
    try {
      const orientation = orientationController();
      if (entering) {
        // Fullscreen belongs to MAVERO's shell. The provider iframe is never invoked or manipulated.
        await playerRoot?.requestFullscreen?.();
        try { await orientation?.lock?.('landscape'); } catch { /* device/browser declined; fullscreen layout remains active */ }
        landscapeMode = true;
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = undefined;
      } else {
        try { orientation?.unlock?.(); } catch { /* unsupported */ }
        landscapeMode = false;
        if (document.fullscreenElement === playerRoot) await document.exitFullscreen?.();
        revealControls();
      }
    } catch {
      landscapeMode = false;
      errorMessage = 'Landscape mode is not available in this browser.';
    } finally {
      landscapeToggleInFlight = false;
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

  function chooseSource(sourceId: string, variant?: string) {
    // Phase 8: closeSourceSheet restores focus to the trigger.
    closeSourceSheet();
    // Phase 7F (MegaPlay): only fire onSourceChange when the source
    // OR the variant actually changed. Clicking the active variant
    // button should be a no-op (no re-resolution).
    const sourceChanged = sourceId !== source?.sourceId;
    const variantChanged = variant !== undefined && variant !== source?.metadata?.selectedVariant;
    if (sourceChanged || variantChanged) {
      state = 'switching-source';
      errorMessage = '';
      onSourceChange(sourceId, variant);
    }
  }

  function chooseAdjacentSource(delta: -1 | 1) {
    const nextId = adjacentSource(sourceOptions, source?.sourceId, delta);
    if (nextId) chooseSource(nextId);
  }

  function chooseEpisode(target: PlayerEpisodeTarget) {
    // Phase 8: closeEpisodeSheet restores focus to the trigger.
    closeEpisodeSheet();
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
    // Phase 8: clear any pending embed load timeout before retrying.
    clearEmbedLoadTimeout();
    if (source?.sourceId) {
      state = 'switching-source';
      onSourceChange(source.sourceId);
      return;
    }
    if (videoElement) { videoElement.load(); capturePendingSeek(pendingSeekState, currentTime, Date.now()); }
    state = source?.type === 'embed' ? 'embed-loading' : 'preparing';
    // Phase 8: if retrying an embed, start the timeout again.
    if (state === 'embed-loading' && source?.sourceId) startEmbedLoadTimeout(source.sourceId);
  }

  // ----- Phase 8: Embed load timeout -----
  //
  // If an embed iframe never fires `on:load`, the player would stay in
  // `embed-loading` indefinitely. This timeout transitions to the error
  // state after EMBED_LOAD_TIMEOUT_MS (18s) — conservative enough to not
  // interrupt slow legitimate providers.
  //
  // Stale-source protection: the timeout captures the sourceId at start
  // time. When it fires, it checks that the current sourceIdentity still
  // matches. If the user switched sources while the timeout was pending,
  // the timeout is a no-op — the new source's timeout is managed by its
  // own startEmbedLoadTimeout call.

  function startEmbedLoadTimeout(sourceId: string) {
    clearEmbedLoadTimeout();
    // Phase 8 bug fix: capture the sourceId in a local const so the timeout
    // callback validates against the identity that belonged to THIS PARTICULAR
    // timer invocation — NOT the mutable `embedLoadTimeoutSourceId` which
    // may have been overwritten by a newer source's startEmbedLoadTimeout call.
    // Without this capture, a stale queued callback from source A could read
    // the current mutable value ('B') after source B started, and incorrectly
    // transition source B to error.
    const timeoutSourceId = sourceId;
    embedLoadTimeoutSourceId = timeoutSourceId;
    embedLoadTimer = setTimeout(() => {
      embedLoadTimer = undefined;
      // Stale-source guard: compare against the captured `timeoutSourceId`
      // (immutable per-timer), NOT the mutable `embedLoadTimeoutSourceId`.
      // If the user switched to a different source while this timeout was
      // pending, sourceIdentity will not match timeoutSourceId.
      if (sourceIdentity !== timeoutSourceId) return;
      // Only transition to error if we're still in the embed-loading state.
      // If handleEmbedLoad already fired, state will be 'playing' and we
      // must NOT override it.
      if (state !== 'embed-loading') return;
      state = 'error';
      errorMessage = 'This source is taking too long to load.';
      revealControls();
    }, EMBED_LOAD_TIMEOUT_MS);
  }

  function clearEmbedLoadTimeout() {
    if (embedLoadTimer) {
      clearTimeout(embedLoadTimer);
      embedLoadTimer = undefined;
    }
    embedLoadTimeoutSourceId = '';
  }

  // ----- Phase 8: Focus management for source/episode sheets -----
  //
  // When a sheet opens, focus moves into the sheet (close button preferred).
  // When it closes (via close button, backdrop, Escape, or selection), focus
  // restores to the trigger element if it's still connected to the DOM.
  //
  // Tab/Shift+Tab is trapped within the active sheet so focus cannot escape
  // behind the modal backdrop. Only one sheet can be open at a time.

  function openSourceSheet(trigger: HTMLElement) {
    sourceSheetTrigger = trigger;
    episodeMenuOpen = false; // only one sheet at a time
    streamsSheetOpen = false;
    sourceMenuOpen = true;
    // Focus the close button after Svelte renders the sheet.
    setTimeout(() => focusSheetCloseButton('source'), 0);
  }

  function openEpisodeSheet(trigger: HTMLElement) {
    episodeSheetTrigger = trigger;
    sourceMenuOpen = false; // only one sheet at a time
    streamsSheetOpen = false;
    episodeMenuOpen = true;
    setTimeout(() => focusSheetCloseButton('episode'), 0);
  }

  // ----- Phase 9: the dedicated MAVERO streams sheet -----
  //
  // Provider selection (source sheet) and MAVERO stream selection (this
  // sheet) are SEPARATE acts. The source sheet stays a clean provider list
  // with ONE "X Streams →" entry point; this sheet groups the streams by
  // addon and can also be opened directly while a MAVERO source plays, so
  // switching streams never forces a detour through the source sheet.

  function openStreamsSheet(trigger: HTMLElement, fromSourceSheet = false) {
    streamsSheetTrigger = trigger;
    sourceMenuOpen = false; // only one sheet at a time
    episodeMenuOpen = false;
    streamsSheetReturnToSource = fromSourceSheet;
    streamsSheetOpen = true;
    setTimeout(() => focusSheetCloseButton('streams'), 0);
  }

  function closeSourceSheet() {
    sourceMenuOpen = false;
    restoreFocus(sourceSheetTrigger);
    sourceSheetTrigger = null;
  }

  function closeStreamsSheet() {
    if (!streamsSheetOpen) return;
    streamsSheetOpen = false;
    if (streamsSheetReturnToSource) {
      // GOAL 16 back navigation: entered from the source sheet → back
      // reopens it (focus goes to its close button, not the dead trigger).
      streamsSheetReturnToSource = false;
      streamsSheetTrigger = null;
      sourceMenuOpen = true;
      setTimeout(() => focusSheetCloseButton('source'), 0);
      return;
    }
    restoreFocus(streamsSheetTrigger);
    streamsSheetTrigger = null;
  }

  function closeEpisodeSheet() {
    episodeMenuOpen = false;
    restoreFocus(episodeSheetTrigger);
    episodeSheetTrigger = null;
  }

  function restoreFocus(element: HTMLElement | null) {
    if (element instanceof HTMLElement && element.isConnected) {
      try { element.focus(); } catch { /* element not focusable */ }
    }
  }

  function focusSheetCloseButton(which: 'source' | 'episode' | 'streams') {
    const sheetClass = which === 'source' ? '.source-sheet' : which === 'episode' ? '.episode-sheet' : '.mavero-streams-sheet';
    const sheet = playerRoot?.querySelector(sheetClass);
    if (!sheet) return;
    const closeBtn = sheet.querySelector('.close-button');
    if (closeBtn instanceof HTMLElement) {
      closeBtn.focus();
      return;
    }
    // Fallback: focus the first focusable element in the sheet.
    const firstFocusable = sheet.querySelector('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (firstFocusable instanceof HTMLElement) firstFocusable.focus();
  }

  function handleSheetKeydown(event: KeyboardEvent) {
    // Phase 8/9: focus trap + Escape for all three sheets. Only active when
    // a sheet is open.
    if (!sourceMenuOpen && !episodeMenuOpen && !streamsSheetOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (sourceMenuOpen) closeSourceSheet();
      else if (episodeMenuOpen) closeEpisodeSheet();
      else if (streamsSheetOpen) closeStreamsSheet();
      return;
    }
    if (event.key !== 'Tab') return;
    const activeSheet = sourceMenuOpen
      ? playerRoot?.querySelector('.source-sheet')
      : episodeMenuOpen
        ? playerRoot?.querySelector('.episode-sheet')
        : streamsSheetOpen
          ? playerRoot?.querySelector('.mavero-streams-sheet')
          : null;
    if (!activeSheet) return;
    const focusables = Array.from(activeSheet.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
    if (!focusables.length) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !activeSheet.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !activeSheet.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  // ----- Phase 6: Wake Lock -----
  //
  // Shell-local screen wake lock. Acquired while Mavero considers playback
  // to be actively playing (direct video 'play' event, or embed 'embedload'
  // event). Released on pause/end/error/source-switch/episode-switch/destroy
  // and when the document becomes hidden. Re-acquired on visibility-visible
  // if playback was still active when the document hid.
  //
  // The sentinel's `release` event is observed so that a system-initiated
  // release (e.g. OS power management) updates internal state.
  //
  // Race-condition-safe: if `request('screen')` resolves after PlayerShell
  // is destroyed, the sentinel is released immediately and no destroyed
  // component state is touched.

  async function acquireWakeLock() {
    if (!wakeLockSupported) return;
    // Don't acquire if we already hold a sentinel that hasn't been released.
    if (wakeLockSentinel && !wakeLockSentinel.released) return;
    // Phase 6 audit fix: request-generation mechanism. Capture the request id
    // at call time. After the async request resolves, verify the id is still
    // current. If releaseWakeLock() or any other invalidating event fired
    // during the await (incrementing wakeLockRequestId or setting
    // wakeLockDestroyed), the resolved sentinel is released immediately
    // rather than installed as a stale wake lock.
    const requestId = ++wakeLockRequestId;
    try {
      const nav = navigator as WakeLockNavigator;
      const sentinel = await nav.wakeLock!.request('screen');
      // Validity check after await: the request must still be current, the
      // component must not be destroyed, the document must still be visible
      // (wake lock is meaningless if hidden), and playback must still require
      // a wake lock (no newer acquire superseded this one).
      if (
        wakeLockDestroyed ||
        requestId !== wakeLockRequestId ||
        document.hidden ||
        (wakeLockSentinel && !wakeLockSentinel.released)
      ) {
        try { await sentinel?.release?.(); } catch { /* already released */ }
        return;
      }
      wakeLockSentinel = sentinel;
      try { sentinel?.addEventListener?.('release', handleWakeLockSentinelRelease); } catch { /* some browsers lack addEventListener on the sentinel */ }
    } catch {
      // Spec: rejects if document not visible, or if permission denied.
      // Silently no-op — wake lock is best-effort. Do NOT install a sentinel.
    }
  }

  function handleWakeLockSentinelRelease() {
    // The sentinel fired its `release` event (system-initiated or our own
    // release() call). Clear the local ref so acquireWakeLock() can re-acquire.
    if (wakeLockSentinel) {
      try { wakeLockSentinel.removeEventListener?.('release', handleWakeLockSentinelRelease); } catch { /* already removed */ }
    }
    wakeLockSentinel = null;
  }

  async function releaseWakeLock() {
    // Phase 6 audit fix: increment the request id so any in-flight
    // acquireWakeLock() call that resolves AFTER this release will fail
    // the validity check and release its sentinel immediately instead of
    // installing a stale wake lock.
    wakeLockRequestId++;
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    if (!sentinel) return;
    try { sentinel.removeEventListener?.('release', handleWakeLockSentinelRelease); } catch { /* already removed */ }
    try { await sentinel.release?.(); } catch { /* already released */ }
  }

  // ----- Phase 6: Media Session -----
  //
  // Media Session metadata + action handlers for DIRECT playback only.
  // Embed sources cannot be commanded reliably (except CineSrc, but the
  // postMessage round-trip makes Media Session state updates unreliable).
  //
  // Action handlers registered: play, pause, seekbackward, seekforward, seekto.
  // NOT registered: previoustrack/nexttrack (no existing chooseAdjacentEpisode
  // helper exists in the current architecture).
  //
  // setPositionState is called only when:
  //   - duration is finite and > 0
  //   - position is finite, >= 0, and <= duration
  //   - playbackRate is finite and > 0

  // Phase 6 audit fix: derive artwork MIME type from URL extension. Falls back
  // to 'image/jpeg' (the most common poster/backdrop format) when the extension
  // is unknown or missing. Avoids claiming every artwork is JPEG when the URL
  // might be PNG or WebP.
  function artworkMimeType(url: string): string {
    const lower = url.toLowerCase().split('?')[0].split('#')[0];
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.avif')) return 'image/avif';
    return 'image/jpeg'; // conservative fallback
  }

  function setupMediaSession() {
    if (!mediaSessionSupported) return;
    const nav = navigator as MediaSessionNavigator;
    const session = nav.mediaSession;
    if (!session) return;
    // Build metadata. Artwork is only included when a valid image URL exists
    // — empty URLs would create invalid artwork entries. The MIME type is
    // derived from the URL extension when possible (avoids claiming every
    // artwork is JPEG when the URL might be PNG/WebP).
    const artworkUrl = content.backdrop ?? content.poster ?? '';
    const artwork = artworkUrl ? [{ src: artworkUrl, sizes: '512x512', type: artworkMimeType(artworkUrl) }] : undefined;
    try {
      if ('MediaMetadata' in window) {
        session.metadata = new MediaMetadata({
          title: content.title,
          artist: currentEpisode?.title ?? (content.type === 'movie' ? 'Movie' : content.type === 'series' ? 'Series' : 'Anime'),
          album: 'MAVERO',
          ...(artwork ? { artwork } : {})
        });
      }
      mediaSessionActive = true;
    } catch {
      // MediaMetadata constructor may be unavailable on older Safari.
      mediaSessionActive = false;
    }
  }

  function registerMediaSessionHandlers() {
    if (!mediaSessionSupported) return;
    const nav = navigator as MediaSessionNavigator;
    const session = nav.mediaSession;
    if (!session?.setActionHandler) return;
    // Only register handlers that can be correctly implemented for DIRECT
    // playback. Embed sources do not get action handlers (caller gates this
    // by only invoking on direct sources — see handleLoadedMetadata).
    const trySet = (action: string, handler: () => void) => {
      try { session.setActionHandler!(action, handler); } catch { /* some Safari versions throw for unsupported actions */ }
    };
    trySet('play', () => { if (source?.type === 'direct' && videoElement?.paused) void videoElement.play(); });
    trySet('pause', () => { if (source?.type === 'direct' && videoElement && !videoElement.paused) videoElement.pause(); });
    trySet('seekbackward', () => seekBy(-10));
    trySet('seekforward', () => seekBy(10));
    // seekto: MediaSessionActionDetails includes seekTime / fastSeek. The handler
    // signature accepts an optional details argument; we cast through unknown
    // to avoid relying on lib.dom typings that may not be present on older TS.
    type SeekToDetails = { seekTime?: number; fastSeek?: boolean };
    const seekToHandler = (raw: unknown) => {
      const details = raw as SeekToDetails | undefined;
      if (typeof details?.seekTime === 'number' && Number.isFinite(details.seekTime)) seek(details.seekTime);
    };
    try { session.setActionHandler('seekto', seekToHandler as () => void); } catch { /* unsupported */ }
  }

  function clearMediaSession() {
    if (!mediaSessionSupported) return;
    const nav = navigator as MediaSessionNavigator;
    const session = nav.mediaSession;
    if (!session) return;
    try { session.metadata = null; } catch { /* unsupported */ }
    try { session.playbackState = 'none'; } catch { /* unsupported */ }
    // Clear action handlers. Wrapped in try/catch because browser
    // implementations differ (Safari may throw for null handler on some actions).
    const actions = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'];
    for (const action of actions) {
      try { session.setActionHandler?.(action, null); } catch { /* unsupported */ }
    }
    mediaSessionActive = false;
  }

  function syncMediaSessionPlaybackState(value: 'playing' | 'paused' | 'none') {
    if (!mediaSessionSupported || !mediaSessionActive) return;
    const nav = navigator as MediaSessionNavigator;
    try { nav.mediaSession!.playbackState = value; } catch { /* unsupported */ }
  }

  function syncMediaSessionPositionState() {
    if (!mediaSessionSupported || !mediaSessionActive) return;
    const nav = navigator as MediaSessionNavigator;
    const session = nav.mediaSession;
    if (!session?.setPositionState) return;
    // Validate per spec — invalid values throw or are silently ignored.
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (!Number.isFinite(currentTime) || currentTime < 0 || currentTime > duration) return;
    if (!Number.isFinite(playbackRate) || playbackRate <= 0) return;
    try {
      session.setPositionState({ duration, playbackRate, position: currentTime });
    } catch { /* invalid position state — silently skip */ }
  }

  // ----- Phase 6: visibility/wake-lock coordination -----
  //
  // Wake Lock spec: the sentinel auto-releases when the document becomes
  // hidden. We track whether playback was active when the document hid so we
  // can re-acquire on visibility-visible. This is invoked from the existing
  // svelte:window onvisibilitychange handler (extended below to call this).

  function handleVisibilityChangeForWakeLock() {
    if (document.hidden) {
      // Phase 6 audit fix 2: capture BOTH direct and embed playback state
      // before the auto-release. The `playing` flag tracks direct HTMLVideo
      // playback; `embedPlaying` tracks normalized provider playback events.
      // Either may be active when the document hides, and either should
      // trigger re-acquisition on visible.
      wasPlayingBeforeHidden = playing || embedPlaying;
      // Per spec, the sentinel auto-releases. But explicit release is safer
      // for cross-browser consistency — some browsers hold the lock briefly.
      void releaseWakeLock();
    } else {
      // Phase 6 audit fix 2: re-acquire only if the same playback state is
      // still active. Do NOT re-acquire if the user paused/stopped while
      // hidden, or if the source changed while hidden (which resets both
      // playing and embedPlaying). Direct playback re-acquires if `playing`
      // is still true; embed playback re-acquires if `embedPlaying` is still
      // true. Either path uses the same acquireWakeLock mechanism.
      const stillActive = wasPlayingBeforeHidden && (playing || embedPlaying);
      if (stillActive) {
        void acquireWakeLock();
      }
      wasPlayingBeforeHidden = false;
    }
  }
</script>

<svelte:window onbeforeunload={() => emitProgress('close')} onvisibilitychange={() => { if (document.hidden) emitProgress('visibility'); handleVisibilityChangeForWakeLock(); }} />

  <div bind:this={playerRoot} class="player-shell" class:landscape-mode={landscapeMode} class:controls-hidden={!controlsVisible} role="application" aria-label="MAVERO video player">
  {#if !landscapeMode}
  <header class="player-header">
    <div class="header-title-row">
      <button class="header-button header-nav" type="button" aria-label="Close player" onclick={onClose}><ArrowLeft size={18} /><span>Back</span></button>
      <div class="header-title"><strong>{content.title}</strong>{#if currentEpisode}<span>S{String(currentEpisode.season).padStart(2, '0')} · E{String(currentEpisode.episode).padStart(2, '0')}{#if currentEpisode.title} · {currentEpisode.title}{/if}</span>{/if}</div>
      <button class="header-button compact orientation-button" class:active={landscapeMode} type="button" aria-label={landscapeMode ? 'Exit landscape player' : 'Toggle landscape player'} aria-pressed={landscapeMode} onclick={() => void toggleLandscape()}><Maximize2 size={17} /><span>{landscapeMode ? 'Portrait' : 'Landscape'}</span></button>
    </div>
  </header>
  {:else}
  <div class="landscape-controls-overlay">
    {#if sourceOptions.length}<button class="landscape-overlay-button" type="button" aria-label="Switch source" aria-expanded={sourceMenuOpen} onclick={(e) => { if (sourceMenuOpen) closeSourceSheet(); else openSourceSheet(e.currentTarget as HTMLElement); }}><Settings2 size={20} /></button>{/if}
    <button class="landscape-overlay-button" type="button" aria-label="Exit landscape player" aria-pressed={landscapeMode} onclick={() => void toggleLandscape()}><Maximize2 size={20} /></button>
  </div>
  {/if}

  <section class="stage-wrap" aria-label="Player viewport">
    <PlayerViewport bind:this={viewport} bind:videoElement bind:iframeElement {source} {mediaUrl} sandboxEnabled={effectiveSandboxEnabled} poster={content.backdrop ?? content.poster ?? ''} title={content.title} state={effectiveState} subtitles={effectiveSubtitles} on:loadedmetadata={handleLoadedMetadata} on:timeupdate={handleTimeUpdate} on:play={handlePlay} on:pause={handlePause} on:waiting={handleWaiting} on:playing={handlePlaying} on:seeking={handleSeeking} on:seeked={handleSeeked} on:ended={handleEnded} on:error={handleMediaError} on:embedload={handleEmbedLoad} on:enginequality={handleEngineQuality} on:durationchange={handleSeekOpportunity} on:loadeddata={handleSeekOpportunity} on:canplay={handleSeekOpportunity} on:progress={handleSeekOpportunity} />

    {#if resolutionError || errorMessage || effectiveState === 'error' || effectiveState === 'provider-error' || effectiveState === 'source-unavailable' || effectiveState === 'unsupported-format' || effectiveState === 'embed-unavailable'}
      <div class="message-card" role="alert">
        <div class="message-icon"><AlertTriangle size={17} /></div>
        <div><strong>This source isn't available.</strong><p>{resolutionError || errorMessage || 'Choose another source or try again.'}</p></div>
        <div class="message-actions"><button class="small-button" type="button" aria-label="Try again" onclick={retry}><RotateCcw size={14} /> Try again</button>{#if sourceOptions.length}<button class="small-button secondary" type="button" aria-label="Switch source" onclick={(e) => openSourceSheet(e.currentTarget as HTMLElement)}><Settings2 size={14} /> Switch source</button>{/if}</div>
      </div>
    {:else if state === 'completed'}
      <div class="completion-card" role="status"><Check size={18} /><span>Episode complete</span></div>
    {:else if effectiveState === 'preparing' || effectiveState === 'resolving' || effectiveState === 'switching-source' || effectiveState === 'embed-loading'}
      <div class="loading-card" role="status"><span class="loading-ring" aria-hidden="true"><span></span></span><span class="loading-copy"><strong>{effectiveState === 'switching-source' ? 'Switching source…' : effectiveState === 'embed-loading' ? 'Starting your stream…' : 'Loading player…'}</strong><small>{resolutionMessage || (effectiveState === 'embed-loading' ? 'Loading provider embed…' : 'Preparing playback…')}</small></span></div>
    {/if}

  </section>

  <!-- Bottom controls area: direct sources get full PlayerControls; embed sources get shell controls.
       Phase 9: In landscape mode, the bottom-bar is completely hidden — the provider's own controls
       are inside the iframe, and Mavero only shows the minimal header overlay (title + exit + source). -->
  {#if !landscapeMode}
  <div class="bottom-bar" class:visible={controlsVisible}>
    {#if source?.type === 'direct'}
      <PlayerControls playing={playing} {muted} {volume} {currentTime} {duration} {buffered} {playbackRate} {pictureInPictureSupported} {pictureInPicture} subtitles={subtitles} selectedSubtitle={selectedSubtitle} qualities={qualities} selectedQuality={selectedQuality} internalQualities={engineQuality?.options ?? []} selectedInternalQuality={engineQuality?.selected ?? PLAYER_AUTO_QUALITY_ID} sourceCount={sourceOptions.length} streamCount={maveroStreams.length} onTogglePlay={togglePlay} onSeek={seek} onVolume={setVolume} onToggleMute={toggleMute} onPlaybackRate={setPlaybackRate} onSubtitle={setSubtitle} onQuality={setQuality} onInternalQuality={setInternalQuality} onPictureInPicture={togglePictureInPicture} onStep={seekBy} onSources={() => { if (sourceMenuOpen) closeSourceSheet(); else openSourceSheet(document.activeElement as HTMLElement); }} onStreams={() => { if (streamsSheetOpen) closeStreamsSheet(); else openStreamsSheet(document.activeElement as HTMLElement); }} />
    {:else if source?.type === 'embed' || effectiveState === 'embed-loading' || effectiveState === 'switching-source'}
      <!-- Phase 5: Embed source shell controls bar — Mavero-owned controls for embed playback -->
      <div class="embed-shell-controls" role="toolbar" aria-label="Embed playback controls">
        <div class="shell-info">
          <span class="shell-source-name">{sourceOptions.find((o) => o.id === source?.sourceId)?.name ?? 'Loading…'}</span>
        </div>
        <div class="shell-actions">
          {#if sourceOptions.length}<button class="shell-button" type="button" aria-label="Switch source" aria-expanded={sourceMenuOpen} onclick={(e) => { if (sourceMenuOpen) closeSourceSheet(); else openSourceSheet(e.currentTarget as HTMLElement); }}><Settings2 size={16} /></button>{/if}
          {#if episodes.length}<button class="shell-button" type="button" aria-label="Open episode list" aria-expanded={episodeMenuOpen} onclick={(e) => { if (episodeMenuOpen) closeEpisodeSheet(); else openEpisodeSheet(e.currentTarget as HTMLElement); }}><ListVideo size={16} /></button>{/if}
          <button class="shell-button" type="button" aria-label={`Open details for ${content.title}`} onclick={onDetails}><Info size={16} /></button>
          {#if source?.type === 'embed'}<button class="shell-button" class:active={effectiveSandboxEnabled} type="button" aria-label={`Turn sandbox ${effectiveSandboxEnabled ? 'off' : 'on'}`} aria-pressed={effectiveSandboxEnabled} onclick={toggleSandbox}>{#if effectiveSandboxEnabled}<ShieldCheck size={16} />{:else}<ShieldOff size={16} />{/if}</button>{/if}
        </div>
      </div>
    {/if}
  </div>
  {/if}

  {#if sourceMenuOpen}
    <!-- Phase 5: Compact source sheet — bottom-anchored sheet, not full-screen drawer -->
    <div class="sheet-overlay" role="presentation" onclick={() => closeSourceSheet()}></div>
    <div class="source-sheet" role="dialog" aria-modal="true" aria-label="Available playback sources">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-head"><span class="eyebrow">Source</span><button class="close-button" type="button" aria-label="Close source list" onclick={() => closeSourceSheet()}><X size={17} /></button></div>
      <div class="sheet-list">{#each sourceOptions as option}<div class="sheet-option-row"><button class="sheet-option" class:active={option.id === source?.sourceId && (!option.variants || option.variants.length === 0 || option.variants.includes(source?.metadata?.selectedVariant ?? ''))} type="button" onclick={() => chooseSource(option.id)}><span class="option-mark">{#if option.id === source?.sourceId}<Check size={14} />{:else}<span></span>{/if}</span><span><strong>{option.name}</strong><small>{option.status ?? 'available'}{#if option.integrationType} · {option.integrationType}{/if}</small></span></button>{#if option.variants && option.variants.length > 0}<div class="variant-row" role="group" aria-label={`${option.name} variants`}>{#each option.variants as variant}<button class="variant-button" class:active={option.id === source?.sourceId && source?.metadata?.selectedVariant === variant} type="button" aria-pressed={option.id === source?.sourceId && source?.metadata?.selectedVariant === variant} onclick={(e) => { e.stopPropagation(); chooseSource(option.id, variant); }}>{variant === 'sub' ? 'SUB' : variant === 'dub' ? 'DUB' : variant.toUpperCase()}</button>{/each}</div>{/if}{#if option.id === MAVERO_PLAYER_SOURCE_ID && maveroStreams.length}
          <!-- Phase 9: the ONLY stream entry point in the source sheet — ONE
               "X Streams →" button under the MAVERO Player provider row.
               The individual addon streams no longer render here; they live
               in the dedicated streams sheet (provider selection and stream
               selection are separate acts). -->
          <button class="streams-entry-button" type="button" aria-label={`Open the ${maveroStreams.length} MAVERO Player streams`} onclick={(e) => { e.stopPropagation(); openStreamsSheet(e.currentTarget as HTMLElement, true); }}><Clapperboard size={14} aria-hidden="true" /><strong>{maveroStreams.length} Stream{maveroStreams.length === 1 ? '' : 's'}</strong><ArrowRight size={14} aria-hidden="true" /></button>
        {/if}</div>{/each}
      </div>
    </div>
  {/if}

  {#if streamsSheetOpen}
    <!-- Phase 9: the dedicated MAVERO streams sheet — provider selection
         (source sheet) and stream selection (here) are SEPARATE acts.
         Streams are grouped by addon display name in the resolver's
         deterministic order; each card renders ONLY addon-supplied
         metadata via Svelte auto-escaping (no raw-HTML rendering, no raw URLs, no
         manifest/db identifiers, no admin controls). The current stream
         carries the check icon + aria-selected (never color alone);
         failed streams keep their card with a marker while every other
         stream stays selectable (failure isolation). -->
    <div class="sheet-overlay" role="presentation" onclick={() => closeStreamsSheet()}></div>
    <div class="mavero-streams-sheet" role="dialog" aria-modal="true" aria-label="MAVERO Player streams">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-head">
        <button class="close-button" type="button" aria-label="Back to source list" onclick={() => closeStreamsSheet()}><ArrowLeft size={17} /></button>
        <span class="eyebrow streams-eyebrow"><Clapperboard size={13} aria-hidden="true" />{MAVERO_PLAYER_SOURCE_NAME} · {maveroStreams.length} stream{maveroStreams.length === 1 ? '' : 's'}</span>
        <button class="close-button" type="button" aria-label="Close stream list" onclick={() => closeStreamsSheet()}><X size={17} /></button>
      </div>
      <div class="sheet-list streams-list">
        {#if maveroStreamGroups.length}
          <div class="mavero-groups" role="listbox" aria-label="MAVERO Player addon streams">
            {#each maveroStreamGroups as group (group.addonName)}
              <div class="mavero-group" role="group" aria-label={`${group.addonName} streams`}>
                <div class="mavero-group-head" role="presentation">
                  <span class="mavero-group-name" title={group.addonName}>{group.addonName}</span>
                  <small class="mavero-group-count">{group.streams.length} stream{group.streams.length === 1 ? '' : 's'}</small>
                </div>
                {#each group.streams as stream (stream.url)}
                  <MaveroStreamCard {stream} selected={stream.url === mediaUrl} failed={failedStreamUrls.includes(stream.url)} onselect={selectMaveroStream} />
                {/each}
              </div>
            {/each}
          </div>
          {#if engineQuality && engineQuality.options.length > 1}
            <!-- Phase 6: internal quality of the ACTIVE engine-driven
                 manifest (AUTO + levels). Lives with the ACTIVE stream's
                 context in the streams sheet; the desktop controls select
                 mirrors this exact state — there is never a second
                 competing quality menu. -->
            <div class="variant-row mavero-quality-row" role="group" aria-label="Playback quality">
              <span class="mavero-quality-title">Quality</span>
              {#each engineQuality.options as option (option.id)}
                <button class="variant-button" class:active={engineQuality?.selected === option.id} type="button" aria-pressed={engineQuality?.selected === option.id} onclick={() => setInternalQuality(option.id)}>{option.label}</button>
              {/each}
            </div>
          {/if}
        {:else}
          <div class="streams-empty" role="status">No streams are available right now.</div>
        {/if}
      </div>
    </div>
  {/if}

  {#if episodeMenuOpen}
    <!-- Phase 5: Compact episode sheet — matching the source sheet style -->
    <div class="sheet-overlay" role="presentation" onclick={() => closeEpisodeSheet()}></div>
    <div class="episode-sheet" role="dialog" aria-modal="true" aria-label="Episode list">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-head"><span class="eyebrow">Episodes · {episodes.length}</span><button class="close-button" type="button" aria-label="Close episode list" onclick={() => closeEpisodeSheet()}><X size={17} /></button></div>
      <div class="sheet-list">{#each episodes as episode}<button class="sheet-option" class:active={currentEpisode?.season === episode.season && currentEpisode?.episode === episode.number} type="button" onclick={() => chooseEpisode({ season: episode.season, episode: episode.number, title: episode.title })}><span class="episode-number">{String(episode.number).padStart(2, '0')}</span><span><strong>{episode.title}</strong><small>S{episode.season} · {episode.runtime ?? 'Episode'}</small></span></button>{/each}</div>
    </div>
  {/if}

</div>

<style>
  .player-shell { --player-bg: var(--base); position: relative; min-height: 100svh; min-height: 100dvh; overflow: hidden; color: var(--ink); background: var(--player-bg); display: flex; flex-direction: column; }
  .player-shell.landscape-mode { display: flex; flex-direction: column; height: 100dvh; min-height: 100svh; min-height: 100dvh; overflow: hidden; }
  /* Phase 9 fix: landscape controls overlay — two buttons top-right only. */
  .landscape-controls-overlay { position: absolute; z-index: 14; top: max(8px, env(safe-area-inset-top)); right: max(8px, env(safe-area-inset-right)); display: flex; gap: 6px; }
  .landscape-overlay-button { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(0,0,0,.74); cursor: pointer; box-shadow: var(--shadow-sm); backdrop-filter: blur(12px); }
  .landscape-overlay-button:hover, .landscape-overlay-button:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .landscape-overlay-button:active { transform: scale(.96); }
  .player-shell.landscape-mode .header-button span { display: none; }
  /* Phase 9: stage-wrap fills the ENTIRE viewport in landscape — no header/footer space. */
  .player-shell.landscape-mode .stage-wrap { display: flex; flex: 1 1 auto; align-items: stretch; justify-content: stretch; min-height: 0; padding: 0; width: 100%; height: 100%; }
  .player-shell.landscape-mode .stage-wrap :global(.viewport), .player-shell.landscape-mode .stage-wrap :global(.viewport.embed) { flex: 1 1 auto; width: 100%; max-width: none; height: 100%; max-height: none; min-height: 0; aspect-ratio: auto; border-radius: 0; }
  .player-shell.landscape-mode .stage-wrap :global(.viewport iframe), .player-shell.landscape-mode .stage-wrap :global(.viewport video) { min-height: 0; width: 100%; height: 100%; }
  /* Phase 9 fix: landscape source sheet is player-local (absolute, not fixed).
     .player-shell has position: relative, so absolute anchors to the player
     viewport — not the browser page. This prevents the drawer from floating
     detached at the page edge.

     IMPORTANT: The portrait bottom-sheet rule (.source-sheet, .episode-sheet)
     and the desktop @media (min-width: 769px) centered-popover rule both set
     `position: fixed` and `transform`/`bottom`/`left`/`right`/`max-height`/
     `animation` that conflict with this landscape rule. To make the
     landscape rule deterministically win, we explicitly RESET every
     conflicting property here (transform, animation, bottom, left, right,
     max-height, border-radius, border-top) and scope the desktop popover
     rule to non-landscape via :not(.landscape-mode) below. Without these
     resets, on a landscape phone whose viewport is ≥769px wide the desktop
     popover rule (transform: translate(-50%, -50%)) would override the
     landscape rule and the drawer would float as a small centered popup
     near the top of the player instead of a full-height right-edge drawer. */
  .player-shell.landscape-mode .source-sheet { position: absolute; z-index: 21; top: 0; right: 0; bottom: 0; left: auto; width: min(320px, 30vw); height: 100%; max-height: 100%; margin: 0; transform: none; border-top: 0; border-radius: 0; border-left: 1px solid var(--line-strong); background: rgba(13,13,13,.98); box-shadow: var(--shadow-lg); animation: slide-right var(--motion-normal) var(--ease-out); }
  .player-shell.landscape-mode .source-sheet .sheet-list { max-height: 100%; overflow-y: auto; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .player-shell.landscape-mode .episode-sheet { position: absolute; z-index: 21; top: 0; right: 0; bottom: 0; left: auto; width: min(340px, 32vw); height: 100%; max-height: 100%; margin: 0; transform: none; border-top: 0; border-radius: 0; border-left: 1px solid var(--line-strong); background: rgba(13,13,13,.98); box-shadow: var(--shadow-lg); animation: slide-right var(--motion-normal) var(--ease-out); }
  .player-shell.landscape-mode .episode-sheet .sheet-list { max-height: 100%; overflow-y: auto; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  /* Phase 9: the streams sheet follows the same right-edge drawer contract
     in landscape (slightly wider — it hosts the rich stream cards). */
  .player-shell.landscape-mode .mavero-streams-sheet { position: absolute; z-index: 21; top: 0; right: 0; bottom: 0; left: auto; width: min(400px, 38vw); height: 100%; max-height: 100%; margin: 0; transform: none; border-top: 0; border-radius: 0; border-left: 1px solid var(--line-strong); background: rgba(13,13,13,.98); box-shadow: var(--shadow-lg); animation: slide-right var(--motion-normal) var(--ease-out); }
  .player-shell.landscape-mode .mavero-streams-sheet .sheet-list { max-height: 100%; overflow-y: auto; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  /* Phase 9 fix: landscape backdrop is player-local (absolute, not fixed).
     Anchored to .player-shell via position: relative. Does NOT cover the
     page viewport — only the player area. Drawer z-index (21) sits above
     backdrop z-index (20) so the drawer is always visible above the scrim. */
  .player-shell.landscape-mode .sheet-overlay { position: absolute; z-index: 20; inset: 0; background: rgba(0,0,0,.35); backdrop-filter: none; }
  @keyframes slide-right { from { transform: translateX(100%); } to { transform: translateX(0); } }
  /* Portrait header: compact top bar */
  .player-header { position: relative; z-index: 8; flex: 0 0 auto; display: flex; align-items: center; padding: calc(10px + env(safe-area-inset-top)) clamp(12px, 4vw, 32px) 10px; background: rgba(0,0,0,.6); backdrop-filter: blur(12px); }
  .header-title-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; width: 100%; min-height: 40px; }
  .header-title-row .header-nav { justify-self: start; }
  .header-title-row .orientation-button { justify-self: end; }
  /* Phase 9 fix: header-actions-right removed — landscape uses .landscape-controls-overlay instead. */
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
  /* Phase 5/9: Compact source/streams/episode sheets — bottom-anchored, not full-screen.
     Scoped to non-landscape so the landscape rule above deterministically
     wins, even on wide landscape phones (viewport ≥769px wide) that would
     otherwise also match the desktop @media below. */
  .sheet-overlay { position: fixed; z-index: 20; inset: 0; background: rgba(0,0,0,.5); backdrop-filter: blur(2px); }
  .player-shell:not(.landscape-mode) .source-sheet, .player-shell:not(.landscape-mode) .episode-sheet, .player-shell:not(.landscape-mode) .mavero-streams-sheet { position: fixed; z-index: 21; bottom: 0; left: 0; right: 0; top: auto; max-height: 60dvh; overflow: auto; border-top: 1px solid var(--line-strong); border-radius: var(--radius-lg) var(--radius-lg) 0 0; background: rgba(13,13,13,.98); box-shadow: var(--shadow-lg); backdrop-filter: blur(28px); padding-bottom: env(safe-area-inset-bottom); transform: none; animation: sheet-up var(--motion-normal) var(--ease-out); }
  .episode-sheet { max-height: 65dvh; }
  .mavero-streams-sheet { max-height: 70dvh; }
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
  /* Phase 7F (MegaPlay): source option row wraps the base button + optional
     variant toggle row. The variant row renders SUB/DUB buttons inline so
     the user can see both variants belong to the SAME provider — they are
     NOT separate source entries. Touch targets remain >= 44px. */
  .sheet-option-row { display: flex; flex-direction: column; gap: 6px; }
  .variant-row { display: flex; gap: 6px; padding: 0 12px 6px; }
  .variant-button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; min-width: 56px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255,255,255,.02); cursor: pointer; font: inherit; font-size: .58rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .variant-button:hover, .variant-button:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .variant-button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
  .option-mark { display: grid; flex: 0 0 24px; place-items: center; width: 24px; height: 24px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent); }
  .option-mark > span { width: 5px; height: 5px; border-radius: 50%; background: var(--muted-deep); }
  /* Phase 9: "X Streams →" entry point under the MAVERO Player provider row
     inside the source sheet. Compact, full-width, 44px touch target. */
  .streams-entry-button { display: flex; align-items: center; gap: 8px; width: calc(100% - 24px); min-height: 44px; margin: 2px 12px 4px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 8px 12px; color: var(--ink-soft); background: rgba(255,255,255,.03); cursor: pointer; font: inherit; font-size: .62rem; }
  .streams-entry-button strong { color: var(--ink); font-size: .66rem; }
  .streams-entry-button:last-child { margin-left: auto; color: var(--muted); }
  .streams-entry-button:hover, .streams-entry-button:focus-visible { border-color: var(--accent); background: var(--accent-soft); }
  /* Phase 9: dedicated MAVERO streams sheet — grouped addon sections with
     rich stream cards. Groups stack vertically; addon names truncate with
     ellipsis; cards wrap badges instead of overflowing narrow screens. */
  .streams-eyebrow { display: inline-flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .streams-list { display: grid; gap: 6px; }
  .mavero-groups { display: grid; gap: 10px; }
  .mavero-group { display: grid; gap: 2px; }
  .mavero-group-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 6px 12px 2px; }
  .mavero-group-name { overflow: hidden; color: var(--ink-soft); font-size: .66rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
  .mavero-group-count { flex: 0 0 auto; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  .streams-empty { display: grid; place-items: center; min-height: 88px; color: var(--muted); font-size: .66rem; }
  .mavero-quality-row { align-items: center; flex-wrap: wrap; margin-top: 4px; }
  .mavero-quality-title { padding: 0 4px 0 12px; color: var(--muted); font-size: .58rem; }
  .episode-number { flex: 0 0 28px; color: var(--accent); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .65rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
  /* Desktop: source/streams/episode sheets become centered popovers.
     Scoped to non-landscape so a wide landscape phone (≥769px wide) does
     NOT pick up this centered-popover rule — the landscape right-edge
     drawer rule above must win in landscape mode. */
  @media (min-width: 769px) {
    .player-shell:not(.landscape-mode) .source-sheet, .player-shell:not(.landscape-mode) .episode-sheet, .player-shell:not(.landscape-mode) .mavero-streams-sheet { bottom: auto; top: 50%; left: 50%; right: auto; transform: translate(-50%, -50%); width: min(400px, calc(100% - 48px)); max-height: min(70dvh, 560px); border-radius: var(--radius-lg); border: 1px solid var(--line-strong); animation: none; }
    .player-shell:not(.landscape-mode) .episode-sheet { width: min(440px, calc(100% - 48px)); }
    .player-shell:not(.landscape-mode) .mavero-streams-sheet { width: min(460px, calc(100% - 48px)); }
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
  @media (prefers-reduced-motion: reduce) { .loading-ring, :global(.spin) { animation: none; } .header-button, .bottom-bar { transition: none; } .source-sheet, .episode-sheet, .mavero-streams-sheet { animation: none; } .player-shell.landscape-mode .source-sheet, .player-shell.landscape-mode .episode-sheet, .player-shell.landscape-mode .mavero-streams-sheet { animation: none; } }
</style>
