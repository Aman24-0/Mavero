<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUpRight, Clock3, Heart, LogIn, LogOut, Settings2, ShieldCheck, Sparkles, UserRound } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';
  import { listFavoriteDeletions } from '$lib/client/progress/database';
  import { getLocalFavorites, getLocalProgressRecords } from '$lib/client/progress/service';
  import ConfirmDialog from '$components/ConfirmDialog.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import { favoriteToMedia } from '$lib/client/progress/presenter';
  import { syncAuthenticatedState, getSyncStatus, type SyncStatus } from '$lib/client/progress/cloud';
  import { mergeFavoritesWithProgress } from '$lib/shared/progress-merge';

  let { data }: { data: PageData } = $props();
  let favoriteItems = $state<MediaItem[]>([]);
  let watchedSeconds = $state(0);
  let loaded = $state(false);
  let errorMessage = $state('');
  let syncStatus = $state<SyncStatus>('pending');
  let signoutOpen = $state(false);
  let signoutBusy = $state(false);
  let signoutError = $state('');

  function accountName() {
    const metadata = data.user?.user_metadata;
    return typeof metadata?.display_name === 'string' && metadata.display_name.trim() ? metadata.display_name : data.user?.email?.split('@')[0] ?? 'Guest';
  }

  function accountEmail() {
    return data.user?.email ?? '';
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
      const response = await fetch('/auth/sign-out', { method: 'POST', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Sign out failed.');
      window.location.replace(response.url || '/discover');
    } catch {
      signoutBusy = false;
      signoutError = 'Unable to sign out right now. Please try again.';
    }
  }

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

  onMount(() => { void loadLocalState(); });
  let isAuthenticated = $derived(Boolean(data.user));
  let watchedLabel = $derived(watchedSeconds >= 3600 ? `${(watchedSeconds / 3600).toFixed(1)}h` : `${Math.round(watchedSeconds / 60)}m`);
  let favoriteCount = $derived(favoriteItems.length);
</script>

<svelte:head><title>Profile — Mavero</title><meta name="description" content="Manage your MAVERO profile and synced library." /><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="profile-page">
  <!-- Cinematic profile identity -->
  <header class="profile-hero">
    <div class="hero-inner">
      <div class="hero-eyebrow"><UserRound size={13} /> MAVERO / Your space</div>
      <div class="hero-grid">
        <div class="avatar" aria-hidden="true">{initials()}</div>
        <div class="identity-copy">
          <h1>{accountName()}</h1>
          {#if accountEmail()}
            <p class="identity-email">{accountEmail()}</p>
          {/if}
          <p class="identity-tagline">{isAuthenticated ? 'Your library follows you across devices.' : 'Pick up where you left off, or make room for something new.'}</p>
          <div class="identity-meta" aria-live="polite">
            <span class:online={syncStatus === 'synced'} class:syncing={syncStatus === 'syncing'}></span>
            {isAuthenticated ? syncStatusLabel(syncStatus) : 'Guest profile · Local library'}
          </div>
        </div>
        {#if !isAuthenticated}
          <a href="/auth/sign-in" class="sign-in-cta">
            <LogIn size={15} /> <span>Sign in to sync</span>
          </a>
        {:else}
          <span class="account-badge"><ShieldCheck size={13} /> Cloud account</span>
        {/if}
      </div>
    </div>
  </header>

  <div class="profile-body">
    {#if errorMessage}
      <section class="error-banner" role="alert">
        <strong>Your local library is resting.</strong>
        <span>{errorMessage}</span>
        <button type="button" onclick={loadLocalState}>Retry</button>
      </section>
    {/if}

    <!-- Personal / library summary -->
    <section class="stats-section" aria-labelledby="stats-heading">
      <div class="section-eyebrow"><Sparkles size={12} /> Library summary</div>
      <h2 id="stats-heading">Your Mavero, at a glance.</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon"><Heart size={16} /></div>
          <div class="stat-copy">
            <strong>{favoriteCount}</strong>
            <small>{isAuthenticated ? 'Synced My List' : 'Saved on this device'}</small>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon"><Clock3 size={16} /></div>
          <div class="stat-copy">
            <strong>{watchedLabel}</strong>
            <small>{isAuthenticated ? 'Watch time' : 'Watched locally'}</small>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon"><ShieldCheck size={16} /></div>
          <div class="stat-copy">
            <strong>{isAuthenticated ? 'Cloud' : 'Guest'}</strong>
            <small>{isAuthenticated ? 'Account synced' : 'Local-only profile'}</small>
          </div>
        </div>
      </div>
    </section>

    <!-- Single Settings shortcut — My List and Discover are already in the
         global bottom nav / sidebar, so they are intentionally not
         duplicated here as quick-action cards. -->
    <section class="actions-section" aria-labelledby="actions-heading">
      <div class="section-eyebrow"><Settings2 size={12} /> Quick action</div>
      <h2 id="actions-heading">Tune your experience.</h2>
      <div class="action-grid">
        <a class="action-card" href="/settings">
          <div class="action-icon"><Settings2 size={18} /></div>
          <div class="action-copy">
            <strong>Settings</strong>
            <small>Account, playback & data</small>
          </div>
          <ArrowUpRight size={16} class="action-arrow" />
        </a>
      </div>
    </section>

    <!-- CineLog discovery panel -->
    <section class="cinelog-panel" aria-labelledby="cinelog-heading">
      <div class="cinelog-icon"><Sparkles size={18} /></div>
      <div class="cinelog-copy">
        <div class="section-eyebrow">Try CineLog</div>
        <h2 id="cinelog-heading">Your watch history, beautifully organized.</h2>
        <p>CineLog is a movie tracker for movies, TV shows, and anime. Keep watching, planning, completed titles, and collections in one cinematic vault.</p>
      </div>
      <a class="cinelog-cta" href="https://cinelogv2.vercel.app" target="_blank" rel="noreferrer">Explore CineLog <ArrowUpRight size={15} /></a>
    </section>

    {#if isAuthenticated}
      <section class="danger-actions" aria-labelledby="account-actions-heading">
        <div class="section-eyebrow"><LogOut size={12} /> Account</div>
        <h2 id="account-actions-heading">Manage your session.</h2>
        <button type="button" class="signout-btn" onclick={openSignout}>
          <LogOut size={15} /> <span>Sign out</span>
        </button>
      </section>
    {/if}

    <footer class="profile-footer">
      <span class="footer-line">Mavero @2026</span>
      <a class="tmdb-credit" href="https://www.themoviedb.org/about/logos-attribution?language=en-US" target="_blank" rel="noreferrer">
        Data from <img class="tmdb-logo" src="https://upload.wikimedia.org/wikipedia/commons/8/89/Tmdb.new.logo.svg" alt="The Movie Database" />
      </a>
    </footer>
  </div>
</div>

<ConfirmDialog open={signoutOpen} eyebrow="MAVERO / Sign out" title="Sign out?" description="Are you sure you want to sign out of Mavero?" primaryLabel={signoutBusy ? 'Signing out…' : 'Sign out'} primaryDisabled={signoutBusy} cancelDisabled={signoutBusy} onCancel={closeSignout} onPrimary={confirmSignout}>
  {#if signoutError}<p class="dialog-error" role="alert">{signoutError}</p>{/if}
</ConfirmDialog>

<ScrollToTop />

<style>
  .profile-page {
    --p-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    padding-bottom: calc(110px + env(safe-area-inset-bottom, 0px));
  }

  /* Hero */
  .profile-hero {
    /* The shell already adds the topbar offset via --shell-content-top.
       We only add a deliberate per-page breathing room here. */
    padding: 28px var(--p-gutter) 30px;
    border-bottom: 1px solid rgba(255,255,255,.05);
    background:
      radial-gradient(circle at 88% -30%, rgba(255,255,255,.05), transparent 50%),
      radial-gradient(circle at 10% 20%, rgba(255,255,255,.03), transparent 40%),
      #000;
  }
  .hero-inner { width: min(1200px, 100%); margin-inline: auto; }
  .hero-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    color: #77777f;
    font-size: .6rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .hero-grid {
    display: grid;
    grid-template-columns: 88px 1fr auto;
    align-items: center;
    gap: 22px;
    margin-top: 14px;
  }
  .avatar {
    display: grid; place-items: center;
    width: 88px; height: 88px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,.12);
    color: #f5f5f5;
    background:
      radial-gradient(circle at 30% 25%, rgba(255,255,255,.1), transparent 50%),
      rgba(255,255,255,.04);
    font-size: 1.7rem; font-weight: 800;
    letter-spacing: .02em;
    box-shadow: 0 8px 30px rgba(0,0,0,.4);
  }
  .identity-copy h1 {
    margin: 0;
    color: #f5f5f5;
    font-size: clamp(1.7rem, 4vw, 2.6rem);
    font-weight: 800;
    letter-spacing: -.025em;
    line-height: 1.05;
    text-wrap: balance;
  }
  .identity-email {
    margin: 6px 0 0;
    color: #c7c7cc;
    font-size: .82rem;
    font-weight: 500;
  }
  .identity-tagline {
    margin: 6px 0 0;
    color: #b7b7bd;
    font-size: .82rem;
    line-height: 1.5;
    max-width: 480px;
  }
  .identity-meta {
    display: inline-flex; align-items: center; gap: 7px;
    margin-top: 14px;
    color: #77777f;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .identity-meta > span {
    width: 6px; height: 6px; border-radius: 50%;
    background: #ffb020;
  }
  .identity-meta > span.online { background: #35d68f; box-shadow: 0 0 0 3px rgba(53,214,143,.18); }
  .identity-meta > span.syncing { background: #c7c7cc; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }

  .sign-in-cta {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 11px 20px;
    border-radius: 999px;
    color: #000;
    background: #f5f5f5;
    font-size: .8rem; font-weight: 700;
    text-decoration: none;
    box-shadow: 0 4px 20px rgba(255,255,255,.12);
    transition: transform 200ms cubic-bezier(.22,1,.36,1);
  }
  .sign-in-cta:hover { transform: translateY(-1px); }
  .account-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 12px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 999px;
    color: #c7c7cc;
    font-size: .62rem; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase;
    background: rgba(255,255,255,.03);
  }

  /* Body */
  .profile-body {
    width: min(1200px, calc(100% - 2 * var(--p-gutter)));
    margin-inline: auto;
    padding-top: 32px;
  }

  .error-banner {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px 14px;
    align-items: center;
    padding: 14px 16px;
    margin-bottom: 22px;
    border: 1px solid rgba(255,176,32,.22);
    border-radius: 12px;
    background: rgba(255,176,32,.04);
    color: #f5f5f5;
    font-size: .78rem;
  }
  .error-banner strong { color: #ffb020; font-weight: 800; }
  .error-banner span { color: #b7b7bd; }
  .error-banner button {
    padding: 6px 14px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.06);
    font: inherit;
    font-size: .7rem; font-weight: 700;
    cursor: pointer;
  }
  .error-banner button:hover { background: rgba(255,255,255,.12); }

  /* Section primitives */
  .section-eyebrow {
    display: inline-flex; align-items: center; gap: 5px;
    color: #c7c7cc;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .12em; text-transform: uppercase;
  }
  .profile-body h2 {
    margin: 6px 0 16px;
    color: #f5f5f5;
    font-size: clamp(1.1rem, 2vw, 1.4rem);
    font-weight: 800;
    letter-spacing: -.015em;
  }

  /* Stats */
  .stats-section { margin-bottom: 36px; }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  .stat-card {
    display: flex; align-items: center; gap: 14px;
    padding: 18px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 14px;
    background: rgba(255,255,255,.015);
    transition: border-color 200ms cubic-bezier(.22,1,.36,1);
  }
  .stat-card:hover { border-color: rgba(255,255,255,.14); }
  .stat-icon {
    display: grid; place-items: center;
    width: 38px; height: 38px;
    border-radius: 10px;
    color: #f5f5f5;
    background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.06);
  }
  .stat-copy strong {
    display: block;
    color: #f5f5f5;
    font-size: 1.5rem; font-weight: 800;
    letter-spacing: -.01em;
    line-height: 1;
  }
  .stat-copy small {
    display: block; margin-top: 4px;
    color: #77777f;
    font-size: .62rem; font-weight: 600;
    letter-spacing: .04em; text-transform: uppercase;
  }

  /* Action grid */
  .actions-section { margin-bottom: 36px; }
  .action-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
  }
  .action-card {
    display: flex; align-items: center; gap: 14px;
    padding: 18px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 14px;
    background: rgba(255,255,255,.015);
    color: inherit;
    text-decoration: none;
    transition: border-color 200ms cubic-bezier(.22,1,.36,1),
                background 200ms cubic-bezier(.22,1,.36,1),
                transform 200ms cubic-bezier(.22,1,.36,1);
  }
  .action-card:hover {
    border-color: rgba(255,255,255,.18);
    background: rgba(255,255,255,.03);
    transform: translateY(-1px);
  }
  .action-card:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }
  .action-icon {
    display: grid; place-items: center;
    width: 42px; height: 42px;
    border-radius: 11px;
    color: #f5f5f5;
    background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.06);
    flex: 0 0 auto;
  }
  .action-copy { flex: 1; min-width: 0; }
  .action-copy strong {
    display: block;
    color: #f5f5f5;
    font-size: .92rem; font-weight: 700;
    letter-spacing: -.005em;
  }
  .action-copy small {
    display: block; margin-top: 2px;
    color: #77777f;
    font-size: .7rem;
  }
  .action-arrow { color: #77777f; flex: 0 0 auto; transition: transform 200ms ease, color 200ms ease; }
  .action-card:hover .action-arrow { color: #f5f5f5; transform: translate(2px, -2px); }

  /* CineLog panel */
  .cinelog-panel {
    display: grid;
    grid-template-columns: 46px 1fr auto;
    align-items: center; gap: 18px;
    margin-bottom: 36px;
    padding: 22px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 14px;
    background:
      radial-gradient(circle at 0% 0%, rgba(255,255,255,.04), transparent 50%),
      rgba(255,255,255,.015);
  }
  .cinelog-icon {
    display: grid; place-items: center;
    width: 46px; height: 46px;
    border-radius: 12px;
    color: #f5f5f5;
    background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.08);
  }
  .cinelog-copy h2 {
    margin: 4px 0 6px;
    font-size: 1.05rem;
  }
  .cinelog-copy p {
    margin: 0;
    color: #b7b7bd;
    font-size: .78rem;
    line-height: 1.55;
    max-width: 640px;
  }
  .cinelog-cta {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 10px 18px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.05);
    font-size: .76rem; font-weight: 700;
    text-decoration: none;
    transition: background 180ms ease, border-color 180ms ease;
    white-space: nowrap;
  }
  .cinelog-cta:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.24); }

  /* Sign-out */
  .danger-actions { margin-bottom: 28px; }
  .signout-btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 20px;
    border: 1px solid rgba(255,176,32,.28);
    border-radius: 999px;
    color: #ffb020;
    background: rgba(255,176,32,.05);
    font: inherit;
    font-size: .78rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease, color 180ms ease;
  }
  .signout-btn:hover { background: rgba(255,176,32,.12); border-color: rgba(255,176,32,.5); color: #ffd17a; }
  .signout-btn:active { transform: scale(.98); }
  .signout-btn:disabled { opacity: .5; cursor: not-allowed; }

  .profile-footer {
    /* Centered single block: Mavero copyright on one line, TMDB
       attribution beneath it. Subtle, small, neutral gray. */
    display: grid; justify-items: center; gap: 6px;
    margin-top: 32px;
    padding-top: 22px;
    border-top: 1px solid rgba(255,255,255,.05);
    color: #77777f;
    font-size: .62rem;
    text-align: center;
  }
  .footer-line { color: #77777f; letter-spacing: .04em; }
  .tmdb-credit { display: inline-flex; align-items: center; gap: 7px; color: #77777f; text-decoration: none; }
  .tmdb-credit:hover { color: #c7c7cc; }
  .tmdb-logo { width: 38px; height: 27px; object-fit: contain; }
  .dialog-error { margin: 12px 0 0; color: #ffb020; font-size: .72rem; line-height: 1.45; }

  @media (max-width: 720px) {
    .profile-hero { padding-top: 22px; }
    .hero-grid { grid-template-columns: 64px 1fr; gap: 16px; }
    .avatar { width: 64px; height: 64px; font-size: 1.3rem; }
    .identity-copy h1 { font-size: clamp(1.4rem, 5.5vw, 2rem); }
    .sign-in-cta, .account-badge { grid-column: 1 / -1; justify-self: start; }
    .cinelog-panel { grid-template-columns: 40px 1fr; }
    .cinelog-icon { width: 40px; height: 40px; }
    .cinelog-cta { grid-column: 1 / -1; justify-self: start; }
  }
  @media (max-width: 480px) {
    .stats-grid { grid-template-columns: 1fr; }
    .stat-copy strong { font-size: 1.3rem; }
  }
  @media (min-width: 900px) {
    .profile-hero { padding-top: 48px; }
    .identity-copy h1 { font-size: clamp(2rem, 3.4vw, 2.8rem); }
  }
  @media (prefers-reduced-motion: reduce) {
    .stat-card, .action-card, .sign-in-cta, .cinelog-cta, .signout-btn, .identity-meta > span.syncing { transition: none; animation: none; }
  }
</style>
