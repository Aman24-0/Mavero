<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { Check, Monitor, Smartphone, Tv, Laptop, ShieldCheck, AlertCircle, LoaderCircle } from 'lucide-svelte';
  import AuthShell from '$components/AuthShell.svelte';
  import { haptic } from '$lib/client/haptics';

  let pairingSecret = $state(page.url.searchParams.get('s') ?? '');
  let loading = $state(true);
  let deviceName = $state('');
  let browser = $state<string | null>(null);
  let os = $state<string | null>(null);
  let platform = $state<string | null>(null);
  let error = $state('');
  let approving = $state(false);
  let approved = $state(false);
  let expired = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    if (!pairingSecret) {
      error = 'No pairing request found.';
      loading = false;
      return;
    }
    void loadPairingInfo();
  });

  async function loadPairingInfo() {
    loading = true;
    try {
      const res = await fetch(`/api/auth/device-pairing/info?s=${encodeURIComponent(pairingSecret)}`, {
        headers: { accept: 'application/json' },
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        error = payload.message ?? 'Unable to load pairing request.';
        if (payload.status === 'expired') expired = true;
        loading = false;
        return;
      }
      deviceName = payload.pairing.deviceName ?? 'Unknown device';
      browser = payload.pairing.browser;
      os = payload.pairing.os;
      platform = payload.pairing.platform;
      loading = false;
    } catch {
      error = 'Network error. Please try again.';
      loading = false;
    }
  }

  async function approve() {
    if (approving) return;
    approving = true;
    haptic('light');
    try {
      const res = await fetch('/api/auth/device-pairing/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: pairingSecret }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        error = payload.message ?? 'Unable to approve the device.';
        if (payload.status === 'expired') expired = true;
        approving = false;
        return;
      }
      approved = true;
      haptic('success');
    } catch {
      error = 'Network error. Please try again.';
      approving = false;
    }
  }

  let cancelling = $state(false);

  async function cancel() {
    if (cancelling) return;
    cancelling = true;
    haptic('light');
    try {
      await fetch('/api/auth/device-pairing/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: pairingSecret }),
      });
    } catch {
      // Non-critical — navigate away regardless.
    }
    void goto('/discover');
  }

  function deviceIcon(name: string) {
    const lower = (name || '').toLowerCase();
    if (lower.includes('tv')) return Tv;
    if (lower.includes('mobile') || lower.includes('phone')) return Smartphone;
    if (lower.includes('tablet')) return Smartphone;
    if (lower.includes('desktop')) return Monitor;
    return Laptop;
  }

  // Compute the icon component reactively.
  let DeviceIconComponent = $derived(deviceIcon(deviceName));
</script>

<svelte:head>
  <title>Authorize Device — Mavero</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AuthShell
  eyebrow="MAVERO / Device Authorization"
  title="Authorize this <em>device.</em>"
  subtitle="A new device wants to sign in to your Mavero account."
