<script lang="ts">
  // LT-4 — Live TV player surface + controls (presentation + engine wiring).
  //
  // OWNERSHIP (LT-4 brief §8, LT-3 contract):
  //   * This component RENDERS the page's <video> element and hands it to the
  //     page through the `video` bindable — the page owns it and hands it to
  //     the LT-3 engine (engine.load(video, resolution)). The component never
  //     creates a second video element and never imports Shaka; the ONLY
  //     playback surface it touches is the LT-3 engine contract.
  //   * The component subscribes to the engine's normalized events to drive
  //     its own control state (playing/paused/buffering, time, seek range,
  //     mid-session errors) and attempts autoplay after each 'loaded' event.
  //     Autoplay policy is NEVER bypassed — a rejection becomes a tap-to-play
  //     CTA, not a stream failure (LT-4 brief §10).
  //
  // HONEST LIVE UI (LT-4 brief §11/§12):
  //   * A seek control exists ONLY when the engine reports a real live seek
  //     window (engine.getLiveSeekRange()). No fake VOD timeline is ever
  //     drawn for a non-seekable stream.
  //   * "Go Live" appears only when the playhead is measurably behind the
  //     live edge; the LIVE badge reflects the actual engine position.
  //
  // LT-17 (player UI/controls + video fit):
  //   * Overlay state is derived through the player-overlay module: while
  //     the official embed fallback is mounted, NO native overlay (empty/
  //     loading/error/…) may render — the iframe is the sole visible
  //     playback surface by state logic, not by stacking order.
  //   * The native controls exist in TWO surfaces rendered from shared
  //     snippets: the bar below the video (non-fullscreen) and an
  //     in-surface overlay while fullscreen (auto-hide while playing,
  //     pointer wake, 44px touch targets). The embed fallback keeps its
  //     own controls only — the two control systems stay mutually
  //     exclusive.
  //   * Video display mode (FIT default / FILL user opt-in) is a pure
  //     presentation setting on the video element's object-fit; it never
  //     touches resolution, loading or the engine, and never stretches
  //     broadcast video (FILL crops, preserving the aspect ratio).
  //
  // SECURITY: no console calls, no storage, no URL params. Error text shown
  // here comes EXCLUSIVELY from the LT-2/LT-3 fixed safe tables (either the
  // page-passed message or the engine error's safe message).
  import { onDestroy, onMount } from 'svelte';
  import {
    Play,
    Pause,
    Volume2,
    VolumeX,
    Maximize,
    Minimize,
    LoaderCircle,
    AlertCircle,
    Radio,
    RefreshCw,
    Scan,
    Scaling
  } from 'lucide-svelte';
  import {
    LiveTvPlaybackEngine,
    type LiveTvPlaybackState,
    type LiveTvSeekRange
  } from '$lib/client/live-tv/player';
  import { isLiveTvPlaybackError, type LiveTvPlaybackError } from '$lib/client/live-tv/player-errors';
  import { buildLiveTvEmbedUrl } from '$lib/client/live-tv/api';
  import { createLiveTvFullscreenOrientationCoordinator } from '$lib/client/live-tv/fullscreen-orientation';
  import { isLiveTvOverlayShown } from '$lib/client/live-tv/player-overlay';
  import { describeLivePosition, formatBehindLive } from '$lib/client/live-tv/epg';
  import type { LiveTvChannel } from '$lib/client/live-tv/types';

  let {
    engine = null,
    resolvingChannel = null,
    sessionErrorMessage = null,
    onretry = () => {},
    onuseraction = () => {},
    embedChannelId = null,
    embedReloadToken = 0,
    video = $bindable()
  }: {
    /** The page's LT-3 engine for the active session (null between sessions). */
    engine?: LiveTvPlaybackEngine | null;
    /** The channel whose playback data is being resolved right now (or null). */
    resolvingChannel?: LiveTvChannel | null;
    /** Safe message (LT-2/LT-3 tables) for resolve/load failures; null otherwise. */
    sessionErrorMessage?: string | null;
    /** User asked for a fresh resolve + playback attempt. */
    onretry?: () => void;
    /**
     * Reports a raw USER action on the player surface (LT-5 analytics):
     * 'pause' | 'fullscreen_enter' | 'fullscreen_exit'. The component only
     * REPORTS the intent — the page owns what is tracked (it decides the
     * event/payload), so no analytics knowledge lives here.
     */
    onuseraction?: (action: 'pause' | 'fullscreen_enter' | 'fullscreen_exit') => void;
    /**
     * LT-15 — embed fallback: the channel id whose documented LiveGT embed
     * player is currently mounted (null = native playback only). The URL is
     * built HERE from the LT-2 client's constant + validated id — never a
     * URL handed in from outside, so no arbitrary iframe src can ever be
     * injected through this prop.
     */
    embedChannelId?: string | null;
    /**
     * LT-15 — bumped by the page to force ONE fresh iframe mount ("Try
     * again" while the fallback is active recreates the embed player, it
     * never re-instantiates Shaka).
     */
    embedReloadToken?: number;
    /** The page-owned video element rendered here (bindable, page binds it). */
    video?: HTMLVideoElement | undefined;
  } = $props();

  // The element this component renders (same element across ALL sessions —
  // the engine re-attaches to it; it is never re-created on channel switch).
  let videoRef: HTMLVideoElement | undefined = $state();
  let surface: HTMLElement | undefined = $state();

  // Session UI state driven by engine events.
  let engineState = $state<LiveTvPlaybackState>('idle');
  let engineError = $state<LiveTvPlaybackError | null>(null);
  let autoplayBlocked = $state(false);
  let currentTime = $state(0);
  let seekRange = $state<LiveTvSeekRange | null>(null);
  let volume = $state(1);
  let muted = $state(false);

  // Fullscreen (standard container API only — no custom PiP).
  let canFullscreen = $state(false);
  let isFullscreen = $state(false);

  // ---- LT-17 — video display mode (pure presentation, never playback) --
  // FIT (default): the whole picture inside the player area (letterbox
  // bars may remain when aspect ratios differ). FILL: cover the complete
  // player area, PRESERVING the aspect ratio and cropping the overflow
  // (never a distorted stretch of broadcast video). The mode only swaps
  // the video element's object-fit; it never touches resolution, loading
  // or the engine, and it resets with the component (never persisted).
  type LiveTvFitMode = 'fit' | 'fill';
  let fitMode = $state<LiveTvFitMode>('fit');

  function toggleFitMode(): void {
    fitMode = fitMode === 'fit' ? 'fill' : 'fit';
  }

  // ---- LT-17 — on-screen controls while fullscreen (native only) ------
  // The control bar below the video lives OUTSIDE the fullscreen surface,
  // so fullscreen used to show no controls at all. These overlay controls
  // render INSIDE the surface, only while the surface itself is fullscreen
  // (embed mode excluded — the official embed brings its own controls).
  // They auto-hide after a short idle window while PLAYING and come back
  // on any pointer activity; paused/buffering/loading keep them visible.
  let fsControlsVisible = $state(true);
  let fsHideTimer: ReturnType<typeof setTimeout> | undefined;

  function clearFsHideTimer(): void {
    if (fsHideTimer !== undefined) {
      clearTimeout(fsHideTimer);
      fsHideTimer = undefined;
    }
  }

  function scheduleFsHide(): void {
    clearFsHideTimer();
    if (isFullscreen && !embedActive && engineState === 'playing') {
      fsHideTimer = setTimeout(() => {
        fsControlsVisible = false;
      }, 3200);
    } else {
      fsControlsVisible = true;
    }
  }

  function wakeFsControls(): void {
    if (!isFullscreen || embedActive) return;
    fsControlsVisible = true;
    scheduleFsHide();
  }

  // Pointer wake-up (an action: passive listeners + cleanup, no a11y
  // static-element warnings; a no-op whenever the surface is not
  // fullscreen).
  function wakeSurfaceOnPointer(node: HTMLElement): { destroy(): void } {
    const wake = () => wakeFsControls();
    node.addEventListener('pointermove', wake, { passive: true });
    node.addEventListener('pointerdown', wake, { passive: true });
    return {
      destroy() {
        node.removeEventListener('pointermove', wake);
        node.removeEventListener('pointerdown', wake);
      }
    };
  }

  $effect(() => {
    // Re-evaluates on fullscreen changes and playback-state changes.
    if (isFullscreen && !embedActive) scheduleFsHide();
    else {
      clearFsHideTimer();
      fsControlsVisible = true;
    }
  });

  // ---- LT-15 — embed fallback (documented LiveGT embed player) ----------
  // The iframe src is built EXCLUSIVELY from the LT-2 client's base-URL
  // constant + the strictly validated numeric channel id (the builder
  // returns null for anything else → no iframe is ever mounted). The URL
  // is never taken from API wire data and never persisted anywhere.
  const embedSrc = $derived(embedChannelId !== null ? buildLiveTvEmbedUrl(embedChannelId) : null);
  const embedActive = $derived(embedSrc !== null);
  // Subtle "Switching…" state: shown from the moment the fallback mounts
  // until the embed page's own load event fires (a fresh mount resets it).
  let embedLoaded = $state(false);
  $effect(() => {
    // Re-run on every fresh mount (channel change or reload token bump).
    void embedChannelId;
    void embedReloadToken;
    embedLoaded = false;
  });

  // ---- Engine subscription: re-run on engine change (new session) --------
  // A page channel switch destroys the old engine and passes a fresh one;
  // this effect unsubscribes from the old engine, resets the session UI
  // state and subscribes to the new one. Never two subscriptions at once.
  $effect(() => {
    const eng = engine;
    // Reset per-session UI state (a fresh session starts clean).
    engineState = eng ? eng.getState() : 'idle';
    engineError = null;
    autoplayBlocked = false;
    currentTime = 0;
    seekRange = null;
    // Volume/muted live on the persistent <video> element — carry them over.
    volume = videoRef ? videoRef.volume : 1;
    muted = videoRef ? videoRef.muted : false;
    if (!eng) return;
    const offState = eng.on('statechange', ({ state }) => {
      engineState = state;
    });
    const offLoaded = eng.on('loaded', () => {
      void attemptAutoplay(eng);
    });
    const offTime = eng.on('timeupdate', () => {
      currentTime = eng.getCurrentTime();
      seekRange = eng.getLiveSeekRange();
    });
    const offError = eng.on('error', (error) => {
      // Mid-session fatal failure — safe message from the fixed LT-3 table.
      engineError = error;
      autoplayBlocked = false;
    });
    const offEnded = eng.on('ended', () => {
      // live streams rarely end; the engine settles into 'paused'
    });
    return () => {
      offState();
      offLoaded();
      offTime();
      offError();
      offEnded();
    };
  });

  // Publish the rendered element to the page (bindable). Children mount
  // before the page's onMount, so the element is ready before any load.
  $effect(() => {
    video = videoRef;
  });

  // ---- Autoplay (never a policy bypass; block → tap-to-play CTA) --------
  async function attemptAutoplay(eng: LiveTvPlaybackEngine) {
    autoplayBlocked = false;
    try {
      await eng.play();
    } catch (err) {
      if (isLiveTvPlaybackError(err) && err.kind === 'autoplay_blocked') {
        autoplayBlocked = true; // stream stays loaded; NOT a failure
      }
      // any other rejection surfaces through the engine's error path
    }
  }

  // ---- Controls (operate through the engine contract only) --------------
  function togglePlay() {
    const eng = engine;
    if (!eng) return;
    if (engineState === 'playing') {
      eng.pause();
      onuseraction('pause'); // user-initiated pause (LT-5 analytics report)
    } else {
      void attemptAutoplay(eng);
    }
  }

  function toggleMute() {
    const eng = engine;
    if (!eng) return;
    eng.setMuted(!eng.isMuted());
    muted = eng.isMuted();
  }

  function changeVolume(value: number) {
    const eng = engine;
    if (!eng) return;
    eng.setVolume(value);
    volume = eng.getVolume();
    if (value > 0 && muted) {
      eng.setMuted(false);
      muted = false;
    }
  }

  function onSeekInput(event: Event) {
    const eng = engine;
    const target = event.currentTarget as HTMLInputElement | null;
    if (!eng || !target) return;
    const value = Number(target.value);
    if (Number.isFinite(value)) eng.seek(value);
  }

  function goLive() {
    const eng = engine;
    const range = eng ? eng.getLiveSeekRange() : null;
    if (!eng || !range) return;
    eng.seek(range.end);
    void attemptAutoplay(eng);
  }

  // ---- Fullscreen (standard API on the player surface) -------------------
  // LT-16 — mobile fullscreen orientation enhancement. While OUR surface is
  // fullscreen on a touch-primary device (phone/tablet), the coordinator
  // requests a landscape lock through the Screen Orientation API and
  // releases it when fullscreen ends or the component is destroyed. It is a
  // pure enhancement: desktop never attempts a lock (capability-gated inside
  // the module), and unsupported/declined locks never affect playback or the
  // fullscreen itself. Created once per component; SSR-safe (the default
  // environment is empty on the server, making it a no-op there).
  const fullscreenOrientation = createLiveTvFullscreenOrientationCoordinator();

  function onFullscreenChange() {
    const fullscreenElement =
      typeof document !== 'undefined' ? document.fullscreenElement : null;
    // `isFullscreen` keeps its EXACT former meaning (button icon + analytics
    // intent): the surface ITSELF is the fullscreen element (our button).
    isFullscreen = fullscreenElement === surface;
    // Orientation-relevant fullscreen is wider: when the cross-origin embed's
    // INTERNAL player goes fullscreen, the browser promotes the iframe
    // ELEMENT in THIS document (never its internals — the iframe is never
    // reached into). The iframe lives inside the surface, so containment
    // covers BOTH playback modes (native video + embed fallback) through the
    // one shared surface, with zero changes to how fullscreen is requested.
    const surfaceFullscreen =
      surface !== undefined &&
      fullscreenElement !== null &&
      (fullscreenElement === surface || surface.contains(fullscreenElement));
    if (surfaceFullscreen) fullscreenOrientation.noteFullscreenGained();
    else fullscreenOrientation.noteFullscreenLost();
  }

  function toggleFullscreen() {
    if (!surface || typeof document === 'undefined') return;
    if (document.fullscreenElement) {
      onuseraction('fullscreen_exit'); // user intent (LT-5 analytics report)
      void document.exitFullscreen().catch(() => {});
    } else {
      onuseraction('fullscreen_enter');
      void surface.requestFullscreen().catch(() => {});
    }
  }

  onMount(() => {
    canFullscreen = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  });

  onDestroy(() => {
    // The PAGE owns the engine lifecycle (destroy on unmount/switch); this
    // component only drops its element references on teardown.
    // LT-16: never leave an orientation lock behind after unmount (safe
    // no-op when none is held; also invalidates any pending lock promise).
    fullscreenOrientation.dispose();
    // LT-17: never leave a controls-auto-hide timer behind either.
    clearFsHideTimer();
    video = undefined;
  });

  // ---- Derived display state ---------------------------------------------
  // LT-15: while the embed fallback is active the native failure message
  // is deliberately suppressed — the fallback UI replaces the error UI.
  // The derivation still reads ONLY the safe tables and can only remove
  // text, never introduce new text.
  const displayError = $derived(embedActive ? null : sessionErrorMessage ?? engineError?.message ?? null);
  const sessionEngaged = $derived(
    Boolean(engine) && engineState !== 'idle' && engineState !== 'destroyed'
  );
  // LT-17 (Issue 1) — every native overlay kind is derived through the
  // player-overlay module, which returns false for ALL kinds while the
  // official embed fallback is mounted: the iframe is the sole visible
  // playback surface, so the native empty/loading/error overlays can
  // never render over it (state logic, not stacking order). The chain
  // below keeps its ordered priority: error → connecting → loading →
  // tap-to-play → buffering → empty.
  const overlayState = $derived({
    embedActive,
    sessionError: displayError,
    resolving: resolvingChannel !== null,
    enginePresent: engine !== null,
    engineState,
    autoplayBlocked
  });
  const showConnecting = $derived(isLiveTvOverlayShown('connecting', overlayState));
  const showLoading = $derived(isLiveTvOverlayShown('loading', overlayState));
  const showTapPlay = $derived(isLiveTvOverlayShown('tap-to-play', overlayState));
  const showBuffering = $derived(isLiveTvOverlayShown('buffering', overlayState));
  const showEmptyState = $derived(isLiveTvOverlayShown('empty', overlayState));
  const controlsEnabled = $derived(sessionEngaged && engineState !== 'error' && !displayError);
  const livePosition = $derived(describeLivePosition(seekRange, currentTime));
  const behindLabel = $derived(formatBehindLive(livePosition.behindSeconds));
  const showSeek = $derived(
    controlsEnabled && engineState !== 'loading' && seekRange !== null && seekRange.end > seekRange.start
  );
  const showGoLive = $derived(
    controlsEnabled && livePosition.behindSeconds !== null && seekRange !== null
  );
  const activeChannelName = $derived(resolvingChannel?.name ?? '');
  const showNativeControls = $derived(!embedActive);
