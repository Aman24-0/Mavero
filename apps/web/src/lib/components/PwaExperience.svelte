<script lang="ts">
  import { onMount } from 'svelte';

  // ============================================================
  // PWA install banner — refined UX
  // ============================================================
  //
  // Eligibility signal:
  //   The ONLY eligibility signal is the browser firing
  //   `beforeinstallprompt`. We do NOT show the banner merely because
  //   the browser is mobile / Chrome / has a manifest / has a service
  //   worker / is not standalone. If `beforeinstallprompt` never fires
  //   (iOS Safari, Firefox, desktop browsers without PWA support), the
  //   banner never appears.
  //
  // Standalone detection:
  //   If the app is already installed / launched as a PWA
  //   (`display-mode: standalone` or `navigator.standalone`), the
  //   banner is permanently hidden for that session — even if a stray
  //   `beforeinstallprompt` fires (some browsers fire it in
  //   non-standalone contexts only, but we guard defensively).
  //
  // Cooldown:
  //   "Not now" / dismissed-install does NOT permanently block
  //   installation. We store a timestamp in localStorage and suppress
  //   the banner for COOLDOWN_MS (7 days). After the cooldown, if
  //   `beforeinstallprompt` fires again, the banner may reappear.
  //
  //   Old format migration: the previous implementation stored
  //   `mavero-install-dismissed` = `'1'` (a permanent boolean). We
  //   migrate this safely: if the stored value is `'1'` (old format),
  //   we treat it as a dismissal that happened "now" — so the cooldown
  //   applies immediately (the user won't see the banner for 7 days
  //   from the moment they open the updated app). This is better than
  //   the old permanent block, and better than suddenly showing the
  //   banner to every existing user on update.
  //
  // Native prompt:
  //   `event.prompt()` is called ONLY from the user's click on the
  //   Install button (browsers require a user gesture). After
  //   `prompt()`, the event is one-use — we clear it immediately. We
  //   `await userChoice` to learn the outcome:
  //     - accepted → hide banner (the appinstalled event will fire
  //       separately; we also clear state here for instant feedback).
  //     - dismissed → apply the normal cooldown.
  //
  // appinstalled:
  //   Immediately clears the install event + hides the banner + clears
  //   pending state. We do NOT permanently mark "installed" in
  //   localStorage — the browser's actual standalone/display-mode state
  //   remains authoritative (the user could uninstall later).
  //
  // No navigation interference:
  //   This component does NOT use popstate, history.back(), goto(), or
  //   any navigation API. It does not intercept unrelated clicks, block
  //   scrolling, or cover the bottom navigation. It's a fixed-position
  //   toast that sits above the mobile nav pill.

  type InstallPromptEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  };

  // 7 days — reasonable, non-aggressive. The user won't see the banner
  // again for a week after dismissing. After that, if
  // beforeinstallprompt fires again, the banner may reappear (giving
  // the user another chance to install without being nagged).
  const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
  const DISMISS_KEY = 'mavero-install-dismissed';

  let installEvent: InstallPromptEvent | null = null;
  let showInstallPrompt = false;
  let installing = false;
  let offline = false;
  let updateAvailable = false;

  // Standalone detection: display-mode: standalone (Chrome/Edge PWA)
  // OR navigator.standalone (iOS Safari standalone). If either is true,
  // the app is already installed/launched as a PWA — never show the
  // banner.
  function isStandalone(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    // iOS Safari exposes navigator.standalone (boolean). Other browsers
    // don't have this property — the Boolean() cast safely returns
    // false for undefined.
    return Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  }

  // ---- Cooldown helpers ----
  // The stored value is either:
  //   - old format: '1' (permanent boolean from the previous impl)
  //   - new format: a numeric timestamp string (Date.now() at dismissal)
  //
  // isDismissedRecently() handles both: old '1' is migrated to a
  // fresh timestamp (treated as dismissed "now" so the 7-day cooldown
  // applies immediately on first load of the updated app).

  function getDismissedTimestamp(): number {
    if (typeof localStorage === 'undefined') return 0;
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return 0;
    if (raw === '1') {
      // Old format migration: treat as dismissed "now". Write the new
      // timestamp format so subsequent reads are fast (no re-migration).
      const now = Date.now();
      try { localStorage.setItem(DISMISS_KEY, String(now)); } catch { /* quota / private mode */ }
      return now;
    }
    const ts = Number(raw);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  }

  function isDismissedRecently(): boolean {
    const ts = getDismissedTimestamp();
    if (ts === 0) return false;
    return Date.now() - ts < COOLDOWN_MS;
  }

  function recordDismissal(): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* quota / private mode */ }
  }

  function clearDismissal(): void {
    // Called when the user accepts the install — no need to keep the
    // dismissal timestamp around. The appinstalled event + standalone
    // detection will keep the banner hidden going forward.
    if (typeof localStorage === 'undefined') return;
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* quota / private mode */ }
  }

  // ---- Banner visibility ----
  // The banner is shown ONLY when ALL of:
  //   1. A valid beforeinstallprompt event has been captured (installEvent !== null)
  //   2. The app is NOT running in standalone mode (isStandalone() === false)
  //   3. The user has NOT dismissed recently (cooldown not active)
  //   4. We're not currently in the middle of calling prompt() (installing === false)
  //
  // If any condition changes (e.g. appinstalled fires, or the user
  // dismisses), the reactive `showInstallPrompt` flag updates and the
  // banner disappears.
  function shouldShowBanner(): boolean {
    return Boolean(installEvent) && !isStandalone() && !isDismissedRecently() && !installing;
  }

  function updateBannerVisibility(): void {
    showInstallPrompt = shouldShowBanner();
  }

  // ---- Install flow ----
  async function installApp() {
    if (!installEvent || installing) return;
    installing = true;
    updateBannerVisibility();
    const promptEvent = installEvent;
    // The event is one-use — clear it BEFORE calling prompt() so a
    // double-click can't call prompt() twice.
    installEvent = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        // The appinstalled event will fire separately and clear
        // everything. We also clear the dismissal timestamp here so a
        // future uninstall/reinstall cycle isn't permanently blocked.
        clearDismissal();
      } else {
        // User dismissed the native install sheet — apply the normal
        // cooldown.
        recordDismissal();
      }
    } catch {
      // prompt() can throw if the event is stale or the browser
      // refuses. Treat as a dismissal (cooldown) so we don't
      // immediately re-show the banner on the next beforeinstallprompt.
      recordDismissal();
    } finally {
      installing = false;
      updateBannerVisibility();
    }
  }

  function dismissInstallPrompt() {
    recordDismissal();
    showInstallPrompt = false;
  }

  // ---- Online/offline + SW update (unchanged) ----
  function handleOnlineState() {
    offline = !navigator.onLine;
  }

  // ---- Lifecycle ----
  // The beforeinstallprompt listener is registered in onMount and
  // stays for the component's lifetime (the component is mounted once
  // in the root +layout.svelte and never unmounts during normal app
  // usage). We do NOT poll. We do NOT re-register. If the event fired
  // before onMount runs (very unlikely in practice — onMount fires
  // before any user interaction), the browser typically re-fires it on
  // the next eligible interaction.
  let beforeInstallPromptHandler: ((event: Event) => void) | null = null;
  let appinstalledHandler: (() => void) | null = null;

  onMount(() => {
    offline = !navigator.onLine;

    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((registration) => {
        void registration.update();
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) updateAvailable = true;
          });
        });
      }).catch(() => undefined);
    }

    // beforeinstallprompt listener — the ONLY eligibility signal.
    // We register it unconditionally (even in standalone mode — some
    // browsers don't fire it in standalone, but if they do, the
    // shouldShowBanner() check will suppress the banner anyway via
    // isStandalone()).
    beforeInstallPromptHandler = (event: Event) => {
      // Prevent the browser's default mini-infobar (Chrome < 76 /
      // Android). We show our own tasteful banner instead.
      event.preventDefault();
      installEvent = event as InstallPromptEvent;
      updateBannerVisibility();
    };
    window.addEventListener('beforeinstallprompt', beforeInstallPromptHandler);

    // appinstalled — immediately clear everything.
    appinstalledHandler = () => {
      installEvent = null;
      installing = false;
      showInstallPrompt = false;
      // Don't permanently mark installed — the browser's
      // standalone/display-mode state remains authoritative.
    };
    window.addEventListener('appinstalled', appinstalledHandler);

    window.addEventListener('online', handleOnlineState);
    window.addEventListener('offline', handleOnlineState);

    return () => {
      if (beforeInstallPromptHandler) window.removeEventListener('beforeinstallprompt', beforeInstallPromptHandler);
      if (appinstalledHandler) window.removeEventListener('appinstalled', appinstalledHandler);
      window.removeEventListener('online', handleOnlineState);
      window.removeEventListener('offline', handleOnlineState);
    };
  });
