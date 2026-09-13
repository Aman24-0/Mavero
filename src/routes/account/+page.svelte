<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Cloud, Info, LockKeyhole, LogIn, LogOut, Mail, ShieldCheck, Sparkles, Trash2, UserRound } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';
  import ConfirmDialog from '$components/ConfirmDialog.svelte';
  import AppFooter from '$components/AppFooter.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import { clearLocalData, listFavoriteDeletions } from '$lib/client/progress/database';
  import { getLocalFavorites, getLocalProgressRecords } from '$lib/client/progress/service';
  import { favoriteToMedia } from '$lib/client/progress/presenter';
  import { syncAuthenticatedState, getSyncStatus, type SyncStatus } from '$lib/client/progress/cloud';
  import { mergeFavoritesWithProgress } from '$lib/shared/progress-merge';
  import { haptic } from '$lib/client/haptics';

  let { data, form }: { data: PageData; form?: { section?: string; success?: boolean; message?: string } } = $props();

  // ── Identity (migrated from Profile) ────────────────────────────
  const displayName = $derived(typeof data.user?.user_metadata?.display_name === 'string' && data.user.user_metadata.display_name.trim() ? data.user.user_metadata.display_name : '');
  const userEmail = $derived(data.user?.email ?? '');
  let isAuthenticated = $derived(Boolean(data.user));

  function accountName() {
    const metadata = data.user?.user_metadata;
    return typeof metadata?.display_name === 'string' && metadata.display_name.trim() ? metadata.display_name : data.user?.email?.split('@')[0] ?? 'Guest';
  }

  function initials() {
    const name = accountName();
    if (!name) return '·';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function syncStatusLabel(status: SyncStatus) {
    return ({ synced: 'Synced across devices', syncing: 'Syncing your library…', pending: 'Sync pending', offline: 'Offline · Local cache active', error: 'Cloud sync will retry later' } satisfies Record<SyncStatus, string>)[status];
  }

  // ── Library summary (migrated from Profile — real data path) ────
  let favoriteItems = $state<MediaItem[]>([]);
  let watchedSeconds = $state(0);
  let loaded = $state(false);
  let errorMessage = $state('');
  let syncStatus = $state<SyncStatus>('pending');

  async function loadLocalState() {
    errorMessage = '';
    try {
      if (data.user) {
        const cloud = await syncAuthenticatedState();
        syncStatus = cloud.status;
        favoriteItems = mergeFavoritesWithProgress(cloud.favorites, cloud.progress, cloud.favoriteDeletions).map((record) => favoriteToMedia(record, cloud.progress));
        watchedSeconds = cloud.progress.reduce((total, record) => total + record.currentTime, 0);
      } else {
        const [favoriteRecords, progressRecords, deletions] = await Promise.all([getLocalFavorites(), getLocalProgressRecords(), listFavoriteDeletions()]);
        favoriteItems = mergeFavoritesWithProgress(favoriteRecords, progressRecords, deletions).map((record) => favoriteToMedia(record, progressRecords));
        watchedSeconds = progressRecords.reduce((total, record) => total + record.currentTime, 0);
      }
      loaded = true;
    } catch {
      syncStatus = getSyncStatus();
      errorMessage = 'Your library is temporarily unavailable, but browsing and playback remain available.';
      loaded = true;
    }
  }

  let watchedLabel = $derived(watchedSeconds >= 3600 ? `${(watchedSeconds / 3600).toFixed(1)}h` : `${Math.round(watchedSeconds / 60)}m`);
  let favoriteCount = $derived(favoriteItems.length);

  // ── Experience preferences (migrated from Settings) ─────────────
  let settings = $state({ autoplay: true, autoResume: true, reducedMotion: false });

  function persistSettings() {
    localStorage.setItem('mavero.settings', JSON.stringify(settings));
  }

  function persistSettingsAndHaptic() {
    persistSettings();
    haptic('light');
  }

  // ── Adult Mode (migrated from Settings — server-authoritative) ──
  let adultAvailable = $state(false);
  let adultEnabled = $state(false);
  let adultLoading = $state(false);

  async function loadAdultMode() {
    try {
      const response = await fetch('/api/settings/adult-mode');
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload.ok) return;
      adultAvailable = Boolean(payload.adminAllows);
      adultEnabled = Boolean(payload.userEnabled);
    } catch { /* ignore */ }
  }

  async function toggleAdultMode() {
    if (!adultAvailable || adultLoading) return;
    adultLoading = true;
    try {
      const response = await fetch('/api/settings/adult-mode', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !adultEnabled })
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (payload.ok) {
        adultEnabled = Boolean(payload.enabled);
        haptic('light');
        // The server is the authority — the client only reflects state.
        window.location.reload();
      }
    } catch { /* ignore */ }
    adultLoading = false;
  }

  // ── Password disclosure (compact UX) ────────────────────────────
  let passwordOpen = $state(false);

  function togglePassword() {
    passwordOpen = !passwordOpen;
    if (passwordOpen) haptic('light');
  }

  // ── Sign out (migrated from Profile) ────────────────────────────
  let signoutOpen = $state(false);
  let signoutBusy = $state(false);
  let signoutError = $state('');

  function openSignout() {
    signoutError = '';
    signoutOpen = true;
  }

  function closeSignout() {
    if (!signoutBusy) signoutOpen = false;
  }

  async function confirmSignout() {
    if (signoutBusy) return;
    signoutBusy = true;
    signoutError = '';
    try {
      const response = await fetch('/auth/sign-out', {
        method: 'POST',
        headers: { accept: 'application/json' },
        redirect: 'follow'
      });
      // A successful sign-out ends with a 303 redirect to /discover.
      // fetch follows it automatically; navigate via full page
      // replacement so auth cookies are re-read in a clean context.
      if (response.ok || response.redirected || (response.status >= 300 && response.status < 400)) {
        const target = response.redirected && response.url ? response.url : '/discover';
        window.location.replace(target);
        return;
      }
      let message = 'Unable to sign out right now. Please try again.';
      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const payload = await response.json();
          if (payload && typeof payload.message === 'string') message = payload.message;
        }
      } catch {
        // ignore — use the default message
      }
      signoutBusy = false;
      signoutError = message;
    } catch {
      signoutBusy = false;
      signoutError = 'Unable to sign out right now. Please check your connection and try again.';
    }
  }

  // ── Delete account (migrated from Settings — two-step, DELETE) ──
  let deleteStep = $state<'initial' | 'final' | null>(null);
  let deleteConfirmation = $state('');
  let deleteBusy = $state(false);
  let deleteError = $state('');
  let deleteSuccess = $state(false);

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

  onMount(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('mavero.settings') ?? '{}') as Partial<typeof settings>;
      settings = { ...settings, ...stored };
    } catch {
      // Keep the safe defaults if local storage is unavailable or malformed.
    }
    void loadLocalState();
    void loadAdultMode();
  });
