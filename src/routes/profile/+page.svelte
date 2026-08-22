<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUpRight, Bookmark, Clock3, Heart, LogIn, Settings2, ShieldCheck, LogOut } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import ErrorState from '$components/ErrorState.svelte';
  import { getLocalFavorites, getLocalPersistenceState, getLocalProgressRecords } from '$lib/client/progress/service';
  import { listFavoriteDeletions } from '$lib/client/progress/database';
  import { favoriteToMedia } from '$lib/client/progress/presenter';
  import { syncAuthenticatedState, getSyncStatus, type SyncStatus } from '$lib/client/progress/cloud';
  import { mergeFavoritesWithProgress } from '$lib/shared/progress-merge';

  let { data }: { data: PageData } = $props();
  let favoriteItems = $state<MediaItem[]>([]);
  let watchedSeconds = $state(0);
  let storageMessage = $state('Preparing local storage…');
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
      const state = await getLocalPersistenceState();
      if (data.user) {
        const cloud = await syncAuthenticatedState();
        syncStatus = cloud.status;
        favoriteItems = mergeFavoritesWithProgress(cloud.favorites, cloud.progress, cloud.favoriteDeletions).map((record) => favoriteToMedia(record, cloud.progress));
        watchedSeconds = cloud.progress.reduce((total, record) => total + record.currentTime, 0);
        storageMessage = state.status === 'indexeddb' ? 'IndexedDB cache · Cloud-authoritative after sync' : 'Memory fallback · Cloud sync will retry';
      } else {
        const [favoriteRecords, progressRecords, deletions] = await Promise.all([getLocalFavorites(), getLocalProgressRecords(), listFavoriteDeletions()]);
        favoriteItems = mergeFavoritesWithProgress(favoriteRecords, progressRecords, deletions).map((record) => favoriteToMedia(record, progressRecords));
        watchedSeconds = progressRecords.reduce((total, record) => total + record.currentTime, 0);
        storageMessage = state.status === 'indexeddb' ? 'IndexedDB · Local & private' : 'Memory fallback · This session only';
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

<svelte:head>
  <title>Profile — Mavero</title>
  <meta name="description" content="Manage your MAVERO My List and synced MAVERO library." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="container-wide profile-page">
  <section class="profile-header"><div class="profile-avatar">{accountName().slice(0, 2).toUpperCase()}</div><div><div class="eyebrow">MAVERO / Your space</div><h1>Welcome back, {accountName()}.</h1><p>{isAuthenticated ? 'Your library follows you across devices.' : 'Pick up where you left off, or make room for something new.'}</p></div>{#if !isAuthenticated}<a href="/auth/sign-in" class="btn btn-secondary"><LogIn size={15} /> Sign in to sync</a>{:else}<span class="account-status">Cloud account</span>{/if}</section>

  <div class="profile-grid"><section class="profile-card profile-card-main"><div class="eyebrow">{isAuthenticated ? 'Cloud library' : 'Guest mode'}</div><h2>{isAuthenticated ? 'Your story travels with you.' : 'Your watch history lives here.'}</h2><p>{isAuthenticated ? 'MAVERO reconciles this device with your cloud library without losing newer local progress.' : 'MAVERO saves your progress on this device automatically. Sign in when you want it available everywhere.'}</p><div class="sync-row"><span><ShieldCheck size={15} /> {storageMessage}</span><span>{isAuthenticated ? syncStatusLabel(syncStatus) : loaded ? 'Ready' : 'Loading'}</span></div></section><section class="profile-card"><div class="eyebrow">Your activity</div><div class="activity-list"><div><Clock3 size={15} /><span><strong>{watchedLabel}</strong><small>{isAuthenticated ? 'Cloud history' : 'Watched locally'}</small></span></div><div><Heart size={15} /><span><strong>{favoriteItems.length} title{favoriteItems.length === 1 ? '' : 's'}</strong><small>{isAuthenticated ? 'Synced My List' : 'Saved on this device'}</small></span></div></div></section></div>

  {#if errorMessage}<ErrorState eyebrow="MAVERO / Local state" title="Your local library is resting." message={errorMessage} retry={loadLocalState} />{/if}

  <section class="section"><div class="section-head"><div><div class="eyebrow">Saved for later</div><h2 class="section-title">My list</h2></div><a class="section-link" href="/my-list"><Bookmark size={14} /> View all <ArrowUpRight size={13} /></a></div>{#if !loaded}<div class="profile-empty">Loading your local library…</div>{:else if favoriteItems.length}<div class="profile-rail">{#each favoriteItems as item}<MediaCard {item} />{/each}</div>{:else}<EmptyState eyebrow="MAVERO / My list" title="Keep a title close." message="Use My list on a detail page to save titles to this device." actionLabel="Browse Discover" actionHref="/discover" />{/if}</section>


  <section class="cinelog-banner"><div class="cinelog-mark">CL</div><div><div class="eyebrow">A separate product, made for tracking</div><h2>Track everything you watch.</h2><p>Organize your movies, series, and anime with CineLog.</p></div><a class="btn btn-primary" href="https://cinelogv2.vercel.app" target="_blank" rel="noreferrer">Open CineLog <ArrowUpRight size={15} /></a></section>

  <section class="preferences"><div><div class="eyebrow">Preferences</div><h2>Keep it yours.</h2></div><div class="preference-items"><span><Settings2 size={15} /> Playback settings</span><span><Bookmark size={15} /> Local library on this device</span></div></section>

  {#if isAuthenticated}<form class="signout-form" method="POST" action="/auth/sign-out"><button type="submit" class="btn signout-btn"><LogOut size={15} /> Sign out</button></form>{/if}
</div>

<style>
  .profile-page { padding-bottom: 64px; }
  .profile-header { display: grid; grid-template-columns: 60px minmax(0, 1fr) auto; align-items: center; gap: 15px; padding: 48px 0 28px; }
  .profile-avatar { display: grid; place-items: center; width: 60px; height: 60px; border: 1px solid rgba(255,255,255,.18); border-radius: 50%; color: #0d0b14; background: linear-gradient(145deg, #dbb7a5, #8672a5); font-size: .9rem; font-weight: 800; }
  .profile-header h1 { margin: 7px 0 7px; font-size: clamp(2rem, 4vw, 4rem); line-height: .98; letter-spacing: -.07em; }
  .profile-header p { margin: 0; color: var(--muted); font-size: .84rem; }
  .account-status { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; text-transform: uppercase; }
  .signout-form { display: flex; justify-content: flex-end; margin-top: 24px; }
  .signout-btn { color: #ffadb8; border-color: rgba(236,91,111,.28); background: rgba(236,91,111,.08); }
  .signout-btn:hover { color: #ffd9de; border-color: rgba(236,91,111,.5); background: rgba(236,91,111,.15); }
  .profile-grid { display: grid; grid-template-columns: 1.35fr .8fr; gap: 12px; }
  .profile-card { min-height: 136px; padding: 18px; border: 1px solid var(--line); border-radius: 17px; background: var(--surface); }
  .profile-card-main { background: radial-gradient(circle at 80% 20%, rgba(155,135,245,.13), transparent 19rem), var(--surface); }
  .profile-card h2 { max-width: 440px; margin: 11px 0 8px; font-size: 1.75rem; letter-spacing: -.06em; }
  .profile-card p { max-width: 510px; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.65; }
  .sync-row { display: flex; gap: 18px; margin-top: 18px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .59rem; }
  .sync-row span { display: inline-flex; align-items: center; gap: 6px; }
  .sync-row span:first-child { color: var(--success); }
  .activity-list { display: grid; gap: 12px; margin-top: 15px; }
  .activity-list > div { display: flex; align-items: center; gap: 10px; color: var(--accent); }
  .activity-list span { display: grid; gap: 3px; }
  .activity-list strong { color: var(--ink); font-size: .88rem; }
  .activity-list small { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; }
  .profile-rail { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(160px, 1fr); gap: 14px; overflow-x: auto; scrollbar-width: none; }
  .profile-rail::-webkit-scrollbar { display: none; }
  .profile-empty { padding: 36px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); color: var(--muted); font-size: .8rem; }
  .cinelog-banner { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 14px; margin-top: 42px; padding: 18px; border: 1px solid rgba(155,135,245,.25); border-radius: 18px; background: rgba(155,135,245,.07); }
  .cinelog-mark { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; color: #0d0b14; background: var(--accent); font-size: .85rem; font-weight: 800; }
  .cinelog-banner h2 { margin: 7px 0 4px; font-size: 1.35rem; letter-spacing: -.05em; }
  .cinelog-banner p { margin: 0; color: var(--muted); font-size: .75rem; }
  .preferences { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 30px 0 0; }
  .preferences h2 { margin: 8px 0 0; font-size: 1.7rem; letter-spacing: -.06em; }
  .preference-items { display: grid; gap: 10px; align-content: start; }
  .preference-items span { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: .77rem; }
  @media (max-width: 720px) { .profile-header { grid-template-columns: 52px minmax(0, 1fr); padding-top: 84px; } .profile-avatar { width: 52px; height: 52px; } .profile-header .btn { grid-column: 1 / -1; justify-self: start; } .signout-form { justify-content: flex-start; } .profile-grid, .preferences { grid-template-columns: 1fr; } .profile-rail { grid-auto-columns: 42vw; } .cinelog-banner { grid-template-columns: 42px 1fr; } .cinelog-mark { width: 42px; height: 42px; border-radius: 12px; } .cinelog-banner .btn { grid-column: 1 / -1; justify-self: start; } }
</style>
