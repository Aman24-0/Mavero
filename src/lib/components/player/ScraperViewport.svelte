<script lang="ts">
  // Phase 7 — Direct Play / Scraper Mode: Video.js player + hardened SSE.
  //
  // This component connects to the media-worker's SSE endpoint
  // (GET /api/extract/stream) to receive real-time scraper results.
  // When a user selects a successful stream, the scanning grid
  // transitions to a Video.js player using the VHS HLS pipeline.
  //
  // DESIGN CONTRACTS (Phase 7):
  //   * SINGLE authoritative player lifecycle — exactly ONE `$effect`
  //     reacts to `activeStream + videoElement` and initializes the
  //     Video.js player. There are NO duplicate effects.
  //   * SINGLE playback owner — Video.js (with VHS) is the only HLS
  //     engine; no parallel hls.js instance is ever created on the
  //     same media element.
  //   * `mediaWorkerUrl` is `string | null` — when `null` (production
  //     without MAVERO_MEDIA_WORKER_URL configured), the component
  //     renders a typed "Extractor unavailable" state instead of
  //     silently dialing 127.0.0.1.
  //   * Provider cards only become `success` when the scraper returns
  //     a valid URL + supported media type. A `UNSUPPORTED` typed
  //     error renders the card as `unavailable`, NOT as `success`.
  //   * Source switching captures currentTime, disposes the old
  //     Video.js player, creates a new one, and restores seek position.
  //   * Video.js is disposed on exit, source switch, and unmount.
  //   * EventSource is closed on destroy, on exit, and on scan
  //     completion — no zombie connections.

  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { ArrowLeft, Check, X, LoaderCircle } from 'lucide-svelte';
  import videojs from 'video.js';
  import type Player from 'video.js/dist/types/player';
  import qualityLevelsPlugin from 'videojs-contrib-quality-levels';
  import ScraperControls from './ScraperControls.svelte';

  // Phase 7 — minimal structural types for Video.js track lists.
  // Video.js's own typings don't expose indexed access (`list[i]`);
  // we cast through these inline shapes to access `.label`, `.language`,
  // `.enabled`, `.mode`, and `.kind` without losing type safety on
  // the values we actually read.
  type VjsAudioTrack = { label?: string; language?: string; enabled: boolean };
  type VjsTextTrack = { label?: string; language?: string; mode: string; kind: string };
  type VjsAudioTrackList = { length: number; [i: number]: VjsAudioTrack | undefined } &
    { addEventListener: (evt: string, fn: () => void) => void };
  type VjsTextTrackList = { length: number; [i: number]: VjsTextTrack | undefined } &
    { addEventListener: (evt: string, fn: () => void) => void };

  // ============================================================
  // Props
  // ============================================================

  let {
    title = 'Direct Play',
    subtitle = 'Scanning high-speed servers…',
    contentId = '',
    contentType = 'movie' as 'movie' | 'series' | 'anime',
    season = undefined as number | undefined,
    episode = undefined as number | undefined,
    /**
     * Phase 7 — production media-worker URL. `null` in production
     * without MAVERO_MEDIA_WORKER_URL configured (no implicit
     * localhost fallback). The dev path falls back to
     * `http://127.0.0.1:3000` via +page.server.ts.
     */
    mediaWorkerUrl = null as string | null,
  }: {
    title?: string;
    subtitle?: string;
    contentId?: string;
    contentType?: 'movie' | 'series' | 'anime';
    season?: number | undefined;
    episode?: number | undefined;
    mediaWorkerUrl?: string | null;
  } = $props();

  const dispatch = createEventDispatcher<{ exit: void; streamselected: { url: string; provider: string } }>();

  // ============================================================
  // Provider state (driven by SSE events)
  // ============================================================

  // Phase 7 — honest provider states. `unavailable` is a typed state
  // distinct from `failed`: it means "the provider adapter itself is
  // not implemented" (UNSUPPORTED), not "extraction failed at runtime".
  type ProviderStatus = 'scanning' | 'success' | 'failed' | 'unavailable';
  type ProviderCard = {
    name: string;
    status: ProviderStatus;
    streamUrl?: string;
    streamType?: 'hls' | 'mp4';
    error?: string;
  };

  let providers = $state<ProviderCard[]>([
    { name: 'VidSrc', status: 'scanning' },
    { name: 'VidLink', status: 'scanning' },
    { name: 'Cineverse', status: 'scanning' },
    { name: 'SLast', status: 'scanning' },
  ]);

  // Extracted streams collected from SSE (only successes with valid URLs).
  let extractedStreams: { provider: string; url: string; type: 'hls' | 'mp4' }[] = [];

  // Scan completion state.
  let scanComplete = $state(false);

  // ============================================================
  // Player state
  // ============================================================

  type ActiveStream = { provider: string; url: string; type: 'hls' | 'mp4' } | null;
  let activeStream = $state<ActiveStream>(null);

  // The DOM <video> element — bound via `bind:this`. Video.js wraps it.
  let videoElement = $state<HTMLVideoElement | null>(null);

  // The Video.js player instance — the SINGLE playback owner.
  let playerInstance: Player | null = null;

  // Generation token — bumped on every source switch so a slow
  // initialization for source A is invalidated when the source
  // switches to B (race-condition guard, spec §17).
  let playerGeneration = 0;

  let playerError = $state<string>('');

  // Playback tracking state — driven by Video.js events.
  let isPlaying = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);
  let buffered = $state(0);
  let muted = $state(false);
  let showControls = $state(true);
  let controlsTimer: ReturnType<typeof setTimeout> | undefined;

  // Phase 7 — Video.js quality / audio / subtitle state. Replaces the
  // old hls.js-specific `Level[]` / `MediaPlaylist[]` arrays.
  let qualities = $state<{ height: number; bitrate: number; name?: string; index: number }[]>([]);
  let currentLevel = $state(-1); // -1 = Auto
  let audioTracks = $state<{ id: number; name?: string; lang?: string; enabled: boolean }[]>([]);
  let currentAudioTrack = $state(-1);
  let subtitleTracks = $state<{ id: number; name?: string; lang?: string; mode: string }[]>([]);
  let currentSubtitleTrack = $state(-1); // -1 = Off

  // Phase 7 — Source switcher modal + pending seek for seamless restore.
  let showSourceSwitcher = $state(false);
  let pendingSeekPosition: number | undefined = undefined;

  let eventSource: EventSource | null = null;

  // Track whether Video.js has been registered with the quality-levels
  // plugin (register once per page load).
  let qualityLevelsRegistered = false;

  // ============================================================
  // Controls visibility (inactivity timer)
  // ============================================================

  function revealControls() {
    showControls = true;
    if (controlsTimer) clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
      if (isPlaying) showControls = false;
    }, 4000);
  }

  function hideControlsNow() {
    if (isPlaying) {
      showControls = false;
      if (controlsTimer) clearTimeout(controlsTimer);
    }
  }

  // ============================================================
  // Video.js player lifecycle — SINGLE authoritative effect
  // ============================================================

  /**
   * Maps an ExtractResult type to the Video.js source type.
   *   * hls → 'application/vnd.apple.mpegurl' (VHS handles it)
   *   * mp4 → 'video/mp4'
   */
  function videojsSourceType(streamType: 'hls' | 'mp4'): string {
    return streamType === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4';
  }

  /**
   * Initializes the Video.js player for the given stream URL.
   *
   * This is the SINGLE player-init path. Called by the $effect below
   * when BOTH `activeStream` and `videoElement` are truthy.
   *
   * Race protection: bumps `playerGeneration` and captures the local
   * generation. Any async continuation (loadstart, loadedmetadata) is
   * discarded if the generation has advanced by the time it fires
   * (source switched in the meantime).
   */
  function initPlayer(streamUrl: string, streamType: 'hls' | 'mp4', seekPosition?: number): void {
    destroyPlayer();
    if (!videoElement) return;
    playerError = '';

    // Register the quality-levels plugin once per page (idempotent).
    if (!qualityLevelsRegistered) {
      try {
        videojs.registerPlugin('qualityLevels', qualityLevelsPlugin);
      } catch {
        // Already registered — safe to ignore.
      }
      qualityLevelsRegistered = true;
    }

    const generation = ++playerGeneration;

    const player = videojs(videoElement, {
      controls: false, // custom OTT overlay
      autoplay: false, // we call play() manually after metadata
      preload: 'auto',
      fluid: true,
      html5: {
        vhs: {
          // VHS (Video.js HTTP Streaming) — the built-in HLS engine.
          overrideNative: true,
          enableLowInitialPlaylist: true,
        },
      },
    }) as Player;

    playerInstance = player;

    // Load the source — Video.js / VHS handles HLS, native handles MP4.
    player.src({ src: streamUrl, type: videojsSourceType(streamType) });

    // ============================================================
    // Player event listeners — drive the playback-tracking state
    // ============================================================

    player.on('play', () => {
      if (generation !== playerGeneration) return;
      isPlaying = true;
      revealControls();
    });
    player.on('pause', () => {
      if (generation !== playerGeneration) return;
      isPlaying = false;
      showControls = true;
      if (controlsTimer) clearTimeout(controlsTimer);
    });
    player.on('timeupdate', () => {
      if (generation !== playerGeneration) return;
      currentTime = player.currentTime() ?? 0;
      const bufferedEnd = player.bufferedEnd();
      buffered = Number.isFinite(bufferedEnd) ? bufferedEnd : 0;
    });
    player.on('durationchange', () => {
      if (generation !== playerGeneration) return;
      const d = player.duration() ?? 0;
      duration = Number.isFinite(d) ? d : 0;
    });
    player.on('loadedmetadata', () => {
      if (generation !== playerGeneration) return;
      const d = player.duration() ?? 0;
      duration = Number.isFinite(d) ? d : 0;
    });
    player.on('volumechange', () => {
      if (generation !== playerGeneration) return;
      muted = player.muted() ?? false;
    });
    player.on('ended', () => {
      if (generation !== playerGeneration) return;
      isPlaying = false;
      showControls = true;
    });

    // ============================================================
    // Quality levels (HLS via VHS) — videojs-contrib-quality-levels
    // ============================================================

    const setupQualityLevels = () => {
      if (generation !== playerGeneration) return;
      try {
        const qlPlugin = (player as unknown as { qualityLevels?: () => { length: number; getLevel: (i: number) => { height?: number; bitrate?: number } | null } | undefined }).qualityLevels?.();
        if (!qlPlugin) return;
        qualities = [];
        for (let i = 0; i < qlPlugin.length; i++) {
          const level = qlPlugin.getLevel(i);
          if (!level) continue;
          qualities.push({
            height: level.height || 0,
            bitrate: level.bitrate || 0,
            index: i,
            name: level.height ? `${level.height}p` : `Level ${i + 1}`,
          });
        }
      } catch {
        qualities = [];
      }
    };
    player.on('loadedmetadata', setupQualityLevels);

    // ============================================================
    // Audio tracks (HLS via VHS) — Video.js audioTrack API
    // ============================================================

    const setupAudioTracks = () => {
      if (generation !== playerGeneration) return;
      try {
        const tracks = player.audioTracks?.() as unknown as VjsAudioTrackList | undefined;
        if (!tracks) return;
        audioTracks = [];
        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i];
          if (!t) continue;
          audioTracks.push({
            id: i,
            name: t.label || t.language || `Track ${i + 1}`,
            lang: t.language,
            enabled: t.enabled,
          });
        }
        const enabled = audioTracks.find((t) => t.enabled);
        currentAudioTrack = enabled ? enabled.id : -1;
      } catch {
        audioTracks = [];
      }
    };
    player.on('loadedmetadata', setupAudioTracks);
    player.audioTracks?.()?.addEventListener('change', setupAudioTracks);

    // ============================================================
    // Text tracks (subtitles) — Video.js textTrack API
    // ============================================================

    const setupTextTracks = () => {
      if (generation !== playerGeneration) return;
      try {
        const tracks = player.textTracks?.() as unknown as VjsTextTrackList | undefined;
        if (!tracks) return;
        subtitleTracks = [];
        // Skip the VHS-generated metadata track (if any).
        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i];
          if (!t) continue;
          if (t.kind === 'metadata') continue;
          subtitleTracks.push({
            id: i,
            name: t.label || t.language || `Subtitle ${i + 1}`,
            lang: t.language,
            mode: t.mode,
          });
        }
        const showing = subtitleTracks.find((t) => t.mode === 'showing');
        currentSubtitleTrack = showing ? showing.id : -1;
      } catch {
        subtitleTracks = [];
      }
    };
    player.on('loadedmetadata', setupTextTracks);
    player.textTracks?.()?.addEventListener('change', setupTextTracks);

    // ============================================================
    // Fatal error handling — show recovery UI, do NOT auto-retry
    // (spec §16: "Do not immediately convert every failure into an
    // FFmpeg job").
    // ============================================================
    player.on('error', () => {
      if (generation !== playerGeneration) return;
      const err = player.error();
      if (!err) return;
      // Phase 7 — honest fatal-error state. The user chooses another
      // source; no silent retry, no FFmpeg fallback.
      playerError = 'This source could not be played directly. Try another source.';
    });

    // ============================================================
    // Restore seek position + start playback (autoplay-safe)
    // ============================================================
    player.one('loadedmetadata', () => {
      if (generation !== playerGeneration) return;
      if (seekPosition !== undefined && seekPosition > 0) {
        const safeSeek = Math.min(seekPosition, (player.duration() || seekPosition) - 2);
        if (safeSeek > 0) {
          try { player.currentTime(safeSeek); } catch { /* not ready yet */ }
        }
      }
      // Autoplay — handle browser autoplay restrictions gracefully.
      // Autoplay failure is NOT a source failure (spec §26).
      const p = player.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          // Autoplay succeeded — playback state will be set by 'play' event.
        }).catch(() => {
          // Autoplay blocked (browser policy) — show controls so the
          // user can press play. This is NOT a player error.
          showControls = true;
          isPlaying = false;
        });
      }
    });
  }

  function destroyPlayer(): void {
    if (playerInstance) {
      try {
        playerInstance.dispose();
      } catch {
        // Already disposed — no-op.
      }
      playerInstance = null;
    }
    // Bump generation so any in-flight async continuation is invalidated.
    playerGeneration++;
    // Reset all playback state.
    qualities = [];
    audioTracks = [];
    subtitleTracks = [];
    currentLevel = -1;
    currentAudioTrack = -1;
    currentSubtitleTrack = -1;
    isPlaying = false;
    currentTime = 0;
    duration = 0;
    buffered = 0;
  }

  /**
   * SINGLE authoritative player-initialization effect.
   *
   * Replaces the Phase 4 code which had TWO competing `$effect()`
   * blocks both reacting to `activeStream + videoElement`. The new
   * effect is the only place a Video.js player is constructed.
   *
   * The `pendingSeekPosition` module-level variable is read + cleared
   * synchronously inside the effect so a source switch can request a
   * seek restore without triggering a second effect.
   */
  $effect(() => {
    if (activeStream && videoElement) {
      const seek = pendingSeekPosition;
      pendingSeekPosition = undefined;
      initPlayer(activeStream.url, activeStream.type, seek);
    }
  });

  // ============================================================
  // Control handlers (called by ScraperControls)
  // ============================================================

  function togglePlay() {
    if (!playerInstance) return;
    if (playerInstance.paused()) {
      const p = playerInstance.play();
      if (p && typeof p.then === 'function') {
        p.catch(() => { /* autoplay blocked — not a fatal error */ });
      }
    } else {
      playerInstance.pause();
    }
  }

  function seekTo(time: number) {
    if (playerInstance) {
      try { playerInstance.currentTime(time); } catch { /* not ready */ }
    }
  }

  function toggleMute() {
    if (playerInstance) {
      const muted = !playerInstance.muted();
      playerInstance.muted(muted);
    }
  }

  function setQuality(level: number) {
    // Phase 7 — Video.js / VHS quality selection via
    // videojs-contrib-quality-levels. -1 = Auto.
    try {
      const ql = (playerInstance as unknown as { qualityLevels?: () => { length: number; getLevel: (i: number) => { height?: number; bitrate?: number; enabled?: boolean } | null } | undefined })?.qualityLevels?.();
      if (!ql) return;
      for (let i = 0; i < ql.length; i++) {
        const l = ql.getLevel(i);
        if (!l) continue;
        l.enabled = level === -1 || i === level;
      }
      currentLevel = level;
    } catch {
      /* quality API not available for this source */
    }
  }

  function setAudioTrack(trackId: number) {
    try {
      const tracks = playerInstance?.audioTracks?.() as unknown as VjsAudioTrackList | undefined;
      if (!tracks) return;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t) continue;
        t.enabled = i === trackId;
      }
      currentAudioTrack = trackId;
    } catch {
      /* audio track API not available */
    }
  }

  function setSubtitleTrack(trackId: number) {
    try {
      const tracks = playerInstance?.textTracks?.() as unknown as VjsTextTrackList | undefined;
      if (!tracks) return;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t) continue;
        if (t.kind === 'metadata') continue;
        t.mode = i === trackId ? 'showing' : 'disabled';
      }
      currentSubtitleTrack = trackId;
    } catch {
      /* text track API not available */
    }
  }

  // ============================================================
  // Source switching (seamless — preserves seek position)
  // ============================================================

  function openSourceSwitcher() {
    showSourceSwitcher = true;
  }

  function closeSourceSwitcher() {
    showSourceSwitcher = false;
  }

  function switchToStream(stream: { provider: string; url: string; type: 'hls' | 'mp4' }) {
    // Capture current playback position BEFORE destroying the player.
    const savedTime = playerInstance?.currentTime() ?? 0;

    showSourceSwitcher = false;

    // Setting `activeStream` triggers the SINGLE $effect, which calls
    // `initPlayer` with the seek position. The pending position is
    // stashed in a module-level variable so the effect picks it up.
    pendingSeekPosition = savedTime > 5 ? savedTime : 0;
    activeStream = { provider: stream.provider, url: stream.url, type: stream.type };
  }

  // ============================================================
  // Event handlers
  // ============================================================

  function handleExit() {
    destroyPlayer();
    cleanupEventSource();
    if (controlsTimer) clearTimeout(controlsTimer);
    dispatch('exit');
  }

  function cleanupEventSource() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  /**
   * Phase 7 — Honest provider-card status. A card only becomes
   * `success` when the SSE event carried BOTH a valid URL AND a
   * supported media type ('hls' or 'mp4'). An `UNSUPPORTED` typed
   * error renders the card as `unavailable`.
   */
  function applySseResult(data: {
    provider?: string;
    status?: string;
    stream?: { url?: string; type?: string };
    error?: string;
    category?: string;
  }): void {
    if (!data.provider || !data.status) return;
    const providerName = data.provider;

    if (data.status === 'success' && data.stream?.url) {
      // Validate the URL is well-formed and the type is playable.
      const streamUrl = data.stream.url;
      try {
        const u = new URL(streamUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error('non-http(s) URL');
        }
      } catch {
        providers = providers.map((p) =>
          p.name === providerName
            ? { ...p, status: 'failed', error: 'No playable stream' }
            : p
        );
        return;
      }
      const streamType = data.stream.type === 'mp4' ? 'mp4' : 'hls';
      extractedStreams.push({ provider: providerName, url: streamUrl, type: streamType });
      providers = providers.map((p) =>
        p.name === providerName
          ? { ...p, status: 'success', streamUrl, streamType }
          : p
      );
    } else if (data.status === 'failed') {
      // Phase 7 — map UNSUPPORTED to the `unavailable` card state.
      const isUnsupported = data.category === 'UNSUPPORTED';
      const safeMessage = safeUserMessage(data.category, data.error);
      providers = providers.map((p) =>
        p.name === providerName
          ? { ...p, status: isUnsupported ? 'unavailable' : 'failed', error: safeMessage }
          : p
      );
    }
  }

  /**
   * Maps a typed error category to a safe user-facing message.
   * NEVER exposes provider internals / stack traces / signed URLs.
   */
  function safeUserMessage(category: string | undefined, fallback: string | undefined): string {
    switch (category) {
      case 'UNSUPPORTED':
        return 'Extractor unavailable';
      case 'NETWORK_ERROR':
        return 'Connection failed';
      case 'HTTP_ERROR':
        return 'Provider unavailable';
      case 'NO_STREAM':
        return 'No playable stream';
      case 'PARSER_ERROR':
        return 'No playable stream';
      case 'PLAYBACK_UNAVAILABLE':
        return 'No playable stream';
      default:
        return fallback ?? 'Failed';
    }
  }

  function selectStream(stream: { provider: string; url: string }) {
    // Find the stream type from the extractedStreams array.
    const extracted = extractedStreams.find((s) => s.url === stream.url);
    const type: 'hls' | 'mp4' = extracted?.type ?? 'hls';
    dispatch('streamselected', stream);
    activeStream = { provider: stream.provider, url: stream.url, type };
  }

  function backToScan() {
    destroyPlayer();
    activeStream = null;
  }

  onMount(() => {
    // Phase 7 — typed "Extractor unavailable" state when no worker URL
    // is configured. NO implicit localhost fallback in production.
    if (!mediaWorkerUrl) {
      providers = providers.map((p) => ({
        ...p,
        status: 'unavailable' as const,
        error: 'Extractor unavailable',
      }));
      scanComplete = true;
      return;
    }

    const params = new URLSearchParams({
      tmdbId: contentId,
      mediaType: contentType === 'anime' ? 'series' : contentType,
    });
    if (season !== undefined) params.set('season', String(season));
    if (episode !== undefined) params.set('episode', String(episode));

    const sseUrl = `${mediaWorkerUrl}/api/extract/stream?${params.toString()}`;

    try {
      eventSource = new EventSource(sseUrl);
    } catch {
      providers = providers.map((p) => ({ ...p, status: 'failed' as const, error: 'Connection unavailable' }));
      scanComplete = true;
      return;
    }

    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.status === 'done') {
          scanComplete = true;
          cleanupEventSource();
          return;
        }
        applySseResult(data);
      } catch {
        // Malformed SSE event — ignore.
      }
    };

    eventSource.onerror = () => {
      if (!scanComplete) {
        providers = providers.map((p) =>
          p.status === 'scanning' ? { ...p, status: 'failed' as const, error: 'Connection failed' } : p
        );
        scanComplete = true;
      }
      cleanupEventSource();
    };
  });

  onDestroy(() => {
    destroyPlayer();
    cleanupEventSource();
    if (controlsTimer) clearTimeout(controlsTimer);
  });
