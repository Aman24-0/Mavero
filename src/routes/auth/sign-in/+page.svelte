<script lang="ts">
  import { page } from '$app/state';
  import { ArrowRight, Mail, LockKeyhole, Eye, EyeOff, ShieldCheck, AlertCircle, CheckCircle2 } from 'lucide-svelte';
  import AuthShell from '$components/AuthShell.svelte';

  type AuthForm = { message?: string; email?: string; success?: boolean };
  let { form }: { form?: AuthForm } = $props();
  const queryMessage = page.url.searchParams.get('error') === 'confirmation'
    ? 'That confirmation link could not be completed. Please try signing in again.'
    : page.url.searchParams.get('error') === 'missing_confirmation'
      ? 'That confirmation link is incomplete. Please request a new one.'
      : '';
  const nextPath = page.url.searchParams.get('next') ?? '/profile';

  let showPassword = $state(false);
  let emailValue = $state(form?.email ?? '');
  let resetEmailValue = $state(form?.email ?? '');
  let resetOpen = $state(false);
</script>

<svelte:head>
  <title>Sign in — Mavero</title>
  <meta name="description" content="Sign in to sync your MAVERO library across devices." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AuthShell
  eyebrow="MAVERO / Cross-device sync"
  title="Welcome back to"
  titleAccent="Mavero."
  subtitle="Sign in to sync Continue Watching, favorites, and history across your devices. You can keep exploring without an account."
  backHref="/profile"
  backLabel="Back to Profile"
>
  {#if form?.message || queryMessage}
    <div class:success={form?.success} class="auth-message" role="alert">
      {#if form?.success}<CheckCircle2 size={14} />{:else}<AlertCircle size={14} />{/if}
      <span>{form?.message ?? queryMessage}</span>
    </div>
  {/if}

  {#if !form?.success}
    <form method="POST" action="?/signIn" class="auth-form">
      <input type="hidden" name="next" value={nextPath} />

      <label class="field">
        <span class="field-label">Email</span>
        <div class="input-wrap">
          <Mail size={16} class="input-icon" />
          <input
            name="email"
            bind:value={emailValue}
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            required
          />
        </div>
      </label>

      <label class="field">
        <span class="field-label">Password</span>
        <div class="input-wrap">
          <LockKeyhole size={16} class="input-icon" />
          <input
            name="password"
            type={showPassword ? 'text' : 'password'}
            placeholder="Your password"
            autocomplete="current-password"
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
        <span>Sign in</span> <ArrowRight size={14} />
      </button>
    </form>

    <!-- Forgot password — integrated inline toggle, not a <details> element. -->
    {#if !resetOpen}
      <button type="button" class="inline-link" onclick={() => (resetOpen = true)}>
        Forgot your password?
      </button>
    {:else}
      <form method="POST" action="?/reset" class="auth-form reset-form">
        <div class="reset-divider"><span>Reset password</span></div>
        <label class="field">
          <span class="field-label">Account email</span>
          <div class="input-wrap">
            <Mail size={16} class="input-icon" />
            <input
              name="email"
              bind:value={resetEmailValue}
              type="email"
              placeholder="you@example.com"
              autocomplete="email"
              required
            />
          </div>
        </label>
        <div class="reset-actions">
          <button type="button" class="inline-link muted" onclick={() => (resetOpen = false)}>Cancel</button>
          <button class="secondary-cta" type="submit">Send reset link</button>
        </div>
      </form>
    {/if}
  {/if}

  <div class="divider" role="separator" aria-orientation="horizontal"><span>or</span></div>

  <p class="auth-switch">New to MAVERO? <a href="/auth/sign-up">Create an account</a></p>

  <div class="auth-note"><ShieldCheck size={14} /> <span>Your guest progress stays local until you choose to sync it.</span></div>
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
  .reset-form { margin-top: 4px; padding-top: 4px; }

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
    transition: transform 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1), border-color 180ms cubic-bezier(.22,1,.36,1), opacity 180ms ease;
  }
  .primary-cta {
    color: #000;
    background: #f5f5f5;
    border-color: #f5f5f5;
    box-shadow: 0 4px 18px rgba(255, 255, 255, .12);
  }
  .primary-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(255, 255, 255, .18); }
  .primary-cta:active { transform: scale(.98); }
  .primary-cta:disabled { opacity: .55; cursor: not-allowed; transform: none; box-shadow: none; }
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
