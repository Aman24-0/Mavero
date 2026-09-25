<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
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

  // Phase 5: refs to the retry buttons in the expired/error states.
  // When the state transitions to expired or error, a $effect
  // focuses the retry button so TV-remote / keyboard users can
  // immediately activate it without tabbing. This is the a11y-safe
  // alternative to the `autofocus` HTML attribute (which Svelte's
  // a11y lint correctly warns against for general use).
  let expiredRetryBtn: HTMLButtonElement | undefined = $state();
  let errorRetryBtn: HTMLButtonElement | undefined = $state();

  // Newtask §25 (RC-9 fix): the success-navigation timer is tracked so
  // onDestroy can clear it — if the user navigates away during the
  // 1.5s success window, the pending goto() must never hijack their
  // navigation.
  let navTimer: ReturnType<typeof setTimeout> | undefined;

  // Phase 5: a monotonically-increasing request token. Each call to
  // createPairing() increments this. Stale async callbacks (from a
  // previous pairing attempt whose fetch resolved after the user
  // already clicked retry) check this token and bail out — they
  // cannot mutate state belonging to a newer request.
  let requestToken = 0;

  onMount(() => {
    void createPairing();
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    if (navTimer) clearTimeout(navTimer);
  });

  async function createPairing() {
    // Phase 5: increment the request token. Any stale callback from
    // a previous attempt will see its captured token is stale and
    // bail out before mutating state.
    const myToken = ++requestToken;
    pairingState = 'loading';
    errorMessage = '';
    qrDataUrl = '';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }

    try {
      const res = await fetch('/api/auth/device-pairing/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const payload = await res.json();
      if (myToken !== requestToken) return; // stale — a newer retry superseded us
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
      //
      // Phase 5: render at a higher resolution (480px) so the image
      // is sharp on large screens and TV displays. The displayed
      // size is controlled by CSS (responsive), not by the raster
      // pixel dimensions. 480px gives ~2x density over the largest
      // display size (~320px), avoiding blur on high-DPI screens.
      try {
        qrDataUrl = await QRCode.toDataURL(qrUrl, {
          width: 480,
          margin: 2,
          color: { dark: '#050708', light: '#f2fff8' },
        });
      } catch {
        // If local QR generation fails, show the short code fallback.
        qrDataUrl = '';
      }

      if (myToken !== requestToken) return; // stale
      pairingState = 'pending';
      startCountdown(myToken);
      startPolling(myToken);
    } catch {
      if (myToken !== requestToken) return; // stale
      pairingState = 'error';
      errorMessage = 'Network error. Please try again.';
    }
  }

  function startCountdown(token: number) {
    const updateCountdown = () => {
      if (token !== requestToken) {
        // Stale timer from a previous pairing attempt — clear self.
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
        return;
      }
      const remaining = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
      countdown = remaining;
      if (remaining <= 0 && pairingState === 'pending') {
        pairingState = 'expired';
        if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
      }
    };
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
  }

  function startPolling(token: number) {
    let consecutiveErrors = 0;
    pollTimer = setInterval(async () => {
      if (token !== requestToken) {
        // Stale poller from a previous attempt — clear self.
        if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
        return;
      }
      if (pairingState !== 'pending') return;
      try {
        const res = await fetch(`/api/auth/device-pairing/status?secret=${encodeURIComponent(pairingSecret)}`, {
          headers: { accept: 'application/json' },
        });
        const payload = await res.json();
        if (token !== requestToken) return; // stale — newer retry superseded us
        consecutiveErrors = 0;

        if (!res.ok || !payload.ok) {
          if (payload.status === 'expired') {
            pairingState = 'expired';
            if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
            if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
          }
          return;
        }

        if (payload.status === 'approved') {
          pairingState = 'exchanging';
          if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
          if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
          await exchangeSession(token);
        } else if (payload.status === 'cancelled') {
          pairingState = 'error';
          errorMessage = 'The authorization was cancelled.';
          if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
          if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
        } else if (payload.status === 'expired') {
          pairingState = 'expired';
          if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
          if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
        }
      } catch {
        if (token !== requestToken) return; // stale
        consecutiveErrors++;
        if (consecutiveErrors > 5) {
          pairingState = 'error';
          errorMessage = 'Connection lost. Please try again.';
          if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
          if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
        }
      }
    }, 3000); // Poll every 3 seconds — within the pairingPoll rate limit (60/min)
  }

  async function exchangeSession(token: number) {
    try {
      // Call the dedicated device-pairing exchange endpoint.
      // This endpoint atomically claims the approved pairing request
      // via the claim_device_pairing RPC (SELECT FOR UPDATE → capture
      // the OLD OTP → UPDATE consumed + clear the stored OTP →
      // RETURN OLD) and performs exchangeCodeForSession on the TV's
      // own Supabase SSR client. The OTP NEVER reaches the client —
      // no separate /consume call is needed.
      const res = await fetch('/api/auth/device-pairing/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: pairingSecret }),
        redirect: 'manual',
      });
      if (token !== requestToken) return; // stale

      if (res.ok) {
        // Exchange endpoint has finalized server-side: pairing is
        // marked consumed, the OTP code is cleared, TV session
        // cookies are set. No client-side consume call required.
        pairingState = 'success';
        // Navigate to discover after a brief delay so the user sees
        // the success state before the page transitions.
        //
        // Newtask §25 (RC-14 fix): invalidateAll() reruns the root
        // layout server load BEFORE navigating — this page loaded
        // while the browser was UNAUTHENTICATED, so the cached layout
        // data still says "guest". Without invalidation the TV would
        // land on /discover still rendering the guest UI until a full
        // page reload. The timer is tracked (navTimer) and cleared on
        // destroy so it can never hijack a manual navigation.
        navTimer = setTimeout(() => {
          void invalidateAll().then(() => goto('/discover'));
        }, 1500);
      } else {
        pairingState = 'error';
        errorMessage = 'Unable to establish a session. Please try again.';
      }
    } catch {
      if (token !== requestToken) return; // stale
      pairingState = 'error';
      errorMessage = 'Unable to establish a session. Please try again.';
    }
  }

  function formatCountdown(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Phase 5: focus management for TV-remote / keyboard users.
  // When the state transitions to 'expired' or 'error', focus the
  // primary retry button so it's immediately reachable without a
  // mouse. Uses tick() to wait for the DOM to reflect the new state
  // before focusing. Only fires on state transitions into the
  // terminal states — not on every state change.
  let lastFocusedState: PairingState = 'idle';
  $effect(() => {
    const state = pairingState;
    if (state !== lastFocusedState && (state === 'expired' || state === 'error')) {
      // State just transitioned into a terminal retry state.
      void tick().then(() => {
        const btn = state === 'expired' ? expiredRetryBtn : errorRetryBtn;
        btn?.focus();
      });
    }
    lastFocusedState = state;
  });
</script>

<svelte:head>
  <title>TV Sign in — Mavero</title>
  <meta name="description" content="Scan a QR code to sign in on this device." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<!--
  Phase 5 — TV/Desktop QR UI.
  AuthShell is shared with /auth/sign-in, /auth/sign-up, /auth/reset.
  We override ONLY the back button props for the TV context:
    - backHref="/discover" (the consumer landing page — a TV is
      unauthenticated, so /account would just redirect to guest view;
      /discover is the sensible "back" destination).
    - backLabel="Back to Mavero" (clearer than "Back" on a TV where
      the user may not understand what they're going back to).
  AuthShell itself is NOT modified globally.
-->
<AuthShell
  eyebrow="MAVERO / TV Sign in"
  title="Sign in with your <em>phone.</em>"
  subtitle="Scan the QR code with your phone's camera to sign in on this device."
  backHref="/discover"
  backLabel="Back to Mavero"
>
  <div class="tv-login" role="region" aria-label="TV sign-in">
    {#if pairingState === 'loading'}
      <div class="tv-state-loading" role="status" aria-live="polite">
        <LoaderCircle size={32} class="spin" />
        <span>Preparing your sign-in code…</span>
      </div>
    {:else if pairingState === 'pending'}
      <div class="tv-qr-area">
        <div class="tv-qr-frame">
          <!-- QR code generated locally via the qrcode package — the
               pairing URL is NEVER sent to an external service.
               The img has no fixed width/height attributes; CSS
               controls the responsive display size. The raster is
               480px (rendered at ~2x density) so it stays sharp on
               high-DPI and large displays. -->
          <div class="tv-qr-placeholder">
            {#if qrDataUrl}
              <img
                src={qrDataUrl}
                alt="QR code for Mavero sign-in — scan with your phone camera"
                class="tv-qr-img"
                loading="eager"
                decoding="async"
              />
            {:else}
              <div class="tv-qr-fallback">QR unavailable</div>
            {/if}
          </div>
        </div>
        <div class="tv-qr-info">
          <p class="tv-instructions">Scan with your phone or tablet</p>
          <!--
            aria-live="off" on the countdown — it updates every
            second and would be noise on a screen reader. The
            countdown is visually prominent; the expiry transition
            to the "Code expired" state IS announced via the
            expired container's aria-live="polite".
          -->
          <div class="tv-countdown" aria-live="off">
            Code expires in <span class="tv-countdown-value">{formatCountdown(countdown)}</span>
          </div>
          {#if shortCode}
            <div class="tv-shortcode">
              <span class="shortcode-label">Or enter code manually:</span>
              <span class="shortcode-value">{shortCode}</span>
            </div>
          {/if}
        </div>
      </div>
      <div class="tv-waiting" role="status" aria-live="polite">
        <LoaderCircle size={16} class="spin" />
        <span>Waiting for scan — approve login on your phone</span>
      </div>
    {:else if pairingState === 'exchanging'}
      <div class="tv-state-success" role="status" aria-live="polite">
        <CheckCircle2 size={32} />
        <h2>Approved!</h2>
        <p>Signing you in…</p>
        <LoaderCircle size={20} class="spin" />
      </div>
    {:else if pairingState === 'success'}
      <div class="tv-state-success" role="status" aria-live="polite">
        <CheckCircle2 size={32} />
        <h2>You're signed in!</h2>
        <p>Redirecting to Mavero…</p>
      </div>
    {:else if pairingState === 'expired'}
      <!--
        Phase 5: focus management. The retry button gets bind:this
        so the $effect above can focus it on the state transition,
        making the primary action reachable immediately for TV-remote
        and keyboard users without requiring a mouse click.
      -->
      <div class="tv-state-expired" role="alert" aria-live="polite">
        <AlertCircle size={32} />
        <h2>Code expired</h2>
        <p>This sign-in code has expired.</p>
        <button
          class="tv-retry-btn"
          type="button"
          bind:this={expiredRetryBtn}
          onclick={() => { haptic('light'); void createPairing(); }}
        >
          <RefreshCw size={16} /> Generate new code
        </button>
      </div>
    {:else if pairingState === 'error'}
      <div class="tv-state-error" role="alert" aria-live="polite">
        <AlertCircle size={32} />
        <h2>Something went wrong</h2>
        <p>{errorMessage}</p>
        <button
          class="tv-retry-btn"
          type="button"
          bind:this={errorRetryBtn}
          onclick={() => { haptic('light'); void createPairing(); }}
        >
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

  .tv-state-loading {
    display: grid; gap: 16px; place-items: center;
    padding: 40px 0;
    color: var(--color-text-muted);
    font-size: .88rem;
  }
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

  /*
    Phase 5: responsive QR display size.
    The raster is 480px (high-DPI friendly); the display size is
    controlled here via clamp() and media queries so the QR scales
    up on larger viewports (desktop, TV) without exceeding a sensible
    maximum. The QR is the visual anchor of the page.

    Default (mobile / small desktop): 240px.
    min(240px, 60vw) ensures it never overflows on very narrow screens.
  */
  .tv-qr-img {
    display: block;
    width: min(240px, 60vw);
    height: auto;
    aspect-ratio: 1 / 1;
    border-radius: var(--radius-sm);
    image-rendering: -webkit-optimize-contrast;
  }
  .tv-qr-fallback {
    width: min(240px, 60vw);
    height: min(240px, 60vw);
    display: grid; place-items: center;
    color: var(--color-text-deep);
    font-size: .78rem;
    background: var(--color-surface-elevated);
    border-radius: var(--radius-sm);
  }

  .tv-qr-info { text-align: center; display: grid; gap: 8px; justify-items: center; }
  .tv-instructions { color: var(--color-text-muted); font-size: .88rem; margin: 0; }
  .tv-countdown {
    color: var(--color-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 1rem; font-weight: 700;
    letter-spacing: .05em;
  }
  .tv-countdown-value {
    display: inline-block;
    min-width: 4ch;
    font-variant-numeric: tabular-nums;
  }

  .tv-shortcode { display: inline-flex; align-items: center; gap: 8px; margin-top: 8px; }
  .shortcode-label { color: var(--color-text-deep); font-size: .66rem; }
  .shortcode-value {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 1.15rem; font-weight: 800; letter-spacing: .1em;
    color: var(--color-text);
    padding: 4px 12px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }

  .tv-waiting {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--color-text-deep); font-size: .82rem;
  }
  .tv-waiting :global(svg) { color: var(--color-text-muted); }

  .tv-state-success {
    display: grid; gap: 12px; place-items: center; text-align: center; padding: 30px 0;
  }
  .tv-state-success :global(svg) { color: var(--color-primary); }
  .tv-state-success h2 { margin: 0; color: var(--color-text); font-size: 1.4rem; }
  .tv-state-success p { margin: 0; color: var(--color-text-muted); font-size: .88rem; }

  .tv-state-expired, .tv-state-error {
    display: grid; gap: 12px; place-items: center; text-align: center; padding: 30px 0;
  }
  .tv-state-expired :global(svg), .tv-state-error :global(svg) { color: var(--color-warning); }
  .tv-state-expired h2, .tv-state-error h2 { margin: 0; color: var(--color-text); font-size: 1.3rem; }
  .tv-state-expired p, .tv-state-error p { margin: 0; color: var(--color-text-muted); font-size: .86rem; max-width: 360px; }

  .tv-retry-btn {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 44px; /* Phase 5: 44px touch/remote target */
    padding: 0 20px;
    border: 1px solid var(--color-primary-border); border-radius: 999px;
    color: #050708; background: var(--color-primary);
    font: inherit; font-size: .82rem; font-weight: 800;
    cursor: pointer;
    box-shadow: var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .tv-retry-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .tv-retry-btn:active { transform: scale(.98); }
  .tv-retry-btn:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 3px; }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /*
    Phase 5: responsive large-screen / TV layout.
    The QR scales up on larger viewports so it's scannable from a
    TV viewing distance. Typography is slightly enlarged for
    readability on large displays.
  */

  /* Small desktop / tablet landscape (≥768px) */
  @media (min-width: 768px) {
    .tv-qr-img, .tv-qr-fallback {
      width: 280px;
    }
    .tv-instructions { font-size: .92rem; }
    .tv-countdown { font-size: 1.05rem; }
    .tv-state-success h2 { font-size: 1.5rem; }
    .tv-state-expired h2, .tv-state-error h2 { font-size: 1.4rem; }
  }

  /* Large desktop / laptop (≥1024px) */
  @media (min-width: 1024px) {
    .tv-qr-img, .tv-qr-fallback {
      width: 320px;
    }
    .tv-qr-frame { padding: 20px; }
    .tv-instructions { font-size: .96rem; }
    .tv-countdown { font-size: 1.12rem; }
    .shortcode-value { font-size: 1.25rem; }
    .tv-state-loading { font-size: .94rem; }
    .tv-state-loading :global(svg), .tv-state-success :global(svg), .tv-state-expired :global(svg), .tv-state-error :global(svg) {
      /* Scale up icons on large screens for visibility from a distance. */
      transform: scale(1.1);
    }
  }

  /* TV / very large display (≥1920px) */
  @media (min-width: 1920px) {
    .tv-qr-img, .tv-qr-fallback {
      width: 360px;
    }
    .tv-qr-frame { padding: 24px; }
    .tv-instructions { font-size: 1.02rem; }
    .tv-countdown { font-size: 1.2rem; }
    .shortcode-value { font-size: 1.35rem; }
    .tv-state-success h2 { font-size: 1.65rem; }
    .tv-state-expired h2, .tv-state-error h2 { font-size: 1.55rem; }
    .tv-state-expired p, .tv-state-error p { font-size: .92rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.spin) { animation: none; }
    .tv-retry-btn { transition: none; }
    .tv-retry-btn:hover { transform: none; filter: none; }
    .tv-retry-btn:active { transform: none; }
  }
</style>
