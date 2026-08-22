<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ArrowRight, CheckCircle2, Clock3, Eye, ListVideo, LoaderCircle, Sparkles } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import ErrorState from '$components/ErrorState.svelte';
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
  let visibleLabel = $derived(selectedStatus ? statusOptions.find((option) => option.value === selectedStatus)?.label ?? 'My List' : 'Everything saved');
  function chipHref(status: WatchlistStatus) { const params = new URLSearchParams(page.url.searchParams); if (selectedStatus === status) params.delete('status'); else params.set('status', status); const query = params.toString(); return query ? `/my-list?${query}` : '/my-list'; }
  async function selectStatus(status: WatchlistStatus) { await goto(chipHref(status), { replaceState: true, keepFocus: true, noScroll: true }); }
  function syncStatusLabel(status: SyncStatus) { return ({ synced: 'Synced across devices', syncing: 'Syncing your library…', pending: 'Local-first library', offline: 'Offline · Local cache active', error: 'Cloud sync will retry later' } satisfies Record<SyncStatus, string>)[status]; }
  async function loadList() {
    loaded = false; errorMessage = '';
    try {
      const state = await getLocalPersistenceState();
      if (data.user) { const cloud = await syncAuthenticatedState(); progressRecords = cloud.progress; records = mergeFavoritesWithProgress(cloud.favorites, cloud.progress, cloud.favoriteDeletions); syncStatus = cloud.status; storageMessage = state.status === 'indexeddb' ? 'IndexedDB cache · Cloud-authoritative after sync' : 'Memory fallback · Cloud sync will retry'; }
      else { const [favorites, progress, deletions] = await Promise.all([getLocalFavorites(), getLocalProgressRecords(), listFavoriteDeletions()]); progressRecords = progress; records = mergeFavoritesWithProgress(favorites, progress, deletions); syncStatus = 'pending'; storageMessage = state.status === 'indexeddb' ? 'IndexedDB · Local & private' : 'Memory fallback · This session only'; }
    } catch { errorMessage = 'Your saved library is temporarily unavailable. Please try again.'; }
    finally { loaded = true; }
  }
  onMount(() => { void loadList(); });
</script>

<svelte:head>
  <title>My List — Mavero</title>
  <meta name="description" content="Your MAVERO watchlist, organized by what you are watching, planning, and have completed." />
</svelte:head>