</script>

<div class="scraper-viewport" role="region" aria-label="Direct play">
  <!-- Exit button — top-left, always visible -->
  <button class="exit-btn" type="button" aria-label="Exit direct mode" onclick={handleExit}>
    <ArrowLeft size={18} />
    <span>Exit Direct Mode</span>
  </button>

  {#if !activeStream}
    <!-- ==================================================== -->
    <!-- Scanning / Provider Grid view                         -->
    <!-- ==================================================== -->
    <div class="scraper-center">
      <h1 class="scraper-title">{title}</h1>
      <p class="scraper-subtitle">{scanComplete ? 'Scan complete' : subtitle}</p>

      <div class="scraper-progress" role="progressbar" aria-label="Scanning progress" aria-valuenow={scanComplete ? 100 : 0} aria-valuemin={0} aria-valuemax={100}>
        <div class="scraper-progress-bar" class:done={scanComplete}></div>
      </div>

      <div class="provider-grid">
        {#each providers as provider (provider.name)}
          <button
            class="provider-card"
            data-status={provider.status}
            aria-label={`${provider.name} ${provider.status}`}
            disabled={provider.status !== 'success'}
            onclick={() => provider.status === 'success' && provider.streamUrl ? selectStream({ provider: provider.name, url: provider.streamUrl }) : undefined}
          >
            <div class="provider-icon">
              {#if provider.status === 'success'}
                <Check size={18} />
              {:else if provider.status === 'failed' || provider.status === 'unavailable'}
                <X size={18} />
              {:else}
                <LoaderCircle size={18} />
              {/if}
            </div>
            <span class="provider-name">{provider.name}</span>
            <span class="provider-status-label">
              {provider.status === 'success'
                ? 'Ready'
                : provider.status === 'failed'
                  ? 'Failed'
                  : provider.status === 'unavailable'
                    ? 'Unavailable'
                    : 'Scanning…'}
            </span>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <!-- ==================================================== -->
    <!-- Video.js player view (custom OTT controls)             -->
    <!-- ==================================================== -->
    <div class="player-container" role="region" aria-label="Video player" onpointermove={revealControls} onpointerleave={hideControlsNow}>
      <button class="back-to-scan-btn" type="button" aria-label="Back to source list" onclick={backToScan}>
        <ArrowLeft size={16} />
        <span>Sources</span>
      </button>

      {#if playerError}
        <div class="player-error" role="alert">
          <p>{playerError}</p>
          <button class="retry-btn" type="button" onclick={backToScan}>Choose another source</button>
        </div>
      {/if}

      <!-- Phase 7: Video.js wraps this <video> element. The data-setup
           is intentionally minimal — Video.js is constructed
           imperatively in initPlayer() so the effect can pass
           generation-aware options. -->
      <div data-vjs-player class="video-js-host">
        <video
          bind:this={videoElement}
          playsinline
          class="video-js vjs-default-skin vjs-big-play-centered"
          aria-label={`${activeStream?.provider ?? ''} stream playback`}
        ></video>
      </div>

      <!-- Custom OTT control overlay (preserved from Phase 4) -->
      <ScraperControls
        {isPlaying}
        {currentTime}
        {duration}
        {buffered}
        {muted}
        {showControls}
        qualities={qualities}
        {currentLevel}
        {audioTracks}
        {currentAudioTrack}
        {subtitleTracks}
        {currentSubtitleTrack}
        activeProvider={activeStream?.provider ?? ''}
        mediaWorkerUrl={mediaWorkerUrl ?? ''}
        activeStreamUrl={activeStream?.url ?? ''}
        ontoggleplay={togglePlay}
        onseek={seekTo}
        ontogglemute={toggleMute}
        onsetquality={setQuality}
        onsetaudio={setAudioTrack}
        onsetsubtitle={setSubtitleTrack}
        onopensources={openSourceSwitcher}
      />
    </div>

    <!-- Phase 7: Source switcher modal -->
    {#if showSourceSwitcher}
      <div class="source-switcher-overlay" role="presentation" onclick={closeSourceSwitcher} onkeydown={(e) => { if (e.key === 'Escape') closeSourceSwitcher(); }}>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="source-switcher-panel" role="dialog" aria-modal="true" aria-label="Available sources" tabindex="-1" onclick={(e) => e.stopPropagation()}>
          <div class="switcher-head">
            <span class="switcher-title">Available Sources</span>
            <button class="switcher-close" type="button" aria-label="Close" onclick={closeSourceSwitcher}>✕</button>
          </div>
          <div class="switcher-list">
            {#each extractedStreams as stream (stream.provider + stream.url)}
              <button
                class="switcher-item"
                class:active={stream.provider === activeStream?.provider}
                type="button"
                onclick={() => switchToStream(stream)}
              >
                <div class="switcher-item-icon">
                  {#if stream.provider === activeStream?.provider}<Check size={14} />{:else}<span></span>{/if}
                </div>
                <span class="switcher-item-name">{stream.provider}</span>
                <span class="switcher-item-type">{stream.type.toUpperCase()}</span>
              </button>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .scraper-viewport {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--base);
    overflow: hidden;
    padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
  }

  /* Exit button */
  .exit-btn {
    position: absolute;
    top: max(16px, env(safe-area-inset-top));
    left: max(16px, env(safe-area-inset-left));
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, .04);
    color: var(--ink-soft);
    font-size: .72rem;
    font-weight: 700;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
    backdrop-filter: blur(8px);
    z-index: 20;
  }
  .exit-btn:hover { background: rgba(255, 255, 255, .08); color: var(--ink); border-color: rgba(255, 255, 255, .28); }
  .exit-btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .exit-btn :global(svg) { flex-shrink: 0; }

  /* Center content (scanning view) */
  .scraper-center { display: flex; flex-direction: column; align-items: center; gap: 18px; max-width: 680px; width: 100%; text-align: center; }
  .scraper-title { margin: 0; font-size: clamp(1.4rem, 4vw, 2rem); font-weight: 850; letter-spacing: -.02em; color: var(--ink); line-height: 1.15; }
  .scraper-subtitle { margin: 0; font-size: clamp(.78rem, 2vw, .88rem); color: var(--muted); line-height: 1.4; }

  /* Progress bar */
  .scraper-progress { width: 100%; max-width: 420px; height: 4px; border-radius: 99px; background: var(--surface-2); overflow: hidden; margin-top: 4px; }
  .scraper-progress-bar { height: 100%; width: 100%; border-radius: 99px; background: linear-gradient(90deg, transparent, var(--ink), transparent); background-size: 200% 100%; animation: scraper-scan 1.6s linear infinite; }
  .scraper-progress-bar.done { animation: none; background: var(--success); opacity: .5; }
  @keyframes scraper-scan { 0% { background-position: -100% 0; } 100% { background-position: 100% 0; } }

  /* Provider grid */
  .provider-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; width: 100%; max-width: 560px; margin-top: 12px; }
  .provider-card { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 10px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); cursor: default; font: inherit; }
  .provider-card:not(:disabled) { cursor: pointer; }
  .provider-card:not(:disabled):hover { background: rgba(53, 214, 143, .08); }
  .provider-card[data-status='scanning'] { border-color: rgba(255, 255, 255, .12); }
  .provider-card[data-status='success'] { border-color: rgba(53, 214, 143, .35); background: rgba(53, 214, 143, .04); }
  .provider-card[data-status='failed'] { border-color: rgba(255, 176, 32, .35); background: rgba(255, 176, 32, .04); }
  .provider-card[data-status='unavailable'] { border-color: rgba(255, 255, 255, .12); background: rgba(255, 255, 255, .02); opacity: .7; }
  .provider-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--line); background: var(--surface-2); }
  .provider-card[data-status='scanning'] .provider-icon { color: var(--ink-soft); }
  .provider-card[data-status='scanning'] .provider-icon :global(svg) { animation: scraper-spin 1s linear infinite; }
  .provider-card[data-status='success'] .provider-icon { color: var(--success); border-color: rgba(53, 214, 143, .3); }
  .provider-card[data-status='failed'] .provider-icon { color: var(--warning); border-color: rgba(255, 176, 32, .3); }
  .provider-card[data-status='unavailable'] .provider-icon { color: var(--muted); border-color: var(--line); }
  @keyframes scraper-spin { to { transform: rotate(360deg); } }
  .provider-name { font-size: .72rem; font-weight: 700; color: var(--ink); letter-spacing: -.01em; }
  .provider-status-label { font-size: .58rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .provider-card[data-status='success'] .provider-status-label { color: var(--success); }
  .provider-card[data-status='failed'] .provider-status-label { color: var(--warning); }
  .provider-card[data-status='unavailable'] .provider-status-label { color: var(--muted); }

  /* Phase 7: Video.js player view */
  .player-container { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #000; }
  .video-js-host { width: 100%; height: 100%; }
  /* Video.js takes over the <video> — the vjs classes style it. */
  :global(.video-js) { width: 100%; height: 100%; }
  :global(.vjs-tech) { object-fit: contain; }

  .back-to-scan-btn { position: absolute; top: max(16px, env(safe-area-inset-top)); right: max(16px, env(safe-area-inset-right)); display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-md); background: rgba(0, 0, 0, .6); color: var(--ink-soft); font-size: .7rem; font-weight: 700; cursor: pointer; backdrop-filter: blur(8px); z-index: 20; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .back-to-scan-btn:hover { background: rgba(0, 0, 0, .8); color: var(--ink); }
  .back-to-scan-btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

  .player-error { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 16px; z-index: 25; color: var(--ink-soft); text-align: center; }
  .player-error p { margin: 0; font-size: .88rem; }
  .retry-btn { padding: 10px 18px; border: 1px solid var(--line-strong); border-radius: var(--radius-md); background: rgba(255, 255, 255, .06); color: var(--ink); font-size: .72rem; font-weight: 700; cursor: pointer; transition: background var(--motion-fast) var(--ease-out); }
  .retry-btn:hover { background: rgba(255, 255, 255, .1); }

  /* Phase 7: Source switcher modal */
  .source-switcher-overlay { position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .7); backdrop-filter: blur(8px); }
  .source-switcher-panel { width: min(100%, 380px); max-height: 70vh; overflow-y: auto; border: 1px solid var(--line-strong); border-radius: var(--radius-lg); background: var(--surface); padding: 16px; }
  .switcher-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .switcher-title { font-size: .82rem; font-weight: 800; color: var(--ink); }
  .switcher-close { border: 0; background: transparent; color: var(--muted); font-size: 1.1rem; cursor: pointer; padding: 4px; }
  .switcher-close:hover { color: var(--ink); }
  .switcher-list { display: flex; flex-direction: column; gap: 4px; }
  .switcher-item { display: flex; align-items: center; gap: 10px; padding: 10px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-soft); font: inherit; font-size: .72rem; font-weight: 600; cursor: pointer; transition: background 100ms ease, color 100ms ease; text-align: left; }
  .switcher-item:hover { background: rgba(255, 255, 255, .06); color: var(--ink); }
  .switcher-item.active { background: rgba(255, 255, 255, .1); color: var(--ink); }
  .switcher-item-icon { display: grid; place-items: center; width: 20px; height: 20px; color: var(--success); }
  .switcher-item-name { flex: 1; }
  .switcher-item-type { font-size: .55rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }

  /* Responsive */
  @media (max-width: 480px) {
    .provider-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
    .provider-card { padding: 12px 6px; }
    .scraper-title { font-size: 1.3rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .scraper-progress-bar { animation: none; opacity: .5; }
    .provider-icon :global(svg) { animation: none; }
  }
</style>
