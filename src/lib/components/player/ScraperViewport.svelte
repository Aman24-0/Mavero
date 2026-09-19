<script lang="ts">
  // Phase 2 — Direct Play / Scraper Mode: SSE-connected scanning viewport.
  //
  // This component connects to the media-worker's SSE endpoint
  // (GET /api/extract/stream) to receive real-time scraper results.
  // Each scraper result updates the provider card from 'scanning' to
  // 'success' or 'failed'. The extracted stream URLs are collected for
  // use by the future native video player (Phase 3).
  //
  // DESIGN CONTRACTS:
  //   * Uses Mavero's existing CSS variables (no hardcoded colors).
  //   * Card states: 'scanning' (spinner), 'success' (green check),
  //     'failed' (red cross).
  //   * The exit button dispatches a Svelte event so PlayerShell can
  //     set isScraperMode = false and remount the iframe.
  //   * EventSource is closed on destroy and on exit to prevent leaks.
  //   * Does NOT import or depend on PlaybackManager, PlayerViewport,
  //     or any resolver logic.

  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { ArrowLeft, Check, X, LoaderCircle } from 'lucide-svelte';

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

  // Provider state — now driven by SSE events instead of static mocks.
  type ProviderStatus = 'scanning' | 'success' | 'failed';
  type ProviderCard = { name: string; status: ProviderStatus; streamUrl?: string; error?: string };

  // The 4 providers that the backend scrapers will scan. These match
  // the scrapers registered in apps/media-worker/src/scrapers/index.ts.
  let providers = $state<ProviderCard[]>([
    { name: 'VidSrc', status: 'scanning' },
    { name: 'VidLink', status: 'scanning' },
    { name: 'Cineverse', status: 'scanning' },
    { name: 'SLast', status: 'scanning' },
  ]);

  // Extracted streams collected from SSE — for use by the future player.
  let extractedStreams: { provider: string; url: string; type: string }[] = [];

  // Scan completion state
  let scanComplete = $state(false);

  let eventSource: EventSource | null = null;

  function handleExit() {
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
  }

  onMount(() => {
    // Build the SSE endpoint URL with query params.
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
      // EventSource not available (SSR or unsupported browser) —
      // mark all providers as failed.
      providers = providers.map((p) => ({ ...p, status: 'failed' as const, error: 'Connection unavailable' }));
      scanComplete = true;
      return;
    }

    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        // Done event — all scrapers have settled.
        if (data.status === 'done') {
          scanComplete = true;
          cleanupEventSource();
          return;
        }

        // Provider result event — update the matching card.
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
        // Malformed SSE event — ignore (the connection stays open).
      }
    };

    eventSource.onerror = () => {
      // EventSource fires 'error' on connection failure AND on normal
      // close (when the server sends done + end). If we haven't received
      // 'done' yet, mark remaining scanning providers as failed.
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
    cleanupEventSource();
  });
</script>

<div class="scraper-viewport" role="region" aria-label="Direct play scanning">
  <!-- Exit button — top-left, always visible -->
  <button class="exit-btn" type="button" aria-label="Exit direct mode" onclick={handleExit}>
    <ArrowLeft size={18} />
    <span>Exit Direct Mode</span>
  </button>

  <!-- Centered scanning content -->
  <div class="scraper-center">
    <h1 class="scraper-title">{title}</h1>
    <p class="scraper-subtitle">{scanComplete ? 'Scan complete' : subtitle}</p>

    <!-- CSS-animated progress bar (stops animating when scan is done) -->
    <div class="scraper-progress" role="progressbar" aria-label="Scanning progress" aria-valuenow={scanComplete ? 100 : 0} aria-valuemin={0} aria-valuemax={100}>
      <div class="scraper-progress-bar" class:done={scanComplete}></div>
    </div>

    <!-- Provider grid -->
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
    z-index: 5;
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
  .exit-btn :global(svg) {
    flex-shrink: 0;
  }

  /* Center content */
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
  .provider-card:not(:disabled) {
    cursor: pointer;
  }
  .provider-card:not(:disabled):hover {
    background: rgba(53, 214, 143, .08);
  }

  /* Card status states */
  .provider-card[data-status='scanning'] {
    border-color: rgba(255, 255, 255, .12);
  }
  .provider-card[data-status='success'] {
    border-color: rgba(53, 214, 143, .35);
    background: rgba(53, 214, 143, .04);
  }
  .provider-card[data-status='failed'] {
    border-color: rgba(255, 176, 32, .35);
    background: rgba(255, 176, 32, .04);
  }

  .provider-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: var(--surface-2);
  }
  .provider-card[data-status='scanning'] .provider-icon {
    color: var(--ink-soft);
  }
  .provider-card[data-status='scanning'] .provider-icon :global(svg) {
    animation: scraper-spin 1s linear infinite;
  }
  .provider-card[data-status='success'] .provider-icon {
    color: var(--success);
    border-color: rgba(53, 214, 143, .3);
  }
  .provider-card[data-status='failed'] .provider-icon {
    color: var(--warning);
    border-color: rgba(255, 176, 32, .3);
  }
  @keyframes scraper-spin { to { transform: rotate(360deg); } }

  .provider-name {
    font-size: .72rem;
    font-weight: 700;
    color: var(--ink);
    letter-spacing: -.01em;
  }
  .provider-status-label {
    font-size: .58rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .provider-card[data-status='success'] .provider-status-label {
    color: var(--success);
  }
  .provider-card[data-status='failed'] .provider-status-label {
    color: var(--warning);
  }

  /* Responsive */
  @media (max-width: 480px) {
    .provider-grid {
      grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
      gap: 8px;
    }
    .provider-card {
      padding: 12px 6px;
    }
    .scraper-title {
      font-size: 1.3rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .scraper-progress-bar { animation: none; opacity: .5; }
    .provider-icon :global(svg) { animation: none; }
  }
</style>
