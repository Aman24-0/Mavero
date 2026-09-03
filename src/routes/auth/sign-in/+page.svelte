<script lang="ts">
  import { page } from '$app/state';
  import { ArrowRight, Mail, LockKeyhole, ShieldCheck, AlertCircle, CheckCircle2 } from 'lucide-svelte';
  import AuthShell from '$components/AuthShell.svelte';

  type AuthForm = { message?: string; email?: string; success?: boolean };
  let { form }: { form?: AuthForm } = $props();
  const queryMessage = page.url.searchParams.get('error') === 'confirmation'
    ? 'That confirmation link could not be completed. Please try signing in again.'
    : page.url.searchParams.get('error') === 'missing_confirmation'
      ? 'That confirmation link is incomplete. Please request a new one.'
      : '';
  const nextPath = page.url.searchParams.get('next') ?? '/profile';
</script>

<svelte:head>
  <title>Sign in — Mavero</title>
  <meta name="description" content="Sign in to sync your MAVERO library across devices." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AuthShell
  eyebrow="MAVERO / Cross-device sync"
  title="Keep your place"
  titleAccent="everywhere."
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
          <Mail size={15} class="input-icon" />
          <input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required />
        </div>
      </label>
      <label class="field">
        <span class="field-label">Password</span>
        <div class="input-wrap">
          <LockKeyhole size={15} class="input-icon" />
          <input name="password" type="password" placeholder="Your password" autocomplete="current-password" required />
        </div>
      </label>
      <button class="primary-cta" type="submit">
        Continue <ArrowRight size={14} />
      </button>
    </form>

    <details class="reset-details">
      <summary>Forgot your password?</summary>
      <form method="POST" action="?/reset" class="auth-form inline-form">
        <label class="field">
          <span class="field-label">Account email</span>
          <div class="input-wrap">
            <Mail size={15} class="input-icon" />
            <input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required />
          </div>
        </label>
        <button class="secondary-cta" type="submit">Send reset link</button>
      </form>
    </details>
  {/if}

  <p class="auth-switch">New to MAVERO? <a href="/auth/sign-up">Create an account</a></p>
  <div class="auth-note"><ShieldCheck size={14} /> <span>Your guest progress stays local until you choose to sync it.</span></div>
</AuthShell>

<style>
  .auth-message {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 11px 12px;
    border: 1px solid rgba(255,176,32,.28);
    border-radius: 10px;
    color: #ffb020;
    background: rgba(255,176,32,.05);
    font-size: .76rem; line-height: 1.5;
  }
  .auth-message :global(svg) { flex: 0 0 auto; margin-top: 1px; }
  .auth-message.success {
    border-color: rgba(53,214,143,.3);
    color: #35d68f;
    background: rgba(53,214,143,.05);
  }

  .auth-form { display: grid; gap: 14px; }
  .inline-form { margin-top: 12px; }

  .field { display: grid; gap: 7px; }
  .field-label {
    color: #77777f;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .input-wrap {
    display: flex; align-items: center; gap: 10px;
    height: 46px;
    padding: 0 14px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 10px;
    background: rgba(255,255,255,.03);
    transition: border-color 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1);
  }
  .input-wrap:focus-within {
    border-color: rgba(255,255,255,.28);
    background: rgba(255,255,255,.06);
  }
  .input-icon { color: #77777f; flex: 0 0 auto; }
  .input-wrap input {
    width: 100%; min-width: 0;
    border: 0; outline: 0;
    color: #f5f5f5;
    background: transparent;
    font: inherit;
    font-size: .86rem;
  }
  .input-wrap input::placeholder { color: #55555d; }

  .primary-cta, .secondary-cta {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    min-height: 46px;
    padding: 0 22px;
    border-radius: 999px;
    font-size: .82rem; font-weight: 700;
    cursor: pointer;
    text-decoration: none;
    border: 1px solid transparent;
    transition: transform 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1), border-color 180ms cubic-bezier(.22,1,.36,1);
  }
  .primary-cta {
    color: #000;
    background: #f5f5f5;
    border-color: #f5f5f5;
    box-shadow: 0 4px 18px rgba(255,255,255,.12);
  }
  .primary-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(255,255,255,.18); }
  .primary-cta:active { transform: scale(.98); }
  .secondary-cta {
    color: #f5f5f5;
    background: rgba(255,255,255,.05);
    border-color: rgba(255,255,255,.14);
  }
  .secondary-cta:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.24); }
  .secondary-cta:active { transform: scale(.98); }

  .reset-details { margin-top: 6px; }
  .reset-details summary {
    cursor: pointer;
    color: #c7c7cc;
    font-size: .74rem; font-weight: 700;
    padding: 6px 0;
    list-style: none;
  }
  .reset-details summary::-webkit-details-marker { display: none; }
  .reset-details summary::before {
    content: '›'; display: inline-block; margin-right: 6px;
    color: #77777f; transition: transform 180ms ease;
  }
  .reset-details[open] summary::before { transform: rotate(90deg); }
  .reset-details summary:hover { color: #f5f5f5; }

  .auth-switch {
    margin: 16px 0 0;
    text-align: center;
    color: #77777f;
    font-size: .76rem;
  }
  .auth-switch a {
    color: #f5f5f5;
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: rgba(255,255,255,.4);
  }
  .auth-switch a:hover { text-decoration-color: #f5f5f5; }

  .auth-note {
    display: flex; align-items: center; gap: 8px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid rgba(255,255,255,.05);
    color: #77777f;
    font-size: .62rem; line-height: 1.5;
  }
  .auth-note :global(svg) { flex: 0 0 auto; color: #35d68f; }

  @media (prefers-reduced-motion: reduce) {
    .primary-cta, .secondary-cta, .input-wrap, .reset-details summary::before { transition: none; }
  }
</style>