</script>

<svelte:head><title>Account — Mavero</title><meta name="description" content="Your Mavero account, library and preferences in one place." /><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="account-page">
  <!-- Compact identity header: avatar + name + email + sync state -->
  <header class="account-top">
    <div class="top-inner">
      <div class="page-eyebrow"><UserRound size={12} /> MAVERO / Account</div>
      <div class="identity-row">
        <div class="avatar" aria-hidden="true">{initials()}</div>
        <div class="identity-copy">
          <h1>{accountName()}</h1>
          {#if userEmail}
            <p class="identity-email">{userEmail}</p>
          {/if}
          <p class="identity-meta" aria-live="polite">
            <span class:online={isAuthenticated && syncStatus === 'synced'} class:syncing={syncStatus === 'syncing'}></span>
            {isAuthenticated ? syncStatusLabel(syncStatus) : 'Guest profile · Local library'}
          </p>
        </div>
        {#if !isAuthenticated}
          <a class="sign-in-cta" href="/auth/sign-in"><LogIn size={14} /> <span>Sign in to sync</span></a>
        {/if}
      </div>
    </div>
  </header>

  <div class="account-body">
    {#if errorMessage}
      <section class="error-banner" role="alert">
        <strong>Your local library is resting.</strong>
        <span>{errorMessage}</span>
        <button type="button" onclick={loadLocalState}>Retry</button>
      </section>
    {/if}

    {#if data.user}
      <!-- ACCOUNT — profile & security -->
      <section class="account-section" aria-labelledby="profile-security-title">
        <div class="section-title-row">
          <span class="section-icon" aria-hidden="true"><UserRound size={14} /></span>
          <h2 id="profile-security-title">Profile &amp; security</h2>
        </div>

        <form class="inline-form" method="POST" action="?/profile">
          <label class="field">
            <span class="field-label">Display name</span>
            <input name="displayName" value={displayName} maxlength="80" autocomplete="name" required />
          </label>
          <button class="secondary-cta" type="submit"><Check size={14} /> Save profile</button>
          {#if form?.section === 'profile'}
            <p class="form-note" class:ok={form.success} role={form.success ? 'status' : 'alert'}>{form.message}</p>
          {/if}
        </form>

        <form class="inline-form" method="POST" action="?/email">
          <label class="field">
            <span class="field-label">Email</span>
            <input name="email" type="email" value={userEmail} autocomplete="email" required />
          </label>
          <button class="secondary-cta" type="submit"><Mail size={14} /> Update email</button>
          {#if form?.section === 'email'}
            <p class="form-note" class:ok={form.success} role={form.success ? 'status' : 'alert'}>{form.message}</p>
          {/if}
        </form>

        <div class="password-block">
          <div class="password-summary">
            <div class="password-copy">
              <strong>Password</strong>
              <small>Change your account password</small>
            </div>
            <button class="secondary-cta" type="button" aria-expanded={passwordOpen} aria-controls="password-form" onclick={togglePassword}>
              <LockKeyhole size={14} /> {passwordOpen ? 'Hide' : 'Change password'}
            </button>
          </div>
          {#if passwordOpen}
            <form id="password-form" class="inline-form" method="POST" action="?/password">
              <div class="password-fields">
                <label class="field">
                  <span class="field-label">New password</span>
                  <input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" required />
                </label>
                <label class="field">
                  <span class="field-label">Confirm password</span>
                  <input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required />
                </label>
              </div>
              <button class="secondary-cta" type="submit"><LockKeyhole size={14} /> Change password</button>
            </form>
          {/if}
          {#if form?.section === 'password'}
            <p class="form-note" class:ok={form.success} role={form.success ? 'status' : 'alert'}>{form.message}</p>
          {/if}
        </div>
      </section>
    {/if}

    <!-- EXPERIENCE — playback & interface -->
    <section class="account-section" aria-labelledby="experience-title">
      <div class="section-title-row">
        <span class="section-icon" aria-hidden="true"><Sparkles size={14} /></span>
        <h2 id="experience-title">Playback &amp; interface</h2>
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
        <div class="group-label" role="presentation">Interface</div>
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

    <!-- CONTENT — Adult Mode (server-authoritative; only when available) -->
    {#if adultAvailable}
      <section class="account-section" aria-labelledby="adult-title">
        <div class="section-title-row">
          <span class="section-icon" aria-hidden="true"><ShieldCheck size={14} /></span>
          <h2 id="adult-title">Adult Mode</h2>
        </div>
        <div class="toggle-list">
          <label class="toggle-row">
            <span class="toggle-copy">
              <strong>Enable Adult Mode</strong>
              <small>Show the Indian Adult Shows section and adult content in search results.</small>
            </span>
            <span class="toggle-switch">
              <input type="checkbox" checked={adultEnabled} disabled={adultLoading} onchange={toggleAdultMode} />
              <i aria-hidden="true"></i>
            </span>
          </label>
        </div>
      </section>
    {/if}

    <!-- LIBRARY — real summary values -->
    <section class="account-section" aria-labelledby="library-title">
      <div class="section-title-row">
        <span class="section-icon" aria-hidden="true"><Cloud size={14} /></span>
        <h2 id="library-title">Your library</h2>
      </div>
      <div class="stat-strip">
        <div class="stat-cell">
          <span class="stat-label">My List</span>
          <strong>{loaded ? `${favoriteCount} ${favoriteCount === 1 ? 'title' : 'titles'}` : '…'}</strong>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Watch time</span>
          <strong>{loaded ? watchedLabel : '…'}</strong>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Sync</span>
          <strong>{isAuthenticated ? 'Cloud' : 'Guest'}</strong>
          <small>{isAuthenticated ? 'Account synced' : 'Local-only profile'}</small>
        </div>
      </div>
    </section>

    <!-- ABOUT — compact -->
    <section class="account-section" aria-labelledby="about-title">
      <div class="section-title-row">
        <span class="section-icon" aria-hidden="true"><Info size={14} /></span>
        <h2 id="about-title">About</h2>
      </div>
      <div class="about-list">
        <div class="about-row"><span>Application</span><strong>Mavero</strong></div>
        <div class="about-row"><span>Category</span><strong>Movies, series &amp; anime</strong></div>
        <div class="about-row"><span>Data source</span><strong>TMDB</strong></div>
        <div class="about-row">
          <span>Attribution</span>
          <a class="tmdb-link" href="https://www.themoviedb.org/about/logos-attribution?language=en-US" target="_blank" rel="noreferrer">
            <img class="tmdb-logo" src="https://upload.wikimedia.org/wikipedia/commons/8/89/Tmdb.new.logo.svg" alt="The Movie Database" />
          </a>
        </div>
      </div>
    </section>

    <!-- CineLog — compact promotion near the session footer -->
    <section class="cinelog-strip" aria-label="Try CineLog">
      <div class="cinelog-copy">
        <div class="cinelog-eyebrow"><Sparkles size={11} /> Try CineLog</div>
        <p>Your watch history, beautifully organized — movies, shows &amp; anime in one vault.</p>
      </div>
      <a class="cinelog-cta" href="https://cinelogv2.vercel.app" target="_blank" rel="noreferrer">Explore <Sparkles size={12} /></a>
    </section>

    {#if data.user}
      <!-- ACCOUNT — session -->
      <section class="account-section session-section" aria-labelledby="session-title">
        <div class="section-title-row">
          <span class="section-icon" aria-hidden="true"><LogOut size={14} /></span>
          <h2 id="session-title">Session</h2>
        </div>
        <button type="button" class="signout-btn" onclick={openSignout}>
          <LogOut size={14} /> <span>Sign out</span>
        </button>
      </section>

      <!-- DANGER ZONE -->
      <section class="danger-zone" aria-labelledby="danger-title">
        <div class="section-title-row">
          <span class="section-icon danger-icon" aria-hidden="true"><Trash2 size={14} /></span>
          <h2 id="danger-title">Delete account</h2>
        </div>
        <p class="danger-copy">Permanently delete your account and personal data. This cannot be undone.</p>
        <button class="delete-account-btn" type="button" onclick={openDelete} disabled={deleteBusy}>
          <Trash2 size={13} /> Delete account
        </button>
      </section>

      {#if deleteSuccess}
        <div class="form-note ok global-note" role="status"><Check size={13} /> Account deleted successfully. Returning to Discover…</div>
      {/if}
    {/if}

    <AppFooter />
  </div>
</div>

<ConfirmDialog open={signoutOpen} eyebrow="MAVERO / Sign out" title="Sign out?" description="Are you sure you want to sign out of Mavero?" primaryLabel={signoutBusy ? 'Signing out…' : 'Sign out'} primaryDisabled={signoutBusy} cancelDisabled={signoutBusy} onCancel={closeSignout} onPrimary={confirmSignout}>
  {#if signoutError}<p class="dialog-error" role="alert">{signoutError}</p>{/if}
</ConfirmDialog>

<ConfirmDialog open={deleteStep === 'initial'} eyebrow="MAVERO / Danger zone" title="Delete your account?" description="This will permanently delete your Mavero account and associated personal data. This action cannot be undone." primaryLabel="Continue" tone="danger" onCancel={closeDelete} onPrimary={continueDelete} />
<ConfirmDialog open={deleteStep === 'final'} eyebrow="MAVERO / Final confirmation" title="Confirm account deletion" description="To permanently delete your account, type DELETE below. This final action cannot be undone." primaryLabel={deleteBusy ? 'Deleting…' : 'Delete account'} primaryDisabled={deleteBusy || deleteConfirmation !== 'DELETE'} cancelDisabled={deleteBusy} tone="danger" onCancel={closeDelete} onPrimary={deleteAccount}>
  <label class="delete-confirm-label" for="delete-confirmation">Type <code>DELETE</code> to continue</label>
  <input id="delete-confirmation" class="delete-confirm-input" type="text" bind:value={deleteConfirmation} autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="delete-confirmation-help" disabled={deleteBusy} />
  <small id="delete-confirmation-help" class="delete-confirm-help">The text is case-sensitive.</small>
  {#if deleteError}<p class="dialog-error" role="alert">{deleteError}</p>{/if}
</ConfirmDialog>

<ScrollToTop />

<style>
  .account-page {
    --a-gutter: clamp(16px, 4vw, 40px);
    min-height: calc(100dvh - 76px);
    /* Reserved space so the floating 5-item mobile nav never covers content. */
    padding-bottom: calc(110px + env(safe-area-inset-bottom, 0px));
  }

  /* ── Compact identity header ── */
  .account-top {
    padding: 18px var(--a-gutter) 16px;
    border-bottom: 1px solid rgba(255,255,255,.05);
    background:
      radial-gradient(circle at 88% -40%, rgba(255,255,255,.045), transparent 46%),
      #000;
  }
  .top-inner { width: min(800px, 100%); margin-inline: auto; }
  .page-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    color: #77777f;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .identity-row {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
  }
  .avatar {
    display: grid; place-items: center;
    width: 44px; height: 44px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,.12);
    color: #f5f5f5;
    background:
      radial-gradient(circle at 30% 25%, rgba(255,255,255,.1), transparent 50%),
      rgba(255,255,255,.04);
    font-size: .95rem; font-weight: 800;
    letter-spacing: .02em;
  }
  .identity-copy { min-width: 0; }
  .identity-copy h1 {
    margin: 0;
    color: #f5f5f5;
    font-size: 1.14rem; font-weight: 800;
    letter-spacing: -.015em;
    line-height: 1.15;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .identity-email {
    margin: 3px 0 0;
    color: #c7c7cc;
    font-size: .76rem; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .identity-meta {
    display: inline-flex; align-items: center; gap: 6px;
    margin: 6px 0 0;
    color: #77777f;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .identity-meta > span {
    width: 6px; height: 6px; border-radius: 50%;
    background: #ffb020;
    flex: 0 0 auto;
  }
  .identity-meta > span.online { background: #35d68f; box-shadow: 0 0 0 3px rgba(53,214,143,.18); }
  .identity-meta > span.syncing { background: #c7c7cc; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }
  .sign-in-cta {
    grid-column: 1 / -1;
    justify-self: start;
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 999px;
    color: #000;
    background: #f5f5f5;
    font-size: .74rem; font-weight: 700;
    text-decoration: none;
    box-shadow: 0 4px 18px rgba(255,255,255,.1);
    transition: transform 180ms cubic-bezier(.22,1,.36,1);
  }
  .sign-in-cta:hover { transform: translateY(-1px); }
  .sign-in-cta:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }
  /* From 560px the sign-in CTA joins the identity row instead of
     spending a full extra header row below it. */
  @media (min-width: 560px) {
    .identity-row { grid-template-columns: auto 1fr auto; }
    .sign-in-cta { grid-column: auto; justify-self: end; }
  }

  /* ── Body ── */
  .account-body {
    width: min(800px, calc(100% - 2 * var(--a-gutter)));
    margin-inline: auto;
    padding-top: 12px;
  }

  .error-banner {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 12px;
    align-items: center;
    padding: 12px 14px;
    margin-bottom: 12px;
    border: 1px solid rgba(255,176,32,.22);
    border-radius: 12px;
    background: rgba(255,176,32,.04);
    color: #f5f5f5;
    font-size: .74rem;
  }
  .error-banner strong { color: #ffb020; font-weight: 800; }
  .error-banner span { color: #b7b7bd; }
  .error-banner button {
    padding: 6px 13px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.06);
    font: inherit;
    font-size: .68rem; font-weight: 700;
    cursor: pointer;
  }
  .error-banner button:hover { background: rgba(255,255,255,.12); }

  /* ── Sections: single-level, compact outlined groups ── */
  .account-section {
    margin-top: 12px;
    padding: 13px 14px 15px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 12px;
  }
  .section-title-row {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 2px;
  }
  /* Plain inline glyph — the boxed chip read as decorative bulk. */
  .section-icon {
    display: inline-flex; align-items: center;
    color: #8a8a92;
    flex: 0 0 auto;
  }
  .section-icon :global(svg) { display: block; }
  .section-title-row h2 {
    margin: 0;
    color: #f5f5f5;
    font-size: .9rem; font-weight: 800;
    letter-spacing: -.01em;
  }

  /* ── Forms ── */
  .inline-form {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    gap: 8px;
    padding: 10px 0 2px;
    border-top: 1px solid rgba(255,255,255,.05);
  }
  .account-section .inline-form:first-of-type { border-top: 0; }
  .field { display: grid; gap: 5px; min-width: 0; }
  .field-label {
    color: #77777f;
    font-size: .56rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .inline-form input {
    width: 100%; box-sizing: border-box;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 10px;
    color: #f5f5f5;
    background: rgba(255,255,255,.03);
    font: inherit;
    font-size: .84rem;
    outline: 0;
    transition: border-color 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1);
  }
  .inline-form input:focus { border-color: rgba(255,255,255,.28); background: rgba(255,255,255,.06); }
  .inline-form input::placeholder { color: #55555d; }
  .form-note {
    grid-column: 1 / -1;
    display: flex; align-items: center; gap: 6px;
    margin: 0;
    color: #ffb020;
    font-size: .72rem; line-height: 1.45;
  }
  .form-note.ok { color: #35d68f; }

  /* Password disclosure */
  .password-block { border-top: 1px solid rgba(255,255,255,.05); margin-top: 2px; padding-top: 10px; }
  .password-summary {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .password-copy { display: grid; gap: 3px; min-width: 0; }
  .password-copy strong { color: #f5f5f5; font-size: .82rem; font-weight: 700; }
  .password-copy small { color: #77777f; font-size: .7rem; }
  .password-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  #password-form { border-top: 0; padding-top: 10px; }

  /* ── Buttons ── */
  .secondary-cta {
    display: inline-flex; align-items: center; gap: 6px;
    justify-self: end;
    min-height: 40px;
    padding: 0 15px;
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.14);
    font: inherit;
    font-size: .74rem; font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    transition: transform 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1), border-color 180ms cubic-bezier(.22,1,.36,1);
  }
  .secondary-cta:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.24); }
  .secondary-cta:active { transform: scale(.98); }
  .secondary-cta:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }

  /* ── Toggles ── */
  .toggle-list { display: grid; margin-top: 2px; }
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    padding: 10px 0;
    border-top: 1px solid rgba(255,255,255,.05);
    cursor: pointer;
  }
  .toggle-row:first-child { border-top: 0; padding-top: 4px; }
  .toggle-copy { display: grid; gap: 3px; min-width: 0; }
  .toggle-copy strong { color: #f5f5f5; font-size: .8rem; font-weight: 700; }
  .toggle-copy small { color: #77777f; font-size: .7rem; line-height: 1.45; }
  .group-label {
    padding: 10px 0 2px;
    color: #c7c7cc;
    font-size: .56rem; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase;
  }
  .group-label + .toggle-row { border-top: 0; padding-top: 4px; }
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

  /* ── Library stat strip — flat columns, no nested card ── */
  .stat-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-top: 8px;
  }
  .stat-cell {
    display: grid; gap: 3px;
    padding: 8px 12px;
    border-left: 1px solid rgba(255,255,255,.05);
    min-width: 0;
  }
  .stat-cell:first-child { border-left: 0; padding-left: 0; }
  .stat-label {
    color: #77777f;
    font-size: .56rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
    white-space: nowrap;
  }
  .stat-cell strong {
    color: #f5f5f5;
    font-size: .95rem; font-weight: 800;
    letter-spacing: -.01em;
    line-height: 1;
    white-space: nowrap;
  }
  .stat-cell small { color: #77777f; font-size: .62rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ── About ── */
  .about-list { margin-top: 2px; }
  .about-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 8px 0;
    border-top: 1px solid rgba(255,255,255,.05);
    font-size: .78rem;
  }
  .about-row:first-child { border-top: 0; }
  .about-row span { color: #77777f; font-size: .7rem; }
  .about-row strong { color: #f5f5f5; font-weight: 700; }
  .tmdb-link { display: inline-flex; align-items: center; }
  .tmdb-logo { width: 38px; height: 27px; object-fit: contain; }

  /* ── CineLog compact strip ── */
  .cinelog-strip {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-top: 12px;
    padding: 12px 14px;
    border: 1px solid rgba(255,255,255,.07);
    border-radius: 12px;
    background:
      radial-gradient(circle at 0% 0%, rgba(255,255,255,.035), transparent 55%),
      rgba(255,255,255,.012);
  }
  .cinelog-eyebrow {
    display: inline-flex; align-items: center; gap: 5px;
    color: #c7c7cc;
    font-size: .56rem; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase;
  }
  .cinelog-copy p {
    margin: 4px 0 0;
    color: #b7b7bd;
    font-size: .72rem; line-height: 1.45;
  }
  .cinelog-cta {
    display: inline-flex; align-items: center; gap: 5px;
    flex: 0 0 auto;
    min-height: 38px;
    padding: 0 14px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.05);
    font-size: .72rem; font-weight: 700;
    text-decoration: none;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .cinelog-cta:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.24); }
  .cinelog-cta:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }

  /* ── Session + danger ── */
  .signout-btn {
    display: inline-flex; align-items: center; gap: 7px;
    margin-top: 8px;
    min-height: 40px;
    padding: 0 16px;
    border: 1px solid rgba(255,176,32,.28);
    border-radius: 999px;
    color: #ffb020;
    background: rgba(255,176,32,.05);
    font: inherit;
    font-size: .74rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease, color 180ms ease;
  }
  .signout-btn:hover { background: rgba(255,176,32,.12); border-color: rgba(255,176,32,.5); color: #ffd17a; }
  .signout-btn:active { transform: scale(.98); }
  .signout-btn:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }

  .danger-zone {
    margin-top: 12px;
    padding: 13px 14px 15px;
    border: 1px solid rgba(255,176,32,.22);
    border-radius: 12px;
    background: rgba(255,176,32,.025);
  }
  .danger-icon { color: #ffb020; }
  .danger-copy {
    margin: 6px 0 0;
    color: #77777f;
    font-size: .7rem; line-height: 1.5;
  }
  .delete-account-btn {
    margin-top: 10px;
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 40px;
    padding: 0 14px;
    border: 1px solid rgba(255,176,32,.35);
    border-radius: 999px;
    color: #ffb020;
    background: rgba(255,176,32,.05);
    font: inherit;
    font-size: .72rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease, color 180ms ease;
  }
  .delete-account-btn:hover:not(:disabled) { background: rgba(255,176,32,.12); border-color: rgba(255,176,32,.55); color: #ffd17a; }
  .delete-account-btn:disabled { opacity: .5; cursor: not-allowed; }
  .delete-account-btn:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }

  .global-note { margin-top: 12px; }

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
    letter-spacing: .12em;
    font-weight: 800;
  }
  .delete-confirm-input:focus { border-color: rgba(255,255,255,.28); }
  .delete-confirm-help {
    display: block; margin-top: 7px;
    color: #77777f;
    font-size: .64rem;
  }
  .dialog-error { margin: 12px 0 0; color: #ffb020; font-size: .72rem; line-height: 1.45; }

  /* ── Responsive ── */
  @media (max-width: 560px) {
    .password-fields { grid-template-columns: 1fr; }
    .stat-cell { padding: 8px 10px; }
    .stat-cell:first-child { padding-left: 0; }
    .stat-cell strong { font-size: .9rem; }
  }
  @media (min-width: 900px) {
    .account-top { padding-top: 26px; }
    .avatar { width: 52px; height: 52px; font-size: 1.02rem; }
    .identity-copy h1 { font-size: 1.26rem; }
    .account-section { padding: 15px 18px 17px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .sign-in-cta, .secondary-cta, .toggle-switch i, .toggle-switch i::after, .signout-btn, .delete-account-btn, .cinelog-cta, .identity-meta > span.syncing { transition: none; animation: none; }
  }
</style>
