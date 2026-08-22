<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUpRight, Bookmark, Clock3, Heart, LogIn, Settings2, ShieldCheck, LogOut, Sparkles } from 'lucide-svelte';
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
  function accountName() { const metadata = data.user?.user_metadata; return typeof metadata?.display_name === 'string' && metadata.display_name.trim() ? metadata.display_name : data.user?.email?.split('@')[0] ?? 'Alex'; }
  function syncStatusLabel(status: SyncStatus) { return ({ synced: 'Synced across devices', syncing: 'Syncing your library…', pending: 'Sync pending', offline: 'Offline · Local cache active', error: 'Cloud sync will retry later' } satisfies Record<SyncStatus, string>)[status]; }
  async function loadLocalState() {
    errorMessage = '';
    try {
      const state = await getLocalPersistenceState();
      if (data.user) { const cloud = await syncAuthenticatedState(); syncStatus = cloud.status; favoriteItems = mergeFavoritesWithProgress(cloud.favorites, cloud.progress, cloud.favoriteDeletions).map((record) => favoriteToMedia(record, cloud.progress)); watchedSeconds = cloud.progress.reduce((total, record) => total + record.currentTime, 0); storageMessage = state.status === 'indexeddb' ? 'IndexedDB cache · Cloud-authoritative after sync' : 'Memory fallback · Cloud sync will retry'; }
      else { const [favoriteRecords, progressRecords, deletions] = await Promise.all([getLocalFavorites(), getLocalProgressRecords(), listFavoriteDeletions()]); favoriteItems = mergeFavoritesWithProgress(favoriteRecords, progressRecords, deletions).map((record) => favoriteToMedia(record, progressRecords)); watchedSeconds = progressRecords.reduce((total, record) => total + record.currentTime, 0); storageMessage = state.status === 'indexeddb' ? 'IndexedDB · Local & private' : 'Memory fallback · This session only'; }
      loaded = true;
    } catch { syncStatus = getSyncStatus(); errorMessage = 'Your library is temporarily unavailable, but browsing and playback remain available.'; loaded = true; }
  }
  onMount(() => { void loadLocalState(); });
  let isAuthenticated = $derived(Boolean(data.user));
  let watchedLabel = $derived(watchedSeconds >= 3600 ? `${(watchedSeconds / 3600).toFixed(1)}h` : `${Math.round(watchedSeconds / 60)}m`);
</script>

