<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    TVFocusCoordinator,
    canExitApplication,
    createTVNavigation,
    exitApplication,
    getTVRemoteAction,
    isTizen,
    isTizenBrewHostedModule,
    type TVRemoteEvent,
    type TVScreen
  } from '$lib/tv';
  import type { MediaItem } from '$data/content';
  import TvError from './TvError.svelte';
  import TvHeader from './TvHeader.svelte';
  import TvHero from './TvHero.svelte';
  import TvLoading from './TvLoading.svelte';
  import TvMediaRail from './TvMediaRail.svelte';
  import TvNav from './TvNav.svelte';

  type ActionTarget = HTMLElement & { dataset: DOMStringMap };
  type AsyncState = 'loading' | 'ready' | 'error';
  type DiscoverData = {
    featured?: MediaItem;
    movies: MediaItem[];
    series: MediaItem[];
    anime: MediaItem[];
    popularMovies?: MediaItem[];
    popularSeries?: MediaItem[];
    popularAnime?: MediaItem[];
    errorMessage?: string;
  };

  const emptyDiscover: DiscoverData = { movies: [], series: [], anime: [] };

  let {
    discover = emptyDiscover
  }: {
    discover?: DiscoverData;
  } = $props();

  let root: HTMLElement;
  let coordinator: TVFocusCoordinator;
  const navigation = createTVNavigation();

  let screen = $state<TVScreen>('home');
  let exitDialogOpen = $state(false);
  let previousFocusId = $state<string | null>(null);
  let asyncState = $state<AsyncState>('ready');
  let errorMessage = $state('The Discover section did not respond.');
  let statusMessage = $state('Ready for real Discover content.');
  let selectedTitle = $state<string | null>(null);
  let exitCapability = $state('Browser-safe mode');
  let lastActivationKey = '';
  let lastActivationAt = 0;

  const navItems: Array<{ id: string; label: string; screen: TVScreen }> = [
    { id: 'tv-nav-home', label: 'Home', screen: 'home' },
    { id: 'tv-nav-search', label: 'Search', screen: 'search' },
    { id: 'tv-nav-list', label: 'My List', screen: 'my-list' },
    { id: 'tv-nav-settings', label: 'Settings', screen: 'settings' }
  ];

  onMount(() => {
    coordinator = new TVFocusCoordinator(root);
    coordinator.initialize('tv-nav-home');
    exitCapability = isTizenBrewHostedModule()
      ? 'TizenBrew host-return mode'
      : isTizen() && canExitApplication()
        ? 'Tizen standalone exit API available'
        : 'Browser-safe mode';

    const handleKeydown = (event: KeyboardEvent) => {
      const action = getTVRemoteAction(event as TVRemoteEvent);
      if (!action) return;

      if (action === 'back') {
        event.preventDefault();
        handleBack();
        return;
      }

      if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
        event.preventDefault();
        coordinator.move(action, exitDialogOpen ? 'tv-exit' : undefined);
        return;
      }

      if (action === 'enter') {
        event.preventDefault();
        const active = document.activeElement;
        if (active instanceof HTMLElement && root.contains(active)) active.click();
      }
    };

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      coordinator.destroy();
    };
  });

  function hasDiscoverContent(data: DiscoverData) {
    return Boolean(data.featured || data.movies.length || data.series.length || data.anime.length);
  }

  function handleBack() {
    if (exitDialogOpen) {
      cancelExit();
      return;
    }

    const previous = navigation.goBack();
    if (previous) {
      screen = previous.screen;
      asyncState = discover.errorMessage && !hasDiscoverContent(discover) ? 'error' : 'ready';
      statusMessage = `Returned to ${screenLabel(screen)}.`;
      restoreAfterRender([previous.focusId, `tv-nav-${screen}`, 'tv-nav-home']);
      return;
    }

    openExitConfirmation();
  }

  function openExitConfirmation() {
    previousFocusId = coordinator.rememberFocus();
    exitDialogOpen = true;
    statusMessage = 'Exit confirmation opened.';
    restoreAfterRender(['tv-exit-cancel']);
  }

  function cancelExit() {
    exitDialogOpen = false;
    statusMessage = 'Exit cancelled. Focus restored.';
    const restoreId = previousFocusId;
    previousFocusId = null;
    restoreAfterRender([restoreId, `tv-nav-${screen}`, 'tv-nav-home']);
  }

  function confirmExit() {
    const result = exitApplication();
    if (result.ok && result.reason === 'host-returned') {
      exitDialogOpen = false;
      previousFocusId = null;
      statusMessage = 'Returning to the TizenBrew host.';
      return;
    }

    if (result.ok && result.reason === 'native-requested') {
      exitDialogOpen = false;
      previousFocusId = null;
      statusMessage = 'Native Tizen exit requested for the standalone application.';
      return;
    }

    exitDialogOpen = false;
    statusMessage = 'Native Tizen exit is unavailable in this browser preview.';
    const restoreId = previousFocusId;
    previousFocusId = null;
    restoreAfterRender([restoreId, `tv-nav-${screen}`, 'tv-nav-home']);
  }

  function handleAction(event: MouseEvent, explicitFocusId?: string, explicitAction?: string) {
    const target = event.currentTarget as ActionTarget;
    const focusId = explicitFocusId ?? target.dataset.tvFocusId ?? '';
    const now = performance.now();
    if (focusId && focusId === lastActivationKey && now - lastActivationAt < 180) return;
    lastActivationKey = focusId;
    lastActivationAt = now;
    const action = explicitAction ?? target.dataset.tvAction ?? '';

    if (action.startsWith('screen:')) {
      const nextScreen = action.slice('screen:'.length) as TVScreen;
      if (nextScreen === screen) {
        statusMessage = `${screenLabel(nextScreen)} is already active.`;
        return;
      }
      navigation.rememberFocus(focusId || null);
      navigation.open(nextScreen, focusId || null);
      screen = nextScreen;
      asyncState = 'ready';
      statusMessage = `${screenLabel(nextScreen)} is ready for remote navigation.`;
      return;
    }

    if (action === 'retry') {
      statusMessage = 'Retrying Discover content.';
      globalThis.location.reload();
      return;
    }

    if (action === 'placeholder') {
      statusMessage = `${screenLabel(screen)} TV content is reserved for its roadmap phase.`;
      return;
    }

    if (action === 'quit') {
      openExitConfirmation();
      return;
    }

    if (action === 'cancel-exit') {
      cancelExit();
      return;
    }

    if (action === 'confirm-exit') confirmExit();
  }

  function handleMediaSelect(item: MediaItem, _event: MouseEvent, _focusId: string) {
    selectedTitle = item.title;
    statusMessage = `Selected ${item.title}. Detail actions are not wired in this Discover slice.`;
  }

  function restoreAfterRender(ids: Array<string | null>) {
    void tick().then(() => {
      const restore = (attempt = 0) => {
        if (coordinator.restoreFirst(ids)) return;
        if (attempt < 20) {
          setTimeout(() => restore(attempt + 1), 20);
          return;
        }
        coordinator.focusFirst();
      };

      const schedule = () => restore();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(schedule));
      } else {
        setTimeout(schedule, 0);
      }
    });
  }

  function screenLabel(value: TVScreen) {
    return value === 'my-list' ? 'My List' : value[0].toUpperCase() + value.slice(1);
  }