>
  <div class="authorize-page">
    {#if loading}
      <div class="authorize-loading">
        <LoaderCircle size={24} class="spin" />
        <span>Loading device information…</span>
      </div>
    {:else if approved}
      <div class="authorize-success">
        <Check size={32} />
        <h2>Device authorized</h2>
        <p>The device can now complete sign-in on its screen.</p>
        <a class="authorize-done-btn" href="/account">Go to my account</a>
      </div>
    {:else if expired}
      <div class="authorize-expired">
        <AlertCircle size={32} />
        <h2>Request expired</h2>
        <p>This pairing request has expired. Please generate a new code on the device.</p>
        <a class="authorize-done-btn" href="/discover">Back to Mavero</a>
      </div>
    {:else if error}
      <div class="authorize-error">
        <AlertCircle size={32} />
        <h2>Unable to authorize</h2>
        <p>{error}</p>
        <a class="authorize-done-btn" href="/discover">Back to Mavero</a>
      </div>
    {:else}
      <div class="authorize-device-card">
        <div class="authorize-device-head">
          <span class="authorize-device-icon"><DeviceIconComponent size={20} /></span>
          <div>
            <strong class="authorize-device-name">{deviceName}</strong>
            <span class="authorize-device-meta">{[browser, os].filter(Boolean).join(' · ') || 'Unknown browser'}</span>
          </div>
        </div>
        {#if platform}
          <div class="authorize-platform">Platform: {platform}</div>
        {/if}
        <div class="authorize-actions">
          <button class="authorize-cancel-btn" type="button" onclick={cancel} disabled={cancelling || approving}>Cancel</button>
          <button class="authorize-approve-btn" type="button" onclick={approve} disabled={approving}>
            {#if approving}<LoaderCircle size={16} class="spin" /> Approving…{:else}<ShieldCheck size={16} /> Approve{/if}
          </button>
        </div>
      </div>
    {/if}
  </div>
</AuthShell>

<style>
  .authorize-page { display: grid; gap: 20px; padding: 16px 0; }

  .authorize-loading { display: grid; gap: 12px; place-items: center; padding: 30px 0; color: var(--color-text-muted); font-size: .82rem; }
  .authorize-loading :global(svg) { color: var(--color-primary); }

  .authorize-success, .authorize-expired, .authorize-error {
    display: grid; gap: 12px; place-items: center; text-align: center; padding: 30px 0;
  }
  .authorize-success :global(svg) { color: var(--color-primary); }
  .authorize-expired :global(svg), .authorize-error :global(svg) { color: var(--color-warning); }
  .authorize-success h2, .authorize-expired h2, .authorize-error h2 {
    margin: 0; color: var(--color-text); font-size: 1.1rem; font-weight: 800;
  }
  .authorize-success p, .authorize-expired p, .authorize-error p {
    margin: 0; color: var(--color-text-muted); font-size: .78rem; max-width: 320px;
  }

  .authorize-done-btn {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 40px; padding: 0 18px;
    border: 1px solid var(--color-primary-border); border-radius: 999px;
    color: #050708; background: var(--color-primary);
    font: inherit; font-size: .76rem; font-weight: 800;
    text-decoration: none;
    box-shadow: var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out);
  }
  .authorize-done-btn:hover { transform: translateY(-1px); }
  .authorize-done-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .authorize-device-card {
    display: grid; gap: 16px;
    padding: 20px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .authorize-device-head { display: flex; align-items: center; gap: 14px; }
  .authorize-device-icon {
    display: grid; place-items: center; width: 40px; height: 40px;
    border-radius: 10px; color: var(--color-primary);
    background: var(--color-primary-soft); border: 1px solid var(--color-primary-border);
    flex: 0 0 auto;
  }
  .authorize-device-name { display: block; color: var(--color-text); font-size: .88rem; font-weight: 700; }
  .authorize-device-meta { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: .68rem; }
  .authorize-platform { color: var(--color-text-deep); font-size: .62rem; font-family: 'JetBrains Mono', ui-monospace, monospace; }

  .authorize-actions { display: flex; gap: 10px; justify-content: flex-end; }
  .authorize-cancel-btn {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 40px; padding: 0 16px;
    border: 1px solid var(--color-border-strong); border-radius: 999px;
    color: var(--color-text); background: transparent;
    font: inherit; font-size: .76rem; font-weight: 700; cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .authorize-cancel-btn:hover { background: var(--color-surface-elevated); border-color: var(--color-border-strong); }
  .authorize-cancel-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .authorize-approve-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    min-height: 40px; padding: 0 18px;
    border: 1px solid transparent; border-radius: 999px;
    color: #050708; background: var(--color-primary);
    font: inherit; font-size: .76rem; font-weight: 800; cursor: pointer;
    box-shadow: var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .authorize-approve-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.06); }
  .authorize-approve-btn:active { transform: scale(.98); }
  .authorize-approve-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .authorize-approve-btn:disabled { opacity: .6; cursor: progress; }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
