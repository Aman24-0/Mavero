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
    RefreshCw
  } from 'lucide-svelte';
  import {
    LiveTvPlaybackEngine,
    type LiveTvPlaybackState,
    type LiveTvSeekRange
  } from '$lib/client/live-tv/player';
  import { isLiveTvPlaybackError, type LiveTvPlaybackError } from '$lib/client/live-tv/player-errors';
  import { buildLiveTvEmbedUrl } from '$lib/client/live-tv/api';
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
  function onFullscreenChange() {
    isFullscreen = typeof document !== 'undefined' && document.fullscreenElement === surface;
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
  <div class="player-surface" bind:this={surface}>
    <video
      bind:this={videoRef}
      playsinline
      aria-label="Live TV stream"
      class:embed-hidden={embedActive}
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
    {:else if resolvingChannel}
      <div class="player-overlay" role="status">
        <span class="overlay-spinner" aria-hidden="true"><LoaderCircle size={26} /></span>
        <p class="overlay-message">Connecting to {activeChannelName}…</p>
      </div>
    {:else if engineState === 'loading'}
      <div class="player-overlay" role="status">
        <span class="overlay-spinner" aria-hidden="true"><LoaderCircle size={26} /></span>
        <p class="overlay-message">Loading stream…</p>
      </div>
    {:else if autoplayBlocked}
      <div class="player-overlay" role="status">
        <button class="tap-play" type="button" onclick={togglePlay} aria-label="Start playback">
          <Play size={30} strokeWidth={2.2} />
        </button>
        <p class="overlay-message">Tap to play</p>
      </div>
    {:else if engineState === 'buffering'}
      <div class="player-overlay subtle" role="status">
        <span class="overlay-spinner" aria-hidden="true"><LoaderCircle size={22} /></span>
      </div>
    {:else if !sessionEngaged}
      <div class="player-overlay" role="status">
        <span class="overlay-mark" aria-hidden="true"><Radio size={22} /></span>
        <p class="overlay-message">Select a channel to start watching.</p>
      </div>
    {/if}
  </div>

  <div class="player-controls" aria-label="Playback controls">
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

    <span class="ctl-spacer" aria-hidden="true"></span>

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
    {/if}

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
  }
  .player-surface video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #020405;
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
  }

  @media (prefers-reduced-motion: reduce) {
    .overlay-spinner { animation: none; }
    .live-badge .live-dot { animation: none; }
    .tap-play:hover { transform: none; }
  }
</style>
