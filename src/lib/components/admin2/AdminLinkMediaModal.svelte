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
  // The TMDB search reuses the EXISTING `/api/admin/media/search` endpoint.
  // The link endpoint resolves the canonical media_item UUID server-side
  // via CanonicalMediaService.ensure* — the client sends the TMDB type +
  // bare TMDB ID, NOT a fabricated UUID or prefixed canonical key.
  //
  // MAV-FOCUSED fix (reactive loop + UUID contract):
  //   * Modal initialization is driven by a `$derived` snapshot of the
  //     `open` prop — NOT a `$effect` that reads/writes reactive state
  //     it itself mutates. The snapshot is compared to the previous one;
  //     init runs only when `open` transitions false→true.
  //   * Inventory requests use AbortController + a 15s timeout. Stale
  //     responses are ignored (session token check).
  //   * The `mediaItemId` sent to the link endpoint is the bare TMDB ID +
  //     content type — the server resolves it to a real UUID.

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
    title: string;
    contentType: string;
    tmdbId: string;
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
  import { onDestroy } from 'svelte';
  import { Link2, Search, FileVideo, Check, AlertCircle, Loader2, Film, Tv, Sparkles, X, RotateCcw } from 'lucide-svelte';

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

  // --- Step A: TMDB search state ---
  let tmdbSearchQuery = $state('');
  let tmdbSearchType = $state<'movie' | 'series'>('movie');
  let tmdbSearching = $state(false);
  let tmdbResults = $state<TmdbSearchResult[]>([]);
  let tmdbError = $state<string | null>(null);
  let tmdbDebounce: ReturnType<typeof setTimeout> | null = null;

  // The selected media item carries the TMDB identity (type + bare TMDB ID).
  // The server resolves this to a real media_items UUID via
  // CanonicalMediaService.ensure*.
  let selectedMedia = $state<{
    title: string;
    contentType: string;
    tmdbId: string;
    season?: number | null;
    episode?: number | null;
  } | null>(null);

  // --- Step B: Provider file picker state ---
  type ProviderTab = {
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
    selectedFile: { providerAssetId: string; title: string | null; filename: string | null } | null;
    loaded: boolean;
  };

  // Non-reactive mutable state — NOT tracked by $effect.
  // Using a plain object + manual re-render trigger.
  let tabsData: ProviderTab[] = [];
  let tabsVersion = $state(0); // bump to trigger re-render
  let activeTabId = $state<string | null>(null);
  let linkError = $state<string | null>(null);
  let linking = $state(false);
  let linkSuccess = $state<string | null>(null);

  // Session token for stale-response protection.
  let sessionToken = 0;
  // AbortControllers for in-flight inventory requests.
  const abortControllers = new Map<string, AbortController>();

  // --- Derived ---
  let step = $derived(preselectedMediaItem ? 'provider' : (selectedMedia ? 'provider' : 'tmdb'));

  function getActiveTab(): ProviderTab | null {
    return tabsData.find((t) => t.adapterId === activeTabId) ?? null;
  }

  function bumpTabs() { tabsVersion += 1; }

  // --- Modal initialization (lifecycle-safe) ---
  // Track the previous `open` value to detect false→true transitions.
  let prevOpen = false;

  $effect(() => {
    const isOpen = open;
    if (isOpen && !prevOpen) {
      // Modal just opened — initialize once.
      prevOpen = true;
      initModal();
    } else if (!isOpen && prevOpen) {
      // Modal just closed — cleanup.
      prevOpen = false;
      cleanupModal();
    }
  });

  function initModal() {
    // Cancel any in-flight requests from a previous session.
    cancelAllRequests();
    sessionToken += 1; // invalidate stale responses

    // Reset TMDB search state.
    tmdbSearchQuery = '';
    tmdbResults = [];
    tmdbError = null;
    tmdbSearching = false;
    if (tmdbDebounce) { clearTimeout(tmdbDebounce); tmdbDebounce = null; }

    // Reset link state.
    linkError = null;
    linking = false;
    linkSuccess = null;

    // Set the selected media item.
    if (preselectedMediaItem) {
      selectedMedia = {
        title: preselectedMediaItem.title,
        contentType: preselectedMediaItem.contentType,
        tmdbId: preselectedMediaItem.tmdbId,
        season: preselectedMediaItem.season ?? null,
        episode: preselectedMediaItem.episode ?? null,
      };
    } else {
      selectedMedia = null;
    }

    // Build provider tabs from a snapshot of the providers prop.
    tabsData = providers.map((p) => ({
      adapterId: p.adapterId,
      name: p.name,
      inventory: [],
      loading: false,
      error: null,
      searchQuery: '',
      selectedFile: null,
      loaded: false,
    }));
    activeTabId = tabsData[0]?.adapterId ?? null;
    bumpTabs();

    // Lazy-load the first tab's inventory.
    if (activeTabId) void loadInventory(activeTabId);
  }

  function cleanupModal() {
    cancelAllRequests();
    sessionToken += 1;
    if (tmdbDebounce) { clearTimeout(tmdbDebounce); tmdbDebounce = null; }
    selectedMedia = null;
    tabsData = [];
    activeTabId = null;
    bumpTabs();
  }

  function cancelAllRequests() {
    for (const [, controller] of abortControllers) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
    abortControllers.clear();
  }

  onDestroy(() => {
    cancelAllRequests();
    if (tmdbDebounce) clearTimeout(tmdbDebounce);
  });

  // --- Step A: TMDB search ---
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
    // Store the TMDB identity (type + bare TMDB ID). The server resolves
    // this to a real media_items UUID — the client NEVER sends a prefixed
    // canonical key as a UUID.
    selectedMedia = {
      title: result.title,
      contentType: result.type,
      tmdbId: result.tmdbId,
    };
    // Reset provider-tab file selections.
    for (const tab of tabsData) {
      tab.selectedFile = null;
    }
    bumpTabs();
  }

  // --- Step B: Provider file picker ---
  async function loadInventory(adapterId: string) {
    const tab = tabsData.find((t) => t.adapterId === adapterId);
    if (!tab || tab.loaded || tab.loading) return;

    const mySession = sessionToken;
    const controller = new AbortController();
    abortControllers.set(adapterId, controller);

    tab.loading = true;
    tab.error = null;
    bumpTabs();

    // Bounded timeout — 15 seconds. A hung provider request must not
    // leave the modal permanently loading.
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(`/api/admin/hosting/providers/${encodeURIComponent(adapterId)}/files`, {
        signal: controller.signal,
      });
      const data = await res.json();

      // Ignore stale responses (modal was closed/reopened).
      if (mySession !== sessionToken) return;

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
        tab.loaded = true;
      } else {
        tab.error = data.error?.message ?? 'Failed to load provider inventory.';
        tab.inventory = [];
        tab.loaded = false; // allow retry
      }
    } catch (err: any) {
      if (mySession !== sessionToken) return;
      if (err?.name === 'AbortError') {
        tab.error = 'Request timed out. Click Retry to try again.';
      } else {
        tab.error = err instanceof Error ? err.message : 'Failed to load provider inventory.';
      }
      tab.inventory = [];
      tab.loaded = false; // allow retry
    } finally {
      clearTimeout(timeoutId);
      abortControllers.delete(adapterId);
      if (mySession === sessionToken) {
        tab.loading = false;
        bumpTabs();
      }
    }
  }

  function retryInventory(adapterId: string) {
    const tab = tabsData.find((t) => t.adapterId === adapterId);
    if (!tab) return;
    tab.loaded = false;
    tab.error = null;
    void loadInventory(adapterId);
  }

  function selectTab(adapterId: string) {
    if (activeTabId === adapterId) return;
    activeTabId = adapterId;
    const tab = tabsData.find((t) => t.adapterId === adapterId);
    if (tab && !tab.loaded && !tab.loading) void loadInventory(adapterId);
  }

  function getFilteredInventory(tab: ProviderTab) {
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
    // Unlinked assets (mavero_status='missing') are surfaced with
    // linkedToMediaItemId=null by the server — they are always linkable.
    if (!file.linkedToMediaItemId) return true;
    // Actively linked to another title — NOT linkable (must unlink first).
    return false;
  }

  async function confirmLink() {
    const tab = getActiveTab();
    if (!tab?.selectedFile || !selectedMedia) return;
    const file = tab.selectedFile;
    const sourceId = providers.find((p) => p.adapterId === tab.adapterId)?.sourceId;
    if (!sourceId) {
      linkError = `Could not resolve the Mavero source for provider "${tab.adapterId}".`;
      return;
    }
    linking = true;
    linkError = null;
    linkSuccess = null;
    try {
      // Send the TMDB identity (contentType + tmdbId + season/episode) —
      // the server resolves this to a real media_items UUID via
      // CanonicalMediaService.ensure*.
      const body: Record<string, string> = {
        providerSourceId: sourceId,
        providerAssetId: file.providerAssetId,
        contentType: selectedMedia.contentType,
        tmdbId: selectedMedia.tmdbId,
      };
      if (selectedMedia.season != null) body.season = String(selectedMedia.season);
      if (selectedMedia.episode != null) body.episode = String(selectedMedia.episode);

      const res = await fetch('/api/admin/media/assets/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        linkSuccess = `Linked "${file.filename ?? file.title ?? file.providerAssetId}" to "${selectedMedia.title}".`;
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
            <button type="button" class="result-row" class:selected={selectedMedia?.tmdbId === result.tmdbId} onclick={() => selectTmdbResult(result)}>
              <div class="result-icon">{#if result.type === 'movie'}<Film size={14} />{:else if result.type === 'anime'}<Sparkles size={14} />{:else}<Tv size={14} />{/if}</div>
              <div class="result-info">
                <div class="result-title">{result.title}</div>
                <div class="result-meta"><span>{result.type}</span>{#if result.year}<span>· {result.year}</span>{/if}<span>· TMDB {result.tmdbId}</span></div>
              </div>
              {#if selectedMedia?.tmdbId === result.tmdbId}<span class="result-check"><Check size={14} /></span>{/if}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Step B: Provider file picker -->
      {#if step === 'provider'}
        <h3 class="modal-step">{preselectedMediaItem ? '1' : '2'}. Select a provider file</h3>
        <div class="selected-media-bar">
          <span class="selected-media-label">Linking to:</span>
          <strong>{selectedMedia?.title ?? 'Unknown'}</strong>
          {#if !preselectedMediaItem}
            <button type="button" class="change-media-btn" onclick={() => { selectedMedia = null; }}>Change</button>
          {/if}
        </div>

        {#if tabsData.length === 0}
          <div class="results-empty">No hosting providers are configured.</div>
        {:else}
          <div class="tab-strip" role="tablist" aria-label="Provider">
            {#each tabsData as tab (tab.adapterId)}
              <button type="button" class="tab-btn" class:active={activeTabId === tab.adapterId} role="tab" aria-selected={activeTabId === tab.adapterId} onclick={() => selectTab(tab.adapterId)}>
                {tab.name}
                {#if tab.loaded && !tab.loading}<span class="tab-count">{tab.inventory.length}</span>{/if}
              </button>
            {/each}
          </div>

          {#each tabsData as tab (tab.adapterId)}
            <div role="tabpanel" hidden={activeTabId !== tab.adapterId} class="tab-panel">
              {#if tab.loading}
                <div class="loading-row"><Loader2 size={14} class="spinner" /> Loading {tab.name} inventory…</div>
              {:else if tab.error}
                <div class="error-box-inline" role="alert">
                  <AlertCircle size={14} />
                  <span>{tab.error}</span>
                  <button type="button" class="retry-btn" onclick={() => retryInventory(tab.adapterId)}><RotateCcw size={12} /> Retry</button>
                </div>
              {:else}
                <div class="search-row">
                  <div class="search-input-wrap">
                    <Search size={14} class="search-icon" />
                    <input type="text" class="search-input" placeholder={`Search ${tab.name} files by filename, title, or ID…`} bind:value={tab.searchQuery} oninput={() => bumpTabs()} autocomplete="off" />
                  </div>
                </div>
                <div class="results-list" style="max-height: 280px;">
                  {#if getFilteredInventory(tab).length === 0}
                    <div class="results-empty">{tab.searchQuery.trim() ? `No ${tab.name} files match.` : `No unlinked ${tab.name} files available. Run a sync to discover files.`}</div>
                  {/if}
                  {#each getFilteredInventory(tab) as file (file.providerAssetId)}
                    {@const linkable = isFileLinkable(file)}
                    <button type="button" class="result-row" class:selected={tab.selectedFile?.providerAssetId === file.providerAssetId} class:disabled={!linkable} disabled={!linkable} onclick={() => { tab.selectedFile = { providerAssetId: file.providerAssetId, title: file.title, filename: file.filename }; bumpTabs(); }} aria-disabled={!linkable}>
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
          <button type="button" class="btn btn-confirm" onclick={confirmLink} disabled={!getActiveTab()?.selectedFile || !selectedMedia || linking}>
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
  .error-box-inline { display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin: 8px 20px; border: 1px solid rgba(220,60,60,0.3); border-radius: 8px; background: rgba(220,60,60,0.08); color: #c44; font-size: 0.75rem; }
  .retry-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; margin-left: auto; border: 1px solid rgba(220,60,60,0.4); border-radius: 6px; background: transparent; color: #c44; font-size: 0.65rem; font-weight: 700; cursor: pointer; }
  .retry-btn:hover { background: rgba(220,60,60,0.15); }

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
