<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    TVFocusCoordinator,
    canExitApplication,
    createTVNavigation,
    exitApplication,
    getTVRemoteAction,
    isTizen,
    type TVRemoteEvent,
    type TVScreen
  } from '$lib/tv';

  type ActionTarget = HTMLElement & { dataset: DOMStringMap };

  let root: HTMLElement;
  let coordinator: TVFocusCoordinator;
  const navigation = createTVNavigation();

  let screen = $state<TVScreen>('home');
  let exitDialogOpen = $state(false);
  let previousFocusId = $state<string | null>(null);
  let demoDepth = $state(0);
  let statusMessage = $state('Ready for remote navigation.');
  let exitCapability = $state('Browser-safe mode');
  let lastActivationKey = '';
  let lastActivationAt = 0;

  const navItems: Array<{ id: string; label: string; screen: TVScreen }> = [
    { id: 'tv-nav-home', label: 'Home', screen: 'home' },
    { id: 'tv-nav-search', label: 'Search', screen: 'search' },
    { id: 'tv-nav-list', label: 'My List', screen: 'my-list' },
    { id: 'tv-nav-settings', label: 'Settings', screen: 'settings' }
  ];

  const cards = [
    { id: 'tv-card-1', index: '01', title: 'Start with focus', description: 'Arrow keys move between real buttons.' },
    { id: 'tv-card-2', index: '02', title: 'Enter a test state', description: 'Enter opens a controlled logical state.' },
    { id: 'tv-card-3', index: '03', title: 'Return safely', description: 'Back restores the previous focus.' },
    { id: 'tv-card-4', index: '04', title: 'Quit deliberately', description: 'Root Back and Quit share one dialog.' }
  ];

  onMount(() => {
    coordinator = new TVFocusCoordinator(root);
    coordinator.initialize('tv-nav-home');
    exitCapability = isTizen() && canExitApplication() ? 'Tizen exit API available' : 'Browser-safe mode';

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
        coordinator.move(action);
        return;
      }

      if (action === 'enter') {
        event.preventDefault();
        const active = document.activeElement;
        if (active instanceof HTMLElement && root.contains(active)) {
          active.click();
        }
      }
    };

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
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
      void tick().then(() => coordinator.restore('tv-card-2') || coordinator.focusFirst());
      return;
    }

    const previous = navigation.goBack();
    if (previous) {
      screen = previous.screen;
      statusMessage = `Returned to ${screenLabel(screen)}.`;
      void tick().then(() => coordinator.restore(previous.focusId) || coordinator.focusFirst());
      return;
    }

    openExitConfirmation();
  }

  function openExitConfirmation() {
    previousFocusId = coordinator.rememberFocus();
    exitDialogOpen = true;
    statusMessage = 'Exit confirmation opened.';
    void tick().then(() => coordinator.focusById('tv-exit-cancel'));
  }

  function cancelExit() {
    exitDialogOpen = false;
    statusMessage = 'Exit cancelled. Focus restored.';
    const restoreId = previousFocusId;
    previousFocusId = null;
    void tick().then(() => restoreId && coordinator.restore(restoreId) || coordinator.focusFirst());
  }

  function confirmExit() {
    const result = exitApplication();
    if (result.ok) {
      statusMessage = 'Native Tizen exit requested.';
      return;
    }

    exitDialogOpen = false;
    statusMessage = 'Native Tizen exit is unavailable in this browser preview.';
    const restoreId = previousFocusId;
    previousFocusId = null;
    void tick().then(() => restoreId && coordinator.restore(restoreId) || coordinator.focusFirst());
  }

  function handleAction(event: MouseEvent) {
    const target = event.currentTarget as ActionTarget;
    const focusId = target.dataset.tvFocusId ?? '';
    const now = performance.now();
    if (focusId && focusId === lastActivationKey && now - lastActivationAt < 180) return;
    lastActivationKey = focusId;
    lastActivationAt = now;
    const action = target.dataset.tvAction ?? '';

    if (action.startsWith('screen:')) {
      const nextScreen = action.slice('screen:'.length) as TVScreen;
      if (nextScreen === screen) {
        statusMessage = `${screenLabel(nextScreen)} is already active.`;
        return;
      }
      navigation.open(nextScreen, target.dataset.tvFocusId ?? null);
      screen = nextScreen;
      statusMessage = `${screenLabel(nextScreen)} is a shell placeholder for a later TV phase.`;
      return;
    }

    if (action === 'demo-state') {
      demoDepth = 1;
      statusMessage = 'Test state active. Press Back to restore the previous focus.';
      void tick().then(() => coordinator.focusById('tv-test-return'));
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

    if (action === 'confirm-exit') {
      confirmExit();
    }
  }

  function screenLabel(value: TVScreen) {
    return value === 'my-list' ? 'My List' : value[0].toUpperCase() + value.slice(1);
  }
</script>

<svelte:window onblur={() => coordinator?.focusFirst()} />

<div class="tv-page" bind:this={root}>
  <header class="tv-header">
    <div class="brand-lockup" aria-label="Mavero TV proof">
      <span class="brand-mark">M</span>
      <span>
        <strong>Mavero</strong>
        <small>TV compatibility spike</small>
      </span>
    </div>

    <div class="runtime-badge" aria-live="polite">
      <span class="status-dot" aria-hidden="true"></span>
      {exitCapability}
    </div>
  </header>

  <main class="tv-main" aria-label="Mavero TV shell">
    <nav class="tv-nav" aria-label="TV proof navigation">
      {#each navItems as item}
        <button
          class:active={screen === item.screen}
          class="tv-focusable tv-nav-item"
          data-tv-focusable="true"
          data-tv-focus-id={item.id}
          data-tv-action={`screen:${item.screen}`}
          type="button"
          onclick={handleAction}
        >
          <span class="nav-index">0{navItems.indexOf(item) + 1}</span>
          <span>{item.label}</span>
        </button>
      {/each}
    </nav>

    <section class="tv-hero" aria-labelledby="tv-shell-title">
      <div>
        <p class="eyebrow">Phase 1 / remote-first proof</p>
        <h1 id="tv-shell-title">A focused home for the big screen.</h1>
        <p class="hero-copy">This technical shell proves isolated TV presentation, deterministic focus, safe Back behavior, and a guarded application exit without touching the existing Web/PWA experience.</p>
      </div>
      <div class="hero-status" aria-live="polite">
        <span class="status-label">Current state</span>
        <strong>{demoDepth > 0 ? 'Test state' : screenLabel(screen)}</strong>
        <span>{statusMessage}</span>
      </div>
    </section>

    <section class="tv-section" aria-labelledby="tv-rail-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Navigation test area</p>
          <h2 id="tv-rail-title">Focus rail</h2>
        </div>
        <span class="direction-hint">← → rail · ↑ ↓ sections · Enter select · Back return</span>
      </div>

      {#if demoDepth > 0}
        <div class="test-state-panel">
          <p class="eyebrow">Logical state / 01</p>
          <h2>Back should return here</h2>
          <p>This state exists only to verify that the previous focus survives an asynchronous-looking screen transition.</p>
          <button class="tv-focusable tv-action-button" data-tv-focusable="true" data-tv-focus-id="tv-test-return" data-tv-action="demo-state" type="button" onclick={handleAction}>Keep testing</button>
        </div>
      {:else}
        <div class="tv-rail" role="list" aria-label="Focus test cards">
          {#each cards as card}
            <button class="tv-focusable tv-card" data-tv-focusable="true" data-tv-focus-id={card.id} data-tv-action="demo-state" type="button" onclick={handleAction}>
              <span class="card-index">{card.index}</span>
              <span class="card-title">{card.title}</span>
              <span class="card-description">{card.description}</span>
              <span class="card-arrow" aria-hidden="true">↗</span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <section class="tv-footer-actions" aria-label="TV exit actions">
      <div class="footer-note">
        <span class="eyebrow">Exit policy</span>
        <span>Return closes states first, then confirms only at the TV root. Samsung’s dedicated Exit key is not intercepted.</span>
      </div>
      <button class="tv-focusable quit-button" data-tv-focusable="true" data-tv-focus-id="tv-quit" data-tv-action="quit" type="button" onclick={handleAction}>Quit Mavero</button>
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
          <button class="tv-focusable exit-button cancel" data-tv-focusable="true" data-tv-focus-id="tv-exit-cancel" data-tv-action="cancel-exit" type="button" onclick={handleAction}>Cancel</button>
          <button class="tv-focusable exit-button confirm" data-tv-focusable="true" data-tv-focus-id="tv-exit-confirm" data-tv-action="confirm-exit" type="button" onclick={handleAction}>Exit</button>
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

  .tv-header,
  .tv-main { width: min(100%, 1440px); margin-inline: auto; }
  .tv-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 34px 56px 18px; }
  .brand-lockup { display: flex; align-items: center; gap: 12px; }
  .brand-mark { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 12px; color: #fff; background: var(--tv-accent); font-size: 1.3rem; font-weight: 900; box-shadow: 0 10px 28px rgba(255, 62, 94, .2); }
  .brand-lockup strong { display: block; font-size: 1.06rem; letter-spacing: -.03em; }
  .brand-lockup small { display: block; margin-top: 2px; color: var(--tv-muted); font-size: .62rem; letter-spacing: .13em; text-transform: uppercase; }
  .runtime-badge { display: flex; align-items: center; gap: 9px; color: var(--tv-muted); font-size: .68rem; letter-spacing: .05em; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #70d9a7; box-shadow: 0 0 0 5px rgba(112, 217, 167, .1); }

  .tv-main { padding: 14px 56px 52px; }
  .tv-nav { display: flex; gap: 10px; overflow-x: auto; padding: 6px 4px 14px; scrollbar-width: none; }
  .tv-nav::-webkit-scrollbar { display: none; }
  .tv-focusable { outline: none; }
  .tv-focusable:focus-visible,
  .tv-focusable[data-tv-focus-id]:focus {
    border-color: #fff;
    box-shadow: 0 0 0 4px rgba(255, 62, 94, .8), 0 0 0 8px rgba(255, 62, 94, .16);
  }
  .tv-nav-item { display: flex; min-width: 140px; align-items: center; gap: 12px; padding: 13px 16px; border: 1px solid var(--tv-line); border-radius: 12px; color: var(--tv-muted); background: var(--tv-surface-soft); font-size: .82rem; font-weight: 760; text-align: left; cursor: pointer; transition: border-color 160ms ease, background 160ms ease, color 160ms ease; }
  .tv-nav-item.active { color: var(--tv-ink); border-color: rgba(255, 62, 94, .48); background: rgba(255, 62, 94, .12); }
  .nav-index, .card-index { color: var(--tv-accent); font-size: .6rem; font-weight: 900; letter-spacing: .12em; }

  .tv-hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, .65fr); align-items: end; gap: 36px; padding: clamp(48px, 9vw, 118px) 6px 56px; border-bottom: 1px solid var(--tv-line); }
  .eyebrow { margin: 0 0 10px; color: var(--tv-accent); font-size: .62rem; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; }
  .tv-hero h1 { max-width: 720px; margin: 0; font-size: clamp(2.8rem, 6vw, 6rem); font-weight: 850; letter-spacing: -.075em; line-height: .96; }
  .hero-copy { max-width: 660px; margin: 22px 0 0; color: var(--tv-muted); font-size: clamp(.9rem, 1.4vw, 1.1rem); line-height: 1.65; }
  .hero-status { display: grid; gap: 8px; padding: 20px; border: 1px solid var(--tv-line); border-radius: 16px; background: var(--tv-surface); }
  .status-label { color: var(--tv-muted); font-size: .62rem; letter-spacing: .12em; text-transform: uppercase; }
  .hero-status strong { font-size: 1.18rem; }
  .hero-status span:last-child { color: var(--tv-muted); font-size: .78rem; line-height: 1.5; }

  .tv-section { padding: 42px 6px 0; }
  .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
  .section-heading h2, .test-state-panel h2 { margin: 0; font-size: clamp(1.5rem, 2.8vw, 2.35rem); letter-spacing: -.05em; }
  .direction-hint { color: var(--tv-muted); font-size: .68rem; }
  .tv-rail { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(210px, 1fr); gap: 14px; overflow-x: auto; padding: 8px 4px 16px; scrollbar-color: rgba(255,255,255,.2) transparent; }
  .tv-card { position: relative; display: flex; min-height: 190px; flex-direction: column; align-items: flex-start; justify-content: flex-end; gap: 9px; padding: 20px; border: 1px solid var(--tv-line); border-radius: 16px; color: var(--tv-ink); background: linear-gradient(145deg, rgba(255,255,255,.1), rgba(255,255,255,.035)); text-align: left; cursor: pointer; transition: transform 160ms ease, border-color 160ms ease, background 160ms ease; }
  .tv-card:hover { transform: translateY(-3px); border-color: rgba(255,255,255,.32); }
  .card-title { font-size: 1.04rem; font-weight: 800; letter-spacing: -.025em; }
  .card-description { max-width: 180px; color: var(--tv-muted); font-size: .72rem; line-height: 1.45; }
  .card-arrow { position: absolute; top: 18px; right: 18px; color: var(--tv-accent); font-size: 1.3rem; }
  .test-state-panel { display: grid; max-width: 700px; gap: 10px; padding: 30px; border: 1px solid rgba(112, 217, 167, .35); border-radius: 16px; background: rgba(112, 217, 167, .07); }
  .test-state-panel p:not(.eyebrow) { max-width: 560px; margin: 0 0 10px; color: var(--tv-muted); line-height: 1.6; }
  .tv-action-button { width: fit-content; padding: 12px 16px; border: 1px solid rgba(255,255,255,.16); border-radius: 10px; color: var(--tv-ink); background: var(--tv-surface-soft); cursor: pointer; }

  .tv-footer-actions { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin: 42px 6px 0; padding-top: 22px; border-top: 1px solid var(--tv-line); }
  .footer-note { display: grid; gap: 5px; max-width: 700px; color: var(--tv-muted); font-size: .72rem; line-height: 1.5; }
  .footer-note .eyebrow { margin: 0; }
  .quit-button { min-width: 160px; padding: 14px 18px; border: 1px solid rgba(255, 62, 94, .48); border-radius: 11px; color: #fff; background: rgba(255, 62, 94, .14); font-size: .78rem; font-weight: 850; cursor: pointer; }

  .exit-layer { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 30px; }
  .exit-backdrop { position: absolute; inset: 0; background: rgba(2, 4, 8, .84); }
  .exit-dialog { position: relative; width: min(100%, 560px); padding: 34px; border: 1px solid rgba(255,255,255,.18); border-radius: 20px; background: #151925; box-shadow: 0 30px 120px rgba(0,0,0,.6); }
  .exit-dialog h2 { margin: 0; font-size: clamp(2rem, 4vw, 3.2rem); letter-spacing: -.07em; }
  .exit-dialog > p:not(.eyebrow) { max-width: 440px; margin: 14px 0 0; color: var(--tv-muted); line-height: 1.6; }
  .exit-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 30px; }
  .exit-button { min-width: 132px; padding: 15px 20px; border: 1px solid rgba(255,255,255,.18); border-radius: 11px; color: var(--tv-ink); background: var(--tv-surface-soft); font-size: .8rem; font-weight: 800; cursor: pointer; }
  .exit-button.confirm { border-color: var(--tv-accent); color: #fff; background: var(--tv-accent); }

  @media (max-width: 760px) {
    .tv-header, .tv-main { padding-inline: 22px; }
    .tv-header { align-items: flex-start; flex-direction: column; padding-top: 24px; }
    .tv-hero { grid-template-columns: 1fr; padding-top: 58px; }
    .section-heading, .tv-footer-actions { align-items: flex-start; flex-direction: column; }
    .tv-rail { grid-auto-columns: minmax(220px, 78vw); }
    .quit-button { width: 100%; }
  }

  @media (prefers-reduced-motion: reduce) {
    .tv-nav-item, .tv-card, .tv-action-button, .quit-button, .exit-button { transition: none; }
    .tv-card:hover { transform: none; }
  }
</style>
