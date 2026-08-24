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
  import TvError from './TvError.svelte';
  import TvHeader from './TvHeader.svelte';
  import TvLoading from './TvLoading.svelte';
  import TvNav from './TvNav.svelte';
  import TvRail, { type TVRailCard } from './TvRail.svelte';

  type ActionTarget = HTMLElement & { dataset: DOMStringMap };
  type AsyncState = 'ready' | 'loading' | 'error';

  let root: HTMLElement;
  let coordinator: TVFocusCoordinator;
  const navigation = createTVNavigation();

  let screen = $state<TVScreen>('home');
  let exitDialogOpen = $state(false);
  let previousFocusId = $state<string | null>(null);
  let demoOriginFocusId = $state<string | null>(null);
  let demoDepth = $state(0);
  let asyncState = $state<AsyncState>('ready');
  let asyncOriginFocusId: string | null = null;
  let errorMessage = $state('The TV section did not respond.');
  let statusMessage = $state('Ready for remote navigation.');
  let exitCapability = $state('Browser-safe mode');
  let lastActivationKey = '';
  let lastActivationAt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const navItems: Array<{ id: string; label: string; screen: TVScreen }> = [
    { id: 'tv-nav-home', label: 'Home', screen: 'home' },
    { id: 'tv-nav-search', label: 'Search', screen: 'search' },
    { id: 'tv-nav-list', label: 'My List', screen: 'my-list' },
    { id: 'tv-nav-settings', label: 'Settings', screen: 'settings' }
  ];

  const cards: TVRailCard[] = [
    { id: 'tv-card-1', index: '01', title: 'Start with focus', description: 'Arrow keys move between real buttons.' },
    { id: 'tv-card-2', index: '02', title: 'Open a state', description: 'Enter preserves the originating card.' },
    { id: 'tv-card-3', index: '03', title: 'Return safely', description: 'Back restores the previous focus.' },
    { id: 'tv-card-4', index: '04', title: 'Retry async content', description: 'A loading state settles into a focusable error.', action: 'load-error' }
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
      if (pendingTimer) clearTimeout(pendingTimer);
      coordinator.destroy();
    };
  });

  function handleBack() {
    if (exitDialogOpen) {
      cancelExit();
      return;
    }

    if (demoDepth > 0) {
      demoDepth = 0;
      statusMessage = 'Returned to the TV shell.';
      const restoreId = demoOriginFocusId;
      demoOriginFocusId = null;
      restoreAfterRender([restoreId, `tv-nav-${screen}`, 'tv-nav-home']);
      return;
    }

    const previous = navigation.goBack();
    if (previous) {
      screen = previous.screen;
      asyncState = 'ready';
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
    void tick().then(() => coordinator.restoreFirst([restoreId, `tv-nav-${screen}`, 'tv-nav-home']) || coordinator.focusFirst());
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
      demoDepth = 0;
      asyncState = 'ready';
      statusMessage = `${screenLabel(nextScreen)} is ready for remote navigation.`;
      return;
    }

    if (action === 'demo-state') {
      demoOriginFocusId = focusId || coordinator.rememberFocus();
      demoDepth = 1;
      asyncState = 'ready';
      statusMessage = 'Test state active. Press Back to restore the previous focus.';
      restoreAfterRender(['tv-test-return']);
      return;
    }

    if (action === 'load-error') {
      beginAsyncTransition('error', focusId || coordinator.rememberFocus());
      return;
    }

    if (action === 'retry') {
      beginAsyncTransition('success', asyncOriginFocusId ?? focusId ?? 'tv-retry');
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

  function beginAsyncTransition(outcome: 'success' | 'error', originId: string | null) {
    if (pendingTimer) clearTimeout(pendingTimer);
    const restoreId = outcome === 'success' ? asyncOriginFocusId ?? originId : originId;
    if (outcome === 'error') asyncOriginFocusId = originId;
    asyncState = 'loading';
    demoDepth = 0;
    statusMessage = 'Loading the TV section without moving remote focus unexpectedly.';

    pendingTimer = setTimeout(() => {
      asyncState = outcome === 'error' ? 'error' : 'ready';
      if (outcome === 'error') {
        errorMessage = 'The simulated TV request failed safely.';
        statusMessage = 'Error state active. Retry is ready for Enter.';
      } else {
        statusMessage = 'The TV section recovered. Focus remains deterministic.';
      }
      if (outcome === 'error') restoreAfterRender(['tv-retry']);
      else {
        asyncOriginFocusId = null;
        void tick().then(() => {
          setTimeout(() => restoreAfterRender([restoreId, `tv-nav-${screen}`, 'tv-nav-home']), 80);
        });
      }
    }, 420);
  }

  function handleRetry(event: MouseEvent) {
    handleAction(event, 'tv-retry', 'retry');
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
        <p class="eyebrow">Phase 2 / reusable remote-first shell</p>
        <h1 id="tv-shell-title">A focused home for the big screen.</h1>
        <p class="hero-copy">A dedicated 10-foot presentation layer with large targets, deterministic focus, stable Back behavior, and no dependency on the Web/PWA AppShell.</p>
      </div>
      <div class="hero-status" aria-live="polite">
        <span class="status-label">Current section</span>
        <strong>{demoDepth > 0 ? 'Test state' : screenLabel(screen)}</strong>
        <span>{statusMessage}</span>
      </div>
    </section>

    <section class="tv-section" aria-labelledby="tv-rail-title" aria-busy={asyncState === 'loading'}>
      <div class="section-heading">
        <div>
          <p class="eyebrow">Navigation region</p>
          <h2 id="tv-rail-title">{demoDepth > 0 ? 'Focus restoration probe' : `${screenLabel(screen)} preview`}</h2>
        </div>
        <span class="direction-hint">← → group · ↑ ↓ sections · Enter select · Back return</span>
      </div>

      {#if asyncState === 'loading'}
        <TvLoading label="Loading TV section…" />
      {:else if asyncState === 'error'}
        <TvError message={errorMessage} onRetry={handleRetry} />
      {:else if demoDepth > 0}
        <div class="test-state-panel">
          <p class="eyebrow">Logical state / preserved origin</p>
          <h2>Back returns to the originating card</h2>
          <p>This state is deliberately small. It verifies that a route-like transition can be opened with Enter and closed with Back without losing the previous focus target.</p>
          <button class="tv-focusable tv-action-button" data-tv-focusable="true" data-tv-focus-id="tv-test-return" data-tv-focus-group="tv-section-actions" data-tv-action="demo-state" type="button" onclick={handleAction}>Keep testing</button>
        </div>
      {:else}
        <TvRail cards={cards} onSelect={(card, event) => handleAction(event, card.id, card.action ?? 'demo-state')} />
      {/if}
    </section>

    <section class="tv-footer-actions" aria-label="TV exit actions">
      <div class="footer-note">
        <span class="eyebrow">Exit policy</span>
        <span>Back closes states first, restores logical focus, and confirms only at the TV root. Samsung’s dedicated Exit key is not intercepted.</span>
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
  .tv-page {
    --tv-bg: #080a0f;
    --tv-surface: rgba(20, 24, 34, .94);
    --tv-surface-soft: rgba(255, 255, 255, .055);
    --tv-line: rgba(255, 255, 255, .12);
    --tv-muted: #9da5b7;
    --tv-ink: #f7f8fb;
    --tv-accent: #ff3e5e;
    min-height: 100dvh;
    color: var(--tv-ink);
    background:
      radial-gradient(circle at 82% 0%, rgba(255, 62, 94, .14), transparent 30%),
      radial-gradient(circle at 0% 90%, rgba(77, 116, 255, .1), transparent 28%),
      var(--tv-bg);
    font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
  }

  .tv-main { width: min(100%, 1440px); margin-inline: auto; padding: 14px 56px 52px; }
  .tv-focusable { outline: none; }
  .tv-focusable:focus-visible,
  .tv-focusable[data-tv-focus-id]:focus {
    border-color: #fff;
    box-shadow: 0 0 0 4px rgba(255, 62, 94, .8), 0 0 0 8px rgba(255, 62, 94, .16);
  }

  .tv-hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, .65fr); align-items: end; gap: 36px; padding: clamp(48px, 9vw, 118px) 6px 56px; border-bottom: 1px solid var(--tv-line); }
  .eyebrow { margin: 0 0 10px; color: var(--tv-accent); font-size: .62rem; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; }
  .tv-hero h1 { max-width: 720px; margin: 0; font-size: clamp(2.8rem, 6vw, 6rem); font-weight: 850; letter-spacing: -.075em; line-height: .96; }
  .hero-copy { max-width: 680px; margin: 22px 0 0; color: var(--tv-muted); font-size: clamp(.9rem, 1.4vw, 1.1rem); line-height: 1.65; }
  .hero-status { display: grid; gap: 8px; padding: 22px; border: 1px solid var(--tv-line); border-radius: 16px; background: var(--tv-surface); }
  .status-label { color: var(--tv-muted); font-size: .62rem; letter-spacing: .12em; text-transform: uppercase; }
  .hero-status strong { font-size: 1.2rem; }
  .hero-status span:last-child { color: var(--tv-muted); font-size: .8rem; line-height: 1.5; }

  .tv-section { padding: 44px 6px 0; }
  .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
  .section-heading h2, .test-state-panel h2 { margin: 0; font-size: clamp(1.6rem, 2.8vw, 2.4rem); letter-spacing: -.05em; }
  .direction-hint { color: var(--tv-muted); font-size: .7rem; }
  .test-state-panel { display: grid; max-width: 760px; gap: 10px; padding: 32px; border: 1px solid rgba(112, 217, 167, .35); border-radius: 17px; background: rgba(112, 217, 167, .07); }
  .test-state-panel p:not(.eyebrow) { max-width: 620px; margin: 0 0 10px; color: var(--tv-muted); line-height: 1.6; }
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

  @media (max-width: 760px) {
    .tv-main { padding-inline: 22px; }
    .tv-hero { grid-template-columns: 1fr; padding-top: 58px; }
    .section-heading, .tv-footer-actions { align-items: flex-start; flex-direction: column; }
    .quit-button { width: 100%; }
  }
</style>
