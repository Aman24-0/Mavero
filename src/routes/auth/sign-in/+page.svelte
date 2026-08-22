<script lang="ts">
  import { page } from '$app/state';
  import { ArrowLeft, Mail, LockKeyhole, ShieldCheck } from 'lucide-svelte';

  type AuthForm = { message?: string; email?: string; success?: boolean };
  let { form }: { form?: AuthForm } = $props();
  const queryMessage = page.url.searchParams.get('error') === 'confirmation'
    ? 'That confirmation link could not be completed. Please try signing in again.'
    : page.url.searchParams.get('error') === 'missing_confirmation'
      ? 'That confirmation link is incomplete. Please request a new one.'
      : '';
</script>

<svelte:head>
  <title>Sign in — Mavero</title>
  <meta name="description" content="Sign in to sync your MAVERO library across devices." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="auth-wrap container-wide">
  <a class="back-link" href="/profile"><ArrowLeft size={15} /> Back to Profile</a>
  <div class="auth-card">
    <div class="eyebrow">MAVERO / Cross-device sync</div>
    <h1>Keep your place<br /><em>everywhere.</em></h1>
    <p>Sign in to sync Continue Watching, favorites, and history across your devices. You can keep exploring without an account.</p>
    {#if form?.message || queryMessage}<div class:success={form?.success} class="auth-message" role="alert">{form?.message ?? queryMessage}</div>{/if}
    {#if !form?.success}<form method="POST" action="?/signIn">
      <input type="hidden" name="next" value={page.url.searchParams.get('next') ?? '/profile'} />
      <label>Email<div class="auth-input"><Mail size={15} /><input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required /></div></label>
      <label>Password<div class="auth-input"><LockKeyhole size={15} /><input name="password" type="password" placeholder="Your password" autocomplete="current-password" required /></div></label>
      <button class="btn btn-primary" type="submit">Continue</button>
    </form>{/if}
    {#if !form?.success}<details class="reset-details"><summary>Forgot your password?</summary><form method="POST" action="?/reset"><label>Account email<div class="auth-input"><Mail size={15} /><input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required /></div></label><button class="btn btn-secondary" type="submit">Send reset link</button></form></details>{/if}
    <p class="auth-switch">New to MAVERO? <a href="/auth/sign-up">Create an account</a></p>
    <div class="auth-note"><ShieldCheck size={15} /> Your guest progress stays local until you choose to sync it.</div>
  </div>
</div>

<style>
  em { color: var(--accent-strong); font-style: normal; }
  .auth-wrap { min-height: calc(100dvh - 76px); padding-bottom: 80px; }
  .back-link { display: inline-flex; align-items: center; gap: 8px; padding-top: 32px; color: var(--muted); font-size: .7rem; font-weight: 800; text-decoration: none; }
  .back-link:hover { color: var(--ink); }
  .auth-card { width: min(480px, 100%); margin: 70px auto 0; padding: 30px; border: 1px solid var(--line); border-radius: var(--radius-xl); background: linear-gradient(135deg, rgba(145,182,173,.06), rgba(16,22,25,.96)); box-shadow: var(--shadow-lg); }
  .auth-card h1 { margin: 9px 0 13px; font-family: 'Space Grotesk', sans-serif; font-size: clamp(2.5rem, 6vw, 4.2rem); line-height: .95; letter-spacing: -.08em; }
  .auth-card > p { color: var(--muted); font-size: .8rem; line-height: 1.7; }
  form { display: grid; gap: 15px; margin-top: 28px; }
  label { display: grid; gap: 7px; color: var(--muted); font-size: .66rem; font-weight: 800; }
  .auth-input { display: flex; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted-deep); background: rgba(228,235,232,.035); transition: border-color 160ms var(--ease-out), background 160ms var(--ease-out); }
  .auth-input:focus-within { border-color: rgba(212,168,106,.58); background: rgba(212,168,106,.05); }
  .auth-input input { width: 100%; border: 0; outline: 0; color: var(--ink); background: transparent; font-size: .8rem; }
  .auth-message { margin-top: 18px; padding: 11px 12px; border: 1px solid rgba(229,143,151,.3); border-radius: var(--radius-sm); color: #f2b2ba; background: rgba(229,143,151,.08); font-size: .72rem; line-height: 1.5; }
  .auth-message.success { border-color: rgba(143,190,164,.3); color: var(--success); background: rgba(143,190,164,.08); }
  .reset-details { margin-top: 18px; color: var(--muted); font-size: .7rem; }
  .reset-details summary { cursor: pointer; color: var(--accent-strong); font-weight: 800; }
  .auth-switch { margin: 18px 0 0; text-align: center; }
  .auth-switch a { color: var(--accent-strong); font-weight: 800; }
  .auth-note { display: flex; align-items: center; gap: 7px; margin-top: 18px; color: var(--success); font-family: 'DM Mono', monospace; font-size: .58rem; line-height: 1.5; }
  @media (max-width: 640px) { .auth-wrap { padding-top: 68px; } .auth-card { margin-top: 45px; padding: 23px; border-radius: var(--radius-lg); } }
</style>