<svelte:head><title>Profile — Mavero</title><meta name="description" content="Manage your MAVERO My List and synced MAVERO library." /><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="container-wide profile-page">
  <section class="profile-header">
    <div class="profile-avatar">{accountName().slice(0, 2).toUpperCase()}</div>
    <div class="identity-copy"><div class="eyebrow">MAVERO / Your space</div><h1>{accountName()}<span>.</span></h1><p>{isAuthenticated ? 'Your library follows you across devices.' : 'Pick up where you left off, or make room for something new.'}</p><div class="identity-meta"><span class:online={syncStatus === 'synced'}></span>{isAuthenticated ? syncStatusLabel(syncStatus) : 'Guest profile · Local library'}</div></div>
    {#if !isAuthenticated}<a href="/auth/sign-in" class="btn btn-secondary"><LogIn size={15} /> Sign in to sync</a>{:else}<span class="account-status"><ShieldCheck size={14} /> Cloud account</span>{/if}
  </section>

  <section class="profile-grid">
    <section class="profile-card profile-card-main"><div class="eyebrow">{isAuthenticated ? 'Cloud library' : 'Guest mode'}</div><h2>{isAuthenticated ? 'Your story travels with you.' : 'Your watch history lives here.'}</h2><p>{isAuthenticated ? 'MAVERO reconciles this device with your cloud library without losing newer local progress.' : 'MAVERO saves your progress on this device automatically. Sign in when you want it available everywhere.'}</p><div class="sync-row"><span><ShieldCheck size={15} /> {storageMessage}</span><span>{loaded ? 'Ready' : 'Loading'}</span></div></section>
    <section class="profile-card activity-card"><div class="eyebrow">Your activity</div><div class="activity-list"><div><Clock3 size={15} /><span><strong>{watchedLabel}</strong><small>{isAuthenticated ? 'Watch time' : 'Watched locally'}</small></span></div><div><Heart size={15} /><span><strong>{favoriteItems.length} title{favoriteItems.length === 1 ? '' : 's'}</strong><small>{isAuthenticated ? 'Synced My List' : 'Saved on this device'}</small></span></div></div></section>
  </section>

  {#if errorMessage}<ErrorState eyebrow="MAVERO / Local state" title="Your local library is resting." message={errorMessage} retry={loadLocalState} />{/if}

  <section class="section profile-section"><div class="section-head"><div><div class="eyebrow">Saved for later</div><h2 class="section-title">My list</h2></div><a class="section-link" href="/my-list"><Bookmark size={14} /> View all <ArrowUpRight size={13} /></a></div>{#if !loaded}<div class="profile-empty">Loading your local library…</div>{:else if favoriteItems.length}<div class="profile-rail">{#each favoriteItems as item}<MediaCard {item} editorial />{/each}</div>{:else}<EmptyState eyebrow="MAVERO / My list" title="Keep a title close." message="Use My list on a detail page to save titles to this device." actionLabel="Browse Discover" actionHref="/discover" />{/if}</section>

  <section class="identity-panel"><div class="identity-panel-icon"><Sparkles size={18} /></div><div><div class="eyebrow">A space that is yours</div><h2>Make room for the stories you return to.</h2><p>Your profile keeps your saved titles, progress, and preferences in one calm place.</p></div><a class="btn btn-secondary" href="/my-list">Open My List <ArrowUpRight size={15} /></a></section>
  <section class="preferences" id="preferences"><div><div class="eyebrow">Preferences</div><h2>Keep it yours.</h2></div><div class="preference-items"><span><Settings2 size={15} /> Playback settings</span><span><Bookmark size={15} /> {storageMessage}</span></div></section>
  {#if isAuthenticated}<form class="signout-form" method="POST" action="/auth/sign-out"><button type="submit" class="btn signout-btn"><LogOut size={15} /> Sign out</button></form>{/if}
</div>

<style>
  .profile-page { padding-bottom: 82px; }
  .profile-header { display: grid; grid-template-columns: 78px minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 56px 0 34px; border-bottom: 1px solid var(--line); }
  .profile-avatar { display: grid; place-items: center; width: 78px; height: 78px; border: 1px solid rgba(139,92,246,.55); border-radius: 50%; color: var(--base); background: linear-gradient(145deg, var(--accent-strong), var(--secondary)); font-family: 'Space Grotesk', sans-serif; font-size: 1.5rem; font-weight: 700; }
  .identity-copy h1 { margin: 10px 0 8px; font-family: 'Space Grotesk', sans-serif; font-size: clamp(3rem, 5.5vw, 5.8rem); font-weight: 600; letter-spacing: -.07em; line-height: .8; }
  .identity-copy h1 span { color: var(--accent-strong); }
  .identity-copy p { margin: 0; color: var(--muted); font-size: .82rem; }
  .identity-meta { display: inline-flex; align-items: center; gap: 7px; margin-top: 15px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .55rem; text-transform: uppercase; }
  .identity-meta > span { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); }
  .identity-meta > span.online { background: var(--secondary); box-shadow: 0 0 0 4px var(--secondary-soft); }
  .account-status { display: inline-flex; align-items: center; gap: 7px; color: var(--secondary); font-family: 'DM Mono', monospace; font-size: .58rem; text-transform: uppercase; }
  .profile-grid { display: grid; grid-template-columns: 1.35fr .75fr; gap: 14px; margin-top: 24px; }
  .profile-card { min-height: 165px; padding: 22px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
  .profile-card-main { background: radial-gradient(circle at 88% 18%, rgba(85,214,194,.12), transparent 20rem), var(--surface); }
  .profile-card h2 { max-width: 440px; margin: 13px 0 9px; font-family: 'Space Grotesk', sans-serif; font-size: 2.2rem; font-weight: 600; letter-spacing: -.045em; line-height: .9; }
  .profile-card p { max-width: 510px; margin: 0; color: var(--muted); font-size: .77rem; line-height: 1.65; }
  .sync-row { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 19px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .57rem; }
  .sync-row span { display: inline-flex; align-items: center; gap: 6px; }
  .sync-row span:first-child { color: var(--success); }
  .activity-list { display: grid; gap: 16px; margin-top: 19px; }
  .activity-list > div { display: flex; align-items: center; gap: 11px; color: var(--accent-strong); }
  .activity-list span { display: grid; gap: 3px; }
  .activity-list strong { color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: 1.6rem; font-weight: 600; line-height: .8; }
  .activity-list small { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .profile-section { margin-top: 50px; }
  .profile-rail { display: grid; grid-auto-flow: column; grid-auto-columns: 182px; gap: 16px; overflow-x: auto; scrollbar-width: none; }
  .profile-rail::-webkit-scrollbar { display: none; }
  .profile-empty { padding: 36px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); color: var(--muted); font-size: .8rem; }
  .identity-panel { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 15px; margin-top: 54px; padding: 22px; border: 1px solid rgba(85,214,194,.27); border-radius: var(--radius-lg); background: linear-gradient(110deg, rgba(85,214,194,.11), rgba(139,92,246,.05)); }
  .identity-panel-icon { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 13px; color: var(--base); background: var(--secondary); }
  .identity-panel h2 { margin: 8px 0 5px; font-family: 'Space Grotesk', sans-serif; font-size: 1.8rem; font-weight: 600; letter-spacing: -.04em; line-height: .88; }
  .identity-panel p { margin: 0; color: var(--muted); font-size: .75rem; }
  .preferences { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 38px 0 0; }
  .preferences h2 { margin: 9px 0 0; font-family: 'Space Grotesk', sans-serif; font-size: 2rem; font-weight: 600; letter-spacing: -.05em; }
  .preference-items { display: grid; gap: 11px; align-content: start; }
  .preference-items span { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: .77rem; }
  .signout-form { display: flex; justify-content: flex-end; margin-top: 26px; }
  .signout-btn { color: #f2b2ba; border-color: rgba(243,127,139,.32); background: rgba(243,127,139,.08); }
  @media (max-width: 720px) { .profile-header { grid-template-columns: 58px minmax(0, 1fr); padding-top: 92px; } .profile-avatar { width: 58px; height: 58px; font-size: 1.15rem; } .profile-header .btn, .account-status { grid-column: 1 / -1; justify-self: start; } .profile-grid, .preferences { grid-template-columns: 1fr; } .profile-rail { grid-auto-columns: 42vw; } .identity-panel { grid-template-columns: 40px 1fr; } .identity-panel-icon { width: 40px; height: 40px; } .identity-panel .btn { grid-column: 1 / -1; justify-self: start; } .signout-form { justify-content: flex-start; } }
</style>
