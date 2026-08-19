<script lang="ts">
  import { ArrowLeft, Mail, LockKeyhole, ShieldCheck } from 'lucide-svelte';
  let email = '';
  let password = '';
</script>

<svelte:head><title>Sign in — Mavero</title></svelte:head>

<div class="auth-wrap container-wide"><a class="back-link" href="/profile"><ArrowLeft size={15} /> Back to Profile</a><div class="auth-card"><div class="eyebrow">MAVERO / Cross-device sync</div><h1>Keep your place<br /><em>everywhere.</em></h1><p>Sign in to sync Continue Watching, favorites, and history across your devices. You can keep exploring without an account.</p><form onsubmit={(event) => event.preventDefault()}><label>Email<div class="auth-input"><Mail size={15} /><input bind:value={email} type="email" placeholder="you@example.com" required /></div></label><label>Password<div class="auth-input"><LockKeyhole size={15} /><input bind:value={password} type="password" placeholder="Your password" required /></div></label><button class="btn btn-primary" type="submit">Continue</button></form><div class="auth-note"><ShieldCheck size={15} /> Your guest progress stays local until you choose to sync it.</div></div></div>

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
  .auth-note { display: flex; align-items: center; gap: 7px; margin-top: 18px; color: var(--success); font-family: 'DM Mono', monospace; font-size: .58rem; line-height: 1.5; }
  @media (max-width: 640px) { .auth-wrap { padding-top: 68px; } .auth-card { margin-top: 45px; padding: 23px; } }
</style>
