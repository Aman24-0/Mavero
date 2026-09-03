<script lang="ts">
  import { LockKeyhole, ShieldCheck, AlertCircle, ArrowRight, Eye, EyeOff } from 'lucide-svelte';
  import AuthShell from '$components/AuthShell.svelte';
  import type { PageData } from './$types';

  type ResetForm = { message?: string };
  let { data, form }: { data: PageData; form?: ResetForm } = $props();
  let showPassword = $state(false);
  let showConfirm = $state(false);
</script>

<svelte:head>
  <title>Reset password — Mavero</title>
  <meta name="description" content="Set a new secure password for your MAVERO account." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AuthShell
  eyebrow="MAVERO / Account recovery"
  title="Make it"
  titleAccent="secure again."
  subtitle="Choose a new password for your MAVERO account. Your local guest library remains available on this device."
  backHref="/auth/sign-in"
  backLabel="Back to Sign in"
>
  {#if form?.message}
    <div class="auth-message" role="alert">
      <AlertCircle size={14} />
      <span>{form.message}</span>
    </div>
  {/if}

  {#if data.ready}
    <form method="POST" class="auth-form">
      <label class="field">
        <span class="field-label">New password</span>
        <div class="input-wrap">
          <LockKeyhole size={16} class="input-icon" />
          <input
            name="password"
            type={showPassword ? 'text' : 'password'}
            autocomplete="new-password"
            minlength="6"
            placeholder="At least 6 characters"
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
      <label class="field">
        <span class="field-label">Confirm password</span>
        <div class="input-wrap">
          <LockKeyhole size={16} class="input-icon" />
          <input
            name="confirmation"
            type={showConfirm ? 'text' : 'password'}
            autocomplete="new-password"
            minlength="6"
            placeholder="Repeat your password"
            required
          />
          <button
            type="button"
            class="visibility-toggle"
            aria-label={showConfirm ? 'Hide password' : 'Show password'}
            aria-pressed={showConfirm}
            onclick={() => (showConfirm = !showConfirm)}
          >
            {#if showConfirm}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
          </button>
        </div>
      </label>
      <button class="primary-cta" type="submit">
        <span>Update password</span> <ArrowRight size={14} />
      </button>
    </form>
  {:else}
    <div class="auth-message" role="alert">
      <AlertCircle size={14} />
      <span>This reset link is no longer active. Request a new link from Sign in.</span>
    </div>
    <a class="secondary-cta" href="/auth/sign-in">Request another link</a>
  {/if}

  <div class="auth-note"><ShieldCheck size={14} /> <span>Password changes are handled by the dedicated MAVERO Supabase project.</span></div>
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

  .auth-form { display: grid; gap: 14px; }

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
