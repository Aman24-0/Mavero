<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { LoaderCircle, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-svelte';
  import AuthShell from '$components/AuthShell.svelte';
  import { haptic } from '$lib/client/haptics';
  import QRCode from 'qrcode';

  type PairingState = 'idle' | 'loading' | 'pending' | 'approved' | 'exchanging' | 'success' | 'expired' | 'error';

  let pairingState: PairingState = $state('idle');
  let pairingSecret = $state('');
  let shortCode = $state('');
  let qrUrl = $state('');
  let qrDataUrl = $state('');
  let expiresAt = $state('');
  let countdown = $state(0);
  let errorMessage = $state('');
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    void createPairing();
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (countdownTimer) clearInterval(countdownTimer);
  });

  async function createPairing() {
    pairingState = 'loading';
    errorMessage = '';
    qrDataUrl = '';
    if (pollTimer) clearInterval(pollTimer);
    if (countdownTimer) clearInterval(countdownTimer);

    try {
      const res = await fetch('/api/auth/device-pairing/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        pairingState = 'error';
        errorMessage = payload.message ?? 'Unable to create a pairing request.';
        return;
      }

      pairingSecret = payload.pairing.secret;
      shortCode = payload.pairing.shortCode;
      qrUrl = payload.pairing.qrUrl;
      expiresAt = payload.pairing.expiresAt;

      // Generate QR code locally — NEVER send the pairing URL to an
      // external service. The QR encodes only the pairing URL
      // (/authorize?s=<secret>), which the TV already possesses.
      try {
        qrDataUrl = await QRCode.toDataURL(qrUrl, {
          width: 240,
          margin: 1,
          color: { dark: '#050708', light: '#f2fff8' },
        });
      } catch {
        // If local QR generation fails, show the short code fallback.
        qrDataUrl = '';
      }

      pairingState = 'pending';
      startCountdown();
      startPolling();
    } catch {
      pairingState = 'error';
      errorMessage = 'Network error. Please try again.';
    }
  }

  function startCountdown() {
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
      countdown = remaining;
      if (remaining <= 0 && pairingState === 'pending') {
        pairingState = 'expired';
        if (pollTimer) clearInterval(pollTimer);
        if (countdownTimer) clearInterval(countdownTimer);
      }
    };
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
  }

  function startPolling() {
    let consecutiveErrors = 0;
    pollTimer = setInterval(async () => {
      if (pairingState !== 'pending') return;
      try {
        const res = await fetch(`/api/auth/device-pairing/status?secret=${encodeURIComponent(pairingSecret)}`, {
          headers: { accept: 'application/json' },
        });
        const payload = await res.json();
        consecutiveErrors = 0;

        if (!res.ok || !payload.ok) {
          if (payload.status === 'expired') {
            pairingState = 'expired';
            if (pollTimer) clearInterval(pollTimer);
            if (countdownTimer) clearInterval(countdownTimer);
          }
          return;
        }

        if (payload.status === 'approved') {
          pairingState = 'exchanging';
          if (pollTimer) clearInterval(pollTimer);
          if (countdownTimer) clearInterval(countdownTimer);
          await exchangeSession();
        } else if (payload.status === 'cancelled') {
          pairingState = 'error';
          errorMessage = 'The authorization was cancelled.';
          if (pollTimer) clearInterval(pollTimer);
          if (countdownTimer) clearInterval(countdownTimer);
        } else if (payload.status === 'expired') {
          pairingState = 'expired';
          if (pollTimer) clearInterval(pollTimer);
          if (countdownTimer) clearInterval(countdownTimer);
        }
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors > 5) {
          pairingState = 'error';
          errorMessage = 'Connection lost. Please try again.';
          if (pollTimer) clearInterval(pollTimer);
          if (countdownTimer) clearInterval(countdownTimer);
        }
      }
    }, 3000); // Poll every 3 seconds
  }

  async function exchangeSession() {
    try {
      // Call the dedicated device-pairing exchange endpoint.
      // This endpoint validates the pairing secret server-side and
      // performs exchangeCodeForSession using the stored OTP code.
      // The exchange code NEVER reaches the client — the server
      // reads it from the database and exchanges it internally.
      const res = await fetch('/api/auth/device-pairing/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: pairingSecret }),
        redirect: 'manual',
      });

      if (res.ok) {
        // Consume the pairing (clear the code, mark as consumed).
        void fetch('/api/auth/device-pairing/consume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: pairingSecret }),
        });
        pairingState = 'success';
        // Navigate to discover after a brief delay.
        setTimeout(() => { void goto('/discover'); }, 1500);
      } else {
        pairingState = 'error';
        errorMessage = 'Unable to establish a session. Please try again.';
      }
    } catch {
      pairingState = 'error';
      errorMessage = 'Unable to establish a session. Please try again.';
    }
  }

  function formatCountdown(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
</script>

<svelte:head>
  <title>TV Sign in — Mavero</title>
  <meta name="description" content="Scan a QR code to sign in on this device." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AuthShell
  eyebrow="MAVERO / TV Sign in"
  title="Sign in with your <em>phone.</em>"
  subtitle="Scan the QR code with your phone's camera to sign in on this device."
>
  <div class="tv-login">
    {#if pairingState === 'loading'}
      <div class="tv-state-loading">
        <LoaderCircle size={32} class="spin" />
        <span>Preparing your sign-in code…</span>
      </div>
    {:else if pairingState === 'pending'}
      <div class="tv-qr-area">
        <div class="tv-qr-frame">
          <!-- QR code generated locally via the qrcode package — the
               pairing URL is NEVER sent to an external service. -->
          <div class="tv-qr-placeholder">
            {#if qrDataUrl}
              <img src={qrDataUrl} alt="QR code for Mavero sign-in" width="240" height="240" loading="eager" />
            {:else}
              <div class="tv-qr-fallback">QR unavailable</div>
            {/if}
          </div>
        </div>
        <div class="tv-qr-info">
          <p class="tv-instructions">Open your phone camera and scan this code.</p>
          <div class="tv-countdown">Code expires in {formatCountdown(countdown)}</div>
          {#if shortCode}
            <div class="tv-shortcode">
              <span class="shortcode-label">Or enter code manually:</span>
              <span class="shortcode-value">{shortCode}</span>
            </div>
          {/if}
        </div>
      </div>
      <div class="tv-waiting">
        <LoaderCircle size={16} class="spin" />
        <span>Waiting for approval on your phone…</span>
      </div>
    {:else if pairingState === 'exchanging'}
      <div class="tv-state-success">
        <CheckCircle2 size={32} />
        <h2>Approved!</h2>
        <p>Signing you in…</p>
        <LoaderCircle size={20} class="spin" />
      </div>
    {:else if pairingState === 'success'}
      <div class="tv-state-success">
        <CheckCircle2 size={32} />
        <h2>You're signed in!</h2>
        <p>Redirecting to Mavero…</p>
      </div>
    {:else if pairingState === 'expired'}
      <div class="tv-state-expired">
        <AlertCircle size={32} />
        <h2>Code expired</h2>
        <p>This sign-in code has expired.</p>
        <button class="tv-retry-btn" type="button" onclick={() => { haptic('light'); void createPairing(); }}>
          <RefreshCw size={16} /> Generate new code
        </button>
      </div>
    {:else if pairingState === 'error'}
      <div class="tv-state-error">
        <AlertCircle size={32} />
        <h2>Something went wrong</h2>
        <p>{errorMessage}</p>
        <button class="tv-retry-btn" type="button" onclick={() => { haptic('light'); void createPairing(); }}>
          <RefreshCw size={16} /> Try again
        </button>
      </div>
    {/if}
  </div>
</AuthShell>

<style>
  .tv-login {
    display: grid;
    gap: 24px;
    justify-items: center;
    padding: 20px 0;
  }

  .tv-state-loading { display: grid; gap: 16px; place-items: center; padding: 40px 0; color: var(--color-text-muted); font-size: .82rem; }
  .tv-state-loading :global(svg) { color: var(--color-primary); }

  .tv-qr-area { display: grid; gap: 20px; justify-items: center; }
  .tv-qr-frame {
    padding: 16px;
    border: 2px solid var(--color-primary-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--glow-primary);
  }
  .tv-qr-placeholder { display: grid; place-items: center; }
  .tv-qr-placeholder img { display: block; border-radius: var(--radius-sm); }

  .tv-qr-info { text-align: center; display: grid; gap: 8px; justify-items: center; }
  .tv-instructions { color: var(--color-text-muted); font-size: .82rem; margin: 0; }
  .tv-countdown {
    color: var(--color-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .9rem; font-weight: 700;
    letter-spacing: .05em;
  }

  .tv-shortcode { display: inline-flex; align-items: center; gap: 8px; margin-top: 8px; }
  .shortcode-label { color: var(--color-text-deep); font-size: .6rem; }
  .shortcode-value {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 1.1rem; font-weight: 800; letter-spacing: .1em;
    color: var(--color-text);
    padding: 4px 12px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }

  .tv-waiting {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--color-text-deep); font-size: .74rem;
  }
  .tv-waiting :global(svg) { color: var(--color-text-muted); }

  .tv-state-success { display: grid; gap: 12px; place-items: center; text-align: center; padding: 30px 0; }
  .tv-state-success :global(svg) { color: var(--color-primary); }
  .tv-state-success h2 { margin: 0; color: var(--color-text); font-size: 1.3rem; }
  .tv-state-success p { margin: 0; color: var(--color-text-muted); font-size: .82rem; }

  .tv-state-expired, .tv-state-error { display: grid; gap: 12px; place-items: center; text-align: center; padding: 30px 0; }
  .tv-state-expired :global(svg), .tv-state-error :global(svg) { color: var(--color-warning); }
  .tv-state-expired h2, .tv-state-error h2 { margin: 0; color: var(--color-text); font-size: 1.2rem; }
  .tv-state-expired p, .tv-state-error p { margin: 0; color: var(--color-text-muted); font-size: .78rem; max-width: 320px; }

  .tv-retry-btn {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 40px; padding: 0 18px;
    border: 1px solid var(--color-primary-border); border-radius: 999px;
    color: #050708; background: var(--color-primary);
    font: inherit; font-size: .76rem; font-weight: 800;
    cursor: pointer;
    box-shadow: var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .tv-retry-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .tv-retry-btn:active { transform: scale(.98); }
  .tv-retry-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    :global(.spin) { animation: none; }
  }
</style>
