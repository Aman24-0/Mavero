<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowLeft, Check, LockKeyhole, Mail, Play, RotateCcw, Settings2, Trash2, UserRound } from 'lucide-svelte';
  import type { PageData } from './$types';
  import ConfirmDialog from '$components/ConfirmDialog.svelte';
  import { clearLocalData } from '$lib/client/progress/database';
  import { haptic } from '$lib/client/haptics';

  let { data, form } = $props<{ data: PageData; form?: { section?: string; success?: boolean; message?: string } }>();
  let settings = $state({ autoplay: true, autoResume: true, reducedMotion: false });
  let deleteStep = $state<'initial' | 'final' | null>(null);
  let deleteConfirmation = $state('');
  let deleteBusy = $state(false);
  let deleteError = $state('');
  let deleteSuccess = $state(false);

  function persistSettings() {
    localStorage.setItem('mavero.settings', JSON.stringify(settings));
  }

  function persistSettingsAndHaptic() {
    persistSettings();
    haptic('light');
  }

  onMount(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('mavero.settings') ?? '{}') as Partial<typeof settings>;
      settings = { ...settings, ...stored };
    } catch {
      // Keep the safe defaults if local storage is unavailable or malformed.
    }
  });

  const displayName = $derived(typeof data.user?.user_metadata?.display_name === 'string' ? data.user.user_metadata.display_name : '');

  function openDelete() {
    deleteError = '';
    deleteConfirmation = '';
    deleteStep = 'initial';
  }

  function closeDelete() {
    if (deleteBusy) return;
    deleteStep = null;
    deleteConfirmation = '';
    deleteError = '';
  }

  function continueDelete() {
    if (!deleteBusy && deleteStep === 'initial') deleteStep = 'final';
  }

  async function deleteAccount() {
    if (deleteBusy || deleteConfirmation !== 'DELETE') return;
    deleteBusy = true;
    deleteError = '';
    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ confirmation: deleteConfirmation })
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: { message?: string }; message?: string } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message ?? payload?.message ?? 'Account deletion failed.');
      await clearLocalData();
      deleteStep = null;
      deleteSuccess = true;
      window.setTimeout(() => window.location.replace('/discover'), 500);
    } catch {
      deleteBusy = false;
      deleteError = 'Unable to delete your account right now. Please try again.';
    }
  }
</script>

