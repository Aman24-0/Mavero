<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ArrowRight, Bookmark, CheckCircle2, Clock3, Eye, ListVideo, LoaderCircle, CheckSquare, Square, Trash2, X } from 'lucide-svelte';
  import type { PageData } from './$types';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import ConfirmDialog from '$components/ConfirmDialog.svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
  import { batchRemoveFromMyList, batchSetFavoriteStatus, getLocalFavorites, getLocalPersistenceState, getLocalProgressRecords, type FavoriteIdentity } from '$lib/client/progress/service';
  import { listFavoriteDeletions } from '$lib/client/progress/database';
  import { favoriteToMedia } from '$lib/client/progress/presenter';
  import { batchDeleteCloudFavorites, syncAuthenticatedState, type SyncStatus } from '$lib/client/progress/cloud';
  import { normalizeWatchlistStatus, type FavoriteRecord, type WatchlistStatus, type LocalContentType } from '$lib/client/progress/types';
  import { mergeFavoritesWithProgress } from '$lib/shared/progress-merge';
  import { haptic } from '$lib/client/haptics';
  import { showSuccessToast, showErrorToast } from '$lib/client/toast.svelte';

  let { data }: { data: PageData } = $props();
  let records = $state<FavoriteRecord[]>([]);
  let progressRecords = $state<import('$lib/client/progress/types').WatchProgressRecord[]>([]);
  let loaded = $state(false);
  let errorMessage = $state('');
  let storageMessage = $state('Preparing your library…');
  let syncStatus = $state<SyncStatus>('pending');

  // ============================================================
  // Selection state — keyed by the stable favorite identity
  // (contentType + contentId), NEVER by array index. This survives
  // re-ordering, re-sorting, and partial list refreshes.
  // ============================================================
  let selectionMode = $state(false);
  let selectedKeys = $state<Set<string>>(new Set());
  let busy = $state(false);
  let confirmOpen = $state(false);
  let statusSheetOpen = $state(false);

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
  let selectedCount = $derived(selectedKeys.size);
  let allVisibleSelected = $derived(visibleRecords.length > 0 && visibleRecords.every((record) => selectedKeys.has(record.key)));

  function chipHref(status: WatchlistStatus) { const params = new URLSearchParams(page.url.searchParams); if (selectedStatus === status) params.delete('status'); else params.set('status', status); const query = params.toString(); return query ? `/my-list?${query}` : '/my-list'; }
  async function selectStatus(status: WatchlistStatus) { await goto(chipHref(status), { replaceState: true, keepFocus: true, noScroll: true }); }
  function syncStatusLabel(status: SyncStatus) { return ({ synced: 'Synced across devices', syncing: 'Syncing your library…', pending: 'Local-first library', offline: 'Offline · Local cache active', error: 'Cloud sync will retry later' } satisfies Record<SyncStatus, string>)[status]; }

  // ============================================================
  // Selection operations. The identity is always FavoriteRecord.key
  // which equals `${contentType}:${contentId}`. We never use array
  // index as identity — array indexes can shift on sort / re-fetch.
  // ============================================================
  function identityOf(item: MediaItem): FavoriteIdentity {
    return { contentType: item.type as LocalContentType, contentId: item.id };
  }
  function keyOf(item: MediaItem): string { return `${item.type}:${item.id}`; }

  function toggleSelectionMode() {
    if (busy) return;
    selectionMode = !selectionMode;
    if (!selectionMode) clearSelection();
    haptic('light');
  }
  function clearSelection() {
    if (selectedKeys.size > 0) selectedKeys = new Set();
  }
  function toggleSelect(item: MediaItem) {
    if (busy) return;
    const key = keyOf(item);
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    selectedKeys = next;
  }
  function toggleSelectAllVisible() {
    if (busy) return;
    if (allVisibleSelected) {
      // Deselect only the visible ones (keep selections for other status
      // filters intact, though My List only shows one filter at a time
      // — this is still defensive).
      const next = new Set(selectedKeys);
      for (const record of visibleRecords) next.delete(record.key);
      selectedKeys = next;
    } else {
      const next = new Set(selectedKeys);
      for (const record of visibleRecords) next.add(record.key);
      selectedKeys = next;
    }
    haptic('light');
  }
  function toggleSelectItem(item: MediaItem) {
    toggleSelect(item);
  }

  // ============================================================
  // Batch status change.
  //
  // Single source of truth: whether 1 title or N titles are selected,
  // the same code path runs `batchSetFavoriteStatus` (which reuses
  // `saveFavorite` semantics so createdAt/snapshot are preserved).
  // After the local update completes we fire ONE cloud sync (not
  // one per item). Selection clears automatically on success.
  // ============================================================
  function openStatusSheet() {
    if (busy || selectedCount === 0) return;
    statusSheetOpen = true;
  }
  async function applyStatusChange(status: WatchlistStatus) {
    statusSheetOpen = false;
    if (busy || selectedCount === 0) return;
    const items: FavoriteIdentity[] = [...selectedKeys].map((key) => {
      const [contentType, ...rest] = key.split(':');
      return { contentType: contentType as LocalContentType, contentId: rest.join(':') };
    });
    busy = true;
    try {
      const result = await batchSetFavoriteStatus(items, status);
      await refreshLocalState();
      if (data.user) void syncAuthenticatedState();
      haptic('success');
      const label = statusOptions.find((opt) => opt.value === status)?.label ?? 'My List';
      const count = result.succeeded.length;
      if (count > 0) {
        showSuccessToast(`${count} ${count === 1 ? 'title' : 'titles'} moved to ${label}`);
        clearSelection();
        selectionMode = false;
      }
      if (result.failed.length > 0) {
        showErrorToast(`${result.failed.length} ${result.failed.length === 1 ? 'title' : 'titles'} could not be updated. Please try again.`);
      }
    } catch {
      showErrorToast('Could not update the selected titles. Please try again.');
    } finally {
      busy = false;
    }
  }

  // ============================================================
  // Batch delete.
  //
  // Single source of truth: 1 title or N titles go through the same
  // path. Local-first deletion (reusing `removeFavoriteFromMyList`
  // for each identity, which preserves writer-invalidation race
  // safety), then ONE atomic cloud RPC for all identities at once.
  // The RPC writes a tombstone per identity, so deleted titles
  // cannot resurrect during the next sync.
  // ============================================================
  function openDeleteConfirm() {
    if (busy || selectedCount === 0) return;
    confirmOpen = true;
  }
  function closeDeleteConfirm() {
    if (busy) return;
    confirmOpen = false;
  }
  async function applyDelete() {
    if (busy || selectedCount === 0) return;
    confirmOpen = false;
    const items: FavoriteIdentity[] = [...selectedKeys].map((key) => {
      const [contentType, ...rest] = key.split(':');
      return { contentType: contentType as LocalContentType, contentId: rest.join(':') };
    });
    const expectedCount = items.length;
    busy = true;
    try {
      // 1. Local-first: invalidate writers, drain in-flight flushes,
      //    delete ALL watch_progress for each title, delete favorite,
      //    persist tombstone. Reuses the existing race-safe primitive.
      const localResult = await batchRemoveFromMyList(items);
      // 2. Cloud: one atomic RPC for all identities (favorites +
      //    progress + tombstones). For unauthenticated users this is
      //    a no-op (the local tombstone is enough for cross-tab sync).
      let cloudFailed = false;
      if (data.user) {
        const cloud = await batchDeleteCloudFavorites(localResult.succeeded.map((it) => ({ contentType: it.contentType, contentId: it.contentId })));
        if (!cloud.ok || cloud.failed.length > 0) cloudFailed = true;
        // Always refresh local state from the authoritative cloud after
        // a cloud operation — the sync may have reconciled other rows.
        await syncAuthenticatedState().then(async (synced) => {
          if (synced.authenticated) {
            progressRecords = synced.progress;
            records = mergeFavoritesWithProgress(synced.favorites, synced.progress, synced.favoriteDeletions);
            syncStatus = synced.status;
          }
        }).catch(() => { /* sync errors are surfaced via syncStatus */ });
      }
      await refreshLocalState();

      const removedCount = localResult.succeeded.length;
      if (cloudFailed && data.user) {
        // Cloud failed but local succeeded. The local tombstone ensures
        // the title cannot resurrect on next sync, and a retry will
        // happen automatically. Be honest about the partial result.
        showErrorToast(removedCount > 0
          ? `${removedCount} ${removedCount === 1 ? 'title' : 'titles'} removed locally. Cloud sync will retry.`
          : 'Could not remove the selected titles. Please try again.');
        // Even on cloud failure, the local removal is committed and the
        // title is gone from the UI. Clear selection + close mode so the
        // user can see the result.
        clearSelection();
        selectionMode = false;
        haptic('destructive');
        return;
      }
      if (removedCount > 0) {
        showSuccessToast(`${removedCount} ${removedCount === 1 ? 'title' : 'titles'} removed from My List`);
        clearSelection();
        selectionMode = false;
        haptic('destructive');
      }
      if (localResult.failed.length > 0 && removedCount === 0) {
        showErrorToast('Could not remove the selected titles. Please try again.');
      }
      // Sanity check: if nothing was removed and nothing failed, the
      // selection was empty (shouldn't happen — we checked above).
      if (removedCount === 0 && localResult.failed.length === 0 && expectedCount > 0) {
        showErrorToast('Could not remove the selected titles. Please try again.');
      }
    } catch {
      showErrorToast('Could not remove the selected titles. Please try again.');
    } finally {
      busy = false;
    }
  }

  async function refreshLocalState() {
    const [favorites, progress, deletions] = await Promise.all([getLocalFavorites(), getLocalProgressRecords(), listFavoriteDeletions()]);
    progressRecords = progress;
    records = mergeFavoritesWithProgress(favorites, progress, deletions);
  }

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
      <!-- Simplified header: only the eyebrow (promoted to the page
           heading) and the sync status line. The previous H1 "My List"
           and the marketing subtitle have been removed. -->
      <div class="header-eyebrow" aria-label="MAVERO / My List">
        <Bookmark size={13} /> MAVERO / My List
      </div>
      <div class="header-status-row">
        <div class="list-status" aria-live="polite">
          <span class:online={syncStatus === 'synced'} class:syncing={syncStatus === 'syncing'}></span>
          {syncStatusLabel(syncStatus)}
        </div>
        <button
          class="select-toggle"
          type="button"
          aria-pressed={selectionMode}
          aria-label={selectionMode ? 'Exit selection mode' : 'Select titles to manage'}
          onclick={toggleSelectionMode}
          disabled={busy}
        >
          {#if selectionMode}<X size={14} />{:else}<CheckSquare size={14} />{/if}
          <span>{selectionMode ? 'Done' : 'Select'}</span>
        </button>
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
          <div class="section-actions">
            {#if selectionMode}
              <button
                class="quiet-btn"
                type="button"
                onclick={toggleSelectAllVisible}
                disabled={busy}
                aria-pressed={allVisibleSelected}
              >
                {#if allVisibleSelected}<Square size={13} />{:else}<CheckSquare size={13} />{/if}
                <span>{allVisibleSelected ? 'Deselect all' : 'Select all'}</span>
              </button>
            {/if}
            {#if selectedStatus && !selectionMode}
              <a class="quiet-link" href="/my-list">Show all <ArrowRight size={14} /></a>
            {/if}
          </div>
        </div>
        <div class="media-grid">
          {#each visibleItems as item (item.type + ':' + item.id)}
            <MediaCard
              {item}
              editorial
              selectable={selectionMode}
              selected={selectedKeys.has(`${item.type}:${item.id}`)}
              onSelect={toggleSelectItem}
            />
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
</div>

<!-- Floating action bar — appears when ≥1 titles are selected. ONE shared
     implementation for single + batch status change and single + batch
     delete, so the two can never drift apart. -->
{#if selectionMode && selectedCount > 0}
  <div class="action-bar" role="toolbar" aria-label="Selected titles actions">
    <div class="action-bar-inner">
      <span class="action-bar-count">{selectedCount} selected</span>
      <div class="action-bar-actions">
        <button class="action-btn" type="button" onclick={openStatusSheet} disabled={busy}>
          Status
        </button>
        <button class="action-btn action-btn-danger" type="button" onclick={openDeleteConfirm} disabled={busy}>
          <Trash2 size={14} /> Delete
        </button>
      </div>
    </div>
  </div>
{/if}

<ScrollToTop />

<ConfirmDialog
  open={confirmOpen}
  eyebrow="MAVERO / Remove from My List"
  title={selectedCount === 1 ? 'Remove this title from My List?' : `Remove ${selectedCount} titles from My List?`}
  description="Saved playback progress for {selectedCount === 1 ? 'this title' : 'these titles'} will also be removed. You can always add {selectedCount === 1 ? 'it' : 'them'} back from a detail page."
  primaryLabel={selectedCount === 1 ? 'Remove' : `Remove ${selectedCount}`}
  tone="danger"
  primaryDisabled={busy}
  cancelDisabled={busy}
  onCancel={closeDeleteConfirm}
  onPrimary={applyDelete}
/>

<SelectionSheet
  open={statusSheetOpen}
  eyebrow="MAVERO / Move to"
  title={selectedCount === 1 ? 'Move 1 title to' : `Move ${selectedCount} titles to`}
  options={statusOptions.map((opt) => ({ key: opt.value, label: opt.label, description: opt.description }))}
  selected=""
  onClose={() => { if (!busy) statusSheetOpen = false; }}
  onSelect={(key) => { if (key === 'watching' || key === 'planned' || key === 'completed') void applyStatusChange(key); }}
/>

<style>
  .my-list-page {
    --l-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    /* Reserve room for the floating action bar when it appears. */
    padding-bottom: calc(110px + env(safe-area-inset-bottom, 0px));
  }

  .list-header {
    /* The shell already adds the topbar offset via --shell-content-top.
       We only add a deliberate per-page breathing room here. */
    padding: 28px var(--l-gutter) 18px;
    border-bottom: 1px solid rgba(255,255,255,.05);
    background:
      radial-gradient(circle at 80% -20%, rgba(255,255,255,.04), transparent 50%),
      #000;
  }
  .header-inner { width: min(1400px, 100%); margin-inline: auto; }
  .header-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    color: #f5f5f5;
    font-size: clamp(1.4rem, 4vw, 2rem);
    font-weight: 800;
    letter-spacing: -.02em;
    line-height: 1.1;
  }
  .header-eyebrow :global(svg) { color: #b7b7bd; }
  .header-status-row {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    margin-top: 10px;
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

  .select-toggle {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 36px;
    padding: 0 14px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.06);
    font: inherit;
    font-size: .72rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease, color 180ms ease;
  }
  .select-toggle:hover:not(:disabled) { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.28); }
  .select-toggle:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }
  .select-toggle[aria-pressed="true"] {
    color: #000; border-color: #f5f5f5; background: #f5f5f5;
  }
  .select-toggle:disabled { opacity: .5; cursor: not-allowed; }

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
  .section-actions { display: inline-flex; align-items: center; gap: 10px; }
  .quiet-link {
    display: inline-flex; align-items: center; gap: 6px;
    color: #77777f;
    font-size: .7rem; font-weight: 700;
    text-decoration: none;
    transition: color 180ms ease;
  }
  .quiet-link:hover { color: #f5f5f5; }
  .quiet-btn {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.04);
    font: inherit;
    font-size: .68rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .quiet-btn:hover:not(:disabled) { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.28); }
  .quiet-btn:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }
  .quiet-btn:disabled { opacity: .5; cursor: not-allowed; }
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

  /* Floating action bar. Sits above the floating bottom nav. */
  .action-bar {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    bottom: calc(96px + env(safe-area-inset-bottom, 0px));
    width: min(calc(100% - 24px), 520px);
    animation: action-in 200ms cubic-bezier(.22, 1, .36, 1);
  }
  .action-bar-inner {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 9px 12px 9px 16px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    background: rgba(20, 20, 24, .94);
    backdrop-filter: blur(14px);
    box-shadow: 0 12px 36px rgba(0, 0, 0, .55);
  }
  .action-bar-count {
    color: #f5f5f5;
    font-size: .74rem; font-weight: 700;
    letter-spacing: -.005em;
  }
  .action-bar-actions { display: inline-flex; gap: 6px; }
  .action-btn {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.06);
    font: inherit;
    font-size: .72rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .action-btn:hover:not(:disabled) { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.28); }
  .action-btn:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }
  .action-btn:disabled { opacity: .5; cursor: not-allowed; }
  .action-btn-danger {
    border-color: rgba(255,176,32,.42);
    background: rgba(255,176,32,.16);
    color: #ffd478;
  }
  .action-btn-danger:hover:not(:disabled) {
    background: rgba(255,176,32,.28);
    border-color: rgba(255,176,32,.6);
    color: #fff;
  }
  @keyframes action-in {
    from { opacity: 0; transform: translateX(-50%) translateY(8px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  @media (max-width: 760px) {
    .list-header { padding-top: 22px; }
    .header-status-row { gap: 10px; }
  }
  @media (max-width: 640px) {
    .status-chip { min-height: 36px; padding: 0 11px; font-size: .68rem; gap: 6px; }
    .media-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 11px; }
    .empty-state { padding: 36px 18px; }
    .action-bar { width: min(calc(100% - 18px), 480px); }
  }
  @media (min-width: 900px) {
    .list-header { padding-top: 36px; padding-bottom: 26px; }
    .header-eyebrow { font-size: clamp(1.8rem, 3.2vw, 2.2rem); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-chip, .loading-state :global(svg), .list-status span.syncing, .empty-action, .action-bar { transition: none; animation: none; }
  }
</style>
