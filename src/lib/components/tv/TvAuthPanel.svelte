<script lang="ts">
  let {
    authenticated,
    email,
    message,
    errorMessage
  }: {
    authenticated: boolean;
    email?: string | null;
    message?: string;
    errorMessage?: string;
  } = $props();
</script>

<section class="account-panel" aria-labelledby="tv-account-title">
  <p class="eyebrow">MAVERO account</p>
  <h2 id="tv-account-title">{authenticated ? 'Account & TV access' : 'Sign in on this TV'}</h2>
  {#if authenticated}
    <p class="account-copy">Signed in{email ? ` as ${email}` : ''}. Your local progress can sync to your account when playback begins.</p>
    {#if message}<p class="form-message" role="status">{message}</p>{/if}
    <form method="POST" action="?/signOut">
      <button class="tv-focusable account-action" data-tv-focusable="true" data-tv-focus-id="tv-account-sign-out" data-tv-focus-group="tv-account" type="submit">Sign out on this TV</button>
    </form>
    <p class="pairing-note">Phone QR pairing is not enabled in this build: the current same-origin session model cannot safely isolate a TV cookie from a phone cookie. Manual TV sign-in remains available.</p>
  {:else}
    <p class="account-copy">Use your existing MAVERO email and password. This uses the same Supabase session as the normal account flow; no password is stored by the TV UI.</p>
    {#if errorMessage}<p class="form-message error" role="alert">{errorMessage}</p>{/if}
    {#if message}<p class="form-message" role="status">{message}</p>{/if}
    <form method="POST" action="?/signIn" class="account-form">
      <label for="tv-account-email">Email</label>
      <input id="tv-account-email" class="tv-focusable account-input" data-tv-focusable="true" data-tv-focus-id="tv-account-email" data-tv-focus-group="tv-account" name="email" type="email" autocomplete="email" required />
      <label for="tv-account-password">Password</label>
      <input id="tv-account-password" class="tv-focusable account-input" data-tv-focusable="true" data-tv-focus-id="tv-account-password" data-tv-focus-group="tv-account" name="password" type="password" autocomplete="current-password" required />
      <input type="hidden" name="next" value="/tv" />
      <button class="tv-focusable account-action" data-tv-focusable="true" data-tv-focus-id="tv-account-submit" data-tv-focus-group="tv-account" type="submit">Sign in</button>
    </form>
    <p class="pairing-note">QR phone pairing is not enabled in this build because the current session architecture cannot safely keep phone and TV cookies separate. Use this manual sign-in until a device-bound exchange is added and reviewed.</p>
  {/if}
</section>

<style>
  .account-panel { max-width: 720px; margin: 6vh auto; padding: 42px; border: 1px solid rgba(255,255,255,.18); border-radius: 20px; background: linear-gradient(145deg, rgba(24,28,39,.96), rgba(10,12,18,.96)); box-shadow: 0 24px 70px rgba(0,0,0,.34); }
  .account-panel h2 { margin: 6px 0 14px; color: #fff; font-size: clamp(1.9rem, 3vw, 3rem); font-weight: 950; }
  .account-copy, .pairing-note { margin: 0 0 24px; color: rgba(255,255,255,.78); font-size: 1.05rem; line-height: 1.55; font-weight: 650; }
  .account-form { display: grid; gap: 10px; }
  .account-form label { margin-top: 8px; color: #fff; font-size: 1rem; font-weight: 900; }
  .account-input { min-height: 58px; padding: 12px 16px; border: 2px solid rgba(255,255,255,.25); border-radius: 10px; color: #fff; background: rgba(0,0,0,.28); font-size: 1.05rem; }
  .account-input:focus-visible, .account-action:focus-visible { outline: 4px solid #fff; outline-offset: 3px; }
  .account-action { min-height: 58px; margin-top: 16px; padding: 12px 20px; border: 2px solid var(--tv-accent, #ff5270); border-radius: 10px; color: #fff; background: var(--tv-accent, #ff5270); font-size: 1.05rem; font-weight: 900; cursor: pointer; }
  .form-message { margin: 0 0 18px; color: #b6f5c8; font-weight: 800; }
  .form-message.error { color: #ffb1bc; }
  .pairing-note { margin-top: 28px; margin-bottom: 0; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.14); font-size: .92rem; color: rgba(255,255,255,.62); }
  @media (max-width: 760px) { .account-panel { margin: 24px 0; padding: 26px; } }
</style>
