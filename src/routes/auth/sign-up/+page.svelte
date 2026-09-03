<script lang="ts">
  import { ArrowRight, Mail, LockKeyhole, UserRound, Eye, EyeOff, ShieldCheck, AlertCircle, CheckCircle2 } from 'lucide-svelte';
  import AuthShell from '$components/AuthShell.svelte';

  type AuthForm = { message?: string; success?: boolean; displayName?: string; email?: string };
  let { form }: { form?: AuthForm } = $props();

  let showPassword = $state(false);
  let resendOpen = $state(false);
  let resendEmail = $state('');
</script>

<svelte:head>
  <title>Create account — Mavero</title>
  <meta name="description" content="Create a MAVERO account to sync your library across devices." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AuthShell
  eyebrow="MAVERO / Create account"
  title="Your next story"
  titleAccent="travels with you."
  subtitle="Create an account to keep your progress, watchlist, and history synced across devices."
  backHref="/profile"
  backLabel="Back to Profile"
>
  {#if form?.message}
    <div class:success={form.success} class="auth-message" role="status">
      {#if form.success}<CheckCircle2 size={14} />{:else}<AlertCircle size={14} />{/if}
      <span>{form.message}</span>
    </div>
  {/if}

  {#if !form?.success}
    <form method="POST" action="?/signUp" class="auth-form">
      <input type="hidden" name="next" value="/profile" />

      <label class="field">
        <span class="field-label">Name</span>
        <div class="input-wrap">
          <UserRound size={16} class="input-icon" />
          <input name="name" value={form?.displayName ?? ''} type="text" placeholder="Your name" autocomplete="name" required />
        </div>
      </label>

      <label class="field">
        <span class="field-label">Email</span>
        <div class="input-wrap">
          <Mail size={16} class="input-icon" />
          <input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required />
        </div>
      </label>

      <label class="field">
        <span class="field-label">Password</span>
        <div class="input-wrap">
          <LockKeyhole size={16} class="input-icon" />
          <input
            name="password"
            type={showPassword ? 'text' : 'password'}
            placeholder="At least 6 characters"
            autocomplete="new-password"
            minlength="6"
            required
          />
          <button
            type="button"
            class="visibility-toggle"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            onclick={() => (showPassword = !showPassword)}
          >
            {#if showPassword}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
          </button>
        </div>
      </label>

      <button class="primary-cta" type="submit">
        <span>Create account</span> <ArrowRight size={14} />
      </button>
    </form>

    {#if !resendOpen}
      <button type="button" class="inline-link" onclick={() => (resendOpen = true)}>
        Already created an account? Resend confirmation
      </button>
    {:else}
      <form class="auth-form resend-form" method="POST" action="?/resend">
        <div class="reset-divider"><span>Resend confirmation</span></div>
        <label class="field">
          <span class="field-label">Account email</span>
          <div class="input-wrap">
            <Mail size={16} class="input-icon" />
            <input name="email" bind:value={resendEmail} type="email" placeholder="you@example.com" autocomplete="email" required />
          </div>
        </label>
        <div class="reset-actions">
          <button type="button" class="inline-link muted" onclick={() => (resendOpen = false)}>Cancel</button>
          <button class="secondary-cta" type="submit">Resend email</button>
        </div>
      </form>
    {/if}
  {:else}
    <form class="auth-form" method="POST" action="?/resend">
      <label class="field">
        <span class="field-label">Account email</span>
        <div class="input-wrap">
          <Mail size={16} class="input-icon" />
          <input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required />
        </div>
      </label>
      <button class="secondary-cta" type="submit">Resend confirmation email</button>
    </form>
  {/if}

  <div class="divider" role="separator" aria-orientation="horizontal"><span>or</span></div>

  <p class="auth-switch">Already have an account? <a href="/auth/sign-in">Sign in</a></p>

  <div class="auth-note"><ShieldCheck size={14} /> <span>Your current guest progress will be offered for sync after sign-up.</span></div>
</AuthShell>

<style>
  .auth-message {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 11px 12px;
    border: 1px solid rgba(255, 176, 32, .28);
    border-radius: 10px;
    color: #ffb020;
    background: rgba(255, 176, 32, .05);
    font-size: .76rem; line-height: 1.5;
  }
  .auth-message :global(svg) { flex: 0 0 auto; margin-top: 1px; }
  .auth-message.success {
    border-color: rgba(53, 214, 143, .3);
    color: #35d68f;
    background: rgba(53, 214, 143, .05);
  }

  .auth-form { display: grid; gap: 14px; }
  .resend-form { margin-top: 4px; }

  .field { display: grid; gap: 7px; }
  .field-label {
    color: #969696;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .input-wrap {
    display: flex; align-items: center; gap: 10px;
    height: 48px;
    padding: 0 14px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 10px;
    background: rgba(255, 255, 255, .03);
    transition: border-color 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1);
  }
  .input-wrap:focus-within {
    border-color: rgba(255, 255, 255, .32);
    background: rgba(255, 255, 255, .06);
  }
  .input-icon { color: #969696; flex: 0 0 auto; }
  .input-wrap input {
    width: 100%; min-width: 0;
    border: 0; outline: 0;
    color: #f5f5f5;
    background: transparent;
    font: inherit;
    font-size: .88rem;
  }
  .input-wrap input::placeholder { color: #646464; }

  .visibility-toggle {
    display: grid; place-items: center;
    width: 32px; height: 32px;
    border: 0; border-radius: 8px;
    color: #969696;
    background: transparent;
    cursor: pointer;
    flex: 0 0 auto;
    transition: color 160ms ease, background 160ms ease;
  }
  .visibility-toggle:hover { color: #f5f5f5; background: rgba(255, 255, 255, .06); }
  .visibility-toggle:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }

  .primary-cta, .secondary-cta {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    min-height: 48px;
    padding: 0 22px;
    border-radius: 999px;
    font-size: .84rem; font-weight: 700;
    cursor: pointer;
    text-decoration: none;
    border: 1px solid transparent;
    transition: transform 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1), border-color 180ms cubic-bezier(.22,1,.36,1);
  }
  .primary-cta {
    color: #000;
    background: #f5f5f5;
    border-color: #f5f5f5;
    box-shadow: 0 4px 18px rgba(255, 255, 255, .12);
  }
  .primary-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(255, 255, 255, .18); }
  .primary-cta:active { transform: scale(.98); }
  .secondary-cta {
    color: #f5f5f5;
    background: rgba(255, 255, 255, .05);
    border-color: rgba(255, 255, 255, .14);
  }
  .secondary-cta:hover { background: rgba(255, 255, 255, .1); border-color: rgba(255, 255, 255, .24); }
  .secondary-cta:active { transform: scale(.98); }

  .inline-link {
    background: transparent; border: 0;
    color: #d0d0d0;
    font: inherit;
    font-size: .76rem; font-weight: 700;
    cursor: pointer;
    padding: 4px 0;
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: rgba(255, 255, 255, .3);
    justify-self: start;
  }
  .inline-link:hover { color: #f5f5f5; text-decoration-color: #f5f5f5; }
  .inline-link.muted { color: #969696; font-weight: 600; text-decoration-color: rgba(255, 255, 255, .2); }

  .reset-divider {
    display: flex; align-items: center; gap: 10px;
    color: #969696;
    font-size: .62rem; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase;
    margin-bottom: 4px;
  }
  .reset-divider::before, .reset-divider::after {
    content: ''; flex: 1; height: 1px; background: rgba(255, 255, 255, .08);
  }
  .reset-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }

  .divider {
    display: flex; align-items: center; gap: 12px;
    margin: 4px 0;
    color: #646464;
    font-size: .62rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .divider::before, .divider::after {
    content: ''; flex: 1; height: 1px; background: rgba(255, 255, 255, .08);
  }

  .auth-switch {
    margin: 0;
    text-align: center;
    color: #969696;
    font-size: .78rem;
  }
  .auth-switch a {
    color: #f5f5f5;
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: rgba(255, 255, 255, .4);
  }
  .auth-switch a:hover { text-decoration-color: #f5f5f5; }

  .auth-note {
    display: flex; align-items: center; gap: 8px;
    margin-top: 4px;
    padding-top: 14px;
    border-top: 1px solid rgba(255, 255, 255, .05);
    color: #969696;
    font-size: .62rem; line-height: 1.5;
  }
  .auth-note :global(svg) { flex: 0 0 auto; color: #35d68f; }

  @media (prefers-reduced-motion: reduce) {
    .primary-cta, .secondary-cta, .input-wrap, .visibility-toggle { transition: none; }
  }
</style>
