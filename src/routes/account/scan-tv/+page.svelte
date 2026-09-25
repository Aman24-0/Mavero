<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Camera, CameraOff, AlertCircle, LoaderCircle, ScanLine, RefreshCw, X, Keyboard } from 'lucide-svelte';
  import { haptic } from '$lib/client/haptics';
  import jsQR from 'jsqr';

  // ── State machine ──────────────────────────────────────────────
  // idle        → before camera starts
  // starting    → getUserMedia in flight
  // scanning    → camera active, decode loop running
  // validating  → QR detected, validating before navigation
  // success     → valid QR, navigating to /authorize
  // error       → camera/permission/initialization failure
  // cancelled   → user cancelled (not used as a rendered state;
  //               cancel navigates away)
  type ScanState = 'idle' | 'starting' | 'scanning' | 'validating' | 'success' | 'error';

  let scanState: ScanState = $state('idle');
  let errorMessage = $state('');

  // ── Manual-code entry state (§10/§11) ──
  // Secondary path: the user types the 8-character code shown on
  // the big screen ("Or enter code manually: DH84EXKP"). The code
  // is resolved via the AUTHENTICATED, rate-limited /lookup
  // endpoint into a one-time authorization handle — the raw
  // pairing secret NEVER reaches the browser on this path.
  //
  // UX requirements (§11): auto-uppercase, trim, reject invalid
  // characters, max length 8, clear validation, submit on Enter,
  // loading / expired / invalid / rate-limit states.
  let manualCode = $state('');
  let manualBusy = $state(false);
  let manualError = $state('');
  let manualErrorKind = $state<'' | 'invalid' | 'expired' | 'rate-limited'>('');
  let manualInput: HTMLInputElement | undefined = $state();

  const MANUAL_CODE_MAX = 8;
  // Same alphabet as the server (no ambiguous chars: no 0/O/1/I).
  const MANUAL_CODE_PATTERN = /^[A-Z0-9]{8}$/;

  function normalizeManualCode(raw: string): string {
    // Uppercase, strip whitespace, keep only characters that can
    // appear in a code (letters + digits). Invalid characters are
    // dropped rather than rejected so typing stays smooth.
    return raw
      .toUpperCase()
      .replace(/\s+/g, '')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, MANUAL_CODE_MAX);
  }

  function onManualCodeInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    manualCode = normalizeManualCode(target.value);
    target.value = manualCode;
    // Clear the error as soon as the user edits the code.
    if (manualError) {
      manualError = '';
      manualErrorKind = '';
    }
  }

  function manualCodeValid(): boolean {
    return MANUAL_CODE_PATTERN.test(manualCode);
  }

  async function submitManualCode() {
    if (manualBusy) return;
    // Client-side validation — clear message, no server roundtrip
    // for obviously malformed input.
    if (!manualCodeValid()) {
      manualError = 'Enter the 8-character code shown on the big screen.';
      manualErrorKind = 'invalid';
      manualInput?.focus();
      return;
    }
    manualBusy = true;
    manualError = '';
    manualErrorKind = '';
    haptic('light');
    try {
      const res = await fetch('/api/auth/device-pairing/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code: manualCode }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        manualError = payload.message ?? 'Invalid or expired code.';
        manualErrorKind = payload.status === 'expired' ? 'expired' : payload.status === 'rate-limited' ? 'rate-limited' : 'invalid';
        manualBusy = false;
        return;
      }
      // Success — navigate to the SAME secure device-authorization
      // page as the QR path, with the one-time handle in the URL
      // FRAGMENT (never a query string). Entering the code did NOT
      // approve anything — the explicit Approve click happens on
      // /authorize, exactly like the QR flow.
      stopCamera();
      scanState = 'success';
      void goto(`/authorize#h=${encodeURIComponent(payload.handle)}`);
    } catch {
      manualError = 'Network error. Please try again.';
      manualErrorKind = 'invalid';
      manualBusy = false;
    }
  }

  // Camera + DOM refs.
  let video: HTMLVideoElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let stream: MediaStream | null = null;
  let rafId: number | null = null; // requestAnimationFrame ID for decode loop
  let destroyed = false;

  // Prevents duplicate scan-success callbacks. Once a valid QR is
  // detected, this is set to true and the decode loop stops calling
  // the success handler.
  let scanResolved = false;

  onMount(() => {
    void startCamera();
  });

  onDestroy(() => {
    destroyed = true;
    stopCamera();
  });

  // ── Camera lifecycle ────────────────────────────────────────────

  async function startCamera() {
    // Reset state for retry.
    scanResolved = false;
    stopCamera(); // clean up any previous stream/tracks
    if (destroyed) return;

    scanState = 'starting';
    errorMessage = '';

    // Feature-detect getUserMedia.
    if (!navigator.mediaDevices?.getUserMedia) {
      scanState = 'error';
      errorMessage = 'Camera not available. Your browser does not support camera access.';
      return;
    }

    // Insecure context (http:) blocks getUserMedia entirely.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      scanState = 'error';
      errorMessage = 'Camera access requires a secure (HTTPS) connection.';
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' }, // prefer rear camera on phones
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      if (destroyed) {
        // Component was destroyed while waiting for getUserMedia.
        stopCamera();
        return;
      }

      if (!video) {
        stopCamera();
        scanState = 'error';
        errorMessage = 'Camera initialization failed.';
        return;
      }

      video.srcObject = stream;
      // Wait for the video to be ready before starting the decode loop.
      await video.play().catch(() => {
        // play() can reject if the video element is not ready or if
        // autoplay policy blocks it. We treat this as a camera error.
        throw new Error('Could not start camera preview.');
      });

      if (destroyed) {
        stopCamera();
        return;
      }

      scanState = 'scanning';
      startDecodeLoop();
    } catch (err) {
      if (destroyed) return;
      handleCameraError(err);
    }
  }

  function handleCameraError(err: unknown) {
    stopCamera();
    scanState = 'error';

    const errorName = (err as DOMException)?.name ?? '';
    const errorMsg = (err as Error)?.message ?? '';

    if (errorName === 'NotAllowedError' || errorName === 'SecurityError') {
      errorMessage = 'Camera permission denied. Enable camera access in your browser settings to scan the TV code.';
    } else if (errorName === 'NotFoundError' || errorName === 'OverconstrainedError' || errorName === 'DevicesNotFoundError') {
      errorMessage = 'No camera found. Make sure your device has a camera and it is not in use by another app.';
    } else if (errorName === 'NotReadableError') {
      errorMessage = 'Camera is in use by another application. Close it and try again.';
    } else if (errorName === 'AbortError') {
      errorMessage = 'Camera initialization was interrupted. Please try again.';
    } else if (errorMsg.includes('secure')) {
      errorMessage = 'Camera access requires a secure (HTTPS) connection.';
    } else {
      errorMessage = 'Camera unavailable. Please check your device and try again.';
    }
  }

  function stopCamera() {
    // Stop all camera tracks — this turns off the camera indicator.
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      stream = null;
    }
    // Cancel any pending animation frame.
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    // Detach the stream from the video element.
    if (video) {
      try { video.srcObject = null; } catch { /* ignore */ }
    }
  }

  // ── QR decode loop ─────────────────────────────────────────────

  function startDecodeLoop() {
    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const tick = () => {
      if (destroyed || scanState !== 'scanning' || scanResolved) return;
      if (!video || !canvas) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        // Set canvas to the video's native resolution.
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code && code.data && !scanResolved) {
          // QR detected — validate before navigating.
          scanResolved = true;
          void handleDecodedQR(code.data);
          return; // stop the decode loop
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
  }

  // ── QR validation ──────────────────────────────────────────────
  //
  // CRITICAL SECURITY: the decoded QR data is untrusted input. We
  // must validate that it is a legitimate Mavero TV authorization
  // URL before navigating to it. Reject everything else.

  function validateMaveroPairingURL(raw: string): { valid: true; secret: string } | { valid: false; reason: string } {
    if (!raw || typeof raw !== 'string') {
      return { valid: false, reason: 'empty' };
    }

    // Reject dangerous URI schemes immediately.
    const lower = raw.toLowerCase().trim();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
      return { valid: false, reason: 'dangerous-scheme' };
    }

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { valid: false, reason: 'malformed-url' };
    }

    // Must be same origin as the current page (the Mavero app).
    // This prevents redirecting to arbitrary external domains.
    if (url.origin !== window.location.origin) {
      return { valid: false, reason: 'wrong-origin' };
    }

    // Must be the exact /authorize path.
    if (url.pathname !== '/authorize') {
      return { valid: false, reason: 'wrong-path' };
    }

    // Phase 8: the secret is in the URL FRAGMENT (#s=<secret>), NOT
    // the query string (?s=<secret>). A URL fragment is NOT sent to
    // the HTTP server, so the secret never appears in server logs,
    // browser history request lines, or referrer headers.

    // Reject if there are ANY query parameters — the secret must NOT
    // be in the query string, and no other params are expected.
    if (url.searchParams.toString() !== '') {
      return { valid: false, reason: 'unexpected-query-params' };
    }

    // The fragment must be exactly #s=<secret>.
    // URL.hash includes the leading '#'.
    const hash = url.hash;
    if (!hash || hash.length <= 1) {
      return { valid: false, reason: 'missing-fragment' };
    }

    // Parse the fragment as if it were a query string: #s=<secret>.
    // URLSearchParams handles decoding.
    const fragmentParams = new URLSearchParams(hash.slice(1)); // remove '#'
    const secret = fragmentParams.get('s');
    if (!secret || secret.length < 16) {
      return { valid: false, reason: 'missing-or-short-secret' };
    }

    // Reject if there are unexpected fragment parameters. Only `s` is allowed.
    const allowedFragmentParams = new Set(['s']);
    for (const key of fragmentParams.keys()) {
      if (!allowedFragmentParams.has(key)) {
        return { valid: false, reason: 'unexpected-fragment-param' };
      }
    }

    return { valid: true, secret };
  }

  async function handleDecodedQR(rawData: string) {
    // Stop the camera immediately — we have a QR result.
    stopCamera();

    const result = validateMaveroPairingURL(rawData);

    if (!result.valid) {
      // Invalid QR — show the "not a Mavero code" state and allow
      // the user to scan again. The secret is NOT logged.
      scanState = 'error';
      errorMessage = "This QR code isn't a Mavero sign-in code."
      // Reset scanResolved so retry can detect a new QR.
      scanResolved = false;
      return;
    }

    // Valid Mavero pairing URL — navigate to the existing /authorize
    // flow. The existing /authorize page will load the device info,
    // display it, and ask the user to explicitly approve.
    //
    // IMPORTANT: scanning the QR does NOT approve the pairing. The
    // user must explicitly click "Approve" on the /authorize page.
    scanState = 'validating';
    haptic('light');
    // Use the validated secret (NOT the raw decoded data) to build
    // the navigation URL. Phase 8: the secret is placed in the URL
    // fragment (#s=) so it is NOT sent to the HTTP server.
    void goto(`/authorize#s=${encodeURIComponent(result.secret)}`);
  }

  // ── User actions ───────────────────────────────────────────────

  function cancel() {
    haptic('light');
    stopCamera();
    // Navigate back to the Account page.
    void goto('/account');
  }

  function retry() {
    haptic('light');
    void startCamera();
  }