</script>

<section class="ltv-player" aria-label="Live TV player">
  <!-- LT-17 — shared native-control snippets. Each snippet is the SINGLE
       markup source for a control; it is rendered BOTH in the control bar
       below the video AND in the in-surface fullscreen overlay, so the two
       can never drift apart. They are rendered only through the
       showNativeControls branch — never in embed mode. -->
  {#snippet nativeControlCluster()}
    <button
      class="ctl"
      type="button"
      disabled={!controlsEnabled}
      onclick={togglePlay}
      aria-label={engineState === 'playing' ? 'Pause' : 'Play'}
    >
      {#if engineState === 'playing'}
        <Pause size={19} strokeWidth={2.1} />
      {:else}
        <Play size={19} strokeWidth={2.1} />
      {/if}
    </button>

    <button
      class="ctl"
      type="button"
      disabled={!controlsEnabled}
      onclick={toggleMute}
      aria-label={muted ? 'Unmute' : 'Mute'}
    >
      {#if muted}
        <VolumeX size={18} />
      {:else}
        <Volume2 size={18} />
      {/if}
    </button>

    {#if controlsEnabled}
      <input
        class="volume"
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={volume}
        oninput={(event) => changeVolume(Number((event.currentTarget as HTMLInputElement).value))}
        aria-label="Volume"
      />
    {/if}

    {#if sessionEngaged && !displayError}
      {#if livePosition.atLiveEdge}
        <span class="live-badge live" aria-label="Watching at the live edge">
          <span class="live-dot" aria-hidden="true"></span> LIVE
        </span>
      {:else if behindLabel}
        <span class="live-badge behind" aria-label={behindLabel}>{behindLabel}</span>
      {/if}
      {#if showGoLive}
        <button class="ctl go-live" type="button" onclick={goLive}>Go live</button>
      {/if}
    {/if}
  {/snippet}

  {#snippet liveSeekControl()}
    {#if showSeek && seekRange}
      <input
        class="live-seek"
        type="range"
        min={seekRange.start}
        max={seekRange.end}
        step="1"
        value={Math.min(Math.max(currentTime, seekRange.start), seekRange.end)}
        oninput={onSeekInput}
        aria-label="Seek within the live window"
      />
    {/if}
  {/snippet}

  {#snippet fitModeButton()}
    {#if controlsEnabled}
      <button
        class="ctl fit-toggle"
        class:active={fitMode === 'fill'}
        type="button"
        onclick={toggleFitMode}
        aria-label={fitMode === 'fit'
          ? 'Switch video display mode to fill (crop the picture edges)'
          : 'Switch video display mode to fit (show the whole picture)'}
        title={fitMode === 'fit' ? 'Display: Fit — switch to Fill' : 'Display: Fill — switch to Fit'}
      >
        {#if fitMode === 'fill'}
          <Scaling size={15} />
        {:else}
          <Scan size={15} />
        {/if}
        <span class="fit-label">{fitMode === 'fill' ? 'Fill' : 'Fit'}</span>
      </button>
    {/if}
  {/snippet}

  {#snippet fullscreenButton()}
    {#if canFullscreen}
      <button
        class="ctl"
        type="button"
        onclick={toggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        {#if isFullscreen}
          <Minimize size={18} />
        {:else}
          <Maximize size={18} />
        {/if}
      </button>
    {/if}
  {/snippet}

  <div
    class="player-surface"
    class:fs-idle={isFullscreen && !fsControlsVisible}
    bind:this={surface}
    use:wakeSurfaceOnPointer
  >
    <video
      bind:this={videoRef}
      playsinline
      aria-label="Live TV stream"
      class:embed-hidden={embedActive}
      class:video-fill={fitMode === 'fill'}
    ></video>

    {#if embedSrc}
      <!-- LT-15 — documented LiveGT embed fallback (mounted ONLY after the
           native engine genuinely failed; exactly one iframe at a time;
           src from the LT-2 builder + validated id only). The wrapper +
           iframe follow the official documented responsive pattern. -->
      <div class="embed-frame">
        {#key embedReloadToken}
          <iframe
            src={embedSrc}
            title="Live TV alternate player"
            style="position:absolute;inset:0;width:100%;height:100%;border:0"
            allowfullscreen
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            onload={() => {
              embedLoaded = true;
            }}
          ></iframe>
        {/key}
        {#if !embedLoaded}
          <div class="embed-pending player-overlay subtle" role="status">
            <span class="overlay-spinner" aria-hidden="true"><LoaderCircle size={22} /></span>
            <p class="overlay-message">Switching to alternate player…</p>
          </div>
        {/if}
      </div>
    {/if}

    {#if !embedActive && displayError}
      <div class="player-overlay" role="alert">
        <span class="overlay-mark" aria-hidden="true"><AlertCircle size={22} /></span>
        <p class="overlay-message">{displayError}</p>
        <button class="btn btn-secondary overlay-action" type="button" onclick={onretry}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    {:else if showConnecting}
      <div class="player-overlay" role="status">
        <span class="overlay-spinner" aria-hidden="true"><LoaderCircle size={26} /></span>
        <p class="overlay-message">Connecting to {activeChannelName}…</p>
      </div>
    {:else if showLoading}
      <div class="player-overlay" role="status">
        <span class="overlay-spinner" aria-hidden="true"><LoaderCircle size={26} /></span>
        <p class="overlay-message">Loading stream…</p>
      </div>
    {:else if showTapPlay}
      <div class="player-overlay" role="status">
        <button class="tap-play" type="button" onclick={togglePlay} aria-label="Start playback">
          <Play size={30} strokeWidth={2.2} />
        </button>
        <p class="overlay-message">Tap to play</p>
      </div>
    {:else if showBuffering}
      <div class="player-overlay subtle" role="status">
        <span class="overlay-spinner" aria-hidden="true"><LoaderCircle size={22} /></span>
      </div>
    {:else if showEmptyState}
      <div class="player-overlay" role="status">
        <span class="overlay-mark" aria-hidden="true"><Radio size={22} /></span>
        <p class="overlay-message">Select a channel to start watching.</p>
      </div>
    {/if}

    {#if isFullscreen && !embedActive}
      <!-- LT-17 — native on-screen controls for fullscreen. Rendered ONLY
           while the surface itself is fullscreen and NEVER in embed mode
           (the official embed's own controls stay untouched — the two
           control systems are mutually exclusive). -->
      <div class="fs-controls" class:visible={fsControlsVisible}>
        <div class="fs-seek-row">
          {@render liveSeekControl()}
        </div>
        <div class="fs-row">
          {@render nativeControlCluster()}
          <span class="ctl-spacer" aria-hidden="true"></span>
          {@render fitModeButton()}
          {@render fullscreenButton()}
        </div>
      </div>
    {/if}
  </div>

  <!-- LT-17 — the bar below the video stays the NON-fullscreen control
       surface. While the surface is fullscreen it is outside the rendered
       screen area, so it is made inert (no stray focus stops) and the
       in-surface .fs-controls take over. -->
  <div class="player-controls" aria-label="Playback controls" inert={isFullscreen}>
    {#if embedActive}
      <!-- LT-15 — embed fallback controls: recreate the embed player (the
           page's retry decides: a fresh iframe mount, never a new Shaka
           attempt); fullscreen still works on the shared surface. -->
      <button
        class="ctl go-live"
        type="button"
        onclick={onretry}
        aria-label="Reload the alternate player"
        title="Reload the alternate player"
      >
        <RefreshCw size={16} /> Reload player
      </button>
      <span class="ctl-spacer" aria-hidden="true"></span>
    {:else if showNativeControls}
      {@render nativeControlCluster()}
      <span class="ctl-spacer" aria-hidden="true"></span>
      {@render liveSeekControl()}
      {@render fitModeButton()}
    {/if}

    {@render fullscreenButton()}
  </div>
</section>

<style>
  .ltv-player {
    display: grid;
    gap: 0;
    min-width: 0;
  }

  .player-surface {
    position: relative;
    aspect-ratio: 16 / 9;
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: #020405;
    box-shadow: var(--shadow-sm);
  }
  .player-surface:fullscreen {
    border-radius: 0;
    border: 0;
    /* The fullscreen element covers the complete screen explicitly (the
       aspect-ratio constraint is void once BOTH dimensions are set). */
    width: 100%;
    height: 100%;
  }
  /* LT-17 — controls hidden after idle while playing fullscreen: hide the
     cursor with them (no cursor floating over the picture). */
  .player-surface:fullscreen.fs-idle {
    cursor: none;
  }
  .player-surface video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #020405;
  }
  /* LT-17 — video display mode FILL (user opt-in): cover the complete
     player area, PRESERVING the aspect ratio and cropping the overflow
     (object-fit: cover crops, it never stretches — a distorted stretch
     of broadcast video is deliberately not offered). FIT stays the
     default through the rule above. */
  .player-surface video.video-fill {
    object-fit: cover;
  }
  /* LT-15 — embed fallback: the native video is hidden (never removed —
     the page owns the element and re-attaches the engine to it for the
     next fresh native session). */
  .player-surface video.embed-hidden {
    display: none;
  }

  /* LT-15 — the documented LiveGT embed fallback frame. The wrapper fills
     the player surface (which already enforces the 16:9 ratio); the iframe
     itself uses the official documented responsive pattern
     (absolute; inset:0; 100%; border:0) so it occupies the complete
     player area with the same dimensions as the native video. */
  .embed-frame {
    position: absolute;
    inset: 0;
    background: #020405;
  }
  .embed-frame iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
  .embed-pending {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    padding: 20px;
    background: rgba(2, 4, 5, .72);
    text-align: center;
  }

  /* LT-17 — native on-screen controls for fullscreen. They live INSIDE
     the fullscreen surface (the bar below the video is not part of the
     fullscreen rendering), stack above everything else, auto-hide after
     an idle window while playing (visibility keeps hidden buttons out of
     the tab order) and stay clear of notched screens through the
     safe-area padding. */
  .fs-controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 4;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 30px 16px calc(10px + env(safe-area-inset-bottom, 0px));
    background: linear-gradient(180deg, rgba(2, 4, 5, 0) 0%, rgba(2, 4, 5, .86) 42%);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity var(--motion-fast) var(--ease-out), visibility 0s linear var(--motion-fast);
  }
  .fs-controls.visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transition: opacity var(--motion-fast) var(--ease-out);
  }
  .fs-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .fs-seek-row {
    display: flex;
    min-width: 0;
  }
  /* Touch-friendly fullscreen targets (44px). */
  .fs-controls .ctl { width: 44px; height: 44px; }
  .fs-controls .ctl.fit-toggle { width: auto; height: 44px; }
  .fs-controls .volume { width: clamp(70px, 14vw, 120px); }
  .fs-controls .live-seek { flex: 1 1 auto; width: 100%; max-width: none; }
  .fs-controls .live-badge { padding: 6px 14px; font-size: .72rem; }

  .player-overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    padding: 20px;
    background: rgba(2, 4, 5, .72);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    text-align: center;
  }
  .player-overlay.subtle {
    justify-content: center;
    align-content: center;
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    pointer-events: none;
  }
  .overlay-mark {
    display: grid;
    place-items: center;
    width: 52px; height: 52px;
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
    color: var(--color-text-muted);
    background: rgba(8, 11, 13, .6);
  }
  .overlay-spinner {
    display: grid;
    place-items: center;
    color: var(--color-primary);
    animation: ltv-spin 1s linear infinite;
  }
  @keyframes ltv-spin { to { transform: rotate(360deg); } }
  .overlay-message {
    margin: 0;
    max-width: 420px;
    color: var(--color-text);
    font-size: .84rem;
    font-weight: 600;
    letter-spacing: -.01em;
    line-height: 1.5;
    text-wrap: pretty;
  }
  .overlay-action { min-height: 40px; padding: 0 18px; }

  .tap-play {
    display: grid;
    place-items: center;
    width: 76px; height: 76px;
    border: 1px solid var(--color-primary-border);
    border-radius: 50%;
    color: var(--color-primary);
    background: rgba(0, 255, 156, .1);
    box-shadow: var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  }
  .tap-play:hover { transform: scale(1.06); background: rgba(0, 255, 156, .16); }
  .tap-play:active { transform: scale(.96); }

  .player-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 10px 14px;
    border: 1px solid var(--color-border);
    border-top: 0;
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
    background: var(--color-surface);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .player-controls::-webkit-scrollbar { display: none; }

  .ctl {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 40px; height: 40px;
    border: 1px solid transparent;
    border-radius: 50%;
    color: var(--color-text-muted);
    background: transparent;
    transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .ctl:hover:not(:disabled) {
    color: var(--color-primary);
    background: var(--color-primary-soft);
  }
  .ctl:active:not(:disabled) { transform: scale(.94); }
  .ctl:disabled { opacity: .35; cursor: default; }
  .ctl:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .ctl.go-live {
    width: auto;
    padding: 0 14px;
    border-radius: 999px;
    border: 1px solid var(--color-primary-border);
    color: var(--color-primary);
    background: var(--color-primary-soft);
    font-size: .72rem;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* LT-17 — video display-mode toggle (FIT/FILL pill). Shows the CURRENT
     mode; highlighted while the non-default FILL mode is active. */
  .ctl.fit-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: auto;
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    color: var(--color-text-muted);
    background: transparent;
    font-size: .68rem;
    font-weight: 800;
    letter-spacing: .06em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .ctl.fit-toggle .fit-label { line-height: 1; }
  .ctl.fit-toggle.active {
    border-color: var(--color-primary-border);
    color: var(--color-primary);
    background: var(--color-primary-soft);
  }
  .ctl.fit-toggle:hover:not(:disabled) {
    color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .live-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: 0 0 auto;
    padding: 5px 12px;
    border: 1px solid rgba(255, 77, 109, .35);
    border-radius: 999px;
    color: #ff8fa3;
    background: rgba(255, 77, 109, .1);
    font-size: .66rem;
    font-weight: 800;
    letter-spacing: .12em;
    white-space: nowrap;
  }
  .live-badge .live-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--color-danger);
    box-shadow: 0 0 8px rgba(255, 77, 109, .8);
    animation: ltv-pulse 2s ease-in-out infinite;
  }
  @keyframes ltv-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .45; }
  }
  .live-badge.behind {
    border-color: var(--color-border-strong);
    color: var(--color-text-muted);
    background: var(--color-surface-raised);
    letter-spacing: .02em;
    text-transform: none;
    font-size: .68rem;
  }

  /* Touch targets: the INPUT box stays 28px tall (WCAG 2.5.8 — the 4px
     visual track lives on the runnable-track pseudo-elements, so the hit
     area is a practical touch size instead of the track height). */
  .volume, .live-seek {
    flex: 0 1 auto;
    min-width: 0;
    height: 28px;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .volume { width: clamp(64px, 12vw, 110px); }
  .live-seek { flex: 1 1 140px; max-width: 420px; }
  .volume::-webkit-slider-runnable-track,
  .live-seek::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 999px;
    background: rgba(0, 255, 156, .18);
  }
  .volume::-moz-range-track,
  .live-seek::-moz-range-track {
    height: 4px;
    border-radius: 999px;
    background: rgba(0, 255, 156, .18);
  }
  .volume::-webkit-slider-thumb, .live-seek::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 14px; height: 14px;
    margin-top: -5px; /* center the thumb on the 4px webkit track */
    border: 0;
    border-radius: 50%;
    background: var(--color-primary);
    box-shadow: 0 0 8px rgba(0, 255, 156, .6);
  }
  .volume::-moz-range-thumb, .live-seek::-moz-range-thumb {
    width: 14px; height: 14px;
    border: 0;
    border-radius: 50%;
    background: var(--color-primary);
    box-shadow: 0 0 8px rgba(0, 255, 156, .6);
  }
  .volume:focus-visible, .live-seek:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 3px;
  }

  .ctl-spacer { flex: 0 1 14px; }

  @media (max-width: 640px) {
    .player-controls { padding: 8px 10px; gap: 6px; }
    .volume { width: 64px; }
    .live-badge { padding: 4px 10px; }
    .fs-controls { gap: 2px; padding: 26px 10px calc(8px + env(safe-area-inset-bottom, 0px)); }
    .fs-row { gap: 4px; }
    .fs-controls .volume { width: 64px; }
    .ctl.fit-toggle { min-height: 40px; padding: 0 10px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .overlay-spinner { animation: none; }
    .live-badge .live-dot { animation: none; }
    .fs-controls, .fs-controls.visible { transition: none; }
    .tap-play:hover { transform: none; }
  }
</style>