</script>

<div class="tv-page" bind:this={root} data-tv-screen={screen}>
  <TvHeader {exitCapability} />

  <main class="tv-main" aria-label="Mavero TV shell">
    <TvNav items={navItems} activeScreen={screen} onActivate={(item, event) => handleAction(event, item.id, `screen:${item.screen}`)} />

    <section class="tv-hero" aria-labelledby="tv-shell-title">
      <div>
        <p class="eyebrow">Phase 3 / Discover TV experience</p>
        <h1 id="tv-shell-title">Mavero, made for the big screen.</h1>
        <p class="hero-copy">Real Discover content through the existing server contract, presented with remote-first focus and TV-sized targets.</p>
      </div>
      <div class="hero-status" aria-live="polite">
        <span class="status-label">Current section</span>
        <strong>{screenLabel(screen)}</strong>
        <span>{selectedTitle ? `Selected: ${selectedTitle}` : discover.errorMessage ?? statusMessage}</span>
      </div>
    </section>

    {#if screen === 'home'}
      <section class="tv-section tv-discover" aria-label="Discover TV content" aria-busy={asyncState === 'loading'}>
        {#if asyncState === 'error' || (Boolean(discover.errorMessage) && !hasDiscoverContent(discover))}
          <TvError message={discover.errorMessage ?? errorMessage} onRetry={(event) => handleAction(event, 'tv-retry', 'retry')} />
        {:else if !hasDiscoverContent(discover)}
          <TvLoading label="Loading Discover content…" />
        {:else}
          {#if discover.featured}
            <TvHero item={discover.featured} onSelect={handleMediaSelect} />
          {/if}
          <TvMediaRail title="Movies" eyebrow="Discover / films" railId="tv-rail-movies" items={discover.movies} onSelect={handleMediaSelect} />
          <TvMediaRail title="Series" eyebrow="Discover / series" railId="tv-rail-series" items={discover.series} onSelect={handleMediaSelect} />
          <TvMediaRail title="Anime" eyebrow="Discover / anime" railId="tv-rail-anime" items={discover.anime} onSelect={handleMediaSelect} />
        {/if}
      </section>
    {:else}
      <section class="tv-section" aria-labelledby="tv-placeholder-title">
        <div class="placeholder-panel">
          <p class="eyebrow">TV roadmap placeholder</p>
          <h2 id="tv-placeholder-title">{screenLabel(screen)} is ready for a later TV phase.</h2>
          <p>Phase 3 connects Discover data first. This route stays remote-safe without duplicating the Web/PWA feature before its planned TV phase.</p>
          <button class="tv-focusable tv-action-button" data-tv-focusable="true" data-tv-focus-id="tv-placeholder-action" data-tv-focus-group="tv-placeholder" data-tv-action="placeholder" type="button" onclick={handleAction}>Keep browsing Home</button>
        </div>
      </section>
    {/if}

    <section class="tv-footer-actions" aria-label="TV exit actions">
      <div class="footer-note">
        <span class="eyebrow">Exit policy</span>
        <span>Back closes local states, restores logical focus, and confirms only at the TV root. Samsung’s dedicated Exit key is not intercepted.</span>
      </div>
      <button class="tv-focusable quit-button" data-tv-focusable="true" data-tv-focus-id="tv-quit" data-tv-focus-group="tv-footer-actions" data-tv-action="quit" type="button" onclick={handleAction}>Quit Mavero</button>
    </section>
  </main>

  {#if exitDialogOpen}
    <div class="exit-layer" role="presentation">
      <div class="exit-backdrop" aria-hidden="true"></div>
      <div class="exit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="exit-title" aria-describedby="exit-description">
        <p class="eyebrow">Mavero / Exit</p>
        <h2 id="exit-title">Exit Mavero?</h2>
        <p id="exit-description">Return to the TV home screen. Cancel keeps the application open and restores your previous focus.</p>
        <div class="exit-actions">
          <button class="tv-focusable exit-button cancel" data-tv-focusable="true" data-tv-focus-id="tv-exit-cancel" data-tv-focus-group="tv-exit" data-tv-action="cancel-exit" type="button" onclick={handleAction}>Cancel</button>
          <button class="tv-focusable exit-button confirm" data-tv-focusable="true" data-tv-focus-id="tv-exit-confirm" data-tv-focus-group="tv-exit" data-tv-action="confirm-exit" type="button" onclick={handleAction}>Exit</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .tv-page { --tv-bg: #080a0f; --tv-surface: rgba(20, 24, 34, .94); --tv-surface-soft: rgba(255, 255, 255, .055); --tv-line: rgba(255, 255, 255, .12); --tv-muted: #9da5b7; --tv-ink: #f7f8fb; --tv-accent: #ff3e5e; min-height: 100dvh; color: var(--tv-ink); background: radial-gradient(circle at 82% 0%, rgba(255, 62, 94, .14), transparent 30%), radial-gradient(circle at 0% 90%, rgba(77, 116, 255, .1), transparent 28%), var(--tv-bg); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
  .tv-main { width: min(100%, 1440px); margin-inline: auto; padding: 14px 56px 52px; }
  .tv-focusable { outline: none; }
  .tv-focusable:focus-visible, .tv-focusable[data-tv-focus-id]:focus { border-color: #fff; box-shadow: 0 0 0 4px rgba(255, 62, 94, .8), 0 0 0 8px rgba(255, 62, 94, .16); }
  .tv-hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, .65fr); align-items: end; gap: 36px; padding: clamp(48px, 9vw, 118px) 6px 56px; border-bottom: 1px solid var(--tv-line); }
  .eyebrow { margin: 0 0 10px; color: var(--tv-accent); font-size: .62rem; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; }
  .tv-hero h1 { max-width: 720px; margin: 0; font-size: clamp(2.8rem, 6vw, 6rem); font-weight: 850; letter-spacing: -.075em; line-height: .96; }
  .hero-copy { max-width: 680px; margin: 22px 0 0; color: var(--tv-muted); font-size: clamp(.9rem, 1.4vw, 1.1rem); line-height: 1.65; }
  .hero-status { display: grid; gap: 8px; padding: 22px; border: 1px solid var(--tv-line); border-radius: 16px; background: var(--tv-surface); }
  .status-label { color: var(--tv-muted); font-size: .62rem; letter-spacing: .12em; text-transform: uppercase; }
  .hero-status strong { font-size: 1.2rem; }
  .hero-status span:last-child { color: var(--tv-muted); font-size: .8rem; line-height: 1.5; }
  .tv-section { padding: 44px 6px 0; }
  .tv-discover { padding-top: 38px; }
  .placeholder-panel { display: grid; max-width: 760px; gap: 12px; padding: 34px; border: 1px solid var(--tv-line); border-radius: 17px; background: var(--tv-surface); }
  .placeholder-panel h2 { margin: 0; font-size: clamp(1.7rem, 3vw, 2.5rem); letter-spacing: -.05em; }
  .placeholder-panel p:not(.eyebrow) { max-width: 620px; margin: 0; color: var(--tv-muted); line-height: 1.6; }
  .tv-action-button { width: fit-content; padding: 14px 18px; border: 1px solid rgba(255,255,255,.16); border-radius: 11px; color: var(--tv-ink); background: var(--tv-surface-soft); font-size: .82rem; font-weight: 800; cursor: pointer; }
  .tv-footer-actions { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin: 46px 6px 0; padding-top: 24px; border-top: 1px solid var(--tv-line); }
  .footer-note { display: grid; gap: 5px; max-width: 760px; color: var(--tv-muted); font-size: .76rem; line-height: 1.5; }
  .footer-note .eyebrow { margin: 0; }
  .quit-button { min-width: 176px; padding: 15px 20px; border: 1px solid rgba(255, 62, 94, .48); border-radius: 11px; color: #fff; background: rgba(255, 62, 94, .14); font-size: .82rem; font-weight: 850; cursor: pointer; }
  .exit-layer { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 30px; }
  .exit-backdrop { position: absolute; inset: 0; background: rgba(2, 4, 8, .84); }
  .exit-dialog { position: relative; width: min(100%, 560px); padding: 36px; border: 1px solid rgba(255,255,255,.18); border-radius: 20px; background: #151925; box-shadow: 0 30px 120px rgba(0,0,0,.6); }
  .exit-dialog h2 { margin: 0; font-size: clamp(2rem, 4vw, 3.2rem); letter-spacing: -.07em; }
  .exit-dialog > p:not(.eyebrow) { max-width: 440px; margin: 14px 0 0; color: var(--tv-muted); line-height: 1.6; }
  .exit-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 30px; }
  .exit-button { min-width: 138px; padding: 15px 20px; border: 1px solid rgba(255,255,255,.18); border-radius: 11px; color: var(--tv-ink); background: var(--tv-surface-soft); font-size: .82rem; font-weight: 800; cursor: pointer; }
  .exit-button.confirm { border-color: var(--tv-accent); color: #fff; background: var(--tv-accent); }
  @media (max-width: 760px) { .tv-main { padding-inline: 22px; } .tv-hero { grid-template-columns: 1fr; padding-top: 58px; } .tv-footer-actions { align-items: flex-start; flex-direction: column; } .quit-button { width: 100%; } }
</style>