</script>

{#if offline}
  <div class="status-banner" role="status">You’re offline. Cached app shell is available; live catalog and streaming need a connection.</div>
{/if}

{#if updateAvailable}
  <div class="update-banner" role="status">
    <span>A newer Mavero version is ready.</span>
    <button type="button" onclick={() => window.location.reload()}>Refresh</button>
  </div>
{/if}

{#if showInstallPrompt && installEvent}
  <div class="install-prompt" role="dialog" aria-label="Install Mavero">
    <div class="install-icon" aria-hidden="true">
      <img src="/icons/mavero-apple-touch.png" alt="" width="36" height="36" loading="lazy" decoding="async" />
    </div>
    <div class="install-copy">
      <strong>Install Mavero</strong>
      <span>Faster access & app-like experience</span>
    </div>
    <div class="prompt-actions">
      <button class="install-btn" type="button" onclick={installApp} disabled={installing}>
        {installing ? 'Installing…' : 'Install'}
      </button>
      <button class="dismiss-btn" type="button" aria-label="Dismiss install prompt" onclick={dismissInstallPrompt}>
        Not now
      </button>
    </div>
  </div>
{/if}

<style>
  .status-banner, .update-banner {
    position: fixed; right: 16px; bottom: calc(96px + env(safe-area-inset-bottom)); z-index: 60;
    max-width: min(420px, calc(100vw - 32px)); padding: 11px 14px;
    border: 1px solid var(--line); border-radius: var(--radius-md);
    color: var(--ink); background: rgba(15,15,15,.94);
    box-shadow: var(--shadow-sm); font-size: .72rem; line-height: 1.45;
  }
  .update-banner { display: flex; align-items: center; gap: 12px; }
  .update-banner button {
    border: 0; border-radius: 999px; padding: 7px 14px;
    color: #000; background: var(--accent-strong);
    font-size: .7rem; font-weight: 800;
  }

  /* Install banner — compact, native-feel, Mavero visual language.
     Positioned above the mobile nav pill (bottom: 96px) so it never
     covers primary navigation. Uses the existing surface/accent/radius
     tokens for visual consistency. */
  .install-prompt {
    position: fixed;
    right: 16px;
    bottom: calc(96px + env(safe-area-inset-bottom));
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 12px;
    width: min(100% - 32px, 440px);
    padding: 12px 14px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-lg);
    color: var(--ink);
    background: rgba(15, 15, 15, .97);
    backdrop-filter: blur(16px);
    box-shadow: var(--shadow-sm);
    animation: install-slide-in 280ms var(--ease-out, cubic-bezier(.22, 1, .36, 1));
  }

  .install-icon {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface-2);
    border: 1px solid var(--line);
  }
  .install-icon img {
    width: 36px;
    height: 36px;
    object-fit: contain;
  }

  .install-copy {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .install-copy strong {
    color: var(--ink);
    font-size: .78rem;
    font-weight: 800;
    letter-spacing: -.01em;
  }
  .install-copy span {
    color: var(--muted);
    font-size: .62rem;
    line-height: 1.35;
  }

  .prompt-actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .install-btn {
    border: 0;
    border-radius: 999px;
    padding: 8px 16px;
    color: #000;
    background: var(--accent-strong);
    font: inherit;
    font-size: .68rem;
    font-weight: 800;
    cursor: pointer;
    transition: transform 180ms var(--ease-out, cubic-bezier(.22, 1, .36, 1));
  }
  .install-btn:hover:not(:disabled) { transform: scale(1.04); }
  .install-btn:active:not(:disabled) { transform: scale(.97); }
  .install-btn:disabled { opacity: .6; cursor: default; }

  .dismiss-btn {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 7px 12px;
    color: var(--muted);
    background: transparent;
    font: inherit;
    font-size: .64rem;
    font-weight: 700;
    cursor: pointer;
    transition: color 180ms ease, border-color 180ms ease;
  }
  .dismiss-btn:hover { color: var(--ink); border-color: var(--line-strong); }

  @media (max-width: 640px) {
    .install-prompt {
      /* On mobile, the banner stacks: icon + copy on top, actions below.
         This keeps the banner compact enough to not cover the nav pill. */
      flex-wrap: wrap;
      padding: 10px 12px;
      gap: 8px;
    }
    .prompt-actions {
      width: 100%;
      justify-content: flex-end;
      margin-top: 2px;
    }
    .install-copy strong { font-size: .74rem; }
    .install-copy span { font-size: .58rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .install-prompt { animation: none; }
    .install-btn, .dismiss-btn { transition: none; }
  }

  @keyframes install-slide-in {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
