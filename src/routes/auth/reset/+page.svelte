<script lang="ts">
  import { ArrowLeft, LockKeyhole, ShieldCheck } from 'lucide-svelte';
  import type { PageData } from './$types';

  type ResetForm = { message?: string };
  let { data, form }: { data: PageData; form?: ResetForm } = $props();
</script>

<svelte:head>
  <title>Reset password — Mavero</title>
  <meta name="description" content="Set a new secure password for your MAVERO account." />
</svelte:head>

<div class="auth-wrap container-wide">
  <a class="back-link" href="/auth/sign-in"><ArrowLeft size={15} /> Back to Sign in</a>
  <div class="auth-card">
    <div class="eyebrow">MAVERO / Account recovery</div>
    <h1>Make it<br /><em>secure again.</em></h1>
    <p>Choose a new password for your MAVERO account. Your local guest library remains available on this device.</p>
    {#if form?.message}<div class="auth-message" role="alert">{form.message}</div>{/if}
    {#if data.ready}
      <form method="POST">
        <label>New password<div class="auth-input"><LockKeyhole size={15} /><input name="password" type="password" autocomplete="new-password" minlength="6" placeholder="At least 6 characters" required /></div></label>
        <label>Confirm password<div class="auth-input"><LockKeyhole size={15} /><input name="confirmation" type="password" autocomplete="new-password" minlength="6" placeholder="Repeat your password" required /></div></label>
        <button class="btn btn-primary" type="submit">Update password</button>
      </form>
    {:else}
      <div class="auth-message" role="alert">This reset link is no longer active. Request a new link from Sign in.</div>
      <a class="btn btn-secondary" href="/auth/sign-in">Request another link</a>
    {/if}
    <div class="auth-note"><ShieldCheck size={15} /> Password changes are handled by the dedicated MAVERO Supabase project.</div>
  </div>
</div>

<style>
  em { color: var(--accent); font-style: normal; }
  .auth-wrap { min-height: calc(100dvh - 76px); padding-bottom: 80px; }
  .back-link { display: inline-flex; align-items: center; gap: 8px; padding-top: 32px; color: var(--muted); font-size: .72rem; font-weight: 800; text-decoration: none; }
  .auth-card { width: min(480px, 100%); margin: 75px auto 0; padding: 28px; border: 1px solid var(--line); border-radius: 20px; background: var(--surface); }
  .auth-card h1 { margin: 9px 0 13px; color: var(--ink); font-size: clamp(1.7rem, 4vw, 2.3rem); font-weight: 900; line-height: 1.1; letter-spacing: -.02em; }
  .auth-card > p { color: var(--muted); font-size: .82rem; line-height: 1.7; }
  form { display: grid; gap: 15px; margin-top: 28px; }
  label { display: grid; gap: 7px; color: var(--muted); font-size: .68rem; font-weight: 800; }
  .auth-input { display: flex; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--muted-deep); background: rgba(255,255,255,.03); }
  .auth-input input { width: 100%; border: 0; outline: 0; color: var(--ink); background: transparent; font-size: .8rem; }
  .auth-message { margin-top: 18px; padding: 11px 12px; border: 1px solid rgba(255, 139, 139, .28); border-radius: 10px; color: #ff8080; background: rgba(255, 115, 115, .08); font-size: .72rem; line-height: 1.5; }
  .auth-note { display: flex; align-items: center; gap: 7px; margin-top: 18px; color: var(--success); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; line-height: 1.5; }
  @media (max-width: 640px) { .auth-wrap { padding-top: 68px; } .auth-card { margin-top: 45px; padding: 23px; } }
</style>
