<script lang="ts" module>
  // MAV-FOCUSED — Shared Link Media Modal (2026-10).
  //
  // A single reusable component for linking an existing provider file to a
  // Mavero media item. Used by BOTH:
  //   * Media Library → "Link media" header button (Step A: TMDB search →
  //     Step B: provider file selection).
  //   * Missing Media → "Link Existing" (destination media item is already
  //     known from the demand row — skips Step A, goes directly to Step B).
  //
  // The TMDB search reuses the EXISTING `/api/admin/media/search` endpoint
  // (the same one AdminUploadFlow uses) — NOT the local `media_items` table
  // search. This ensures the admin can find ANY title in TMDB, even if it
  // has not yet been added to the Mavero catalog. The `linkAsset` server-
  // side handler creates the `media_item` if it doesn't already exist (via
  // `CanonicalMediaService.ensure*`), or reuses the existing one.
  //
  // The provider file picker has two tabs (Vidara / Abyss) with isolated
  // state — each tab carries its own inventory, search query, loading/
  // error state, and selected file. Terminal deleted/failed files are
  // excluded from the linkable list. Files already linked to a DIFFERENT
  // media item are shown with a "linked elsewhere" badge and disabled.
  //
  // Architecture:
  //   * Step A (TMDB search) — calls `/api/admin/media/search?q=…&type=…`
  //     (TMDB-backed, same as Upload/Import).
  //   * Step B (provider file) — calls `/api/admin/hosting/providers/
  //     [adapterId]/files` (real provider inventory via the adapter).
  //   * Confirm — calls `/api/admin/media/assets/link` with
  //     `{ mediaItemId, providerSourceId, providerAssetId }`.
  //   * When opened with `preselectedMediaItem` (Missing Media case),
  //     Step A is skipped entirely.

  export type TmdbSearchResult = {
    id: string;          // prefixed, e.g. "movie-12345"
    tmdbId: string;      // bare numeric, e.g. "12345"
    title: string;
    year?: number;
    poster?: string;
    type: 'movie' | 'series' | 'anime';
    overview?: string;
  };

  export type PreselectedMediaItem = {
    mediaItemId: string;
    title: string;
    contentType: string;
    tmdbId?: string;
    season?: number | null;
    episode?: number | null;
  };

  export type ProviderSource = {
    adapterId: string;
    name: string;
    sourceId: string;
  };
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Link2, Search, FileVideo, Check, AlertCircle, Loader2, Film, Tv, Sparkles, X } from 'lucide-svelte';

  // --- Props ---
  let {
    open = $bindable(false),
    providers = [] as ProviderSource[],
    preselectedMediaItem = null as PreselectedMediaItem | null,
    onclose = (() => {}) as () => void,
  }: {
    open?: boolean;
    providers?: ProviderSource[];
    preselectedMediaItem?: PreselectedMediaItem | null;
    onclose?: () => void;
  } = $props();

  // --- Step A: TMDB search ---
  let tmdbSearchQuery = $state('');
  let tmdbSearchType = $state<'movie' | 'series'>('movie');
  let tmdbSearching = $state(false);
  let tmdbResults = $state<TmdbSearchResult[]>([]);
  let tmdbError = $state<string | null>(null);
  let tmdbDebounce: ReturnType<typeof setTimeout> | null = null;
  let selectedMediaItem = $state<{ mediaItemId: string; title: string; contentType: string; tmdbId: string } | null>(null);

  // --- Step B: Provider file picker ---
  type LinkProviderTab = {
    adapterId: string;
    name: string;
    inventory: Array<{
      providerAssetId: string;
      title: string | null;
      filename: string | null;
      sizeBytes: number | null;
      durationSeconds: number | null;
      status: string;
      lifecycleState: string;
      linkedToMediaItemId: string | null;
    }>;
    loading: boolean;
    error: string | null;
    searchQuery: string;
    searchDebounce: ReturnType<typeof setTimeout> | null;
    selectedFile: { providerAssetId: string; title: string | null; filename: string | null } | null;
    loaded: boolean;
  };
  let providerTabs = $state<LinkProviderTab[]>([]);
  let activeTabId = $state<string | null>(null);
  let linkError = $state<string | null>(null);
  let linking = $state(false);
  let linkSuccess = $state<string | null>(null);

  // --- Derived ---
  let step = $derived(preselectedMediaItem ? 'provider' : (selectedMediaItem ? 'provider' : 'tmdb'));
  let activeTab = $derived(providerTabs.find((t) => t.adapterId === activeTabId) ?? null);

  // --- Lifecycle ---
  $effect(() => {
    if (open) {
      initModal();
    } else {
      resetState();
    }
  });

  onDestroy(() => {
    if (tmdbDebounce) clearTimeout(tmdbDebounce);
    for (const tab of providerTabs) {
      if (tab.searchDebounce) clearTimeout(tab.searchDebounce);
    }
  });

  function initModal() {
    resetState();
    // If preselected (Missing Media), set the media item directly.
    if (preselectedMediaItem) {
      selectedMediaItem = {
        mediaItemId: preselectedMediaItem.mediaItemId,
        title: preselectedMediaItem.title,
        contentType: preselectedMediaItem.contentType,
        tmdbId: preselectedMediaItem.tmdbId ?? '',
      };
    }
    // Build provider tabs.
    providerTabs = providers.map((p) => ({
      adapterId: p.adapterId,
      name: p.name,
      inventory: [],
      loading: false,
      error: null,
      searchQuery: '',
      searchDebounce: null,
      selectedFile: null,
      loaded: false,
    }));
    activeTabId = providerTabs[0]?.adapterId ?? null;
    // Lazy-load the first tab's inventory.
    if (activeTabId) void loadInventory(activeTabId);
  }

  function resetState() {
    tmdbSearchQuery = '';
    tmdbResults = [];
    tmdbError = null;
    tmdbSearching = false;
    selectedMediaItem = null;
    providerTabs = [];
    activeTabId = null;
    linkError = null;
    linking = false;
    linkSuccess = null;
    if (tmdbDebounce) { clearTimeout(tmdbDebounce); tmdbDebounce = null; }
  }

  // --- Step A: TMDB search (reuses the EXISTING /api/admin/media/search endpoint) ---
  function onTmdbSearchInput() {
    if (tmdbDebounce) clearTimeout(tmdbDebounce);
    tmdbDebounce = setTimeout(() => void doTmdbSearch(), 300);
  }

  async function doTmdbSearch() {
    const q = tmdbSearchQuery.trim();
    if (!q) { tmdbResults = []; return; }
    tmdbSearching = true;
    tmdbError = null;
    try {
      const res = await fetch(`/api/admin/media/search?q=${encodeURIComponent(q)}&type=${tmdbSearchType}`);
      const json = await res.json();
      if (json.ok) {
        tmdbResults = (json.results ?? []).map((r: any) => ({
          id: r.id,
          tmdbId: String(r.id).replace(/^(movie|series|anime)-/, ''),
          title: r.title,
          year: r.year,
          poster: r.poster,
          type: r.type ?? (tmdbSearchType === 'movie' ? 'movie' : 'series'),
          overview: r.overview ?? r.description,
        }));
      } else {
        tmdbResults = [];
        tmdbError = json.error?.message ?? 'Search failed.';
      }
    } catch (err) {
      tmdbResults = [];
      tmdbError = err instanceof Error ? err.message : 'Search failed.';
    } finally {
      tmdbSearching = false;
    }
  }

  function selectTmdbResult(result: TmdbSearchResult) {
    // The TMDB result's `id` is the prefixed canonical key (e.g.
    // "movie-24428"). This IS the `mediaItemId` that `linkAsset` expects —
    // it corresponds to the `media_items.id` column. If the media_item
    // doesn't exist yet, `linkAsset` will create it via
    // `CanonicalMediaService.ensure*`.
    selectedMediaItem = {
      mediaItemId: result.id,
      title: result.title,
      contentType: result.type,
      tmdbId: result.tmdbId,
    };
    // Reset provider-tab selections when a new media item is selected.
    for (const tab of providerTabs) {
      tab.selectedFile = null;
    }
    providerTabs = [...providerTabs];
  }

  // --- Step B: Provider file picker ---
  async function loadInventory(adapterId: string) {
    const tab = providerTabs.find((t) => t.adapterId === adapterId);
    if (!tab || tab.loaded || tab.loading) return;
    tab.loading = true;
    tab.error = null;
    try {
      const res = await fetch(`/api/admin/hosting/providers/${encodeURIComponent(adapterId)}/files`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.files)) {
        tab.inventory = data.files.map((f: any) => ({
          providerAssetId: f.providerAssetId,
          title: f.title ?? null,
          filename: f.filename ?? null,
          sizeBytes: f.sizeBytes ?? null,
          durationSeconds: f.durationSeconds ?? null,
          status: f.status ?? 'unknown',
          lifecycleState: f.lifecycleState ?? f.status ?? 'unknown',
          linkedToMediaItemId: f.linkedToMediaItemId ?? null,
        }));
      } else {
        tab.error = data.error?.message ?? 'Failed to load provider inventory.';
        tab.inventory = [];
      }
    } catch (err) {
      tab.error = err instanceof Error ? err.message : 'Failed to load provider inventory.';
      tab.inventory = [];
    } finally {
      tab.loading = false;
      tab.loaded = true;
      providerTabs = [...providerTabs];
    }
  }

  function selectTab(adapterId: string) {
    if (activeTabId === adapterId) return;
    activeTabId = adapterId;
    const tab = providerTabs.find((t) => t.adapterId === adapterId);
    if (tab && !tab.loaded) void loadInventory(adapterId);
  }

  function onProviderSearchInput(adapterId: string) {
    const tab = providerTabs.find((t) => t.adapterId === adapterId);
    if (!tab) return;
    if (tab.searchDebounce) clearTimeout(tab.searchDebounce);
    tab.searchDebounce = setTimeout(() => {
      providerTabs = [...providerTabs]; // trigger reactivity for filtered list
    }, 200);
  }

  function getFilteredInventory(tab: LinkProviderTab) {
    const q = tab.searchQuery.trim().toLowerCase();
    if (!q) return tab.inventory;
    return tab.inventory.filter((f) => {
      return (f.title ?? '').toLowerCase().includes(q)
        || (f.filename ?? '').toLowerCase().includes(q)
        || (f.providerAssetId ?? '').toLowerCase().includes(q);
    });
  }

  function isFileLinkable(file: { lifecycleState: string; linkedToMediaItemId: string | null }): boolean {
    if (file.lifecycleState === 'deleted' || file.lifecycleState === 'failed') return false;
    if (file.linkedToMediaItemId === '<deleted>') return false;
    if (file.linkedToMediaItemId && file.linkedToMediaItemId !== selectedMediaItem?.mediaItemId) return false;
    return true;
  }

  async function confirmLink() {
    if (!activeTab?.selectedFile || !selectedMediaItem) return;
    const file = activeTab.selectedFile;
    const sourceId = providers.find((p) => p.adapterId === activeTab.adapterId)?.sourceId;
    if (!sourceId) {
      linkError = `Could not resolve the Mavero source for provider "${activeTab.adapterId}".`;
      return;
    }
    linking = true;
    linkError = null;
    linkSuccess = null;
    try {
      const res = await fetch('/api/admin/media/assets/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaItemId: selectedMediaItem.mediaItemId,
          providerSourceId: sourceId,
          providerAssetId: file.providerAssetId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        linkSuccess = `Linked "${file.filename ?? file.title ?? file.providerAssetId}" to "${selectedMediaItem.title}".`;
        // Close after a brief delay so the success message is visible.
        setTimeout(() => {
          open = false;
          onclose();
        }, 800);
      } else {
        linkError = data.error?.message ?? 'Link failed.';
      }
    } catch (err) {
      linkError = err instanceof Error ? `Network error: ${err.message}` : 'Network error during link.';
    } finally {
      linking = false;
    }
  }

  function handleClose() {
    open = false;
    onclose();
  }

  function formatDuration(seconds: number | null): string {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }

  function formatSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
