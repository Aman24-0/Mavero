<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Cloud, Info, LockKeyhole, LogIn, LogOut, Mail, Monitor, ShieldCheck, Smartphone, Sparkles, Trash2, Tv, UserRound, Laptop, LoaderCircle } from 'lucide-svelte';
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
  import { showSuccessToast, showErrorToast } from '$lib/client/toast.svelte';

  let { data, form }: { data: PageData; form?: { section?: string; success?: boolean; message?: string } } = $props();

  // ── Identity (migrated from Profile) ────────────────────────────
  // Phase 2-B: the layout payload is now a projection — no full Supabase
  // User object is serialized to the client. We read the projected
  // `displayName` / `email` fields directly.
  const displayName = $derived(data.user?.displayName ?? '');
  const userEmail = $derived(data.user?.email ?? '');
  let isAuthenticated = $derived(data.isAuthenticated);

  function accountName() {
    return data.user?.displayName ?? (data.user?.email ? data.user.email.split('@')[0] : 'Guest');
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

  // Phase 2-J (audit UIX-1): the previous "Playback & interface" settings
  // section (autoplay / autoResume / reducedMotion) was DEAD — written to
  // localStorage('mavero.settings') but never read by any runtime code
  // (verified via repo-wide grep). The audit requires that dead controls
  // either be wired into actual behavior or removed. Wiring them would
  // require new player-shell behavior changes (out of Phase 2 scope); a
  // fake setting is worse than no setting, so the entire section + the
  // localStorage persistence helpers were removed. Adult Mode (the other
  // toggle on this page) is server-authoritative and remains intact.

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

  // ── Device sessions (Phase 2) ──────────────────────────────────
  type SessionInfo = {
    id: string;
    deviceType: string;
    deviceName: string;
    browser: string | null;
    os: string | null;
    platform: string | null;
    createdAt: string;
    lastSeenAt: string;
    isCurrent: boolean;
  };
  let sessions = $state<SessionInfo[]>([]);
  let sessionsLoading = $state(false);
  let sessionsError = $state('');
  let revokeTarget = $state<SessionInfo | null>(null);
  let revokeBusy = $state(false);

  function relativeTime(iso: string): string {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diff = now - then;
    if (diff < 60_000) return 'Active now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} minute${Math.floor(diff / 60_000) === 1 ? '' : 's'} ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} hour${Math.floor(diff / 3600_000) === 1 ? '' : 's'} ago`;
    if (diff < 172800_000) return 'Yesterday';
    return new Date(iso).toLocaleDateString();
  }

  function deviceIcon(type: string) {
    if (type === 'mobile') return Smartphone;
    if (type === 'tablet') return Smartphone;
    if (type === 'tv') return Tv;
    if (type === 'desktop') return Monitor;
    return Laptop;
  }

  async function loadSessions() {
    if (!data.isAuthenticated) return;
    sessionsLoading = true;
    sessionsError = '';
    try {
      const res = await fetch('/api/account/sessions', { headers: { accept: 'application/json' } });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        sessionsError = payload.message ?? 'Unable to load sessions.';
        sessions = [];
      } else {
        sessions = payload.sessions ?? [];
      }
    } catch {
      sessionsError = 'Unable to load sessions. Please try again.';
      sessions = [];
    } finally {
      sessionsLoading = false;
    }
  }

  function openRevoke(session: SessionInfo) {
    if (session.isCurrent) return;
    revokeTarget = session;
    haptic('light');
  }

  function closeRevoke() {
    revokeTarget = null;
  }

  async function confirmRevoke() {
    if (!revokeTarget || revokeBusy) return;
    revokeBusy = true;
    try {
      const res = await fetch('/api/account/sessions/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: revokeTarget.id }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        showErrorToast(payload.message ?? 'Unable to revoke the session.');
      } else {
        showSuccessToast('Session revoked.');
        // Remove the revoked session from the local list immediately.
        sessions = sessions.filter((s) => s.id !== revokeTarget!.id);
        haptic('success');
      }
    } catch {
      showErrorToast('Unable to revoke the session. Please try again.');
    } finally {
      revokeBusy = false;
      revokeTarget = null;
    }
  }

  // ── Sign out all other devices (Phase 3) ──────────────────────
  let signoutAllOpen = $state(false);
  let signoutAllBusy = $state(false);
  let signoutAllError = $state('');

  function openSignoutAll() {
    signoutAllError = '';
    signoutAllOpen = true;
    haptic('light');
  }

  function closeSignoutAll() {
    if (!signoutAllBusy) signoutAllOpen = false;
  }

  async function confirmSignoutAll() {
    if (signoutAllBusy) return;
    signoutAllBusy = true;
    signoutAllError = '';
    try {
      const res = await fetch('/api/account/sessions/revoke-all', {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        signoutAllError = payload.message ?? 'Unable to sign out other devices.';
        signoutAllBusy = false;
        return;
      }
      // Success — refresh the session list from the server so the
      // current device remains visible (marked "This device") and
      // all other devices are gone.
      showSuccessToast(payload.message ?? 'Signed out of other devices.');
      haptic('success');
      signoutAllOpen = false;
      await loadSessions();
    } catch {
      signoutAllError = 'Unable to sign out other devices. Please try again.';
    } finally {
      signoutAllBusy = false;
    }
  }

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
    // Phase 2-J (audit UIX-1): the dead mavero.settings localStorage load
    // was removed (autoplay / autoResume / reducedMotion toggles were
    // never read by runtime code). Adult Mode loads via loadAdultMode below.
    void loadLocalState();
    void loadSessions();
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

    <!-- Phase 2-J (audit UIX-1): the previous "Playback & interface" section
         (autoplay / autoResume / reducedMotion toggles) was removed — the
         settings were persisted to localStorage('mavero.settings') but never
         read by any runtime code (verified via repo-wide grep). Wiring them
         would require new player-shell behavior changes (out of Phase 2
         scope); a fake setting is worse than no setting. The Adult Mode
         section below remains intact — it's server-authoritative. -->

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
      <!-- ACCOUNT — device sessions (Phase 2) -->
      <section class="account-section" aria-labelledby="sessions-title">
        <div class="section-title-row">
          <span class="section-icon" aria-hidden="true"><Monitor size={14} /></span>
          <h2 id="sessions-title">Devices &amp; Sessions</h2>
        </div>

        {#if sessionsLoading}
          <div class="sessions-loading" role="status" aria-live="polite">
            <LoaderCircle size={16} class="spin" /> Loading sessions…
          </div>
        {:else if sessionsError}
          <div class="sessions-error" role="alert">
            {sessionsError}
            <button class="retry-btn" type="button" onclick={loadSessions}>Retry</button>
          </div>
        {:else if sessions.length === 0}
          <div class="sessions-empty">
            No active sessions found.
          </div>
        {:else}
          <div class="session-list">
            {#each sessions as session (session.id)}
              {@const Icon = deviceIcon(session.deviceType)}
              <div class="session-card" class:current={session.isCurrent}>
                <div class="session-card-head">
                  <span class="session-icon" aria-hidden="true"><Icon size={16} /></span>
                  <div class="session-card-copy">
                    <strong class="session-card-name">{session.deviceName}</strong>
                    <span class="session-card-meta">
                      {[session.browser, session.os].filter(Boolean).join(' · ') || 'Unknown browser'}
                    </span>
                  </div>
                  {#if session.isCurrent}
                    <span class="current-badge">This device</span>
                  {/if}
                </div>
                <div class="session-card-foot">
                  <span class="session-time">{relativeTime(session.lastSeenAt)}</span>
                  {#if !session.isCurrent}
                    <button class="revoke-btn" type="button" onclick={() => openRevoke(session)} disabled={revokeBusy}>
                      Revoke
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Phase 3 — Sign out all OTHER devices. -->
        <!-- Only shown when there is at least one OTHER active session. -->
        {#if !sessionsLoading && !sessionsError && sessions.filter((s) => !s.isCurrent).length > 0}
          <div class="signout-all-row">
            <button type="button" class="signout-all-btn" onclick={openSignoutAll} disabled={signoutAllBusy}>
              <LogOut size={13} /> <span>Sign out all devices</span>
            </button>
          </div>
        {/if}
      </section>

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

<ConfirmDialog open={revokeTarget !== null} eyebrow="MAVERO / Sessions" title="Revoke this session?" description={revokeTarget ? `${revokeTarget.deviceName} will no longer have access to your account.` : ''} primaryLabel={revokeBusy ? 'Revoking…' : 'Revoke'} primaryDisabled={revokeBusy} cancelDisabled={revokeBusy} tone="danger" onCancel={closeRevoke} onPrimary={confirmRevoke} />

<ConfirmDialog open={signoutAllOpen} eyebrow="MAVERO / Sessions" title="Sign out all other devices?" description="This will sign you out from every other device currently using Mavero. This device will remain signed in." primaryLabel={signoutAllBusy ? 'Signing out…' : 'Sign out all'} primaryDisabled={signoutAllBusy} cancelDisabled={signoutAllBusy} tone="danger" onCancel={closeSignoutAll} onPrimary={confirmSignoutAll}>
  {#if signoutAllError}<p class="dialog-error" role="alert">{signoutAllError}</p>{/if}
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
    border-bottom: 1px solid var(--color-border);
    background:
      radial-gradient(circle at 88% -40%, var(--color-primary-soft), transparent 46%),
      var(--color-bg);
  }
  .top-inner { width: min(800px, 100%); margin-inline: auto; }
  .page-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--color-primary);
    font-size: .58rem; font-weight: 800;
    letter-spacing: .14em; text-transform: uppercase;
    text-shadow: 0 0 10px rgba(0, 255, 156, .3);
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
    border: 1px solid var(--color-primary-border);
    color: var(--color-text);
    background:
      radial-gradient(circle at 30% 25%, var(--color-primary-soft), transparent 50%),
      var(--color-surface);
    box-shadow: var(--glow-primary);
    font-size: .95rem; font-weight: 800;
    letter-spacing: .02em;
  }
  .identity-copy { min-width: 0; }
  .identity-copy h1 {
    margin: 0;
    color: var(--color-text);
    font-size: 1.14rem; font-weight: 800;
    letter-spacing: -.015em;
    line-height: 1.15;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .identity-email {
    margin: 3px 0 0;
    color: var(--color-text-muted);
    font-size: .76rem; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .identity-meta {
    display: inline-flex; align-items: center; gap: 6px;
    margin: 6px 0 0;
    color: var(--color-text-muted);
    font-size: .58rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .identity-meta > span {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--color-warning);
    flex: 0 0 auto;
  }
  .identity-meta > span.online { background: var(--color-primary); box-shadow: 0 0 0 3px rgba(0,255,156,.18); }
  .identity-meta > span.syncing { background: var(--color-text-muted); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }
  .sign-in-cta {
    grid-column: 1 / -1;
    justify-self: start;
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 999px;
    color: #050708;
    background: var(--color-primary);
    font-size: .74rem; font-weight: 700;
    text-decoration: none;
    box-shadow: 0 4px 18px rgba(0,255,156,.22), var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .sign-in-cta:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .sign-in-cta:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
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
    border: 1px solid rgba(255,194,71,.22);
    border-radius: var(--radius-md);
    background: rgba(255,194,71,.04);
    color: var(--color-text);
    font-size: .74rem;
  }
  .error-banner strong { color: var(--color-warning); font-weight: 800; }
  .error-banner span { color: var(--color-text-muted); }
  .error-banner button {
    padding: 6px 13px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    color: var(--color-text);
    background: var(--color-primary-soft);
    font: inherit;
    font-size: .68rem; font-weight: 700;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .error-banner button:hover { background: var(--color-primary-soft); border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .error-banner button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Sections: single-level, compact outlined groups ── */
  .account-section {
    margin-top: 12px;
    padding: 13px 14px 15px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .section-title-row {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 2px;
  }
  /* Plain inline glyph — the boxed chip read as decorative bulk. */
  .section-icon {
    display: inline-flex; align-items: center;
    color: var(--color-text-muted);
    flex: 0 0 auto;
  }
  .section-icon :global(svg) { display: block; }
  .section-title-row h2 {
    margin: 0;
    color: var(--color-text);
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
    border-top: 1px solid var(--color-border);
  }
  .account-section .inline-form:first-of-type { border-top: 0; }
  .field { display: grid; gap: 5px; min-width: 0; }
  .field-label {
    color: var(--color-text-muted);
    font-size: .56rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .inline-form input {
    width: 100%; box-sizing: border-box;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    background: var(--color-surface-elevated);
    font: inherit;
    font-size: .84rem;
    outline: 0;
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .inline-form input:focus { border-color: var(--color-primary); background: var(--color-surface-raised); box-shadow: var(--glow-primary); }
  .inline-form input::placeholder { color: var(--color-text-deep); }
  .form-note {
    grid-column: 1 / -1;
    display: flex; align-items: center; gap: 6px;
    margin: 0;
    color: var(--color-warning);
    font-size: .72rem; line-height: 1.45;
  }
  .form-note.ok { color: var(--color-primary); }

  /* Password disclosure */
  .password-block { border-top: 1px solid var(--color-border); margin-top: 2px; padding-top: 10px; }
  .password-summary {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .password-copy { display: grid; gap: 3px; min-width: 0; }
  .password-copy strong { color: var(--color-text); font-size: .82rem; font-weight: 700; }
  .password-copy small { color: var(--color-text-muted); font-size: .7rem; }
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
    color: var(--color-text);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-border-strong);
    font: inherit;
    font-size: .74rem; font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    transition: transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .secondary-cta:hover { background: var(--color-primary-soft); border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .secondary-cta:active { transform: scale(.98); }
  .secondary-cta:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Toggles ── */
  .toggle-list { display: grid; margin-top: 2px; }
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    padding: 10px 0;
    border-top: 1px solid var(--color-border);
    cursor: pointer;
  }
  .toggle-row:first-child { border-top: 0; padding-top: 4px; }
  .toggle-copy { display: grid; gap: 3px; min-width: 0; }
  .toggle-copy strong { color: var(--color-text); font-size: .8rem; font-weight: 700; }
  .toggle-copy small { color: var(--color-text-muted); font-size: .7rem; line-height: 1.45; }
  /* Phase 2-J: the .group-label rule was removed — the only consumer was
     the dead "Playback & interface" section (the "Interface" sub-group
     label inside it). When a future section needs a sub-group label, restore
     this rule with its consumer. */
  .toggle-switch { position: relative; flex: 0 0 auto; }
  .toggle-switch input { position: absolute; opacity: 0; pointer-events: none; }
  .toggle-switch i {
    position: relative; display: block;
    width: 42px; height: 24px;
    border-radius: 999px;
    background: var(--color-surface-raised);
    transition: background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .toggle-switch i::after {
    content: ''; position: absolute;
    top: 3px; left: 3px;
    width: 18px; height: 18px;
    border-radius: 50%;
    background: var(--color-text);
    transition: transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  }
  .toggle-switch input:checked + i { background: var(--color-primary); box-shadow: var(--glow-primary); }
  .toggle-switch input:checked + i::after { transform: translateX(18px); background: #050708; }
  .toggle-switch input:focus-visible + i { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Library stat strip — flat columns, no nested card ── */
  .stat-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-top: 8px;
  }
  .stat-cell {
    display: grid; gap: 3px;
    padding: 8px 12px;
    border-left: 1px solid var(--color-border);
    min-width: 0;
  }
  .stat-cell:first-child { border-left: 0; padding-left: 0; }
  .stat-label {
    color: var(--color-text-muted);
    font-size: .56rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
    white-space: nowrap;
  }
  .stat-cell strong {
    color: var(--color-text);
    font-size: .95rem; font-weight: 800;
    letter-spacing: -.01em;
    line-height: 1;
    white-space: nowrap;
  }
  .stat-cell small { color: var(--color-text-muted); font-size: .62rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ── About ── */
  .about-list { margin-top: 2px; }
  .about-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 8px 0;
    border-top: 1px solid var(--color-border);
    font-size: .78rem;
  }
  .about-row:first-child { border-top: 0; }
  .about-row span { color: var(--color-text-muted); font-size: .7rem; }
  .about-row strong { color: var(--color-text); font-weight: 700; }
  .tmdb-link { display: inline-flex; align-items: center; }
  .tmdb-logo { width: 38px; height: 27px; object-fit: contain; }

  /* ── CineLog compact strip ── */
  .cinelog-strip {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-top: 12px;
    padding: 12px 14px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background:
      radial-gradient(circle at 0% 0%, var(--color-secondary-soft), transparent 55%),
      var(--color-surface);
  }
  .cinelog-eyebrow {
    display: inline-flex; align-items: center; gap: 5px;
    color: var(--color-secondary);
    font-size: .56rem; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase;
  }
  .cinelog-copy p {
    margin: 4px 0 0;
    color: var(--color-text-muted);
    font-size: .72rem; line-height: 1.45;
  }
  .cinelog-cta {
    display: inline-flex; align-items: center; gap: 5px;
    flex: 0 0 auto;
    min-height: 38px;
    padding: 0 14px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    color: var(--color-text);
    background: var(--color-primary-soft);
    font-size: .72rem; font-weight: 700;
    text-decoration: none;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .cinelog-cta:hover { background: var(--color-primary-soft); border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .cinelog-cta:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ── Session + danger ── */
  .signout-btn {
    display: inline-flex; align-items: center; gap: 7px;
    margin-top: 8px;
    min-height: 40px;
    padding: 0 16px;
    border: 1px solid rgba(255,194,71,.28);
    border-radius: 999px;
    color: var(--color-warning);
    background: rgba(255,194,71,.05);
    font: inherit;
    font-size: .74rem; font-weight: 700;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  }
  .signout-btn:hover { background: rgba(255,194,71,.12); border-color: rgba(255,194,71,.5); color: #ffd17a; }
  .signout-btn:active { transform: scale(.98); }
  .signout-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .danger-zone {
    margin-top: 12px;
    padding: 13px 14px 15px;
    border: 1px solid rgba(255,194,71,.22);
    border-radius: var(--radius-md);
    background: rgba(255,194,71,.025);
  }
  .danger-icon { color: var(--color-warning); }
  .danger-copy {
    margin: 6px 0 0;
    color: var(--color-text-muted);
    font-size: .7rem; line-height: 1.5;
  }
  .delete-account-btn {
    margin-top: 10px;
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 40px;
    padding: 0 14px;
    border: 1px solid rgba(255,194,71,.35);
    border-radius: 999px;
    color: var(--color-warning);
    background: rgba(255,194,71,.05);
    font: inherit;
    font-size: .72rem; font-weight: 700;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  }
  .delete-account-btn:hover:not(:disabled) { background: rgba(255,194,71,.12); border-color: rgba(255,194,71,.55); color: #ffd17a; }
  .delete-account-btn:disabled { opacity: .5; cursor: not-allowed; }
  .delete-account-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .global-note { margin-top: 12px; }

  .delete-confirm-label {
    display: block; color: var(--color-text-muted);
    font-size: .72rem; font-weight: 700;
  }
  .delete-confirm-label code {
    color: var(--color-warning);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    letter-spacing: .14em;
    font-weight: 800;
  }
  .delete-confirm-input {
    margin-top: 8px;
    width: 100%; box-sizing: border-box;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    background: var(--color-surface-elevated);
    font: inherit;
    font-size: .84rem;
    outline: 0;
    letter-spacing: .12em;
    font-weight: 800;
  }
  .delete-confirm-input:focus { border-color: var(--color-primary); box-shadow: var(--glow-primary); }
  .delete-confirm-help {
    display: block; margin-top: 7px;
    color: var(--color-text-muted);
    font-size: .64rem;
  }
  .dialog-error { margin: 12px 0 0; color: var(--color-warning); font-size: .72rem; line-height: 1.45; }

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
  /* Large desktop / TV — wider body so the sectioned form layout has room. */
  @media (min-width: 1900px) {
    .account-body { width: min(1100px, calc(100% - 2 * var(--a-gutter))); }
    .top-inner { width: min(1100px, 100%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .sign-in-cta, .secondary-cta, .toggle-switch i, .toggle-switch i::after, .signout-btn, .delete-account-btn, .cinelog-cta, .identity-meta > span.syncing { transition: none; animation: none; }
  }

  /* ── Device sessions (Phase 2) ── */
  .sessions-loading { display: flex; align-items: center; gap: 8px; padding: 16px 0; color: var(--color-text-muted); font-size: .76rem; }
  .sessions-loading :global(svg.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sessions-error { display: flex; align-items: center; gap: 10px; padding: 12px 0; color: var(--color-warning); font-size: .74rem; }
  .retry-btn { border: 1px solid var(--color-border-strong); border-radius: 999px; padding: 4px 12px; background: var(--color-primary-soft); color: var(--color-text); font: inherit; font-size: .68rem; font-weight: 700; cursor: pointer; }
  .retry-btn:hover { border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .retry-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .sessions-empty { padding: 16px 0; color: var(--color-text-deep); font-size: .74rem; }

  .session-list { display: grid; gap: 8px; margin-top: 8px; }
  .session-card {
    display: grid; gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-elevated);
    transition: border-color var(--motion-fast) var(--ease-out);
  }
  .session-card.current { border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .session-card-head {
    display: flex; align-items: center; gap: 10px; min-width: 0;
  }
  .session-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; color: var(--color-primary); background: var(--color-primary-soft); border: 1px solid var(--color-primary-border); flex: 0 0 auto; }
  .session-card-copy { min-width: 0; flex: 1; }
  .session-card-name { display: block; color: var(--color-text); font-size: .78rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-card-meta { display: block; margin-top: 2px; color: var(--color-text-deep); font-size: .62rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .current-badge {
    display: inline-flex; align-items: center;
    padding: 3px 9px; border-radius: 999px;
    color: #050708; background: var(--color-primary);
    font-size: .5rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
    flex: 0 0 auto;
  }
  .session-card-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .session-time { color: var(--color-text-deep); font-size: .58rem; font-family: 'JetBrains Mono', ui-monospace, monospace; }
  .revoke-btn {
    display: inline-flex; align-items: center;
    min-height: 32px; padding: 0 12px;
    border: 1px solid rgba(255, 77, 109, .3); border-radius: 999px;
    color: var(--color-danger); background: transparent;
    font: inherit; font-size: .64rem; font-weight: 700; cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .revoke-btn:hover:not(:disabled) { background: rgba(255, 77, 109, .08); border-color: rgba(255, 77, 109, .5); }
  .revoke-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .revoke-btn:disabled { opacity: .5; cursor: not-allowed; }

  .signout-all-row { margin-top: 12px; display: flex; justify-content: flex-start; }
  .signout-all-btn {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 36px; padding: 0 16px;
    border: 1px solid var(--color-border-strong); border-radius: 999px;
    color: var(--color-text); background: transparent;
    font: inherit; font-size: .72rem; font-weight: 700; cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .signout-all-btn:hover:not(:disabled) { background: var(--color-surface-elevated); border-color: var(--color-danger, #ff4d6d); color: var(--color-danger, #ff4d6d); }
  .signout-all-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .signout-all-btn:disabled { opacity: .5; cursor: not-allowed; }
</style>
