<script lang="ts">
  import { ArrowLeft, Mail, LockKeyhole, UserRound, ShieldCheck } from 'lucide-svelte';

  type AuthForm = { message?: string; success?: boolean; displayName?: string; email?: string };
  let { form }: { form?: AuthForm } = $props();
</script>

<svelte:head><title>Create account — Mavero</title></svelte:head>

<div class="auth-wrap container-wide">
  <a class="back-link" href="/profile"><ArrowLeft size={15} /> Back to Profile</a>
  <div class="auth-card">
    <div class="eyebrow">MAVERO / Create account</div>
    <h1>Your next story<br /><em>travels with you.</em></h1>
    <p>Create an account to keep your progress, watchlist, and history synced across devices.</p>
    {#if form?.message}<div class:success={form.success} class="auth-message" role="status">{form.message}</div>{/if}
    {#if !form?.success}
      <form method="POST" action="?/signUp">
        <input type="hidden" name="next" value="/profile" />
        <label>Name<div class="auth-input"><UserRound size={15} /><input name="name" value={form?.displayName ?? ''} type="text" placeholder="Your name" autocomplete="name" required /></div></label>
        <label>Email<div class="auth-input"><Mail size={15} /><input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required /></div></label>
        <label>Password<div class="auth-input"><LockKeyhole size={15} /><input name="password" type="password" placeholder="At least 6 characters" autocomplete="new-password" minlength="6" required /></div></label>
        <button class="btn btn-primary" type="submit">Create account</button>
      </form>
    {:else}
      <form class="resend-form" method="POST" action="?/resend">
        <input name="email" value={form?.email ?? ''} type="email" placeholder="you@example.com" autocomplete="email" required />
        <button class="btn btn-secondary" type="submit">Resend confirmation email</button>
      </form>
    {/if}
    {#if !form?.success}<details class="resend-details"><summary>Already created an account?</summary><form class="resend-form" method="POST" action="?/resend"><input name="email" type="email" placeholder="Account email" autocomplete="email" required /><button class="btn btn-secondary" type="submit">Resend confirmation email</button></form></details>{/if}
    <p class="auth-switch">Already have an account? <a href="/auth/sign-in">Sign in</a></p>
    <div class="auth-note"><ShieldCheck size={15} /> Your current guest progress will be offered for sync after sign-up.</div>
  </div>
</div>

<style>
  em { color: var(--accent); font-style: normal; }
  .auth-wrap { min-height: calc(100dvh - 76px); padding-bottom: 80px; }
  .back-link { display: inline-flex; align-items: center; gap: 8px; padding-top: 32px; color: var(--muted); font-size: .72rem; font-weight: 800; text-decoration: none; }
  .auth-card { width: min(480px, 100%); margin: 58px auto 0; padding: 28px; border: 1px solid var(--line); border-radius: 20px; background: var(--surface); }
  .auth-card h1 { margin: 9px 0 13px; font-size: clamp(2.4rem, 6vw, 4rem); line-height: .95; letter-spacing: -.08em; }
  .auth-card > p { color: var(--muted); font-size: .82rem; line-height: 1.7; }
  form { display: grid; gap: 15px; margin-top: 28px; }
  label { display: grid; gap: 7px; color: var(--muted); font-size: .68rem; font-weight: 800; }
  .auth-input { display: flex; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--muted-deep); background: rgba(255,255,255,.03); }
  .auth-input input { width: 100%; border: 0; outline: 0; color: var(--ink); background: transparent; font-size: .8rem; }
  .auth-message { margin-top: 18px; padding: 11px 12px; border: 1px solid rgba(255, 139, 139, .28); border-radius: 10px; color: #ffb1b1; background: rgba(255, 115, 115, .08); font-size: .72rem; line-height: 1.5; }
  .auth-message.success { border-color: rgba(123, 220, 171, .28); color: var(--success); background: rgba(123, 220, 171, .08); }
  .resend-details { margin-top: 18px; color: var(--muted); font-size: .7rem; }
  .resend-details summary { cursor: pointer; color: var(--accent); font-weight: 800; }
  .resend-form { display: grid; gap: 10px; margin-top: 10px; }
  .resend-form input { width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 12px; outline: 0; color: var(--ink); background: rgba(255,255,255,.03); font-size: .8rem; }
  .auth-switch { margin: 18px 0 0; text-align: center; }
  .auth-switch a { color: var(--accent); font-weight: 800; }
  .auth-note { display: flex; align-items: center; gap: 7px; margin-top: 18px; color: var(--success); font-family: 'DM Mono', monospace; font-size: .58rem; line-height: 1.5; }
  @media (max-width: 640px) { .auth-wrap { padding-top: 68px; } .auth-card { margin-top: 45px; padding: 23px; } }
</style>