</script>

{#if open}
  <div class="modal-overlay" onclick={handleClose} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="link-media-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <h2 id="link-media-title"><Link2 size={16} /> Link media</h2>
        <button type="button" class="modal-close" onclick={handleClose} aria-label="Close"><X size={16} /></button>
      </div>

      {#if linkError}
        <div class="error-box" role="alert"><AlertCircle size={14} /><span>{linkError}</span></div>
      {/if}
      {#if linkSuccess}
        <div class="success-box" role="status"><Check size={14} /><span>{linkSuccess}</span></div>
      {/if}

      <!-- Step A: TMDB search (skipped when preselectedMediaItem is set) -->
      {#if step === 'tmdb'}
        <h3 class="modal-step">1. Search for a movie or series</h3>
        <div class="search-row">
          <div class="type-toggle" role="radiogroup" aria-label="Search type">
            <button type="button" class:active={tmdbSearchType === 'movie'} onclick={() => tmdbSearchType = 'movie'} role="radio" aria-checked={tmdbSearchType === 'movie'}>Movie</button>
            <button type="button" class:active={tmdbSearchType === 'series'} onclick={() => tmdbSearchType = 'series'} role="radio" aria-checked={tmdbSearchType === 'series'}>Series</button>
          </div>
        </div>
        <div class="search-row">
          <div class="search-input-wrap">
            <Search size={14} class="search-icon" />
            <input type="text" class="search-input" placeholder="Search TMDB by title…" bind:value={tmdbSearchQuery} oninput={onTmdbSearchInput} autocomplete="off" />
            {#if tmdbSearching}<Loader2 size={14} class="search-spinner" />{/if}
          </div>
        </div>
        <div class="results-list" style="max-height: 240px;">
          {#if tmdbError}
            <div class="results-empty"><AlertCircle size={14} /> {tmdbError}</div>
          {:else if tmdbResults.length === 0 && !tmdbSearching}
            <div class="results-empty">{tmdbSearchQuery.trim() ? `No results for "${tmdbSearchQuery}".` : 'Start typing to search TMDB.'}</div>
          {/if}
          {#each tmdbResults as result (result.id)}
            <button type="button" class="result-row" class:selected={selectedMediaItem?.mediaItemId === result.id} onclick={() => selectTmdbResult(result)}>
              <div class="result-icon">{#if result.type === 'movie'}<Film size={14} />{:else if result.type === 'anime'}<Sparkles size={14} />{:else}<Tv size={14} />{/if}</div>
              <div class="result-info">
                <div class="result-title">{result.title}</div>
                <div class="result-meta"><span>{result.type}</span>{#if result.year}<span>· {result.year}</span>{/if}<span>· TMDB {result.tmdbId}</span></div>
              </div>
              {#if selectedMediaItem?.mediaItemId === result.id}<span class="result-check"><Check size={14} /></span>{/if}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Step B: Provider file picker -->
      {#if step === 'provider'}
        <h3 class="modal-step">{preselectedMediaItem ? '1' : '2'}. Select a provider file</h3>
        <div class="selected-media-bar">
          <span class="selected-media-label">Linking to:</span>
          <strong>{selectedMediaItem?.title ?? 'Unknown'}</strong>
          {#if !preselectedMediaItem}
            <button type="button" class="change-media-btn" onclick={() => { selectedMediaItem = null; }}>Change</button>
          {/if}
        </div>

        {#if providerTabs.length === 0}
          <div class="results-empty">No hosting providers are configured.</div>
        {:else}
          <div class="tab-strip" role="tablist" aria-label="Provider">
            {#each providerTabs as tab (tab.adapterId)}
              <button type="button" class="tab-btn" class:active={activeTabId === tab.adapterId} role="tab" aria-selected={activeTabId === tab.adapterId} onclick={() => selectTab(tab.adapterId)}>
                {tab.name}
                {#if tab.loaded && !tab.loading}<span class="tab-count">{tab.inventory.length}</span>{/if}
              </button>
            {/each}
          </div>

          {#each providerTabs as tab (tab.adapterId)}
            <div role="tabpanel" hidden={activeTabId !== tab.adapterId} class="tab-panel">
              {#if tab.loading}
                <div class="loading-row"><Loader2 size={14} class="spinner" /> Loading {tab.name} inventory…</div>
              {:else if tab.error}
                <div class="error-box" role="alert"><AlertCircle size={14} /><span>{tab.error}</span></div>
              {:else}
                <div class="search-row">
                  <div class="search-input-wrap">
                    <Search size={14} class="search-icon" />
                    <input type="text" class="search-input" placeholder={`Search ${tab.name} files by filename, title, or ID…`} bind:value={tab.searchQuery} oninput={() => onProviderSearchInput(tab.adapterId)} autocomplete="off" />
                  </div>
                </div>
                <div class="results-list" style="max-height: 280px;">
                  {#if getFilteredInventory(tab).length === 0}
                    <div class="results-empty">{tab.searchQuery.trim() ? `No ${tab.name} files match.` : `No unlinked ${tab.name} files. Run a sync to discover files.`}</div>
                  {/if}
                  {#each getFilteredInventory(tab) as file (file.providerAssetId)}
                    {@const linkable = isFileLinkable(file)}
                    <button type="button" class="result-row" class:selected={tab.selectedFile?.providerAssetId === file.providerAssetId} class:disabled={!linkable} disabled={!linkable} onclick={() => { tab.selectedFile = { providerAssetId: file.providerAssetId, title: file.title, filename: file.filename }; providerTabs = [...providerTabs]; }} aria-disabled={!linkable}>
                      <div class="result-icon"><FileVideo size={14} /></div>
                      <div class="result-info">
                        <div class="result-title">{file.filename ?? file.title ?? file.providerAssetId}</div>
                        <div class="result-meta">
                          <span>{file.providerAssetId}</span>
                          <span>· {file.status}</span>
                          {#if file.durationSeconds}<span>· {formatDuration(file.durationSeconds)}</span>{/if}
                          {#if file.sizeBytes}<span>· {formatSize(file.sizeBytes)}</span>{/if}
                        </div>
                      </div>
                      {#if !linkable}
                        <span class="badge">{#if file.lifecycleState === 'deleted' || file.lifecycleState === 'failed'}{file.lifecycleState}{:else}linked elsewhere{/if}</span>
                      {:else if tab.selectedFile?.providerAssetId === file.providerAssetId}
                        <span class="result-check"><Check size={14} /></span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      {/if}

      <footer class="modal-actions">
        <button type="button" class="btn btn-cancel" onclick={handleClose}>Cancel</button>
        {#if step === 'provider'}
          <button type="button" class="btn btn-confirm" onclick={confirmLink} disabled={!activeTab?.selectedFile || !selectedMediaItem || linking}>
            {#if linking}<Loader2 size={12} class="spinner" /> Linking…{:else}<Link2 size={12} /> Link file{/if}
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .modal-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; }
  .modal { position: relative; z-index: 91; width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 64px); display: flex; flex-direction: column; background: var(--a2-surface-2, #1a1a1a); border: 1px solid var(--a2-border-strong, #333); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; }
  .modal-wide { width: min(720px, calc(100vw - 32px)); }

  .modal-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--a2-border, #222); }
  .modal-head h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 1rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); }
  .modal-close { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--a2-text-muted, #888); cursor: pointer; }
  .modal-close:hover { background: var(--a2-surface-3, #222); color: var(--a2-text, #ddd); }

  .modal-step { margin: 16px 20px 8px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--a2-text-muted, #888); }

  .selected-media-bar { display: flex; align-items: center; gap: 8px; padding: 8px 20px; background: var(--a2-cyan-soft, rgba(0,200,200,0.08)); border-bottom: 1px solid var(--a2-border, #222); font-size: 0.8rem; color: var(--a2-text, #ddd); }
  .selected-media-label { color: var(--a2-text-muted, #888); }
  .change-media-btn { margin-left: auto; background: transparent; border: 0; color: var(--a2-cyan, #0ff); font-size: 0.7rem; font-weight: 600; cursor: pointer; text-decoration: underline; }

  .search-row { padding: 0 20px; margin-bottom: 8px; }
  .type-toggle { display: inline-flex; gap: 2px; border: 1px solid var(--a2-border, #222); border-radius: 8px; overflow: hidden; }
  .type-toggle button { padding: 6px 14px; border: 0; background: transparent; color: var(--a2-text-muted, #888); font-size: 0.7rem; font-weight: 600; cursor: pointer; }
  .type-toggle button.active { background: var(--a2-cyan-soft, rgba(0,200,200,0.12)); color: var(--a2-cyan, #0ff); }

  .search-input-wrap { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 40px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; }
  .search-input-wrap:focus-within { border-color: var(--a2-cyan, #0ff); }
  .search-input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--a2-text, #ddd); font-size: 0.82rem; }
  .search-input::placeholder { color: var(--a2-text-dim, #555); }
  .search-icon { color: var(--a2-text-dim, #555); flex-shrink: 0; }
  .search-spinner { animation: spin 1s linear infinite; color: var(--a2-text-dim, #555); flex-shrink: 0; }
  .spinner { animation: spin 1s linear infinite; }

  .results-list { overflow-y: auto; padding: 0 20px 8px; display: flex; flex-direction: column; gap: 2px; }
  .results-empty { padding: 24px; text-align: center; color: var(--a2-text-dim, #555); font-size: 0.8rem; display: flex; align-items: center; justify-content: center; gap: 6px; }

  .result-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; cursor: pointer; text-align: left; transition: border-color 140ms ease; }
  .result-row:hover { border-color: var(--a2-cyan-border, #0a4); }
  .result-row.selected { border-color: var(--a2-cyan, #0ff); background: var(--a2-cyan-soft, rgba(0,200,200,0.08)); }
  .result-row.disabled { opacity: 0.5; cursor: not-allowed; }
  .result-row.disabled:hover { border-color: var(--a2-border, #222); }
  .result-icon { display: flex; align-items: center; color: var(--a2-text-dim, #555); flex-shrink: 0; }
  .result-info { flex: 1; min-width: 0; }
  .result-title { font-size: 0.8rem; color: var(--a2-text-bright, #f0f0f0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-meta { display: flex; gap: 4px; font-size: 0.6rem; color: var(--a2-text-dim, #555); text-transform: uppercase; letter-spacing: 0.04em; }
  .result-check { color: var(--a2-cyan, #0ff); flex-shrink: 0; }
  .badge { display: inline-flex; padding: 2px 8px; border-radius: 999px; background: rgba(220,60,60,0.15); color: #c44; border: 1px solid rgba(220,60,60,0.3); font-size: 0.55rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0; }

  .tab-strip { display: flex; gap: 4px; padding: 0 20px; margin-bottom: 8px; border-bottom: 1px solid var(--a2-border, #222); }
  .tab-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--a2-text-muted, #888); font-size: 0.72rem; font-weight: 600; cursor: pointer; transition: color 140ms ease, border-color 140ms ease; }
  .tab-btn:hover { color: var(--a2-text, #ddd); }
  .tab-btn.active { color: var(--a2-cyan, #0ff); border-bottom-color: var(--a2-cyan, #0ff); }
  .tab-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 16px; padding: 0 5px; border-radius: 999px; background: var(--a2-surface-3, #1a1a1a); color: var(--a2-text-dim, #555); font-size: 10px; font-weight: 700; }
  .tab-btn.active .tab-count { background: var(--a2-cyan-soft, rgba(0,200,200,0.12)); color: var(--a2-cyan, #0ff); }
  .tab-panel { flex: 1; overflow-y: auto; padding-bottom: 8px; }

  .loading-row { display: flex; align-items: center; gap: 8px; padding: 24px 20px; color: var(--a2-text-muted, #888); font-size: 0.8rem; }

  .error-box { display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin: 8px 20px; border: 1px solid rgba(220,60,60,0.3); border-radius: 8px; background: rgba(220,60,60,0.08); color: #c44; font-size: 0.75rem; }
  .success-box { display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin: 8px 20px; border: 1px solid rgba(53,214,143,0.3); border-radius: 8px; background: rgba(53,214,143,0.08); color: #35d68f; font-size: 0.75rem; }

  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--a2-border, #222); }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font-size: 0.78rem; font-weight: 700; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
  .btn-cancel { background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .btn-cancel:hover { background: var(--a2-surface-4, #222); color: var(--a2-text, #ddd); }
  .btn-confirm { background: var(--a2-cyan-soft, rgba(0,200,200,0.12)); border-color: var(--a2-cyan-border, #0a4); color: var(--a2-cyan, #0ff); }
  .btn-confirm:hover { background: rgba(0,200,200,0.2); }
  .btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }

  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
