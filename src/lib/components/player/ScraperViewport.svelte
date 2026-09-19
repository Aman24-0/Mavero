<script lang="ts">
  // Phase 3 — Direct Play / Scraper Mode: Native HLS player integration.
  //
  // This component connects to the media-worker's SSE endpoint
  // (GET /api/extract/stream) to receive real-time scraper results.
  // When a user selects a successful stream, the scanning grid
  // transitions to a native HTML5 <video> element using hls.js for
  // HLS playback.
  //
  // DESIGN CONTRACTS:
  //   * Uses Mavero's existing CSS variables (no hardcoded colors).
  //   * Card states: 'scanning' (spinner), 'success' (green check),
  //     'failed' (red cross).
  //   * The exit button dispatches a Svelte event so PlayerShell can
  //     set isScraperMode = false and remount the iframe.
  //   * EventSource is closed on destroy and on exit to prevent leaks.
  //   * HLS instance is destroyed on stream switch, exit, and unmount.
  //   * Does NOT import or depend on PlaybackManager, PlayerViewport,
  //     or any resolver logic.

  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { ArrowLeft, Check, X, LoaderCircle } from 'lucide-svelte';
  import Hls from 'hls.js';
  import type { ErrorData } from 'hls.js';

  // Props (Svelte 5 runes mode — matches PlayerShell)
  let {
    title = 'Direct Play',
    subtitle = 'Scanning high-speed servers…',
    contentId = '',
    contentType = 'movie' as 'movie' | 'series' | 'anime',
    season = undefined as number | undefined,
    episode = undefined as number | undefined,
    mediaWorkerUrl = 'http://127.0.0.1:8787',
  }: {
    title?: string;
    subtitle?: string;
    contentId?: string;
    contentType?: 'movie' | 'series' | 'anime';
    season?: number | undefined;
    episode?: number | undefined;
    mediaWorkerUrl?: string;
  } = $props();

  const dispatch = createEventDispatcher<{ exit: void; streamselected: { url: string; provider: string } }>();

  // Provider state — driven by SSE events.
  type ProviderStatus = 'scanning' | 'success' | 'failed';
  type ProviderCard = { name: string; status: ProviderStatus; streamUrl?: string; error?: string };

  let providers = $state<ProviderCard[]>([
    { name: 'VidSrc', status: 'scanning' },
    { name: 'VidLink', status: 'scanning' },
    { name: 'Cineverse', status: 'scanning' },
    { name: 'SLast', status: 'scanning' },
  ]);

  // Extracted streams collected from SSE.
  let extractedStreams: { provider: string; url: string; type: string }[] = [];

  // Scan completion state
  let scanComplete = $state(false);

  // Phase 3: Native player state
  type ActiveStream = { provider: string; url: string; type: string } | null;
  let activeStream = $state<ActiveStream>(null);
  let videoElement = $state<HTMLVideoElement | null>(null);
  let hlsInstance: Hls | null = null;
  let playerError = $state<string>('');

  let eventSource: EventSource | null = null;

  // ============================================================
  // Phase 3: HLS player lifecycle
  // ============================================================

  /**
   * Initializes the HLS player for the given stream URL.
   * Uses hls.js for browsers that don't support native HLS (Chrome, Firefox).
   * Falls back to native HLS for Safari.
   */
  function initPlayer(streamUrl: string): void {
    // Destroy any existing instance first (stream switch).
    destroyPlayer();

    if (!videoElement) return;

    playerError = '';

    // Check if hls.js is supported (Chrome, Firefox, Edge).
    if (Hls.isSupported()) {
      hlsInstance = new Hls();
      hlsInstance.loadSource(streamUrl);
      hlsInstance.attachMedia(videoElement);

      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        void videoElement?.play().catch(() => {
          // Autoplay was blocked — the user needs to interact.
          // The native controls are visible, so they can press play.
        });
      });

      hlsInstance.on(Hls.Events.ERROR, (_event: unknown, data: ErrorData) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Try to recover network errors.
              hlsInstance?.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              // Try to recover media errors.
              hlsInstance?.recoverMediaError();
              break;
            default:
              // Unrecoverable error — destroy and show error.
              playerError = 'Stream playback failed. Try another source.';
              destroyPlayer();
              break;
          }
        }
      });
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS support.
      videoElement.src = streamUrl;
      void videoElement.play().catch(() => {
        // Autoplay blocked — user can press play via native controls.
      });
    } else {
      playerError = 'HLS playback is not supported in this browser.';
    }
  }

  /**
   * Destroys the HLS instance and cleans up the video element.
   * Called on stream switch, exit, and component unmount.
   */
  function destroyPlayer(): void {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    if (videoElement) {
      videoElement.removeAttribute('src');
      videoElement.load();
    }
    playerError = '';
  }

  // Phase 3: $effect — initialize the player when both activeStream
  // and videoElement become truthy (i.e., when the user selects a
  // stream and the <video> element has been rendered).
  $effect(() => {
    if (activeStream && videoElement) {
      initPlayer(activeStream.url);
    }
  });

  // ============================================================
  // Event handlers
  // ============================================================

  function handleExit() {
    destroyPlayer();
    cleanupEventSource();
    dispatch('exit');
  }

  function cleanupEventSource() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  function selectStream(stream: { provider: string; url: string }) {
    dispatch('streamselected', stream);
    // Phase 3: transition to the native player.
    activeStream = { provider: stream.provider, url: stream.url, type: 'hls' };
  }

  function backToScan() {
    destroyPlayer();
    activeStream = null;
  }

  onMount(() => {
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

        if (data.provider && data.status) {
          providers = providers.map((p) => {
            if (p.name !== data.provider) return p;
            if (data.status === 'success' && data.stream) {
              extractedStreams.push({ provider: data.provider, url: data.stream.url, type: data.stream.type });
              return { ...p, status: 'success' as const, streamUrl: data.stream.url };
            } else if (data.status === 'failed') {
              return { ...p, status: 'failed' as const, error: data.error ?? 'Failed' };
            }
            return p;
          });
        }
      } catch {
        // Malformed SSE event — ignore.
      }
    };

    eventSource.onerror = () => {
      if (!scanComplete) {
        providers = providers.map((p) =>
          p.status === 'scanning' ? { ...p, status: 'failed' as const, error: 'Connection lost' } : p
        );
        scanComplete = true;
      }
      cleanupEventSource();
    };
  });

  onDestroy(() => {
    destroyPlayer();
    cleanupEventSource();
  });
