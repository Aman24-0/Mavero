<script lang="ts">
  // Phase 1 — Direct Play / Scraper Mode: Scanning Viewport.
  //
  // This component is the container for the scraping process and will
  // eventually host the native video player. In Phase 1, it shows:
  //   * A title (passed via prop, falls back to a generic label)
  //   * A subtitle "Scanning high-speed servers..."
  //   * A CSS-animated horizontal progress bar
  //   * A responsive grid of provider cards (mocked)
  //   * An "Exit Direct Mode" button that dispatches `exit`
  //
  // DESIGN CONTRACTS:
  //   * Uses Mavero's existing CSS variables (no hardcoded colors).
  //   * Card states: 'scanning' (spinner), 'success' (green check),
  //     'failed' (red cross). All start as 'scanning' in Phase 1.
  //   * The exit button dispatches a Svelte event so PlayerShell can
  //     set isScraperMode = false and remount the iframe.
  //   * Does NOT import or depend on PlaybackManager, PlayerViewport,
  //     or any resolver logic. Purely a presentational component.

  import { ArrowLeft, Check, X, LoaderCircle } from 'lucide-svelte';

  // Props
  export let title = 'Direct Play';
  export let subtitle = 'Scanning high-speed servers…';

  // Mock provider list for Phase 1. These names match the existing
  // resolver adapters in the codebase (VidSrc, VidY, Cineverse, SLast,
  // FilmU, CinemaOS) so the UI is representative of real scanning.
  type ProviderStatus = 'scanning' | 'success' | 'failed';
  type MockProvider = { name: string; status: ProviderStatus };

  const providers: MockProvider[] = [
    { name: 'VidSrc', status: 'scanning' },
    { name: 'VidY', status: 'scanning' },
    { name: 'Cineverse', status: 'scanning' },
    { name: 'SLast', status: 'scanning' },
    { name: 'FilmU', status: 'scanning' },
    { name: 'CinemaOS', status: 'scanning' },
  ];

  // Dispatch exit event — PlayerShell listens and sets isScraperMode = false.
  function handleExit() {
    dispatch('exit');
  }

  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher<{ exit: void }>();
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
    <p class="scraper-subtitle">{subtitle}</p>

    <!-- CSS-animated progress bar -->
    <div class="scraper-progress" role="progressbar" aria-label="Scanning progress" aria-valuenow={0} aria-valuemin={0} aria-valuemax={100}>
      <div class="scraper-progress-bar"></div>
    </div>

    <!-- Provider grid -->
    <div class="provider-grid">
      {#each providers as provider (provider.name)}
        <div class="provider-card" data-status={provider.status} role="status" aria-label={`${provider.name} ${provider.status}`}>
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
        </div>
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