<div class="my-list-page">
  <div class="container-wide">
    <header class="list-header">
      <div class="list-title-block"><div class="eyebrow"><ListVideo size={13} /> Your library</div><h1>My List<span class="title-mark">.</span></h1><p>Keep the stories you want close, then move them through your watch journey.</p></div>
      <div class="list-status" aria-live="polite"><span class:online={syncStatus === 'synced'}></span>{syncStatusLabel(syncStatus)}</div>
    </header>

    <section class="library-summary" aria-label="Library summary"><div><span>Total titles</span><strong>{totalCount}</strong></div><div><span>Watching now</span><strong>{records.filter((record) => normalizeWatchlistStatus(record.status) === 'watching').length}</strong></div><div><span>Saved for later</span><strong>{records.filter((record) => normalizeWatchlistStatus(record.status) === 'planned').length}</strong></div><div class="summary-note"><Sparkles size={15} /><span>A library that knows where you left off.</span></div></section>

    <nav class="status-nav" aria-label="Filter My List by status">
      <a class:active={!selectedStatus} class="status-chip all-chip" href="/my-list" aria-current={!selectedStatus ? 'page' : undefined}><ListVideo size={15} /><span>All titles</span><b>{totalCount}</b></a>
      {#each statusOptions as option}<a class:active={selectedStatus === option.value} class="status-chip" href={chipHref(option.value)} aria-current={selectedStatus === option.value ? 'page' : undefined} onclick={(event) => { event.preventDefault(); void selectStatus(option.value); }}><option.icon class="status-icon" size={15} /><span>{option.label}</span><b>{records.filter((record) => normalizeWatchlistStatus(record.status) === option.value).length}</b></a>{/each}
    </nav>

    {#if !loaded}
      <section class="loading-state" aria-live="polite"><LoaderCircle size={22} /><span>Gathering your library…</span></section>
    {:else if errorMessage}
      <ErrorState title="My List is taking a pause." message={errorMessage} retry={loadList} />
    {:else if visibleItems.length}
      <section class="list-section" aria-labelledby="list-section-title"><div class="section-heading"><div><div class="eyebrow">{visibleLabel}</div><h2 id="list-section-title">{visibleItems.length} {visibleItems.length === 1 ? 'title' : 'titles'} in view</h2></div>{#if selectedStatus}<a class="quiet-link" href="/my-list">Show all <ArrowRight size={14} /></a>{/if}</div><div class="media-grid">{#each visibleItems as item (item.type + ':' + item.id)}<MediaCard {item} editorial />{/each}</div></section>
    {:else if selectedStatus}
      {@const current = statusOptions.find((option) => option.value === selectedStatus)}<EmptyState eyebrow={`MAVERO / ${current?.label ?? 'My List'}`} title="This shelf is ready." message={current?.description ?? 'Choose a title to begin building this part of your library.'} actionLabel="Browse Discover" actionHref="/discover" />
    {:else}
      <EmptyState eyebrow="MAVERO / Your library" title="Start your next story." message="Save a movie, series, or anime from its detail page and it will appear here." actionLabel="Explore Discover" actionHref="/discover" />
    {/if}

    <footer class="list-footer"><span>{storageMessage}</span><a href="/discover">Find something new <ArrowRight size={13} /></a></footer>
  </div>
</div>

<style>
  .my-list-page { min-height: calc(100vh - 78px); padding: 50px 0 78px; }
  .list-header { display: flex; justify-content: space-between; align-items: end; gap: 20px; padding: 15px 0 30px; border-bottom: 1px solid var(--line); }
  .list-header h1 { margin-top: 10px; }
  .title-mark { color: var(--accent-strong); }
  .list-header p { max-width: 480px; margin: 18px 0 0; color: var(--muted); font-size: .8rem; line-height: 1.65; }
  .list-status { display: inline-flex; align-items: center; gap: 7px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; letter-spacing: .05em; text-transform: uppercase; white-space: nowrap; }
  .list-status span { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); }
  .list-status span.online { background: var(--success); box-shadow: 0 0 0 4px var(--secondary-soft); }
  .library-summary { display: grid; grid-template-columns: repeat(3, minmax(110px, .5fr)) 1.35fr; gap: 12px; margin: 24px 0 10px; }
  .library-summary > div { display: grid; gap: 8px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgba(245,241,232,.025); }
  .library-summary span { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .54rem; text-transform: uppercase; }
  .library-summary strong { color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: 2rem; font-weight: 600; line-height: .8; }
  .library-summary .summary-note { display: flex; grid-template-columns: auto 1fr; align-items: center; gap: 10px; padding: 14px 18px; color: var(--secondary); background: var(--secondary-soft); }
  .library-summary .summary-note span { color: var(--ink-soft); font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; font-style: normal; line-height: 1.05; text-transform: none; }
  .status-nav { display: flex; gap: 7px; overflow-x: auto; padding: 20px 0 22px; scrollbar-width: none; }
  .status-nav::-webkit-scrollbar { display: none; }
  .status-chip { display: inline-flex; align-items: center; gap: 8px; min-height: 39px; padding: 0 13px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: rgba(245,241,232,.025); font-size: .69rem; text-decoration: none; white-space: nowrap; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .status-chip:hover { color: var(--ink); border-color: rgba(167,139,250,.45); transform: translateY(-1px); }
  .status-chip.active { color: #1a150c; border-color: var(--accent-strong); background: var(--accent-strong); }
  .status-chip b { min-width: 18px; color: currentColor; font-family: 'DM Mono', monospace; font-size: .57rem; opacity: .75; text-align: center; }
  .list-section { padding-top: 13px; }
  .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 15px; margin-bottom: 18px; }
  .section-heading h2 { margin: 8px 0 0; font-family: 'Space Grotesk', sans-serif; font-size: 1.75rem; font-weight: 600; letter-spacing: -.04em; }
  .quiet-link, .list-footer a { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: .68rem; text-decoration: none; }
  .quiet-link:hover, .list-footer a:hover { color: var(--accent-strong); }
  .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 182px)); justify-content: start; gap: 28px 16px; }
  .loading-state { display: grid; place-items: center; gap: 10px; min-height: 280px; color: var(--muted); font-size: .75rem; }
  .loading-state :global(svg) { color: var(--accent-strong); animation: spin 1s linear infinite; }
  .list-footer { display: flex; justify-content: space-between; gap: 16px; margin-top: 46px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 760px) { .my-list-page { padding-top: 88px; } .list-header { align-items: start; flex-direction: column; } .library-summary { grid-template-columns: repeat(3, 1fr); } .summary-note { grid-column: 1 / -1; } }
  @media (max-width: 560px) { .list-header h1 { font-size: 3.8rem; } .library-summary { gap: 7px; } .library-summary > div { padding: 12px 10px; } .library-summary .summary-note { padding: 13px; } .library-summary strong { font-size: 1.7rem; } .media-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 11px; } .list-footer { align-items: start; flex-direction: column; } }
  @media (prefers-reduced-motion: reduce) { .status-chip, .loading-state :global(svg) { transition: none; animation: none; } }
</style>