</script>

<div class="scraper-viewport" role="region" aria-label="Direct play">
  <!-- Exit button — top-left, always visible (overlaid on both scanning and player views) -->
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
              {:else if provider.status === 'failed'}
                <X size={18} />
              {:else}
                <LoaderCircle size={18} />
              {/if}
            </div>
            <span class="provider-name">{provider.name}</span>
            <span class="provider-status-label">
              {provider.status === 'success' ? 'Ready' : provider.status === 'failed' ? 'Failed' : 'Scanning…'}
            </span>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <!-- ==================================================== -->
    <!-- Native HLS player view                               -->
    <!-- ==================================================== -->
    <div class="player-container">
      <!-- Back-to-scan button — lets the user pick another source -->
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

      <video
        bind:this={videoElement}
        controls
        playsinline
        autoplay
        class="native-video"
        aria-label={`${activeStream.provider} stream playback`}
      ></video>
    </div>
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
  .exit-btn:hover {
    background: rgba(255, 255, 255, .08);
    color: var(--ink);
    border-color: rgba(255, 255, 255, .28);
  }
  .exit-btn:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }
  .exit-btn :global(svg) { flex-shrink: 0; }

  /* Center content (scanning view) */
  .scraper-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    max-width: 680px;
    width: 100%;
    text-align: center;
  }

  .scraper-title {
    margin: 0;
    font-size: clamp(1.4rem, 4vw, 2rem);
    font-weight: 850;
    letter-spacing: -.02em;
    color: var(--ink);
    line-height: 1.15;
  }

  .scraper-subtitle {
    margin: 0;
    font-size: clamp(.78rem, 2vw, .88rem);
    color: var(--muted);
    line-height: 1.4;
  }

  /* Progress bar */
  .scraper-progress {
    width: 100%;
    max-width: 420px;
    height: 4px;
    border-radius: 99px;
    background: var(--surface-2);
    overflow: hidden;
    margin-top: 4px;
  }
  .scraper-progress-bar {
    height: 100%;
    width: 100%;
    border-radius: 99px;
    background: linear-gradient(90deg, transparent, var(--ink), transparent);
    background-size: 200% 100%;
    animation: scraper-scan 1.6s linear infinite;
  }
  .scraper-progress-bar.done {
    animation: none;
    background: var(--success);
    opacity: .5;
  }
  @keyframes scraper-scan {
    0% { background-position: -100% 0; }
    100% { background-position: 100% 0; }
  }

  /* Provider grid */
  .provider-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 12px;
    width: 100%;
    max-width: 560px;
    margin-top: 12px;
  }

  .provider-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 16px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--surface);
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
    cursor: default;
    font: inherit;
  }
  .provider-card:not(:disabled) { cursor: pointer; }
  .provider-card:not(:disabled):hover { background: rgba(53, 214, 143, .08); }

  .provider-card[data-status='scanning'] { border-color: rgba(255, 255, 255, .12); }
  .provider-card[data-status='success'] { border-color: rgba(53, 214, 143, .35); background: rgba(53, 214, 143, .04); }
  .provider-card[data-status='failed'] { border-color: rgba(255, 176, 32, .35); background: rgba(255, 176, 32, .04); }

  .provider-icon {
    display: grid; place-items: center;
    width: 36px; height: 36px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: var(--surface-2);
  }
  .provider-card[data-status='scanning'] .provider-icon { color: var(--ink-soft); }
  .provider-card[data-status='scanning'] .provider-icon :global(svg) { animation: scraper-spin 1s linear infinite; }
  .provider-card[data-status='success'] .provider-icon { color: var(--success); border-color: rgba(53, 214, 143, .3); }
  .provider-card[data-status='failed'] .provider-icon { color: var(--warning); border-color: rgba(255, 176, 32, .3); }
  @keyframes scraper-spin { to { transform: rotate(360deg); } }

  .provider-name { font-size: .72rem; font-weight: 700; color: var(--ink); letter-spacing: -.01em; }
  .provider-status-label { font-size: .58rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .provider-card[data-status='success'] .provider-status-label { color: var(--success); }
  .provider-card[data-status='failed'] .provider-status-label { color: var(--warning); }

  /* ============================================================ */
  /* Phase 3: Native player view                                  */
  /* ============================================================ */

  .player-container {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
  }

  .native-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }

  .back-to-scan-btn {
    position: absolute;
    top: max(16px, env(safe-area-inset-top));
    right: max(16px, env(safe-area-inset-right));
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, .6);
    color: var(--ink-soft);
    font-size: .7rem;
    font-weight: 700;
    cursor: pointer;
    backdrop-filter: blur(8px);
    z-index: 20;
    transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  }
  .back-to-scan-btn:hover {
    background: rgba(0, 0, 0, .8);
    color: var(--ink);
  }
  .back-to-scan-btn:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  .player-error {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    z-index: 25;
    color: var(--ink-soft);
    text-align: center;
  }
  .player-error p { margin: 0; font-size: .88rem; }

  .retry-btn {
    padding: 10px 18px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, .06);
    color: var(--ink);
    font-size: .72rem;
    font-weight: 700;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out);
  }
  .retry-btn:hover { background: rgba(255, 255, 255, .1); }

  /* Responsive */
  @media (max-width: 480px) {
    .provider-grid {
      grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
      gap: 8px;
    }
    .provider-card { padding: 12px 6px; }
    .scraper-title { font-size: 1.3rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .scraper-progress-bar { animation: none; opacity: .5; }
    .provider-icon :global(svg) { animation: none; }
  }
</style>