<svelte:head><title>Settings — Mavero</title><meta name="description" content="Manage your MAVERO profile, account, playback, and library settings." /><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="container-wide settings-page">
  <a class="back-link" href="/profile"><ArrowLeft size={15} /> Profile</a>
  <header class="settings-header"><div class="eyebrow">MAVERO / Settings</div><h1>Make it yours<span>.</span></h1><p>Manage the details and defaults that shape your Mavero experience.</p></header>

  {#if form?.message}<div class:success={form.success} class="form-feedback" role="status">{form.success ? '✓ ' : ''}{form.message}</div>{/if}

  {#if data.user}
    <section class="settings-section" aria-labelledby="profile-settings-title">
      <div class="section-heading"><div class="section-icon"><UserRound size={17} /></div><div><div class="eyebrow">Profile details</div><h2 id="profile-settings-title">How Mavero knows you.</h2></div></div>
      <form class="settings-form" method="POST" action="?/profile">
        <label><span>Display name</span><input name="displayName" value={displayName} maxlength="80" autocomplete="name" required /></label>
        <button class="btn btn-primary" type="submit"><Check size={15} /> Save profile</button>
      </form>
    </section>

    <section class="settings-section" aria-labelledby="account-settings-title">
      <div class="section-heading"><div class="section-icon"><LockKeyhole size={17} /></div><div><div class="eyebrow">Account access</div><h2 id="account-settings-title">Keep your account secure.</h2></div></div>
      <div class="account-grid">
        <form class="settings-form" method="POST" action="?/email">
          <label><span>Email address</span><input name="email" type="email" value={data.user.email ?? ''} autocomplete="email" required /></label>
          <button class="btn btn-secondary" type="submit"><Mail size={15} /> Update email</button>
        </form>
        <form class="settings-form" method="POST" action="?/password">
          <label><span>New password</span><input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" required /></label>
          <label><span>Confirm password</span><input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required /></label>
          <button class="btn btn-secondary" type="submit"><LockKeyhole size={15} /> Change password</button>
        </form>
      </div>
    </section>
  {:else}
    <section class="settings-section guest-settings"><div class="section-heading"><div class="section-icon"><LockKeyhole size={17} /></div><div><div class="eyebrow">Account access</div><h2>Sign in to manage account settings.</h2><p>Your local library remains available without an account.</p></div></div><a class="btn btn-primary" href="/auth/sign-in">Sign in</a></section>
  {/if}

  <section class="settings-section" aria-labelledby="playback-settings-title">
    <div class="section-heading"><div class="section-icon"><Play size={17} /></div><div><div class="eyebrow">Playback</div><h2 id="playback-settings-title">Set the pace.</h2><p>These preferences are saved privately on this device.</p></div></div>
    <div class="toggle-list">
      <label class="toggle-row"><span><strong>Autoplay next episode</strong><small>Start the next episode automatically when available.</small></span><input type="checkbox" bind:checked={settings.autoplay} onchange={persistSettingsAndHaptic} /><i aria-hidden="true"></i></label>
      <label class="toggle-row"><span><strong>Resume where you left off</strong><small>Use your saved progress when reopening a title.</small></span><input type="checkbox" bind:checked={settings.autoResume} onchange={persistSettingsAndHaptic} /><i aria-hidden="true"></i></label>
    </div>
  </section>

  <section class="settings-section" aria-labelledby="library-settings-title">
    <div class="section-heading"><div class="section-icon"><RotateCcw size={17} /></div><div><div class="eyebrow">Library and interface</div><h2 id="library-settings-title">Keep your library comfortable.</h2><p>Mavero keeps progress local-first and syncs it when your account is available.</p></div></div>
    <div class="toggle-list">
      <label class="toggle-row"><span><strong>Reduce motion</strong><small>Use calmer transitions throughout the app.</small></span><input type="checkbox" bind:checked={settings.reducedMotion} onchange={persistSettingsAndHaptic} /><i aria-hidden="true"></i></label>
    </div>
  </section>

  {#if data.user}
    <section class="danger-zone" aria-labelledby="danger-zone-title">
      <div class="section-heading"><div class="section-icon danger-icon"><Trash2 size={17} /></div><div><div class="eyebrow danger-eyebrow">Danger zone</div><h2 id="danger-zone-title">Delete account</h2><p>Permanently delete your Mavero account and associated personal data.</p></div></div>
      <button class="btn delete-account-btn" type="button" onclick={openDelete} disabled={deleteBusy}><Trash2 size={15} /> Delete account</button>
    </section>
  {/if}

  {#if deleteSuccess}<div class="form-feedback success" role="status">Account deleted successfully. Returning to Discover…</div>{/if}
  <ConfirmDialog open={deleteStep === 'initial'} eyebrow="MAVERO / Danger zone" title="Delete your account?" description="This will permanently delete your Mavero account and associated personal data. This action cannot be undone." primaryLabel="Continue" tone="danger" onCancel={closeDelete} onPrimary={continueDelete} />
  <ConfirmDialog open={deleteStep === 'final'} eyebrow="MAVERO / Final confirmation" title="Confirm account deletion" description="To permanently delete your account, type DELETE below. This final action cannot be undone." primaryLabel={deleteBusy ? 'Deleting…' : 'Delete account'} primaryDisabled={deleteBusy || deleteConfirmation !== 'DELETE'} cancelDisabled={deleteBusy} tone="danger" onCancel={closeDelete} onPrimary={deleteAccount}>
    <label class="delete-confirm-label" for="delete-confirmation">Type <code>DELETE</code> to continue</label>
    <input id="delete-confirmation" class="delete-confirm-input" type="text" bind:value={deleteConfirmation} autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="delete-confirmation-help" disabled={deleteBusy} />
    <small id="delete-confirmation-help" class="delete-confirm-help">The text is case-sensitive.</small>
    {#if deleteError}<p class="dialog-error" role="alert">{deleteError}</p>{/if}
  </ConfirmDialog>

  <footer class="settings-footer"><Settings2 size={14} /><span>MAVERO settings are designed to stay simple, private, and reversible.</span></footer>
</div>

<style>
  .settings-page { min-height: calc(100dvh - 76px); padding: 30px 0 84px; }
  .back-link { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: .74rem; font-weight: 700; text-decoration: none; transition: color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .back-link:hover { color: var(--ink); transform: translateX(-2px); }
  .settings-header { padding: 34px 0 28px; border-bottom: 1px solid var(--line); }
  .settings-header h1 { margin: 10px 0 8px; color: var(--ink); font-size: clamp(2rem, 4vw, 3rem); font-weight: 900; letter-spacing: -.03em; line-height: 1; }
  .settings-header h1 span { color: var(--accent-strong); }
  .settings-header p { margin: 0; color: var(--muted); font-size: .82rem; line-height: 1.6; }
  .form-feedback { margin-top: 22px; padding: 12px 14px; border: 1px solid rgba(255,176,32,.32); border-radius: var(--radius-sm); color: var(--warning); font-size: .72rem; }
  .form-feedback.success { border-color: rgba(74, 222, 128, .28); color: var(--success); background: rgba(74,222,128,.06); }
  .settings-section { margin-top: 22px; padding: 22px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
  .section-heading { display: flex; align-items: flex-start; gap: 12px; }
  .section-icon { display: grid; flex: 0 0 36px; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: var(--accent-strong); background: var(--accent-soft); }
  .section-heading h2 { margin: 7px 0 5px; color: var(--ink); font-size: 1.12rem; font-weight: 800; letter-spacing: -.015em; }
  .section-heading p { margin: 0; color: var(--muted); font-size: .74rem; line-height: 1.55; }
  .settings-form { display: grid; gap: 11px; margin-top: 20px; }
  .settings-form label { display: grid; gap: 7px; }
  .settings-form label span { color: var(--muted-deep); font-size: .58rem; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
  .settings-form input { width: 100%; box-sizing: border-box; min-height: 42px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 9px; color: var(--ink); background: rgba(245,246,250,.035); font-size: .78rem; outline: 0; }
  .settings-form input:focus { border-color: rgba(255,62,94,.65); box-shadow: 0 0 0 3px rgba(255,62,94,.09); }
  .settings-form .btn { justify-self: start; margin-top: 3px; }
  .account-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
  .guest-settings { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .toggle-list { display: grid; gap: 4px; margin-top: 18px; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-top: 1px solid var(--line); cursor: pointer; }
  .toggle-row span { display: grid; gap: 4px; }
  .toggle-row strong { color: var(--ink-soft); font-size: .78rem; }
  .toggle-row small { color: var(--muted-deep); font-size: .67rem; line-height: 1.45; }
  .toggle-row input { position: absolute; opacity: 0; pointer-events: none; }
  .toggle-row i { position: relative; flex: 0 0 40px; width: 40px; height: 22px; border-radius: 999px; background: var(--line-strong); transition: background var(--motion-fast) var(--ease-out); }
  .toggle-row i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--ink); transition: transform var(--motion-fast) var(--ease-out); }
  .toggle-row input:checked + i { background: var(--accent-strong); }
  .toggle-row input:checked + i::after { transform: translateX(18px); background: #fff; }
  .danger-zone { margin-top: 22px; padding: 22px; border: 1px solid rgba(231,140,141,.34); border-radius: var(--radius-lg); background: linear-gradient(110deg, rgba(185,76,92,.08), rgba(245,246,250,.02)); }
  .danger-icon { color: #ff8fa3; background: rgba(185,76,92,.14); }
  .danger-eyebrow { color: #ff8fa3; }
  .delete-account-btn { margin-top: 20px; color: #ff9aac; border-color: rgba(231,140,141,.46); background: rgba(185,76,92,.1); }
  .delete-account-btn:hover { color: #fff; border-color: rgba(231,140,141,.74); background: rgba(185,76,92,.22); }
  .delete-confirm-label { display: block; color: var(--muted-deep); font-size: .68rem; font-weight: 700; }
  .delete-confirm-label code { color: #ff9aac; font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; letter-spacing: .12em; }
  .delete-confirm-input { width: 100%; box-sizing: border-box; min-height: 44px; margin-top: 8px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 9px; color: var(--ink); background: rgba(245,246,250,.04); font-size: .86rem; font-weight: 800; letter-spacing: .12em; outline: 0; }
  .delete-confirm-input:focus { border-color: #d97883; box-shadow: 0 0 0 3px rgba(217,120,131,.14); }
  .delete-confirm-help { display: block; margin-top: 7px; color: var(--muted-deep); font-size: .63rem; }
  .dialog-error { margin: 12px 0 0; color: #ff9aac; font-size: .7rem; line-height: 1.45; }
  .settings-footer { display: flex; align-items: center; gap: 7px; margin-top: 28px; color: var(--muted-deep); font-size: .64rem; }
  @media (max-width: 720px) { .settings-page { padding-top: 88px; } .account-grid { grid-template-columns: 1fr; gap: 7px; } .guest-settings { align-items: flex-start; flex-direction: column; } }
  @media (prefers-reduced-motion: reduce) { .back-link, .toggle-row i, .toggle-row i::after { transition: none; } }
</style>
