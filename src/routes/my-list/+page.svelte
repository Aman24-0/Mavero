<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ArrowRight, CheckCircle2, Clock3, Eye, ListVideo, LoaderCircle } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import ErrorState from '$components/ErrorState.svelte';
  import { getLocalFavorites, getLocalPersistenceState } from '$lib/client/progress/service';
  import { favoriteToMedia } from '$lib/client/progress/presenter';
  import { syncAuthenticatedState, type SyncStatus } from '$lib/client/progress/cloud';
  import { normalizeWatchlistStatus, type FavoriteRecord, type WatchlistStatus } from '$lib/client/progress/types';

  let { data }: { data: PageData } = $props();
  let records = $state<FavoriteRecord[]>([]);
  let loaded = $state(false);
  let errorMessage = $state('');
  let storageMessage = $state('Preparing your library…');
  let syncStatus = $state<SyncStatus>('pending');

  const statusOptions: Array<{ value: WatchlistStatus; label: string; description: string; icon: typeof Eye }> = [
    { value: 'watching', label: 'Watching', description: 'Stories in progress', icon: Eye },
    { value: 'planned', label: 'Planned', description: 'Saved for later', icon: Clock3 },
    { value: 'completed', label: 'Completed', description: 'Finished favourites', icon: CheckCircle2 },
  ];

  function statusFromUrl(): WatchlistStatus | null {
    const value = page.url.searchParams.get('status');
    return value === 'watching' || value === 'planned' || value === 'completed' ? value : null;
  }

  let selectedStatus = $derived(statusFromUrl());
  let visibleRecords = $derived(records.filter((record) => !selectedStatus || normalizeWatchlistStatus(record.status) === selectedStatus));
  let visibleItems = $derived(visibleRecords.map((record) => favoriteToMedia({ ...record, status: normalizeWatchlistStatus(record.status) })));
  let totalCount = $derived(records.length);
  let visibleLabel = $derived(selectedStatus ? statusOptions.find((option) => option.value === selectedStatus)?.label ?? 'My List' : 'Everything saved');

  function chipHref(status: WatchlistStatus) {
    const params = new URLSearchParams(page.url.searchParams);
    if (selectedStatus === status) params.delete('status');
    else params.set('status', status);
    const query = params.toString();
    return query ? `/my-list?${query}` : '/my-list';
  }

  async function selectStatus(status: WatchlistStatus) {
    await goto(chipHref(status), { replaceState: true, keepFocus: true, noScroll: true });
  }

  function syncStatusLabel(status: SyncStatus) {
    return ({ synced: 'Synced across devices', syncing: 'Syncing your library…', pending: 'Local-first library', offline: 'Offline · Local cache active', error: 'Cloud sync will retry later' } satisfies Record<SyncStatus, string>)[status];
  }

  async function loadList() {
    loaded = false;
    errorMessage = '';
    try {
      const state = await getLocalPersistenceState();
      if (data.user) {
        const cloud = await syncAuthenticatedState();
        records = cloud.favorites;
        syncStatus = cloud.status;
        storageMessage = state.status === 'indexeddb' ? 'IndexedDB cache · Cloud-authoritative after sync' : 'Memory fallback · Cloud sync will retry';
      } else {
        records = await getLocalFavorites();
        syncStatus = 'pending';
        storageMessage = state.status === 'indexeddb' ? 'IndexedDB · Local & private' : 'Memory fallback · This session only';
      }
    } catch {
      errorMessage = 'Your saved library is temporarily unavailable. Please try again.';
    } finally {
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
  <div class="container-wide">
    <header class="list-header">
      <div>
        <div class="eyebrow"><ListVideo size={13} /> Your library</div>
        <h1>My List<span class="title-mark">.</span></h1>
        <p>Keep the stories you want close, then move them through your watch journey.</p>
      </div>
      <div class="list-status" aria-live="polite"><span class:online={syncStatus === 'synced'}></span>{syncStatusLabel(syncStatus)}</div>
    </header>

    <nav class="status-nav" aria-label="Filter My List by status">
      <a class:active={!selectedStatus} class="status-chip all-chip" href="/my-list" aria-current={!selectedStatus ? 'page' : undefined}>
        <ListVideo size={15} />
        <span>All</span>
        <b>{totalCount}</b>
      </a>
      {#each statusOptions as option}
        <a class:active={selectedStatus === option.value} class="status-chip" href={chipHref(option.value)} aria-current={selectedStatus === option.value ? 'page' : undefined} onclick={(event) => { event.preventDefault(); void selectStatus(option.value); }}>
          <option.icon class="status-icon" size={15} />
          <span>{option.label}</span>
          <b>{records.filter((record) => normalizeWatchlistStatus(record.status) === option.value).length}</b>
        </a>
      {/each}
    </nav>

    {#if !loaded}
      <section class="loading-state" aria-live="polite"><LoaderCircle size={22} /><span>Gathering your library…</span></section>
    {:else if errorMessage}
      <ErrorState title="My List is taking a pause." message={errorMessage} retry={loadList} />
    {:else if visibleItems.length}
      <section class="list-section" aria-labelledby="list-section-title">
        <div class="section-heading">
          <div><div class="eyebrow">{visibleLabel}</div><h2 id="list-section-title">{visibleItems.length} {visibleItems.length === 1 ? 'title' : 'titles'} in view</h2></div>
          {#if selectedStatus}<a class="quiet-link" href="/my-list">Show all <ArrowRight size={14} /></a>{/if}
        </div>
        <div class="media-grid">{#each visibleItems as item (item.type + ':' + item.id)}<MediaCard {item} />{/each}</div>
      </section>
    {:else if selectedStatus}
      {@const current = statusOptions.find((option) => option.value === selectedStatus)}
      <EmptyState eyebrow={`MAVERO / ${current?.label ?? 'My List'}`} title="This shelf is ready." message={current?.description ?? 'Choose a title to begin building this part of your library.'} actionLabel="Browse Discover" actionHref="/discover" />
    {:else}
      <EmptyState eyebrow="MAVERO / Your library" title="Start your next story." message="Save a movie, series, or anime from its detail page and it will appear here." actionLabel="Explore Discover" actionHref="/discover" />
    {/if}

    <footer class="list-footer"><span>{storageMessage}</span><a href="/discover">Find something new <ArrowRight size={13} /></a></footer>
  </div>
</div>

<style>
  .my-list-page { min-height: calc(100vh - 72px); padding: 38px 0 64px; }
  .list-header { display: flex; justify-content: space-between; align-items: end; gap: 20px; padding: 18px 0 30px; border-bottom: 1px solid var(--line); }
  .eyebrow { display: inline-flex; align-items: center; gap: 7px; }
  .list-header h1 { margin: 9px 0 8px; font-size: clamp(2.8rem, 7vw, 5.6rem); line-height: .9; letter-spacing: -.09em; }
  .title-mark { color: var(--accent); }
  .list-header p { max-width: 480px; margin: 0; color: var(--muted); font-size: .82rem; line-height: 1.6; }
  .list-status { display: inline-flex; align-items: center; gap: 7px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; text-transform: uppercase; white-space: nowrap; }
  .list-status span { width: 6px; height: 6px; border-radius: 50%; background: #d4b27c; }
  .list-status span.online { background: var(--success); box-shadow: 0 0 0 4px rgba(119,212,166,.1); }
  .status-nav { display: flex; gap: 8px; overflow-x: auto; padding: 18px 0 22px; scrollbar-width: none; }
  .status-nav::-webkit-scrollbar { display: none; }
  .status-chip { display: inline-flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: rgba(255,255,255,.025); font-size: .72rem; text-decoration: none; white-space: nowrap; transition: border-color .2s ease, color .2s ease, background .2s ease, transform .2s ease; }
  .status-chip:hover { color: var(--ink); border-color: rgba(155,135,245,.4); transform: translateY(-1px); }
  .status-chip.active { color: #110d1a; border-color: var(--accent); background: var(--accent); }
  .status-chip b { min-width: 18px; color: currentColor; font-family: 'DM Mono', monospace; font-size: .58rem; opacity: .75; text-align: center; }
  .list-section { padding-top: 13px; }
  .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 15px; margin-bottom: 16px; }
  .section-heading h2 { margin: 7px 0 0; font-size: 1.5rem; letter-spacing: -.05em; }
  .quiet-link, .list-footer a { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: .7rem; text-decoration: none; }
  .quiet-link:hover, .list-footer a:hover { color: var(--ink); }
  .media-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 24px 12px; }
  .loading-state { display: grid; place-items: center; gap: 10px; min-height: 340px; color: var(--muted); font-size: .75rem; }
  .loading-state :global(svg) { color: var(--accent); animation: spin 1s linear infinite; }
  .list-footer { display: flex; justify-content: space-between; gap: 16px; margin-top: 42px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .57rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 1100px) { .media-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
  @media (max-width: 820px) { .my-list-page { padding-top: 72px; } .list-header { align-items: start; flex-direction: column; } .media-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 560px) { .list-header h1 { font-size: 3.4rem; } .media-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 10px; } .list-footer { align-items: start; flex-direction: column; } }
  @media (prefers-reduced-motion: reduce) { .status-chip, .loading-state :global(svg) { transition: none; animation: none; } }
</style>
