<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ArrowRight, Bookmark, CheckCircle2, Clock3, Eye, ListVideo, LoaderCircle } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import { getLocalFavorites, getLocalPersistenceState, getLocalProgressRecords } from '$lib/client/progress/service';
  import { listFavoriteDeletions } from '$lib/client/progress/database';
  import { favoriteToMedia } from '$lib/client/progress/presenter';
  import { syncAuthenticatedState, type SyncStatus } from '$lib/client/progress/cloud';
  import { normalizeWatchlistStatus, type FavoriteRecord, type WatchlistStatus } from '$lib/client/progress/types';
  import { mergeFavoritesWithProgress } from '$lib/shared/progress-merge';

  let { data }: { data: PageData } = $props();
  let records = $state<FavoriteRecord[]>([]);
  let progressRecords = $state<import('$lib/client/progress/types').WatchProgressRecord[]>([]);
  let loaded = $state(false);
  let errorMessage = $state('');
  let storageMessage = $state('Preparing your library…');
  let syncStatus = $state<SyncStatus>('pending');

  const statusOptions: Array<{ value: WatchlistStatus; label: string; description: string; icon: typeof Eye }> = [
    { value: 'watching', label: 'Watching', description: 'Stories in progress', icon: Eye },
    { value: 'planned', label: 'Planned', description: 'Saved for later', icon: Clock3 },
    { value: 'completed', label: 'Completed', description: 'Finished favourites', icon: CheckCircle2 },
  ];
  function statusFromUrl(): WatchlistStatus | null { const value = page.url.searchParams.get('status'); return value === 'watching' || value === 'planned' || value === 'completed' ? value : null; }
  let selectedStatus = $derived(statusFromUrl());
  let visibleRecords = $derived(records.filter((record) => !selectedStatus || normalizeWatchlistStatus(record.status) === selectedStatus));
  let visibleItems = $derived(visibleRecords.map((record) => favoriteToMedia({ ...record, status: normalizeWatchlistStatus(record.status) }, progressRecords)));
  let totalCount = $derived(records.length);
  let watchingCount = $derived(records.filter((r) => normalizeWatchlistStatus(r.status) === 'watching').length);
  let plannedCount = $derived(records.filter((r) => normalizeWatchlistStatus(r.status) === 'planned').length);
  let completedCount = $derived(records.filter((r) => normalizeWatchlistStatus(r.status) === 'completed').length);
  let visibleLabel = $derived(selectedStatus ? statusOptions.find((option) => option.value === selectedStatus)?.label ?? 'My List' : 'Everything saved');
  function chipHref(status: WatchlistStatus) { const params = new URLSearchParams(page.url.searchParams); if (selectedStatus === status) params.delete('status'); else params.set('status', status); const query = params.toString(); return query ? `/my-list?${query}` : '/my-list'; }
  async function selectStatus(status: WatchlistStatus) { await goto(chipHref(status), { replaceState: true, keepFocus: true, noScroll: true }); }
  function syncStatusLabel(status: SyncStatus) { return ({ synced: 'Synced across devices', syncing: 'Syncing your library…', pending: 'Local-first library', offline: 'Offline · Local cache active', error: 'Cloud sync will retry later' } satisfies Record<SyncStatus, string>)[status]; }
  async function loadList() {
    errorMessage = '';
    try {
      const statePromise = getLocalPersistenceState();
      const [favorites, progress, deletions, state] = await Promise.all([getLocalFavorites(), getLocalProgressRecords(), listFavoriteDeletions(), statePromise]);
      progressRecords = progress;
      records = mergeFavoritesWithProgress(favorites, progress, deletions);
      loaded = true;
      syncStatus = data.user ? 'syncing' : 'pending';
      storageMessage = data.user
        ? (state.status === 'indexeddb' ? 'IndexedDB cache · Syncing in background' : 'Memory fallback · Cloud sync will retry')
        : (state.status === 'indexeddb' ? 'IndexedDB · Local & private' : 'Memory fallback · This session only');

      if (!data.user) return;
      void syncAuthenticatedState().then((cloud) => {
        progressRecords = cloud.progress;
        records = mergeFavoritesWithProgress(cloud.favorites, cloud.progress, cloud.favoriteDeletions);
        syncStatus = cloud.status;
        storageMessage = state.status === 'indexeddb' ? 'IndexedDB cache · Cloud-authoritative after sync' : 'Memory fallback · Cloud sync will retry';
      });
    } catch {
      errorMessage = 'Your saved library is temporarily unavailable. Please try again.';
      loaded = true;
    }
  }
  onMount(() => { void loadList(); });
