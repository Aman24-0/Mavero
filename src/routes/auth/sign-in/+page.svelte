<script lang="ts">
  import { page } from '$app/state';
  import { ArrowLeft, Mail, LockKeyhole, ShieldCheck } from 'lucide-svelte';

  type AuthForm = { message?: string; email?: string };
  let { form }: { form?: AuthForm } = $props();
  const queryMessage = page.url.searchParams.get('error') === 'confirmation'
    ? 'That confirmation link could not be completed. Please try signing in again.'
    : page.url.searchParams.get('error') === 'missing_confirmation'
      ? 'That confirmation link is incomplete. Please request a new one.'
      : '';
</script>

<svelte:head><title>Sign in — Mavero</title></svelte:head>

<div class="auth-wrap container-wide">
  <a class="back-link" href="/profile"><ArrowLeft size={15} /> Back to Profile</a>
  <div class="auth-card">
    <div class="eyebrow">MAVERO / Cross-device sync</div>
    <h1>Keep your place<br /><em>everywhere.</em></h1>
    <p>Sign in to sync Continue Watching, favorites, and history across your devices. You can keep exploring without an account.</p>
    {#if form?.message || queryMessage}<div class="auth-message" role="alert">{form?.message ?? queryMessage}</div>{/if}
    <form method="POST">
      <input type="hidden" name="next" value={page.url.searchParams.get('next') ?? '/profile'} />
      <label>Email<div class="auth-input"><Mail size={15} /><input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required /></div></label>
      <label>Password<div class="auth-input"><LockKeyhole size={15} /><input name="password" type="password" placeholder="Your password" autocomplete="current-password" required /></div></label>
      <button class="btn btn-primary" type="submit">Continue</button>
    </form>
    <p class="auth-switch">New to MAVERO? <a href="/auth/sign-up">Create an account</a></p>
    <div class="auth-note"><ShieldCheck size={15} /> Your guest progress stays local until you choose to sync it.</div>
  </div>
</div>

<style>
  em { color: var(--accent); font-style: normal; }
  .auth-wrap { min-height: calc(100dvh - 76px); padding-bottom: 80px; }
  .back-link { display: inline-flex; align-items: center; gap: 8px; padding-top: 32px; color: var(--muted); font-size: .72rem; font-weight: 800; text-decoration: none; }
  .auth-card { width: min(480px, 100%); margin: 75px auto 0; padding: 28px; border: 1px solid var(--line); border-radius: 20px; background: var(--surface); }
  .auth-card h1 { margin: 9px 0 13px; font-size: clamp(2.6rem, 6vw, 4.3rem); line-height: .95; letter-spacing: -.08em; }
  .auth-card > p { color: var(--muted); font-size: .82rem; line-height: 1.7; }
  form { display: grid; gap: 15px; margin-top: 28px; }
  label { display: grid; gap: 7px; color: var(--muted); font-size: .68rem; font-weight: 800; }
  .auth-input { display: flex; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--muted-deep); background: rgba(255,255,255,.03); }
  .auth-input input { width: 100%; border: 0; outline: 0; color: var(--ink); background: transparent; font-size: .8rem; }
  .auth-message { margin-top: 18px; padding: 11px 12px; border: 1px solid rgba(255, 139, 139, .28); border-radius: 10px; color: #ffb1b1; background: rgba(255, 115, 115, .08); font-size: .72rem; line-height: 1.5; }
  .auth-switch { margin: 18px 0 0; text-align: center; }
  .auth-switch a { color: var(--accent); font-weight: 800; }
  .auth-note { display: flex; align-items: center; gap: 7px; margin-top: 18px; color: var(--success); font-family: 'DM Mono', monospace; font-size: .58rem; line-height: 1.5; }
  @media (max-width: 640px) { .auth-wrap { padding-top: 68px; } .auth-card { margin-top: 45px; padding: 23px; } }
</style>
