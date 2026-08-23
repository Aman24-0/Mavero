<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUpRight, Clock3, Heart, LogIn, Settings2, ShieldCheck, LogOut, Sparkles } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';
  import ErrorState from '$components/ErrorState.svelte';
  import { getLocalFavorites, getLocalProgressRecords } from '$lib/client/progress/service';
  import { listFavoriteDeletions } from '$lib/client/progress/database';
  import { favoriteToMedia } from '$lib/client/progress/presenter';
  import { syncAuthenticatedState, getSyncStatus, type SyncStatus } from '$lib/client/progress/cloud';
  import { mergeFavoritesWithProgress } from '$lib/shared/progress-merge';

  let { data }: { data: PageData } = $props();
  let favoriteItems = $state<MediaItem[]>([]);
  let watchedSeconds = $state(0);
  let loaded = $state(false);
  let errorMessage = $state('');
  let syncStatus = $state<SyncStatus>('pending');

  function accountName() {
    const metadata = data.user?.user_metadata;
    return typeof metadata?.display_name === 'string' && metadata.display_name.trim() ? metadata.display_name : data.user?.email?.split('@')[0] ?? 'Alex';
  }

  function syncStatusLabel(status: SyncStatus) {
    return ({ synced: 'Synced across devices', syncing: 'Syncing your library…', pending: 'Sync pending', offline: 'Offline · Local cache active', error: 'Cloud sync will retry later' } satisfies Record<SyncStatus, string>)[status];
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
</script>

<svelte:head><title>Profile — Mavero</title><meta name="description" content="Manage your MAVERO profile and synced library." /><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="container-wide profile-page">
  <section class="profile-header">
    <div class="profile-avatar">{accountName().slice(0, 2).toUpperCase()}</div>
    <div class="identity-copy"><div class="eyebrow">MAVERO / Your space</div><h1>{accountName()}<span>.</span></h1><p>{isAuthenticated ? 'Your library follows you across devices.' : 'Pick up where you left off, or make room for something new.'}</p><div class="identity-meta"><span class:online={syncStatus === 'synced'}></span>{isAuthenticated ? syncStatusLabel(syncStatus) : 'Guest profile · Local library'}</div></div>
    {#if !isAuthenticated}<a href="/auth/sign-in" class="btn btn-secondary"><LogIn size={15} /> Sign in to sync</a>{:else}<span class="account-status"><ShieldCheck size={14} /> Cloud account</span>{/if}
  </section>

  <section class="profile-grid">
    <section class="profile-card activity-card">
      <div class="eyebrow">Your activity</div>
      <div class="activity-list" aria-live="polite">
        <div><Clock3 size={15} /><span><strong>{watchedLabel}</strong><small>{isAuthenticated ? 'Watch time' : 'Watched locally'}</small></span></div>
        <div><Heart size={15} /><span><strong>{favoriteItems.length} title{favoriteItems.length === 1 ? '' : 's'}</strong><small>{isAuthenticated ? 'Synced My List' : 'Saved on this device'}</small></span></div>
      </div>
    </section>
  </section>

  {#if errorMessage}<ErrorState eyebrow="MAVERO / Local state" title="Your local library is resting." message={errorMessage} retry={loadLocalState} />{/if}

  <section class="identity-panel">
    <div class="identity-panel-icon"><Sparkles size={18} /></div>
    <div><div class="eyebrow">Try CineLog</div><h2>Your watch history, beautifully organized.</h2><p>CineLog is a movie tracker for movies, TV shows, and anime. Keep watching, planning, completed titles, and collections in one cinematic vault.</p></div>
    <a class="btn btn-secondary" href="https://cinelogv2.vercel.app" target="_blank" rel="noreferrer">Explore CineLog <ArrowUpRight size={15} /></a>
  </section>

  <section class="settings-entry">
    <div><div class="eyebrow">MAVERO / Settings</div><h2>Make it yours.</h2><p>Update your profile details, account access, playback behavior, and library preferences.</p></div>
    <a class="btn btn-secondary" href="/settings"><Settings2 size={15} /> Open Settings <ArrowUpRight size={15} /></a>
  </section>

  {#if isAuthenticated}<form class="signout-form" method="POST" action="/auth/sign-out"><button type="submit" class="btn signout-btn"><LogOut size={15} /> Sign out</button></form>{/if}
  <footer class="profile-footer"><span>MAVERO @2026</span><span>Data from TMDB</span></footer>
</div>

<style>
  .profile-page { padding-bottom: 82px; }
  .profile-header { display: grid; grid-template-columns: 78px minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 56px 0 34px; border-bottom: 1px solid var(--line); }
  .profile-avatar { display: grid; place-items: center; width: 78px; height: 78px; border: 1px solid rgba(255, 62, 94,.55); border-radius: 50%; color: var(--base); background: linear-gradient(145deg, var(--accent-strong), var(--secondary)); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: 1.5rem; font-weight: 700; }
  .identity-copy h1 { margin: 10px 0 8px; color: var(--ink); font-size: clamp(1.9rem, 3.6vw, 2.8rem); font-weight: 900; letter-spacing: -.02em; line-height: 1.1; }
  .identity-copy h1 span { color: var(--accent-strong); }
  .identity-copy p { margin: 0; color: var(--muted); font-size: .82rem; }
  .identity-meta { display: inline-flex; align-items: center; gap: 7px; margin-top: 15px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; text-transform: uppercase; }
  .identity-meta > span { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); }
  .identity-meta > span.online { background: var(--secondary); box-shadow: 0 0 0 4px var(--secondary-soft); }
  .account-status { display: inline-flex; align-items: center; gap: 7px; color: var(--secondary); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; text-transform: uppercase; }
  .profile-grid { display: grid; grid-template-columns: 1fr; gap: 14px; margin-top: 24px; }
  .profile-card { min-height: 165px; padding: 22px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
  .activity-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-top: 22px; }
  .activity-list > div { display: flex; align-items: center; gap: 11px; color: var(--accent-strong); }
  .activity-list span { display: grid; gap: 3px; }
  .activity-list strong { color: var(--ink); font-size: 1.5rem; font-weight: 900; letter-spacing: -.01em; line-height: 1; }
  .activity-list small { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .56rem; }
  .identity-panel, .settings-entry { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 15px; margin-top: 30px; padding: 22px; border: 1px solid rgba(123, 92, 250,.27); border-radius: var(--radius-lg); background: linear-gradient(110deg, rgba(123, 92, 250,.11), rgba(255, 62, 94,.05)); }
  .identity-panel-icon { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 13px; color: var(--base); background: var(--secondary); }
  .identity-panel h2, .settings-entry h2 { margin: 8px 0 5px; color: var(--ink); font-size: 1.25rem; font-weight: 800; letter-spacing: -.015em; line-height: 1.2; }
  .identity-panel p, .settings-entry p { max-width: 680px; margin: 0; color: var(--muted); font-size: .75rem; line-height: 1.6; }
  .settings-entry { border-color: var(--line); background: var(--surface); }
  .signout-form { display: flex; justify-content: flex-end; margin-top: 26px; }
  .signout-btn { color: #ff8fa3; border-color: rgba(231,140,141,.32); background: rgba(231,140,141,.08); }
  .profile-footer { display: flex; justify-content: space-between; gap: 18px; margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; letter-spacing: .04em; text-transform: uppercase; }
  @media (max-width: 720px) {
    .profile-header { grid-template-columns: 58px minmax(0, 1fr); padding-top: 92px; }
    .profile-avatar { width: 58px; height: 58px; font-size: 1.15rem; }
    .profile-header .btn, .account-status { grid-column: 1 / -1; justify-self: start; }
    .activity-list { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .activity-list strong { font-size: 1.25rem; }
    .identity-panel, .settings-entry { grid-template-columns: 40px 1fr; }
    .identity-panel-icon { width: 40px; height: 40px; }
    .identity-panel .btn, .settings-entry .btn { grid-column: 1 / -1; justify-self: start; }
    .signout-form { justify-content: flex-start; }
  }
  @media (max-width: 420px) { .activity-list { grid-template-columns: 1fr; gap: 15px; } .profile-footer { align-items: start; flex-direction: column; gap: 8px; } }
</style>