</script>

<svelte:head>
  <title>Login on Big Screen — Mavero</title>
  <meta name="description" content="Scan the QR code shown on the big screen, or enter the TV code, to sign in on that device." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="scan-page">
  <!-- Top bar: back/cancel button -->
  <div class="scan-top-bar">
    <button class="back-btn" type="button" onclick={cancel} aria-label="Cancel and go back to account">
      <ArrowLeft size={16} /> <span>Back</span>
    </button>
  </div>

  <!-- Camera + scan frame area -->
  <div class="scan-stage" role="region" aria-label="QR code scanner">
    <!--
      Phase 6 fix: the <video> element is ALWAYS mounted — its
      existence does NOT depend on scanState. The video element
      must be in the DOM BEFORE startCamera() attempts to attach a
      MediaStream, because onMount() runs while scanState is 'idle'
      (before any scanning state), and getUserMedia() resolves
      asynchronously. If the video element were conditionally
      rendered inside {#if scanState === 'scanning'}, it would
      not exist when getUserMedia resolves, and the camera would
      be opened (Android green dot) but immediately torn down by
      the `if (!video)` safety check, producing a misleading
      "Camera initialization failed" error.

      Visibility is controlled via CSS classes on the stage and
      video element instead of conditional mount/unmount:
        - .scan-video-hidden: opacity 0 + pointer-events none
          (used when scanState is idle/starting/error/validating,
          so the user sees the overlay, not the camera)
        - .scan-video-active: opacity 1 (used during scanning)
    -->
    <video
      bind:this={video}
      class="scan-video"
      class:scan-video-hidden={scanState !== 'scanning'}
      class:scan-video-active={scanState === 'scanning'}
      autoplay
      playsinline
      muted
      aria-label="Live camera preview for QR scanning"
      aria-hidden={scanState !== 'scanning'}
    ></video>

    <!-- Hidden canvas for frame capture. Never displayed. -->
    <canvas bind:this={canvas} class="scan-canvas-hidden" aria-hidden="true"></canvas>

    {#if scanState === 'idle' || scanState === 'starting'}
      <div class="scan-overlay scan-loading" role="status" aria-live="polite">
        <LoaderCircle size={28} class="spin" />
        <p>Starting camera…</p>
      </div>
    {:else if scanState === 'scanning'}
      <!-- Scan frame guide overlay — rendered on top of the always-mounted video. -->
      <div class="scan-frame" aria-hidden="true">
        <div class="scan-frame-corner scan-frame-tl"></div>
        <div class="scan-frame-corner scan-frame-tr"></div>
        <div class="scan-frame-corner scan-frame-bl"></div>
        <div class="scan-frame-corner scan-frame-br"></div>
        <ScanLine size={20} class="scan-line-icon" />
      </div>
      <div class="scan-instruction" aria-live="polite">
        Scan the QR code shown on the big screen.
      </div>
    {:else if scanState === 'validating' || scanState === 'success'}
      <div class="scan-overlay scan-validating" role="status" aria-live="polite">
        <LoaderCircle size={28} class="spin" />
        <p>QR detected. Opening authorization…</p>
      </div>
    {:else if scanState === 'error'}
      <div class="scan-overlay scan-error" role="alert" aria-live="polite">
        {#if errorMessage.includes('permission denied') || errorMessage.includes('Permission')}
          <CameraOff size={32} />
        {:else}
          <AlertCircle size={32} />
        {/if}
        <h2>Camera unavailable</h2>
        <p>{errorMessage}</p>
        <div class="scan-error-actions">
          <button class="scan-retry-btn" type="button" onclick={retry}>
            <RefreshCw size={14} /> Try again
          </button>
          <button class="scan-back-btn" type="button" onclick={cancel}>
            <X size={14} /> Cancel
          </button>
        </div>
        <!-- Camera broken? The manual-code path still works — the
             form below is always available. -->
      </div>
    {/if}
  </div>

  <!-- §11 — manual-code entry: a secondary path alongside camera
       scanning. Rendered under the scan stage so the camera stays
       the primary flow; "OR" separates the two. The form is easy
       to use on mobile: large mono input, auto-uppercase,
       Enter submits, explicit Continue button. -->
  <div class="manual-code-card">
    <div class="manual-divider" role="separator" aria-label="Alternative to scanning">
      <span class="manual-divider-line"></span>
      <span class="manual-divider-label">OR</span>
      <span class="manual-divider-line"></span>
    </div>

    <form class="manual-form" onsubmit={(event) => { event.preventDefault(); void submitManualCode(); }}>
      <label class="manual-label" for="manual-code-input">
        <Keyboard size={14} />
        <span>Enter TV code</span>
      </label>
      <div class="manual-controls">
        <input
          id="manual-code-input"
          bind:this={manualInput}
          class="manual-input"
          class:manual-input-error={manualError !== ''}
          type="text"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck="false"
          maxlength={MANUAL_CODE_MAX}
          placeholder="DH84EXKP"
          aria-label="TV code — 8 characters shown on the big screen"
          aria-invalid={manualError !== ''}
          aria-describedby={manualError ? 'manual-code-error' : 'manual-code-hint'}
          value={manualCode}
          oninput={onManualCodeInput}
          disabled={manualBusy}
        />
        <button class="manual-submit" type="submit" disabled={manualBusy || !manualCodeValid()}>
          {#if manualBusy}<LoaderCircle size={15} class="spin" />{:else}Continue{/if}
        </button>
      </div>
      {#if manualError}
        <p id="manual-code-error" class="manual-error" role="alert">{manualError}</p>
      {:else}
        <p id="manual-code-hint" class="manual-hint">The 8-character code under the QR code on the big screen.</p>
      {/if}
    </form>
  </div>
</div>

<style>
  .scan-page {
    position: relative;
    min-height: 100dvh;
    background: #000;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Safe area insets for notch/home indicator on phones. */
    padding: calc(env(safe-area-inset-top, 0px)) 0 calc(env(safe-area-inset-bottom, 0px));
  }

  .scan-top-bar {
    position: relative; z-index: 3;
    padding: 14px 16px;
  }
  .back-btn {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 44px; padding: 0 16px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 999px;
    color: #f5f5f5; background: rgba(10, 10, 10, .72);
    backdrop-filter: blur(12px);
    font: inherit; font-size: .76rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .back-btn:hover { background: rgba(20, 20, 20, .85); border-color: rgba(255, 255, 255, .24); }
  .back-btn:active { transform: scale(.97); }
  .back-btn:focus-visible { outline: 3px solid #f5f5f5; outline-offset: 3px; }

  .scan-stage {
    flex: 1;
    position: relative;
    display: grid;
    place-items: center;
    overflow: hidden;
  }

  .scan-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    /* Phase 6 fix: the video element is ALWAYS mounted (so it exists
       when getUserMedia resolves), and its visibility is controlled
       by the scan-video-hidden / scan-video-active classes below.
       Transitions on opacity give a smooth fade between states.
       Do NOT use display:none — that would unmount the element from
       the layout and break video.play(). */
    transition: opacity 220ms ease;
  }

  /* When NOT scanning, hide the camera preview so the user sees the
     overlay (loading / error / validating) instead. */
  .scan-video-hidden {
    opacity: 0;
    pointer-events: none;
  }

  /* When scanning, show the camera preview. */
  .scan-video-active {
    opacity: 1;
  }

  /* Phase 6 fix: the rear/environment camera is NOT mirrored.
     The previous `transform: scaleX(-1)` was applied unconditionally
     and mirrored the rear-camera preview, which is misleading for a
     TV QR scanner (the default camera is environment/rear).
     If front-camera fallback is intentionally supported later,
     handle mirroring based on the actual selected camera track's
     facingMode, not via an unconditional CSS rule. */

  .scan-overlay {
    position: relative; z-index: 2;
    display: grid; gap: 14px; place-items: center; text-align: center;
    padding: 32px 24px;
    max-width: 360px;
  }
  .scan-overlay :global(svg) { color: #f5f5f5; opacity: .9; }
  .scan-overlay p { margin: 0; color: #d0d0d0; font-size: .86rem; line-height: 1.5; }
  .scan-overlay h2 { margin: 0; color: #f5f5f5; font-size: 1.2rem; font-weight: 800; }

  .scan-loading { color: #d0d0d0; }

  .scan-validating :global(svg) { color: var(--color-primary, #00e676); }

  .scan-error :global(svg) { color: var(--color-warning, #ffb74d); }
  .scan-error-actions { display: flex; gap: 10px; margin-top: 6px; flex-wrap: wrap; justify-content: center; }

  .scan-retry-btn, .scan-back-btn {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 44px; padding: 0 18px;
    border-radius: 999px;
    font: inherit; font-size: .78rem; font-weight: 800;
    cursor: pointer;
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .scan-retry-btn {
    border: 1px solid var(--color-primary-border, rgba(0, 230, 118, .3));
    color: #050708; background: var(--color-primary, #00e676);
  }
  .scan-back-btn {
    border: 1px solid rgba(255, 255, 255, .15);
    color: #f5f5f5; background: transparent;
  }
  .scan-retry-btn:hover, .scan-back-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .scan-retry-btn:active, .scan-back-btn:active { transform: scale(.98); }
  .scan-retry-btn:focus-visible, .scan-back-btn:focus-visible { outline: 3px solid #f5f5f5; outline-offset: 3px; }

  /* Scan frame guide — visual hint for where to point the camera. */
  .scan-frame {
    position: relative; z-index: 2;
    width: min(260px, 65vw);
    height: min(260px, 65vw);
    pointer-events: none;
  }
  .scan-frame-corner {
    position: absolute;
    width: 28px; height: 28px;
    border: 3px solid #f5f5f5;
    border-radius: 6px;
  }
  .scan-frame-tl { top: 0; left: 0; border-right: 0; border-bottom: 0; }
  .scan-frame-tr { top: 0; right: 0; border-left: 0; border-bottom: 0; }
  .scan-frame-bl { bottom: 0; left: 0; border-right: 0; border-top: 0; }
  .scan-frame-br { bottom: 0; right: 0; border-left: 0; border-top: 0; }

  /* The ScanLine icon is a Lucide component — its class is forwarded
     to the rendered SVG, so we use :global() to target it. */
  :global(.scan-line-icon) {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    color: rgba(255, 255, 255, .35);
  }

  .scan-instruction {
    position: absolute; bottom: 0; left: 0; right: 0; z-index: 2;
    padding: 20px 24px calc(20px + env(safe-area-inset-bottom, 0px));
    text-align: center;
    color: #f5f5f5;
    font-size: .86rem; font-weight: 600;
    background: linear-gradient(to top, rgba(0,0,0,.7), transparent);
  }

  /* Hidden canvas — used only for frame capture, never displayed. */
  .scan-canvas-hidden {
    position: absolute;
    width: 1px; height: 1px;
    opacity: 0;
    pointer-events: none;
    top: -9999px; left: -9999px;
  }

  /* ── Manual-code entry (§11) ── */
  .manual-code-card {
    position: relative; z-index: 3;
    padding: 0 16px calc(18px + env(safe-area-inset-bottom, 0px));
    max-width: 440px;
    width: 100%;
    margin: 0 auto;
  }
  .manual-divider {
    display: flex; align-items: center; gap: 12px;
    margin: 2px 0 14px;
  }
  .manual-divider-line { flex: 1; height: 1px; background: rgba(255, 255, 255, .14); }
  .manual-divider-label {
    color: #969696; font-size: .64rem; font-weight: 800;
    letter-spacing: .18em;
  }
  .manual-form {
    display: grid; gap: 9px;
    padding: 16px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 16px;
    background: rgba(13, 13, 13, .85);
    backdrop-filter: blur(14px);
  }
  .manual-label {
    display: inline-flex; align-items: center; gap: 7px;
    color: #f5f5f5; font-size: .78rem; font-weight: 800;
  }
  .manual-label :global(svg) { color: var(--color-primary, #00e676); }
  .manual-controls { display: flex; gap: 9px; }
  .manual-input {
    flex: 1; min-width: 0;
    min-height: 48px;
    padding: 0 14px;
    border: 1px solid rgba(255, 255, 255, .16);
    border-radius: 12px;
    background: rgba(0, 0, 0, .45);
    color: #f5f5f5;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 1.15rem; font-weight: 800;
    letter-spacing: .18em;
    text-transform: uppercase;
    caret-color: var(--color-primary, #00e676);
  }
  .manual-input:focus-visible { outline: 2px solid var(--color-focus, #f5f5f5); outline-offset: 2px; }
  .manual-input::placeholder { color: #4a4a4a; letter-spacing: .18em; }
  .manual-input:disabled { opacity: .55; }
  .manual-input-error { border-color: var(--color-warning, #ffb74d); }
  .manual-submit {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 48px; padding: 0 18px;
    border: 1px solid transparent; border-radius: 12px;
    color: #050708; background: var(--color-primary, #00e676);
    font: inherit; font-size: .8rem; font-weight: 800;
    cursor: pointer;
    transition: transform 160ms ease, filter 160ms ease;
  }
  .manual-submit:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.06); }
  .manual-submit:active:not(:disabled) { transform: scale(.98); }
  .manual-submit:focus-visible { outline: 3px solid var(--color-focus, #f5f5f5); outline-offset: 3px; }
  .manual-submit:disabled { opacity: .55; cursor: progress; }
  .manual-error {
    margin: 0; color: var(--color-warning, #ffb74d);
    font-size: .72rem; line-height: 1.45;
  }
  .manual-hint {
    margin: 0; color: #8a8a8a;
    font-size: .72rem; line-height: 1.45;
  }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    :global(.spin) { animation: none; }
    .back-btn, .scan-retry-btn, .scan-back-btn { transition: none; }
    .back-btn:hover, .scan-retry-btn:hover, .scan-back-btn:hover { transform: none; filter: none; }
  }

  /* Landscape: keep the scan frame a reasonable size. */
  @media (orientation: landscape) and (max-height: 500px) {
    .scan-frame { width: min(200px, 45vh); height: min(200px, 45vh); }
    .scan-instruction { padding: 12px 24px; font-size: .8rem; }
    .manual-code-card { display: none; }
  }
</style>
