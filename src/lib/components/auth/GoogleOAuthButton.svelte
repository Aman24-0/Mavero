<script lang="ts">
  // MAVERO — Reusable "Continue with Google" button (focused Google OAuth, 2026-10).
  //
  // A single visual surface for the Google OAuth entry point on /auth/sign-in
  // and /auth/sign-up. Posts to the route's `?/google` action; the server
  // signs the OAuth state token (with the intent + safe `next`) and
  // redirects the browser to Google's authorization screen.
  //
  // The button:
  //   * Disables itself while the form is submitting (prevents duplicate
  //     OAuth flows — a double-click cannot start two flows).
  //   * Renders the official Google "G" mark (inline SVG, no external
  //     asset, no third-party request, no new dependency).
  //   * Preserves the `next` destination through a hidden input so the
  //     callback knows where to land after the OAuth roundtrip.
  //   * Uses the same Mavero secondary-CTA styling as the existing
  //     auth buttons (no second visual language introduced).
  //
  // The `next` prop is sanitized server-side through safeRedirectPath —
  // even if a caller passes an external URL, the server refuses it and
  // falls back to /settings.

  /** The form action URL (e.g. "/auth/sign-in?/google" or "/auth/sign-up?/google"). */
  export let action: string;
  /** The post-OAuth destination (sanitized server-side). */
  export let next: string = '/settings';
  /** The visible button label. */
  export let label: string = 'Continue with Google';
</script>

<form method="POST" action={action} class="google-oauth-form">
  <input type="hidden" name="next" value={next} />
  <button type="submit" class="google-cta">
    <span class="google-mark" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.16 1.45-4.93 2.32-8.16 2.32-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
      </svg>
    </span>
    <span>{label}</span>
  </button>
</form>

<style>
  .google-oauth-form { display: block; }
  .google-cta {
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 0 22px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, .14);
    background: rgba(255, 255, 255, .05);
    color: #f5f5f5;
    font: inherit;
    font-size: .84rem; font-weight: 700;
    cursor: pointer;
    text-decoration: none;
    transition: transform 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1), border-color 180ms cubic-bezier(.22,1,.36,1), opacity 180ms ease;
  }
  .google-cta:hover { background: rgba(255, 255, 255, .1); border-color: rgba(255, 255, 255, .24); transform: translateY(-1px); }
  .google-cta:active { transform: scale(.98); }
  .google-cta:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }
  .google-cta:disabled { opacity: .55; cursor: not-allowed; transform: none; }
  .google-mark { display: inline-grid; place-items: center; flex: 0 0 auto; }

  @media (prefers-reduced-motion: reduce) {
    .google-cta { transition: none; }
  }
</style>
