<script lang="ts" module>
  // MAV-FOCUSED — Compact Media Library list with Add File wizard (2026-10).
  //
  // Replaces the old AdminHostingAssets (2262 lines) with a simple list:
  //   * Compact rows: poster, title, type, TMDB ID, provider, 3-dot menu.
  //   * Add File wizard: TMDB search → provider selection → reference entry → save.
  //   * Three-dot menu: Delete (Mavero-side only) + Update link.
  //
  // Uses the new /api/admin/media/manual-link endpoint for create/update/delete.
  // Uses the existing /api/admin/media/search endpoint for TMDB search.
  // Uses the existing /api/admin/media/library endpoint for the list.

  export type MediaRow = {
    id: string;
    title: string;
    contentType: string;
    tmdbId: string;
    providerAssetId: string;
    providerSourceId: string;
    providerName: string;
    status: string;
    maveroStatus: string;
    mediaAssetId: string;
  };

  export type TmdbResult = {
    id: string;
    tmdbId: string;
    title: string;
    year?: number;
    poster?: string;
    type: 'movie' | 'series' | 'anime';
    overview?: string;
  };
</script>

<script lang="ts">
  import { Plus, MoreVertical, Trash2, Link2, Search, X, Loader2, Film, Tv, Sparkles, AlertCircle, Check, ChevronRight } from 'lucide-svelte';

  // --- Props ---
  let {
    providers = [] as Array<{ adapterId: string; name: string; sourceId: string }>,
    registerAddFile = undefined as ((fn: (() => void) | null) => void) | undefined,
  }: {
    providers?: Array<{ adapterId: string; name: string; sourceId: string }>;
    registerAddFile?: ((fn: (() => void) | null) => void) | undefined;
  } = $props();

  // --- State ---
  let items = $state<MediaRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Add File wizard state
  let wizardOpen = $state(false);
  let wizardStep = $state<'search' | 'provider' | 'reference' | 'saving'>('search');
  let tmdbQuery = $state('');
  let tmdbType = $state<'movie' | 'series'>('movie');
  let tmdbSearching = $state(false);
  let tmdbResults = $state<TmdbResult[]>([]);
  let tmdbError = $state<string | null>(null);
  let tmdbDebounce: ReturnType<typeof setTimeout> | null = null;
  let selectedTmdb = $state<TmdbResult | null>(null);
  let selectedProvider = $state<'vidara' | 'abyss' | null>(null);
  let providerReference = $state('');
  let referenceError = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  // Update link state
  let updateTarget = $state<MediaRow | null>(null);

  // Delete confirmation state
  let deleteTarget = $state<MediaRow | null>(null);
  let deleting = $state(false);

  // Three-dot menu state
  let openMenuId = $state<string | null>(null);

  // --- Lifecycle ---
  let prevOpen = false;

  $effect(() => {
    if (!prevOpen) {
      loadList();
    }
    prevOpen = true;
  });

  // Register the add-file trigger with the parent.
  $effect(() => {
    if (registerAddFile) {
      registerAddFile(() => { openAddWizard(); });
    }
  });

  // Close menu on outside click
  $effect(() => {
    if (openMenuId) {
      const handler = () => { openMenuId = null; };
      window.addEventListener('click', handler);
      return () => window.removeEventListener('click', handler);
    }
  });

  // --- List loading ---
  async function loadList() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/admin/media/library?status=all&limit=100&sort=recently_updated');
      const json = await res.json();
      if (json.ok) {
        items = (json.items ?? []).map(mapLibraryItem).filter((i: MediaRow) => i.mediaAssetId);
      } else {
        error = json.error?.message ?? 'Failed to load media library.';
        items = [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load media library.';
      items = [];
    } finally {
      loading = false;
    }
  }

  function mapLibraryItem(item: any): MediaRow {
    // Find the first non-deleted asset for this media item.
    const asset = (item.assets ?? []).find((a: any) => a.status !== 'deleted') ?? item.assets?.[0];
    const providerName = asset ? providerNameForSource(asset.provider_source_id) : 'Unknown';
    return {
      id: item.id,
      title: item.title + (item.episode_title ? ` — ${item.episode_title}` : ''),
      contentType: item.content_type,
      tmdbId: item.tmdb_id,
      providerAssetId: asset?.provider_asset_id ?? '',
      providerSourceId: asset?.provider_source_id ?? '',
      providerName,
      status: asset?.status ?? 'unknown',
      maveroStatus: asset?.mavero_status ?? 'unknown',
      mediaAssetId: asset?.id ?? '',
    };
  }

  function providerNameForSource(sourceId: string): string {
    const p = providers.find((p) => p.sourceId === sourceId);
    return p?.name ?? p?.adapterId ?? 'Unknown';
  }

  // --- TMDB Search ---
  function onTmdbInput() {
    if (tmdbDebounce) clearTimeout(tmdbDebounce);
    tmdbDebounce = setTimeout(() => void doTmdbSearch(), 300);
  }

  async function doTmdbSearch() {
    const q = tmdbQuery.trim();
    if (!q) { tmdbResults = []; return; }
    tmdbSearching = true;
    tmdbError = null;
    try {
      const res = await fetch(`/api/admin/media/search?q=${encodeURIComponent(q)}&type=${tmdbType}`);
      const json = await res.json();
      if (json.ok) {
        tmdbResults = (json.results ?? []).map((r: any) => ({
          id: r.id,
          tmdbId: String(r.id).replace(/^(movie|series|anime)-/, ''),
          title: r.title,
          year: r.year,
          poster: r.poster,
          type: r.type ?? (tmdbType === 'movie' ? 'movie' : 'series'),
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

  function selectTmdb(result: TmdbResult) {
    selectedTmdb = result;
    wizardStep = 'provider';
  }

  // --- Provider selection ---
  function selectProvider(p: 'vidara' | 'abyss') {
    selectedProvider = p;
    wizardStep = 'reference';
  }

  // --- Save ---
  async function saveLink() {
    if (!selectedTmdb || !selectedProvider || !providerReference.trim()) return;

    // Validate reference
    const ref = providerReference.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(ref) && !ref.startsWith('http')) {
      referenceError = 'Reference must be alphanumeric (filecode/ID) or a full URL.';
      return;
    }
    referenceError = null;

    saving = true;
    saveError = null;
    try {
      const body: Record<string, string> = {
        contentType: selectedTmdb.type,
        tmdbId: selectedTmdb.tmdbId,
        provider: selectedProvider,
        reference: ref,
        // Send the title + year from the TMDB search result so the
        // server doesn't have to re-fetch from TMDB on every save
        // (also works in environments where TMDB credentials are not
        // configured).
        title: selectedTmdb.title,
      };
      if (selectedTmdb.year != null) {
        body.year = String(selectedTmdb.year);
      }

      // If updating, include the mediaAssetId
      if (updateTarget) {
        body.mediaAssetId = updateTarget.mediaAssetId;
      }

      const res = await fetch('/api/admin/media/manual-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.ok) {
        closeWizard();
        await loadList();
      } else {
        saveError = json.error?.message ?? 'Save failed.';
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : 'Network error during save.';
    } finally {
      saving = false;
    }
  }

  // --- Delete ---
  async function confirmDelete() {
    if (!deleteTarget) return;
    deleting = true;
    try {
      const res = await fetch('/api/admin/media/manual-link', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaAssetId: deleteTarget.mediaAssetId }),
      });
      const json = await res.json();
      if (json.ok) {
        deleteTarget = null;
        await loadList();
      } else {
        error = json.error?.message ?? 'Delete failed.';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Network error during delete.';
    } finally {
      deleting = false;
    }
  }

  // --- Wizard control ---
  function openAddWizard() {
    resetWizard();
    wizardOpen = true;
  }

  function openUpdateWizard(row: MediaRow) {
    resetWizard();
    updateTarget = row;
    // Pre-fill with current data
    selectedTmdb = {
      id: `${row.contentType === 'anime' ? 'series' : row.contentType}-${row.tmdbId}`,
      tmdbId: row.tmdbId,
      title: row.title,
      type: row.contentType === 'movie' ? 'movie' : 'series',
    };
    selectedProvider = row.providerName.toLowerCase().includes('vidara') ? 'vidara'
      : row.providerName.toLowerCase().includes('abyss') ? 'abyss' : null;
    providerReference = row.providerAssetId;
    wizardStep = 'search'; // Start at search so admin can change title
    wizardOpen = true;
  }

  function resetWizard() {
    wizardStep = 'search';
    tmdbQuery = '';
    tmdbResults = [];
    tmdbError = null;
    tmdbSearching = false;
    selectedTmdb = null;
    selectedProvider = null;
    providerReference = '';
    referenceError = null;
    saveError = null;
    saving = false;
    updateTarget = null;
    if (tmdbDebounce) { clearTimeout(tmdbDebounce); tmdbDebounce = null; }
  }

  function closeWizard() {
    wizardOpen = false;
    resetWizard();
  }

  // --- Helpers ---
  function contentTypeLabel(type: string): string {
    return type === 'movie' ? 'Movie' : type === 'series' ? 'TV Series' : type === 'anime' ? 'Anime' : type;
  }

  function providerLabel(row: MediaRow): string {
    return row.providerName === 'vidara' || row.providerName.toLowerCase().includes('vidara') ? 'Vidara'
      : row.providerName === 'abyss' || row.providerName.toLowerCase().includes('abyss') ? 'Abyss'
      : row.providerName;
  }
</script>

<section class="media-library" aria-label="Media Library">
  <!-- Loading / Error / Empty / List -->
  {#if loading}
    <div class="state-msg"><Loader2 size={20} class="spinner" /> Loading media library…</div>
  {:else if error}
    <div class="state-msg state-error"><AlertCircle size={20} /> {error}<button class="retry-btn" onclick={loadList}>Retry</button></div>
  {:else if items.length === 0}
    <div class="state-msg state-empty"><Film size={32} /><p>No media linked yet. Click "Add file" to link your first video.</p></div>
  {:else}
    <div class="media-list">
      {#each items as row (row.id)}
        <div class="media-row" data-status={row.maveroStatus}>
          <div class="media-poster">
            {#if row.contentType === 'movie'}<Film size={18} />{:else if row.contentType === 'anime'}<Sparkles size={18} />{:else}<Tv size={18} />{/if}
          </div>
          <div class="media-info">
            <div class="media-title">{row.title}</div>
            <div class="media-meta">
              <span class="badge-type">{contentTypeLabel(row.contentType)}</span>
              <span class="badge-provider" data-provider={providerLabel(row).toLowerCase()}>{providerLabel(row)}</span>
              <span class="tmdb-id">TMDB: {row.tmdbId}</span>
            </div>
          </div>
          <div class="media-actions">
            <!-- Three-dot menu -->
            <button
              type="button"
              class="menu-trigger"
              onclick={(e) => { e.stopPropagation(); openMenuId = openMenuId === row.id ? null : row.id; }}
              aria-label="Actions"
              aria-expanded={openMenuId === row.id}
            >
              <MoreVertical size={16} />
            </button>
            {#if openMenuId === row.id}
              <div class="menu-dropdown" role="menu" onclick={(e) => e.stopPropagation()}>
                <button type="button" class="menu-item" role="menuitem" onclick={() => { openMenuId = null; openUpdateWizard(row); }}>
                  <Link2 size={14} /> Update link
                </button>
                <button type="button" class="menu-item menu-item-danger" role="menuitem" onclick={() => { openMenuId = null; deleteTarget = row; }}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<!-- Add File / Update Link Wizard Modal -->
{#if wizardOpen}
  <div class="wizard-overlay" onclick={closeWizard} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <div class="wizard-head">
        <h2 id="wizard-title">{updateTarget ? 'Update link' : 'Add file'}</h2>
        <button type="button" class="wizard-close" onclick={closeWizard} aria-label="Close"><X size={16} /></button>
      </div>

      {#if saveError}
        <div class="wizard-error" role="alert"><AlertCircle size={14} /> {saveError}</div>
      {/if}

      <!-- Step 1: TMDB Search -->
      {#if wizardStep === 'search'}
        <div class="wizard-step">
          <div class="step-label">Step 1 — Search for a title</div>
          <div class="search-bar">
            <div class="type-toggle" role="radiogroup" aria-label="Search type">
              <button type="button" class:active={tmdbType === 'movie'} onclick={() => tmdbType = 'movie'} role="radio" aria-checked={tmdbType === 'movie'}>Movie</button>
              <button type="button" class:active={tmdbType === 'series'} onclick={() => tmdbType = 'series'} role="radio" aria-checked={tmdbType === 'series'}>Series</button>
            </div>
            <div class="search-input-wrap">
              <Search size={14} class="search-icon" />
              <input type="text" class="search-input" placeholder="Search TMDB by title…" bind:value={tmdbQuery} oninput={onTmdbInput} autocomplete="off" />
              {#if tmdbSearching}<Loader2 size={14} class="spinner" />{/if}
            </div>
          </div>

          {#if updateTarget && selectedTmdb}
            <div class="current-selection">
              <span>Current: <strong>{selectedTmdb.title}</strong></span>
              <button type="button" class="skip-btn" onclick={() => { wizardStep = 'provider'; }}>Keep current →</button>
            </div>
          {/if}

          <div class="results-list">
            {#if tmdbError}
              <div class="results-empty"><AlertCircle size={14} /> {tmdbError}</div>
            {:else if tmdbResults.length === 0 && !tmdbSearching}
              <div class="results-empty">{tmdbQuery.trim() ? `No results for "${tmdbQuery}".` : 'Start typing to search TMDB.'}</div>
            {/if}
            {#each tmdbResults as result (result.id)}
              <button type="button" class="result-row" class:selected={selectedTmdb?.tmdbId === result.tmdbId} onclick={() => selectTmdb(result)}>
                <div class="result-icon">{#if result.type === 'movie'}<Film size={14} />{:else if result.type === 'anime'}<Sparkles size={14} />{:else}<Tv size={14} />{/if}</div>
                <div class="result-info">
                  <div class="result-title">{result.title}</div>
                  <div class="result-meta"><span>{result.type}</span>{#if result.year}<span>· {result.year}</span>{/if}<span>· TMDB {result.tmdbId}</span></div>
                </div>
                {#if selectedTmdb?.tmdbId === result.tmdbId}<span class="result-check"><Check size={14} /></span>{/if}
              </button>
            {/each}
          </div>

          {#if selectedTmdb}
            <div class="wizard-footer">
              <button type="button" class="btn btn-next" onclick={() => { wizardStep = 'provider'; }}>
                Continue <ChevronRight size={14} />
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Step 2: Provider Selection -->
      {#if wizardStep === 'provider'}
        <div class="wizard-step">
          <div class="step-label">Step 2 — Select the host</div>
          <div class="selected-title-bar">
            <span>Linking: <strong>{selectedTmdb?.title}</strong></span>
            <button type="button" class="change-btn" onclick={() => { wizardStep = 'search'; }}>Change</button>
          </div>
          <div class="provider-cards">
            <button type="button" class="provider-card" class:selected={selectedProvider === 'vidara'} onclick={() => selectProvider('vidara')}>
              <div class="provider-name">Vidara</div>
              <div class="provider-desc">Filecode or embed URL from vidara.to</div>
            </button>
            <button type="button" class="provider-card" class:selected={selectedProvider === 'abyss'} onclick={() => selectProvider('abyss')}>
              <div class="provider-name">Abyss</div>
              <div class="provider-desc">Resource ID or player URL from abyss.to</div>
            </button>
          </div>
          <div class="wizard-footer">
            <button type="button" class="btn btn-back" onclick={() => { wizardStep = 'search'; }}>Back</button>
          </div>
        </div>
      {/if}

      <!-- Step 3: Reference Entry -->
      {#if wizardStep === 'reference'}
        <div class="wizard-step">
          <div class="step-label">Step 3 — Enter the file reference</div>
          <div class="selected-title-bar">
            <span>Linking: <strong>{selectedTmdb?.title}</strong> · {selectedProvider}</span>
            <button type="button" class="change-btn" onclick={() => { wizardStep = 'provider'; }}>Change</button>
          </div>
          <div class="ref-input-section">
            <label class="ref-label">
              {selectedProvider === 'vidara' ? 'Vidara filecode or URL' : 'Abyss resource ID or URL'}
            </label>
            <input
              type="text"
              class="ref-input"
              bind:value={providerReference}
              oninput={() => { referenceError = null; }}
              placeholder={selectedProvider === 'vidara' ? 'e.g. Vw0hY4n13k83 or https://vidara.to/e/Vw0hY4n13k83' : 'e.g. ltJEfKQxR or https://player.abyssplayer.com/ltJEfKQxR'}
              autocomplete="off"
            />
            <p class="ref-hint">
              {selectedProvider === 'vidara'
                ? 'Upload your video on the Vidara dashboard, then copy the filecode from the share/embed URL.'
                : 'Upload your video on the Abyss dashboard, then copy the resource ID from the player URL.'}
            </p>
            {#if referenceError}
              <p class="ref-error"><AlertCircle size={12} /> {referenceError}</p>
            {/if}
          </div>
          <div class="wizard-footer">
            <button type="button" class="btn btn-back" onclick={() => { wizardStep = 'provider'; }}>Back</button>
            <button type="button" class="btn btn-save" onclick={saveLink} disabled={saving || !providerReference.trim()}>
              {#if saving}<Loader2 size={12} class="spinner" /> Saving…{:else}{updateTarget ? 'Update' : 'Save'}{/if}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Delete Confirmation -->
{#if deleteTarget}
  <div class="wizard-overlay" onclick={() => { if (!deleting) deleteTarget = null; }} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <h3 id="delete-title"><Trash2 size={16} /> Delete media link?</h3>
      <p class="confirm-desc">This will remove <strong>{deleteTarget.title}</strong> from the Media Library.</p>
      <p class="confirm-note"><strong>The hosted file on {providerLabel(deleteTarget)} will NOT be deleted.</strong> It remains on the provider and can be re-linked later.</p>
      <div class="confirm-actions">
        <button type="button" class="btn btn-cancel" onclick={() => { deleteTarget = null; }} disabled={deleting}>Cancel</button>
        <button type="button" class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
          {#if deleting}<Loader2 size={12} class="spinner" /> Deleting…{:else}<Trash2 size={12} /> Delete{/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .media-library { display: flex; flex-direction: column; gap: var(--a2-space-3); }

  .state-msg { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); color: var(--a2-text-muted); font-size: var(--a2-text-sm); }
  .state-error { color: var(--a2-red); }
  .state-empty p { margin: 0; text-align: center; max-width: 420px; }
  .retry-btn { padding: 6px 14px; border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; }
  .retry-btn:hover { border-color: var(--a2-cyan); color: var(--a2-cyan); }

  .media-list { display: flex; flex-direction: column; gap: 2px; }
  .media-row { display: flex; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); transition: border-color 140ms ease; }
  .media-row:hover { border-color: var(--a2-border-strong); }
  .media-row[data-status="missing"] { opacity: 0.6; }

  .media-poster { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: var(--a2-radius-sm); background: var(--a2-surface-4); color: var(--a2-text-dim); }

  .media-info { flex: 1; min-width: 0; }
  .media-title { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .media-meta { display: flex; gap: var(--a2-space-2); align-items: center; margin-top: 3px; }
  .badge-type { padding: 1px 6px; border-radius: var(--a2-radius-xs); background: var(--a2-surface-4); font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; color: var(--a2-cyan); letter-spacing: 0.04em; }
  .badge-provider { padding: 1px 6px; border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge-provider[data-provider="vidara"] { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
  .badge-provider[data-provider="abyss"] { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
  .tmdb-id { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }

  .media-actions { position: relative; flex-shrink: 0; }
  .menu-trigger { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: var(--a2-radius-sm); background: transparent; color: var(--a2-text-muted); cursor: pointer; }
  .menu-trigger:hover { background: var(--a2-surface-3); color: var(--a2-text); }
  .menu-dropdown { position: absolute; right: 0; top: 100%; z-index: 10; min-width: 160px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); box-shadow: 0 8px 24px rgba(0,0,0,0.3); overflow: hidden; }
  .menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: 0; background: transparent; color: var(--a2-text); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; text-align: left; }
  .menu-item:hover { background: var(--a2-surface-4); }
  .menu-item-danger { color: var(--a2-red); }
  .menu-item-danger:hover { background: var(--a2-red-soft); }

  /* Wizard */
  .wizard-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; }
  .wizard { position: relative; z-index: 91; width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 64px); display: flex; flex-direction: column; background: var(--a2-surface-2, #1a1a1a); border: 1px solid var(--a2-border-strong, #333); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; }
  .wizard-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--a2-border, #222); }
  .wizard-head h2 { margin: 0; font-size: 1rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); }
  .wizard-close { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--a2-text-muted, #888); cursor: pointer; }
  .wizard-close:hover { background: var(--a2-surface-3, #222); color: var(--a2-text, #ddd); }

  .wizard-error { padding: 8px 12px; margin: 8px 20px; border: 1px solid rgba(220,60,60,0.3); border-radius: 8px; background: rgba(220,60,60,0.08); color: #c44; font-size: 0.75rem; display: flex; align-items: center; gap: 6px; }

  .wizard-step { padding: 0 20px 8px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .step-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--a2-text-muted, #888); margin-top: 12px; }

  .search-bar { display: flex; flex-direction: column; gap: 8px; }
  .type-toggle { display: inline-flex; gap: 2px; border: 1px solid var(--a2-border, #222); border-radius: 8px; overflow: hidden; align-self: flex-start; }
  .type-toggle button { padding: 5px 12px; border: 0; background: transparent; color: var(--a2-text-muted, #888); font-size: 0.7rem; font-weight: 600; cursor: pointer; }
  .type-toggle button.active { background: rgba(0,200,200,0.12); color: #0ff; }
  .search-input-wrap { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 38px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; }
  .search-input-wrap:focus-within { border-color: #0ff; }
  .search-input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--a2-text, #ddd); font-size: 0.82rem; }
  .search-input::placeholder { color: var(--a2-text-dim, #555); }
  .search-icon { color: var(--a2-text-dim, #555); flex-shrink: 0; }
  .spinner { animation: spin 1s linear infinite; }

  .current-selection { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(0,200,200,0.08); border-radius: 6px; font-size: 0.75rem; color: var(--a2-text, #ddd); }
  .skip-btn { background: transparent; border: 0; color: #0ff; font-size: 0.7rem; font-weight: 600; cursor: pointer; text-decoration: underline; }

  .results-list { max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .results-empty { padding: 20px; text-align: center; color: var(--a2-text-dim, #555); font-size: 0.8rem; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .result-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; cursor: pointer; text-align: left; transition: border-color 140ms ease; }
  .result-row:hover { border-color: rgba(0,255,255,0.3); }
  .result-row.selected { border-color: #0ff; background: rgba(0,255,255,0.08); }
  .result-icon { display: flex; align-items: center; color: var(--a2-text-dim, #555); flex-shrink: 0; }
  .result-info { flex: 1; min-width: 0; }
  .result-title { font-size: 0.8rem; color: var(--a2-text-bright, #f0f0f0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-meta { display: flex; gap: 4px; font-size: 0.6rem; color: var(--a2-text-dim, #555); text-transform: uppercase; letter-spacing: 0.04em; }
  .result-check { color: #0ff; flex-shrink: 0; }

  .selected-title-bar { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(0,200,200,0.08); border-radius: 6px; font-size: 0.78rem; color: var(--a2-text, #ddd); }
  .change-btn { background: transparent; border: 0; color: #0ff; font-size: 0.7rem; font-weight: 600; cursor: pointer; text-decoration: underline; }

  .provider-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .provider-card { display: flex; flex-direction: column; gap: 4px; padding: 14px; border: 1px solid var(--a2-border, #222); border-radius: 8px; background: var(--a2-surface-3, #1a1a1a); cursor: pointer; text-align: left; transition: border-color 140ms ease; }
  .provider-card:hover { border-color: rgba(0,255,255,0.3); }
  .provider-card.selected { border-color: #0ff; background: rgba(0,255,255,0.08); }
  .provider-name { font-size: 0.9rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); }
  .provider-desc { font-size: 0.65rem; color: var(--a2-text-dim, #555); }

  .ref-input-section { display: flex; flex-direction: column; gap: 6px; }
  .ref-label { font-size: 0.75rem; font-weight: 600; color: var(--a2-text, #ddd); }
  .ref-input { height: 40px; padding: 0 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; color: var(--a2-text, #ddd); font-size: 0.82rem; outline: 0; }
  .ref-input:focus { border-color: #0ff; }
  .ref-hint { margin: 0; font-size: 0.65rem; color: var(--a2-text-dim, #555); line-height: 1.4; }
  .ref-error { margin: 0; font-size: 0.65rem; color: #c44; display: flex; align-items: center; gap: 4px; }

  .wizard-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font-size: 0.78rem; font-weight: 700; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-next { background: rgba(0,200,200,0.12); border-color: rgba(0,200,200,0.3); color: #0ff; }
  .btn-next:hover { background: rgba(0,200,200,0.2); }
  .btn-back { background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .btn-back:hover { color: var(--a2-text, #ddd); }
  .btn-save { background: rgba(53,214,143,0.12); border-color: rgba(53,214,143,0.3); color: #35d68f; }
  .btn-save:hover { background: rgba(53,214,143,0.2); }
  .btn-cancel { background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .btn-danger { background: rgba(220,60,60,0.12); border-color: rgba(220,60,60,0.3); color: #c44; }
  .btn-danger:hover { background: rgba(220,60,60,0.2); }

  /* Delete confirmation */
  .confirm-dialog { position: relative; z-index: 91; width: min(420px, calc(100vw - 32px)); background: var(--a2-surface-2, #1a1a1a); border: 1px solid var(--a2-border-strong, #333); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; padding: 20px; }
  .confirm-dialog h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 0.9rem; color: var(--a2-text-bright, #f0f0f0); }
  .confirm-desc { margin: 0 0 8px; font-size: 0.8rem; color: var(--a2-text, #ddd); }
  .confirm-note { margin: 0 0 16px; font-size: 0.7rem; color: var(--a2-text-muted, #888); }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }

  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .media-row { padding: var(--a2-space-2); }
    .media-poster { width: 32px; height: 32px; }
    .media-title { font-size: var(--a2-text-xs); }
    .media-meta { flex-wrap: wrap; gap: 4px; }
    .provider-cards { grid-template-columns: 1fr; }
  }
</style>
