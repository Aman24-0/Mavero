<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowLeft, Check, LockKeyhole, Mail, Play, RotateCcw, Settings2, Trash2, UserRound, Sparkles, Info } from 'lucide-svelte';
  import type { PageData } from './$types';
  import ConfirmDialog from '$components/ConfirmDialog.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
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
  const userEmail = $derived(data.user?.email ?? '');

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

<div class="settings-page">
  <header class="settings-header">
    <div class="header-inner">
      <a class="back-pill" href="/profile"><ArrowLeft size={15} /> <span>Profile</span></a>
      <div class="header-eyebrow"><Settings2 size={13} /> MAVERO / Settings</div>
      <h1>Make it yours.</h1>
      <p>Manage the details and defaults that shape your Mavero experience.</p>
    </div>
  </header>

  <div class="settings-body">
    {#if form?.message}
      <div class:success={form.success} class="form-feedback" role="status">
        {#if form.success}<Check size={14} />{:else}<Info size={14} />{/if}
        <span>{form.message}</span>
      </div>
    {/if}

    {#if data.user}
      <!-- Account / Profile -->
      <section class="settings-section" aria-labelledby="profile-settings-title">
        <div class="section-head">
          <div class="section-icon"><UserRound size={16} /></div>
          <div>
            <div class="section-eyebrow">Account</div>
            <h2 id="profile-settings-title">Profile details</h2>
            <p class="section-sub">How Mavero knows you.</p>
          </div>
        </div>
        <form class="settings-form" method="POST" action="?/profile">
          <label class="field">
            <span class="field-label">Display name</span>
            <input name="displayName" value={displayName} maxlength="80" autocomplete="name" required />
          </label>
          <button class="primary-cta" type="submit"><Check size={14} /> Save profile</button>
        </form>
      </section>

      <!-- Account access -->
      <section class="settings-section" aria-labelledby="account-settings-title">
        <div class="section-head">
          <div class="section-icon"><LockKeyhole size={16} /></div>
          <div>
            <div class="section-eyebrow">Account</div>
            <h2 id="account-settings-title">Access & security</h2>
            <p class="section-sub">Keep your account secure.</p>
          </div>
        </div>
        <div class="account-grid">
          <form class="settings-form" method="POST" action="?/email">
            <label class="field">
              <span class="field-label">Email address</span>
              <input name="email" type="email" value={userEmail} autocomplete="email" required />
            </label>
            <button class="secondary-cta" type="submit"><Mail size={14} /> Update email</button>
          </form>
          <form class="settings-form" method="POST" action="?/password">
            <label class="field">
              <span class="field-label">New password</span>
              <input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" required />
            </label>
            <label class="field">
              <span class="field-label">Confirm password</span>
              <input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required />
            </label>
            <button class="secondary-cta" type="submit"><LockKeyhole size={14} /> Change password</button>
          </form>
        </div>
      </section>
    {:else}
      <section class="settings-section guest-section" aria-labelledby="guest-settings-title">
        <div class="section-head">
          <div class="section-icon"><LockKeyhole size={16} /></div>
          <div>
            <div class="section-eyebrow">Account</div>
            <h2 id="guest-settings-title">Sign in to manage account settings.</h2>
            <p class="section-sub">Your local library remains available without an account.</p>
          </div>
        </div>
        <a class="primary-cta" href="/auth/sign-in">Sign in</a>
      </section>
    {/if}

    <!-- Playback -->
    <section class="settings-section" aria-labelledby="playback-settings-title">
      <div class="section-head">
        <div class="section-icon"><Play size={16} /></div>
        <div>
          <div class="section-eyebrow">Experience</div>
          <h2 id="playback-settings-title">Playback</h2>
          <p class="section-sub">These preferences are saved privately on this device.</p>
        </div>
      </div>
      <div class="toggle-list">
        <label class="toggle-row">
          <span class="toggle-copy">
            <strong>Autoplay next episode</strong>
            <small>Start the next episode automatically when available.</small>
          </span>
          <span class="toggle-switch">
            <input type="checkbox" bind:checked={settings.autoplay} onchange={persistSettingsAndHaptic} />
            <i aria-hidden="true"></i>
          </span>
        </label>
        <label class="toggle-row">
          <span class="toggle-copy">
            <strong>Resume where you left off</strong>
            <small>Use your saved progress when reopening a title.</small>
          </span>
          <span class="toggle-switch">
            <input type="checkbox" bind:checked={settings.autoResume} onchange={persistSettingsAndHaptic} />
            <i aria-hidden="true"></i>
          </span>
        </label>
      </div>
    </section>

    <!-- Library & interface -->
    <section class="settings-section" aria-labelledby="library-settings-title">
      <div class="section-head">
        <div class="section-icon"><RotateCcw size={16} /></div>
        <div>
          <div class="section-eyebrow">Experience</div>
          <h2 id="library-settings-title">Library & interface</h2>
          <p class="section-sub">Mavero keeps progress local-first and syncs it when your account is available.</p>
        </div>
      </div>
      <div class="toggle-list">
        <label class="toggle-row">
          <span class="toggle-copy">
            <strong>Reduce motion</strong>
            <small>Use calmer transitions throughout the app.</small>
          </span>
          <span class="toggle-switch">
            <input type="checkbox" bind:checked={settings.reducedMotion} onchange={persistSettingsAndHaptic} />
            <i aria-hidden="true"></i>
          </span>
        </label>
      </div>
    </section>

    <!-- About -->
    <section class="settings-section about-section" aria-labelledby="about-title">
      <div class="section-head">
        <div class="section-icon"><Info size={16} /></div>
        <div>
          <div class="section-eyebrow">About</div>
          <h2 id="about-title">About Mavero</h2>
        </div>
      </div>
      <div class="about-list">
        <div class="about-row"><span>Application</span><strong>Mavero</strong></div>
        <div class="about-row"><span>Category</span><strong>Movies, series & anime</strong></div>
        <div class="about-row"><span>Data source</span><strong>TMDB · AniList</strong></div>
        <div class="about-row">
          <span>Attribution</span>
          <a class="tmdb-link" href="https://www.themoviedb.org/about/logos-attribution?language=en-US" target="_blank" rel="noreferrer">
            <img class="tmdb-logo" src="https://upload.wikimedia.org/wikipedia/commons/8/89/Tmdb.new.logo.svg" alt="The Movie Database" />
          </a>
        </div>
      </div>
    </section>

    {#if data.user}
      <section class="danger-zone" aria-labelledby="danger-zone-title">
        <div class="section-head">
          <div class="section-icon danger-icon"><Trash2 size={16} /></div>
          <div>
            <div class="section-eyebrow danger-eyebrow">Danger zone</div>
            <h2 id="danger-zone-title">Delete account</h2>
            <p class="section-sub">Permanently delete your Mavero account and associated personal data. This action cannot be undone.</p>
          </div>
        </div>
        <button class="delete-account-btn" type="button" onclick={openDelete} disabled={deleteBusy}>
          <Trash2 size={14} /> Delete account
        </button>
      </section>
    {/if}

    {#if deleteSuccess}
      <div class="form-feedback success" role="status"><Check size={14} /> <span>Account deleted successfully. Returning to Discover…</span></div>
    {/if}

    <ConfirmDialog open={deleteStep === 'initial'} eyebrow="MAVERO / Danger zone" title="Delete your account?" description="This will permanently delete your Mavero account and associated personal data. This action cannot be undone." primaryLabel="Continue" tone="danger" onCancel={closeDelete} onPrimary={continueDelete} />
    <ConfirmDialog open={deleteStep === 'final'} eyebrow="MAVERO / Final confirmation" title="Confirm account deletion" description="To permanently delete your account, type DELETE below. This final action cannot be undone." primaryLabel={deleteBusy ? 'Deleting…' : 'Delete account'} primaryDisabled={deleteBusy || deleteConfirmation !== 'DELETE'} cancelDisabled={deleteBusy} tone="danger" onCancel={closeDelete} onPrimary={deleteAccount}>
      <label class="delete-confirm-label" for="delete-confirmation">Type <code>DELETE</code> to continue</label>
      <input id="delete-confirmation" class="delete-confirm-input" type="text" bind:value={deleteConfirmation} autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="delete-confirmation-help" disabled={deleteBusy} />
      <small id="delete-confirmation-help" class="delete-confirm-help">The text is case-sensitive.</small>
      {#if deleteError}<p class="dialog-error" role="alert">{deleteError}</p>{/if}
    </ConfirmDialog>
  </div>
</div>

<ScrollToTop />

<style>
  .settings-page {
    --s-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    /* Settings opts out of the mobile floating bottom nav, so it only
       needs a small bottom safe-area padding rather than the full
       110px reserved on other shell pages. */
    padding-bottom: calc(40px + env(safe-area-inset-bottom, 0px));
  }

  .settings-header {
    /* The shell already adds the topbar offset via --shell-content-top.
       We only add a deliberate per-page breathing room here. */
    padding: 26px var(--s-gutter) 22px;
    border-bottom: 1px solid rgba(255,255,255,.05);
    background:
      radial-gradient(circle at 85% -20%, rgba(255,255,255,.04), transparent 50%),
      #000;
  }
  .header-inner { width: min(900px, 100%); margin-inline: auto; }
  .back-pill {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 42px;
    padding: 0 16px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(10, 10, 10, .6);
    backdrop-filter: blur(8px);
    font-size: .74rem; font-weight: 700;
    text-decoration: none;
    transition: background 180ms ease, border-color 180ms ease, transform 180ms ease;
  }
  .back-pill:hover { background: rgba(20, 20, 20, .8); border-color: rgba(255, 255, 255, .24); transform: translateX(-2px); }
  .back-pill:active { transform: translateX(-2px) scale(.97); }
  .back-pill:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }
  .header-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    margin-top: 22px;
    color: #77777f;
    font-size: .6rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .settings-header h1 {
    margin: 8px 0 6px;
    color: #f5f5f5;
    font-size: clamp(1.8rem, 4vw, 2.6rem);
    font-weight: 800;
    letter-spacing: -.025em;
    line-height: 1.05;
  }
  .settings-header p {
    margin: 0;
    color: #b7b7bd;
    font-size: .82rem;
    line-height: 1.55;
    max-width: 480px;
  }

  .settings-body {
    width: min(900px, calc(100% - 2 * var(--s-gutter)));
    margin-inline: auto;
    padding-top: 24px;
  }

  .form-feedback {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 18px;
    padding: 12px 14px;
    border: 1px solid rgba(255,176,32,.28);
    border-radius: 10px;
    color: #ffb020;
    background: rgba(255,176,32,.04);
    font-size: .76rem;
  }
  .form-feedback.success {
    border-color: rgba(53,214,143,.3);
    color: #35d68f;
    background: rgba(53,214,143,.04);
  }

  .settings-section {
    margin-top: 22px;
    padding: 22px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 14px;
    background: rgba(255,255,255,.012);
  }
  .section-head { display: flex; align-items: start; gap: 12px; }
  .section-icon {
    display: grid; place-items: center;
    width: 36px; height: 36px;
    border-radius: 10px;
    color: #f5f5f5;
    background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.06);
    flex: 0 0 auto;
  }
  .section-eyebrow {
    color: #c7c7cc;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .12em; text-transform: uppercase;
  }
  .section-head h2 {
    margin: 5px 0 3px;
    color: #f5f5f5;
    font-size: 1.08rem; font-weight: 800;
    letter-spacing: -.015em;
  }
  .section-sub {
    margin: 0;
    color: #77777f;
    font-size: .74rem; line-height: 1.5;
  }

  /* Form fields */
  .settings-form { display: grid; gap: 12px; margin-top: 18px; }
  .field { display: grid; gap: 7px; }
  .field-label {
    color: #77777f;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .settings-form input,
  .delete-confirm-input {
    width: 100%; box-sizing: border-box;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 10px;
    color: #f5f5f5;
    background: rgba(255,255,255,.03);
    font: inherit;
    font-size: .84rem;
    outline: 0;
    transition: border-color 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1);
  }
  .settings-form input:focus,
  .delete-confirm-input:focus {
    border-color: rgba(255,255,255,.28);
    background: rgba(255,255,255,.06);
  }
  .settings-form input::placeholder { color: #55555d; }

  .account-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 22px;
  }

  /* Buttons */
  .primary-cta, .secondary-cta {
    display: inline-flex; align-items: center; gap: 7px;
    justify-self: start;
    min-height: 42px;
    padding: 0 20px;
    border-radius: 999px;
    font-size: .78rem; font-weight: 700;
    text-decoration: none;
    cursor: pointer;
    transition: transform 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1), border-color 180ms cubic-bezier(.22,1,.36,1);
  }
  .primary-cta {
    color: #000;
    background: #f5f5f5;
    border: 1px solid #f5f5f5;
    box-shadow: 0 4px 18px rgba(255,255,255,.1);
  }
  .primary-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(255,255,255,.16); }
  .primary-cta:active { transform: scale(.98); }
  .secondary-cta {
    color: #f5f5f5;
    background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.14);
  }
  .secondary-cta:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.24); }
  .secondary-cta:active { transform: scale(.98); }

  /* Toggles */
  .toggle-list { display: grid; margin-top: 14px; }
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 16px 0;
    border-top: 1px solid rgba(255,255,255,.05);
    cursor: pointer;
  }
  .toggle-row:first-child { border-top: 0; padding-top: 4px; }
  .toggle-copy { display: grid; gap: 4px; min-width: 0; }
  .toggle-copy strong {
    color: #f5f5f5;
    font-size: .82rem; font-weight: 700;
  }
  .toggle-copy small {
    color: #77777f;
    font-size: .72rem; line-height: 1.5;
  }
  .toggle-switch { position: relative; flex: 0 0 auto; }
  .toggle-switch input { position: absolute; opacity: 0; pointer-events: none; }
  .toggle-switch i {
    position: relative; display: block;
    width: 42px; height: 24px;
    border-radius: 999px;
    background: rgba(255,255,255,.12);
    transition: background 180ms cubic-bezier(.22,1,.36,1);
  }
  .toggle-switch i::after {
    content: ''; position: absolute;
    top: 3px; left: 3px;
    width: 18px; height: 18px;
    border-radius: 50%;
    background: #f5f5f5;
    transition: transform 180ms cubic-bezier(.22,1,.36,1);
  }
  .toggle-switch input:checked + i { background: #f5f5f5; }
  .toggle-switch input:checked + i::after { transform: translateX(18px); background: #000; }
  .toggle-switch input:focus-visible + i { outline: 2px solid #f5f5f5; outline-offset: 2px; }

  /* About list */
  .about-list { margin-top: 14px; }
  .about-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 0;
    border-top: 1px solid rgba(255,255,255,.05);
    font-size: .8rem;
  }
  .about-row:first-child { border-top: 0; padding-top: 4px; }
  .about-row span { color: #77777f; font-size: .72rem; }
  .about-row strong { color: #f5f5f5; font-weight: 700; }
  .tmdb-link { display: inline-flex; align-items: center; }
  .tmdb-logo { width: 42px; height: 30px; object-fit: contain; }

  /* Danger zone */
  .danger-zone {
    margin-top: 22px;
    padding: 22px;
    border: 1px solid rgba(255,176,32,.22);
    border-radius: 14px;
    background: rgba(255,176,32,.025);
  }
  .danger-icon { color: #ffb020; background: rgba(255,176,32,.08); border-color: rgba(255,176,32,.18); }
  .danger-eyebrow { color: #ffb020; }
  .delete-account-btn {
    margin-top: 18px;
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 42px;
    padding: 0 18px;
    border: 1px solid rgba(255,176,32,.35);
    border-radius: 999px;
    color: #ffb020;
    background: rgba(255,176,32,.05);
    font: inherit;
    font-size: .76rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease, color 180ms ease;
  }
  .delete-account-btn:hover:not(:disabled) {
    background: rgba(255,176,32,.12);
    border-color: rgba(255,176,32,.55);
    color: #ffd17a;
  }
  .delete-account-btn:disabled { opacity: .5; cursor: not-allowed; }

  .delete-confirm-label {
    display: block; color: #77777f;
    font-size: .72rem; font-weight: 700;
  }
  .delete-confirm-label code {
    color: #ffb020;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    letter-spacing: .14em;
    font-weight: 800;
  }
  .delete-confirm-input {
    margin-top: 8px;
    letter-spacing: .12em;
    font-weight: 800;
  }
  .delete-confirm-help {
    display: block; margin-top: 7px;
    color: #77777f;
    font-size: .64rem;
  }
  .dialog-error { margin: 12px 0 0; color: #ffb020; font-size: .72rem; line-height: 1.45; }

  @media (max-width: 720px) {
    .settings-header { padding-top: 22px; }
    .account-grid { grid-template-columns: 1fr; gap: 18px; }
    .settings-section, .danger-zone { padding: 18px; }
  }
  @media (max-width: 480px) {
    .toggle-row { padding: 14px 0; }
    .toggle-copy strong { font-size: .78rem; }
    .toggle-copy small { font-size: .68rem; }
  }
  @media (min-width: 900px) {
    .settings-header { padding-top: 44px; }
    .settings-header h1 { font-size: clamp(2rem, 3.4vw, 2.6rem); }
  }
  @media (prefers-reduced-motion: reduce) {
    .back-pill, .toggle-switch i, .toggle-switch i::after, .primary-cta, .secondary-cta, .delete-account-btn { transition: none; }
  }
</style>
