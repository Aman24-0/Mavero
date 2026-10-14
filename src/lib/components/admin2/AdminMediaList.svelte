<script lang="ts" module>
  // MAV-FOCUSED — Compact Media Library list (2026-10).
  //
  // Replaces the old AdminHostingAssets (2262 lines) with a simple list:
  //   * Compact rows: poster, title, type, TMDB ID, provider, 3-dot menu.
  //   * Add File wizard: delegated to the shared AdminAddFileWizard.
  //   * Three-dot menu: Delete (Mavero-side only) + Update link.
  //
  // Uses the /api/admin/media/manual-link endpoint for create/update/delete.
  // Uses the /api/admin/media/search endpoint for TMDB search (via the wizard).
  // Uses the /api/admin/media/library endpoint for the list.

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
</script>

<script lang="ts">
  import { Plus, MoreVertical, Trash2, Link2, Loader2, Film, Tv, Sparkles, AlertCircle } from 'lucide-svelte';
  import AdminAddFileWizard from './AdminAddFileWizard.svelte';
  import type { UpdateTarget } from './AdminAddFileWizard.svelte';

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

  // Shared wizard state
  let wizardOpen = $state(false);
  let wizardUpdateTarget = $state<UpdateTarget | null>(null);

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
    wizardUpdateTarget = null;
    wizardOpen = true;
  }

  function openUpdateWizard(row: MediaRow) {
    wizardUpdateTarget = {
      mediaAssetId: row.mediaAssetId,
      title: row.title,
      contentType: row.contentType,
      tmdbId: row.tmdbId,
      providerName: row.providerName,
      providerAssetId: row.providerAssetId,
    };
    wizardOpen = true;
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

<!-- Shared Add File / Update Link Wizard -->
<AdminAddFileWizard
  bind:open={wizardOpen}
  {providers}
  updateTarget={wizardUpdateTarget}
  onsaved={() => { void loadList(); }}
/>

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

  /* Delete confirmation */
  .wizard-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; }
  .confirm-dialog { position: relative; z-index: 91; width: min(420px, calc(100vw - 32px)); background: var(--a2-surface-2, #1a1a1a); border: 1px solid var(--a2-border-strong, #333); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; padding: 20px; }
  .confirm-dialog h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 0.9rem; color: var(--a2-text-bright, #f0f0f0); }
  .confirm-desc { margin: 0 0 8px; font-size: 0.8rem; color: var(--a2-text, #ddd); }
  .confirm-note { margin: 0 0 16px; font-size: 0.7rem; color: var(--a2-text-muted, #888); }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font-size: 0.78rem; font-weight: 700; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-cancel { background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .btn-danger { background: rgba(220,60,60,0.12); border-color: rgba(220,60,60,0.3); color: #c44; }
  .btn-danger:hover { background: rgba(220,60,60,0.2); }

  .spinner { animation: spin 1s linear infinite; }

  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .media-row { padding: var(--a2-space-2); }
    .media-poster { width: 32px; height: 32px; }
    .media-title { font-size: var(--a2-text-xs); }
    .media-meta { flex-wrap: wrap; gap: 4px; }
  }
</style>
