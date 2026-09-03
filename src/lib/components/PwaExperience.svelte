<script lang="ts">
  import { onMount } from 'svelte';

  type InstallPromptEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  };

  let installEvent: InstallPromptEvent | null = null;
  let showInstallPrompt = false;
  let offline = false;
  let updateAvailable = false;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  }

  function dismissInstallPrompt() {
    showInstallPrompt = false;
    localStorage.setItem('mavero-install-dismissed', '1');
  }

  async function installApp() {
    if (!installEvent) return;
    const promptEvent = installEvent;
    installEvent = null;
    showInstallPrompt = false;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice.outcome === 'dismissed') localStorage.setItem('mavero-install-dismissed', '1');
  }

  function handleOnlineState() {
    offline = !navigator.onLine;
  }

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

    if (!isStandalone() && !localStorage.getItem('mavero-install-dismissed')) {
      window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        installEvent = event as InstallPromptEvent;
        showInstallPrompt = true;
      });
    }

    const installed = () => {
      installEvent = null;
      showInstallPrompt = false;
    };
    window.addEventListener('appinstalled', installed);
    window.addEventListener('online', handleOnlineState);
    window.addEventListener('offline', handleOnlineState);

    return () => {
      window.removeEventListener('appinstalled', installed);
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
  <aside class="install-prompt" aria-label="Install Mavero">
    <div><strong>Install Mavero</strong><span>Keep your watch home one tap away.</span></div>
    <div class="prompt-actions"><button class="install" type="button" onclick={installApp}>Install</button><button class="dismiss" type="button" aria-label="Dismiss install prompt" onclick={dismissInstallPrompt}>Not now</button></div>
  </aside>
{/if}

<style>
  .status-banner, .update-banner { position: fixed; right: 16px; bottom: calc(96px + env(safe-area-inset-bottom)); z-index: 60; max-width: min(420px, calc(100vw - 32px)); padding: 11px 14px; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; color: var(--ink); background: rgba(15,15,15,.94); box-shadow: 0 12px 36px rgba(0,0,0,.45); font-size: .72rem; line-height: 1.45; }
  .update-banner { display: flex; align-items: center; gap: 12px; }
  .update-banner button, .install { border: 0; border-radius: 999px; padding: 7px 14px; color: #000; background: #f5f5f5; font-size: .7rem; font-weight: 800; }
  .install-prompt { position: fixed; right: 16px; bottom: calc(96px + env(safe-area-inset-bottom)); z-index: 60; display: flex; align-items: center; justify-content: space-between; gap: 18px; width: min(100% - 32px, 440px); padding: 14px 16px; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; color: var(--ink); background: rgba(15,15,15,.96); box-shadow: 0 16px 46px rgba(0,0,0,.5); }
  .install-prompt strong, .install-prompt span { display: block; }
  .install-prompt strong { font-size: .78rem; }
  .install-prompt span { margin-top: 3px; color: var(--muted); font-size: .68rem; }
  .prompt-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .dismiss { border: 0; color: var(--muted); background: transparent; font-size: .68rem; font-weight: 700; }
  @media (max-width: 640px) { .install-prompt { display: block; } .prompt-actions { margin-top: 11px; justify-content: flex-end; } }
  @media (prefers-reduced-motion: reduce) { .install-prompt, .status-banner, .update-banner { scroll-behavior: auto; } }
</style>