</script>

<svelte:head>
  <title>My List — Mavero</title>
  <meta name="description" content="Your MAVERO watchlist, organized by what you are watching, planning, and have completed." />
</svelte:head>

<div class="my-list-page">
  <header class="list-header">
    <div class="header-inner">
      <div class="header-eyebrow"><Bookmark size={13} /> MAVERO / My List</div>
      <div class="header-title-row">
        <div>
          <h1>My List</h1>
          <p class="header-sub">Your hand-picked library — synced across your devices when you're signed in.</p>
        </div>
        <div class="list-status" aria-live="polite">
          <span class:online={syncStatus === 'synced'} class:syncing={syncStatus === 'syncing'}></span>
          {syncStatusLabel(syncStatus)}
        </div>
      </div>
    </div>
  </header>

  <nav class="status-nav" aria-label="Filter My List by status">
    <a class:active={!selectedStatus} class="status-chip all-chip" href="/my-list" aria-current={!selectedStatus ? 'page' : undefined}>
      <ListVideo size={15} /><span>All titles</span><b>{totalCount}</b>
    </a>
    {#each statusOptions as option}
      <a
        class:active={selectedStatus === option.value}
        class="status-chip"
        href={chipHref(option.value)}
        aria-current={selectedStatus === option.value ? 'page' : undefined}
        onclick={(event) => { event.preventDefault(); void selectStatus(option.value); }}
      >
        <option.icon class="status-icon" size={15} />
        <span>{option.label}</span>
        <b>{option.value === 'watching' ? watchingCount : option.value === 'planned' ? plannedCount : completedCount}</b>
      </a>
    {/each}
  </nav>

  <div class="list-body">
    {#if !loaded}
      <section class="loading-state" aria-live="polite">
        <LoaderCircle size={22} />
        <span>Gathering your library…</span>
      </section>
    {:else if errorMessage}
      <section class="error-state" role="alert">
        <div class="error-mark">!</div>
        <h2>Your library is taking a pause.</h2>
        <p>{errorMessage}</p>
        <button class="retry-btn" type="button" onclick={loadList}>Try again</button>
      </section>
    {:else if visibleItems.length}
      <section class="list-section" aria-labelledby="list-section-title">
        <div class="section-heading">
          <div>
            <div class="section-eyebrow">{visibleLabel}</div>
            <h2 id="list-section-title">{visibleItems.length} {visibleItems.length === 1 ? 'title' : 'titles'} in view</h2>
          </div>
          {#if selectedStatus}
            <a class="quiet-link" href="/my-list">Show all <ArrowRight size={14} /></a>
          {/if}
        </div>
        <div class="media-grid">
          {#each visibleItems as item (item.type + ':' + item.id)}
            <MediaCard {item} editorial />
          {/each}
        </div>
      </section>
    {:else if selectedStatus}
      {@const current = statusOptions.find((option) => option.value === selectedStatus)}
      <section class="empty-state" aria-live="polite">
        <div class="empty-mark" aria-hidden="true">{#if selectedStatus === 'watching'}<Eye size={22} />{:else if selectedStatus === 'planned'}<Clock3 size={22} />{:else}<CheckCircle2 size={22} />{/if}</div>
        <div class="empty-eyebrow">MAVERO / {current?.label ?? 'My List'}</div>
        <h2>This shelf is ready.</h2>
        <p>{current?.description ?? 'Choose a title to begin building this part of your library.'}</p>
        <a class="empty-action" href="/discover">Browse Discover <ArrowRight size={14} /></a>
      </section>
    {:else}
      <section class="empty-state" aria-live="polite">
        <div class="empty-mark" aria-hidden="true"><Bookmark size={22} /></div>
        <div class="empty-eyebrow">MAVERO / Your library</div>
        <h2>Start your next story.</h2>
        <p>Save a movie, series, or anime from its detail page and it will appear here — your library follows you across devices when you're signed in.</p>
        <a class="empty-action" href="/discover">Explore Discover <ArrowRight size={14} /></a>
      </section>
    {/if}
  </div>

  <footer class="list-footer">
    <span>{storageMessage}</span>
    <a href="/discover">Find something new <ArrowRight size={13} /></a>
  </footer>
</div>

<style>
  .my-list-page {
    --l-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    padding-bottom: calc(90px + env(safe-area-inset-bottom, 0px));
  }

  .list-header {
    padding: calc(36px + env(safe-area-inset-top, 0px)) var(--l-gutter) 18px;
    border-bottom: 1px solid rgba(255,255,255,.05);
    background:
      radial-gradient(circle at 80% -20%, rgba(255,255,255,.04), transparent 50%),
      #000;
  }
  .header-inner { width: min(1400px, 100%); margin-inline: auto; }
  .header-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    color: #77777f;
    font-size: .6rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .header-title-row {
    display: flex; align-items: end; justify-content: space-between; gap: 18px;
    margin-top: 8px;
  }
  .list-header h1 {
    margin: 0;
    color: #f5f5f5;
    font-size: clamp(1.8rem, 4vw, 2.8rem);
    font-weight: 800;
    letter-spacing: -.025em;
    line-height: 1.05;
  }
  .header-sub {
    margin: 8px 0 0;
    color: #b7b7bd;
    font-size: .82rem;
    line-height: 1.55;
    max-width: 520px;
  }
  .list-status {
    display: inline-flex; align-items: center; gap: 7px;
    color: #77777f;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase;
    white-space: nowrap;
  }
  .list-status span {
    width: 6px; height: 6px; border-radius: 50%;
    background: #ffb020;
  }
  .list-status span.online { background: #35d68f; box-shadow: 0 0 0 3px rgba(53,214,143,.18); }
  .list-status span.syncing { background: #c7c7cc; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }

  .status-nav {
    display: flex; gap: 8px; overflow-x: auto;
    padding: 18px var(--l-gutter) 18px;
    scrollbar-width: none;
    width: 100%;
    box-sizing: border-box;
  }
  .status-nav::-webkit-scrollbar { display: none; }
  .status-chip {
    display: inline-flex; align-items: center; gap: 8px;
    min-height: 38px;
    padding: 0 14px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 999px;
    color: #b7b7bd;
    background: rgba(255,255,255,.025);
    font-size: .72rem; font-weight: 700;
    text-decoration: none;
    white-space: nowrap;
    transition: color 180ms cubic-bezier(.22,1,.36,1),
                border-color 180ms cubic-bezier(.22,1,.36,1),
                background 180ms cubic-bezier(.22,1,.36,1);
  }
  .status-chip:hover { color: #f5f5f5; border-color: rgba(255,255,255,.18); background: rgba(255,255,255,.05); }
  .status-chip:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }
  .status-chip.active {
    color: #000; border-color: #f5f5f5; background: #f5f5f5;
  }
  .status-chip b {
    min-width: 18px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: .58rem; font-weight: 800;
    text-align: center;
    background: rgba(255,255,255,.08);
    color: inherit; opacity: .85;
  }
  .status-chip.active b { background: rgba(0,0,0,.18); color: #000; opacity: 1; }

  .list-body { padding: 0 var(--l-gutter); }

  .list-section { padding-top: 12px; }
  .section-heading {
    display: flex; align-items: end; justify-content: space-between; gap: 15px;
    margin-bottom: 18px;
  }
  .section-eyebrow {
    color: #77777f;
    font-size: .6rem; font-weight: 700;
    letter-spacing: .12em; text-transform: uppercase;
  }
  .section-heading h2 {
    margin: 6px 0 0;
    color: #f5f5f5;
    font-size: clamp(1.1rem, 2vw, 1.3rem); font-weight: 800;
    letter-spacing: -.015em;
  }
  .quiet-link, .list-footer a {
    display: inline-flex; align-items: center; gap: 6px;
    color: #77777f;
    font-size: .7rem; font-weight: 700;
    text-decoration: none;
    transition: color 180ms ease;
  }
  .quiet-link:hover, .list-footer a:hover { color: #f5f5f5; }
  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 182px));
    justify-content: start;
    gap: 28px 16px;
  }

  .loading-state {
    display: grid; place-items: center; gap: 12px;
    min-height: 280px;
    color: #77777f;
    font-size: .78rem;
  }
  .loading-state :global(svg) { color: #b7b7bd; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-state {
    display: grid; place-items: center; gap: 8px;
    min-height: 240px;
    margin-top: 28px;
    padding: 36px 20px;
    border: 1px solid rgba(255,176,32,.18);
    border-radius: 14px;
    background: rgba(255,176,32,.03);
    text-align: center;
  }
  .error-mark {
    display: grid; place-items: center;
    width: 44px; height: 44px;
    margin-bottom: 4px;
    border: 1px solid rgba(255,176,32,.35);
    border-radius: 50%;
    color: #ffb020;
    background: rgba(255,176,32,.06);
    font-size: 1.2rem; font-weight: 800;
  }
  .error-state h2 { margin: 0; color: #f5f5f5; font-size: 1.1rem; font-weight: 800; }
  .error-state p { margin: 0; max-width: 380px; color: #b7b7bd; font-size: .8rem; line-height: 1.55; }
  .retry-btn {
    margin-top: 8px;
    padding: 9px 18px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.06);
    font: inherit;
    font-size: .76rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .retry-btn:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.24); }

  .empty-state {
    display: grid; place-items: center; gap: 8px;
    min-height: 280px;
    margin-top: 24px;
    padding: 48px 24px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 14px;
    background:
      radial-gradient(circle at 50% 30%, rgba(255,255,255,.025), transparent 60%),
      rgba(255,255,255,.01);
    text-align: center;
  }
  .empty-mark {
    display: grid; place-items: center;
    width: 60px; height: 60px;
    margin-bottom: 6px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 50%;
    color: #b7b7bd;
    background: rgba(255,255,255,.03);
  }
  .empty-eyebrow {
    color: #77777f;
    font-size: .6rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .empty-state h2 {
    margin: 4px 0;
    color: #f5f5f5;
    font-size: 1.3rem; font-weight: 800;
    letter-spacing: -.015em;
  }
  .empty-state p {
    margin: 0; max-width: 360px;
    color: #b7b7bd;
    font-size: .82rem; line-height: 1.6;
  }
  .empty-action {
    display: inline-flex; align-items: center; gap: 6px;
    margin-top: 14px;
    padding: 11px 22px;
    border-radius: 999px;
    color: #000;
    background: #f5f5f5;
    font-size: .8rem; font-weight: 700;
    text-decoration: none;
    box-shadow: 0 4px 20px rgba(255,255,255,.12);
    transition: transform 200ms cubic-bezier(.22,1,.36,1), box-shadow 200ms cubic-bezier(.22,1,.36,1);
  }
  .empty-action:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(255,255,255,.18); }
  .empty-action:active { transform: scale(.98); }

  .list-footer {
    display: flex; justify-content: space-between; gap: 16px;
    margin-top: 40px;
    padding-top: 18px;
    border-top: 1px solid rgba(255,255,255,.05);
    color: #77777f;
    font-size: .62rem;
  }

  @media (max-width: 760px) {
    .list-header { padding-top: calc(28px + env(safe-area-inset-top, 0px)); }
    .header-title-row { flex-direction: column; align-items: start; gap: 10px; }
    .header-sub { font-size: .78rem; }
  }
  @media (max-width: 640px) {
    .status-chip { min-height: 36px; padding: 0 11px; font-size: .68rem; gap: 6px; }
    .media-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 11px; }
    .list-footer { flex-direction: column; align-items: start; }
    .empty-state { padding: 36px 18px; }
  }
  @media (min-width: 900px) {
    .list-header { padding-top: calc(56px + env(safe-area-inset-top, 0px)); padding-bottom: 26px; }
    .list-header h1 { font-size: clamp(2rem, 3.4vw, 2.8rem); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-chip, .loading-state :global(svg), .list-status span.syncing, .empty-action { transition: none; animation: none; }
  }
</style>
