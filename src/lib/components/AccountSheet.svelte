<script lang="ts">
  import { Bookmark, Settings, X } from 'lucide-svelte';
  import { getSyncStatus, type SyncStatus } from '$lib/client/progress/cloud';
  import { haptic } from '$lib/client/haptics';

  // Navigation & Settings Redesign, Phase 3 — the compact Account sheet.
  //
  // A WhatsApp-overflow-style sheet opened from the header account
  // control. Per the plan it contains ONLY:
  //   1. A compact identity block (display name, email, cloud sync status)
  //   2. My List
  //   3. Settings
  //
  // Contracts:
  //   COMPACT     — much smaller than the Settings page; no sections,
  //                 no forms, no device list.
  //   DISMISSIBLE — close button, backdrop click, Escape.
  //   KEYBOARD    — role="dialog" + aria-modal, focus moves into the
  //                 sheet on open, Tab is trapped inside, focus is
  //                 restored to the trigger on close (the trigger is
  //                 refocused by AppShell's onClose via the saved
  //                 previously-focused element).
  //   POSITION    — mobile (≤640px): bottom sheet above the nav pill
  //                 with safe-area bottom padding; larger viewports:
  //                 popover anchored under the header account control
  //                 (top-right).
  //   MOTION      — one subtle entry animation, disabled entirely under
  //                 prefers-reduced-motion.

  let {
    open = false,
    onClose,
    user = null,
    isAuthenticated = false
  }: {
    open?: boolean;
    onClose: () => void;
    user?: { id: string; email?: string | null; displayName?: string | null } | null;
    isAuthenticated?: boolean;
  } = $props();

  let sheetElement: HTMLElement | undefined = $state();
  let closeButton: HTMLButtonElement | undefined = $state();
  let previouslyFocused: HTMLElement | null = null;
  let syncStatus = $state<SyncStatus>('pending');

  const accountName = $derived(user?.displayName ?? (user?.email ? user.email.split('@')[0] : 'Guest'));
  const initials = $derived((() => {
    const name = accountName;
    if (!name) return '·';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  })());

  const syncLabel = $derived(
    isAuthenticated
      ? ({ synced: 'Synced', syncing: 'Syncing…', pending: 'Sync pending', offline: 'Offline · local', error: 'Sync will retry' } satisfies Record<SyncStatus, string>)[syncStatus]
      : 'Guest · local library'
  );

  // Compact sync status — read from the existing cloud module state (no
  // network roundtrip; syncAuthenticatedState already ran on mount for
  // library-aware routes).
  $effect(() => {
    if (open) {
      try { syncStatus = getSyncStatus(); } catch { /* status stays pending */ }
      previouslyFocused = (document.activeElement as HTMLElement | null) ?? null;
      // Scroll lock (same pattern as the admin sheet).
      document.documentElement.setAttribute('data-account-sheet-open', '');
      // Move focus into the sheet after it mounts.
      requestAnimationFrame(() => closeButton?.focus());
    } else {
      document.documentElement.removeAttribute('data-account-sheet-open');
    }
  });

  $effect(() => {
    return () => {
      // Cleanup on unmount: remove the scroll lock and restore focus.
      document.documentElement.removeAttribute('data-account-sheet-open');
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  });

  function close() {
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
    onClose();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || !sheetElement) return;
    // Focus trap: cycle Tab within the sheet.
    const focusables = sheetElement.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function menuNavigate() {
    haptic('light');
    close();
  }
</script>

{#if open}
  <!-- Backdrop: click to dismiss; the sheet handles Escape/Tab itself. -->
  <div class="sheet-backdrop" onclick={close} aria-hidden="true"></div>
  <div
    bind:this={sheetElement}
    class="account-sheet"
    role="dialog"
    aria-modal="true"
    aria-label="Account"
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <button class="sheet-close" type="button" bind:this={closeButton} onclick={close} aria-label="Close account sheet">
      <X size={15} />
    </button>

    <!-- Identity block: name + email + compact sync status -->
    <div class="sheet-identity">
      <div class="identity-avatar" aria-hidden="true">{initials}</div>
      <div class="identity-copy">
        <p class="identity-name">{accountName}</p>
        {#if user?.email}
          <p class="identity-email">{user.email}</p>
        {/if}
        <p class="identity-sync" class:online={isAuthenticated && syncStatus === 'synced'} aria-live="polite">
          <span class="sync-dot" class:online={isAuthenticated && syncStatus === 'synced'} aria-hidden="true"></span>
          {syncLabel}
        </p>
        {#if !isAuthenticated}
          <a class="identity-signin" href="/auth/sign-in">Sign in to sync</a>
        {/if}
      </div>
    </div>

    <!-- The ONLY two entries per the plan: My List + Settings -->
    <nav class="sheet-menu" aria-label="Account menu">
      <a class="menu-row" href="/my-list" onclick={menuNavigate}>
        <span class="menu-icon"><Bookmark size={17} /></span>
        <span class="menu-copy">
          <strong>My List</strong>
          <small>Your saved titles and watch progress</small>
        </span>
      </a>
      <a class="menu-row" href="/settings" onclick={menuNavigate}>
        <span class="menu-icon"><Settings size={17} /></span>
        <span class="menu-copy">
          <strong>Settings</strong>
          <small>Profile, security and devices</small>
        </span>
      </a>
    </nav>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed; inset: 0; z-index: 70;
    background: rgba(3, 5, 6, .62);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
  }

  .account-sheet {
    position: fixed; top: 76px; right: 22px; z-index: 80;
    width: 304px; box-sizing: border-box;
    padding: 16px 0 8px;
    border: 1px solid var(--color-border-strong);
    border-radius: 16px;
    background: rgba(10, 13, 16, .97);
    backdrop-filter: blur(22px);
    -webkit-backdrop-filter: blur(22px);
    box-shadow: 0 24px 60px rgba(0, 0, 0, .6), 0 0 0 1px rgba(0, 255, 156, .04);
    animation: sheet-pop 160ms cubic-bezier(.22, 1, .36, 1);
  }
  @keyframes sheet-pop {
    from { opacity: 0; transform: translateY(-6px) scale(.98); }
    to { opacity: 1; transform: none; }
  }

  .sheet-close {
    position: absolute; top: 10px; right: 10px;
    display: grid; place-items: center;
    width: 30px; height: 30px;
    border: 1px solid transparent; border-radius: 8px;
    color: var(--color-text-deep); background: transparent; cursor: pointer;
    transition: color var(--motion-fast), background var(--motion-fast);
  }
  .sheet-close:hover { color: var(--color-text); background: var(--color-surface-raised); }
  .sheet-close:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Identity block ── */
  .sheet-identity {
    display: flex; align-items: center; gap: 12px;
    padding: 4px 16px 14px;
    border-bottom: 1px solid var(--color-border);
  }
  .identity-avatar {
    display: grid; place-items: center;
    width: 42px; height: 42px; flex-shrink: 0;
    border-radius: 13px;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary-border);
    box-shadow: var(--glow-primary);
    font-size: .8rem; font-weight: 800; letter-spacing: .04em;
  }
  .identity-copy { min-width: 0; display: grid; gap: 2px; }
  .identity-name {
    margin: 0; color: var(--color-text);
    font-size: .86rem; font-weight: 700; line-height: 1.25;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .identity-email {
    margin: 0; color: var(--color-text-muted);
    font-size: .68rem; line-height: 1.3;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .identity-sync {
    display: inline-flex; align-items: center; gap: 6px; margin: 2px 0 0;
    color: var(--color-text-deep); font-size: .62rem; font-weight: 600;
  }
  .sync-dot {
    width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%;
    background: #6b6b73;
  }
  .sync-dot.online, .identity-sync.online { color: var(--color-primary); }
  .sync-dot.online { background: var(--color-primary); box-shadow: 0 0 8px rgba(0, 255, 156, .5); }
  .identity-signin {
    margin-top: 4px; justify-self: start;
    color: var(--color-primary); font-size: .64rem; font-weight: 700;
    text-decoration: none; border-bottom: 1px solid transparent;
  }
  .identity-signin:hover { border-bottom-color: currentColor; }
  .identity-signin:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Menu rows: the only two entries ── */
  .sheet-menu { display: grid; padding: 6px 8px 4px; }
  .menu-row {
    display: flex; align-items: center; gap: 12px;
    min-height: 52px; padding: 8px 10px;
    border: 1px solid transparent; border-radius: 12px;
    text-decoration: none;
    transition: background var(--motion-fast), border-color var(--motion-fast);
  }
  .menu-row:hover { background: var(--color-surface-raised); border-color: var(--color-border); }
  .menu-row:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
  .menu-row:active { transform: scale(.985); }
  .menu-icon {
    display: grid; place-items: center;
    width: 34px; height: 34px; flex-shrink: 0;
    border-radius: 10px;
    color: var(--color-text-muted);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
  }
  .menu-copy { display: grid; gap: 1px; min-width: 0; }
  .menu-copy strong { color: var(--color-text); font-size: .78rem; font-weight: 700; }
  .menu-copy small { color: var(--color-text-deep); font-size: .6rem; line-height: 1.35; }

  /* ── Mobile (≤640px): bottom sheet above the nav pill ── */
  @media (max-width: 640px) {
    .account-sheet {
      top: auto; right: 0; left: 0; bottom: 0;
      width: 100%;
      border-radius: 20px 20px 0 0;
      padding: 14px 0 calc(12px + env(safe-area-inset-bottom, 0px));
      animation: sheet-rise 200ms cubic-bezier(.22, 1, .36, 1);
    }
    @keyframes sheet-rise {
      from { opacity: 0; transform: translateY(24px); }
      to { opacity: 1; transform: none; }
    }
    .sheet-identity { padding: 4px 18px 14px; }
    .sheet-menu { padding: 6px 10px 4px; }
    /* Comfortable targets above the floating pill. */
    .menu-row { min-height: 56px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .account-sheet { animation: none; }
    .sheet-close, .menu-row { transition: none; }
  }
</style>
