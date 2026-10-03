<script lang="ts">
  /**
   * Admin 2.0 — Phase 1 — Integrations workspace.
   * Full CRUD for Stremio addons. No redirects to legacy UI.
   *
   * CS-1 (AC-001): the page hosts TWO URL-driven tabs:
   *   [ Add-on ]    — Stremio addon management (EXISTING behavior, unchanged)
   *   [ Extension ] — CloudStream Extension Manager (new, CS-1)
   * The "+" button opens an Add Integration selector with two chips:
   *   [ Stremio ]     → the EXISTING Add Stremio Addon flow (Manifest URL →
   *                     Preview → Confirm), preserved verbatim behind the
   *                     selector.
   *   [ CloudStream ] → the new CloudStream repository add flow
   *                     (Repository URL → Validate/Fetch → Preview → Confirm).
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import AdminCloudStreamManager from '$lib/components/admin2/AdminCloudStreamManager.svelte';
  import { Puzzle, Check, RefreshCw, Trash2, Power, Edit3, Package } from 'lucide-svelte';
  import { ALL_DOWNLOAD_LINK_TYPES, linkTypeLabel } from '$lib/shared/download-link-types';
  import type { CloudStreamAdapterStatus, CloudStreamRepositoryPreview } from '$lib/shared/cloudstream-types';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const tab = $derived(data.tab ?? 'addon');

  let addSheetOpen = $state(false);
  /** Selected integration kind in the Add Integration sheet: null | 'stremio' | 'cloudstream'. */
  let addKind: 'stremio' | 'cloudstream' | null = $state(null);
  let detailSheetOpen = $state(false);
  let detailAddon: any = $state(null);
  let manifestUrl = $state('');
  let preview = $state<any>(null);
  let previewing = $state(false);
  let previewError = $state('');

  // CloudStream add-flow state.
  let repositoryUrl = $state('');
  let repositoryPreview: CloudStreamRepositoryPreview | null = $state(null);
  let repositoryPreviewing = $state(false);
  let repositoryPreviewError = $state('');

  function openAddSheet() {
    addSheetOpen = true;
  }

  function closeAddSheet() {
    addSheetOpen = false;
    addKind = null;
    preview = null;
    previewError = '';
    manifestUrl = '';
    repositoryPreview = null;
    repositoryPreviewError = '';
    repositoryUrl = '';
  }

  async function doPreview() {
    if (!manifestUrl.trim()) return;
    previewing = true;
    preview = null;
    previewError = '';
    try {
      // Standard JSON endpoint (POST /api/admin/integrations/preview) —
      // replaces the previous fragile SvelteKit form-action invocation
      // (`/admin/system/integrations?/previewAddon`), which returned a
      // SvelteKit-specific `json.form.preview` shape that silently
      // failed and left the spinner stuck.
      const res = await fetch('/api/admin/integrations/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifestUrl }),
      });
      const json = await res.json();
      if (json.ok && json.preview) {
        preview = json.preview;
      } else {
        // Safe, curated error message from the server (or a clear
        // fallback). Surfaced inline (not via alert) so the admin
        // retains context.
        previewError = json?.error?.message ?? 'Unable to preview addon.';
      }
    } catch {
      previewError = 'Network error — could not reach the preview endpoint.';
    } finally {
      // ALWAYS clear the spinner, even on error, so the UI never
      // gets stuck in the "Loading…" state.
      previewing = false;
    }
  }

  async function doRepositoryPreview() {
    if (!repositoryUrl.trim()) return;
    repositoryPreviewing = true;
    repositoryPreview = null;
    repositoryPreviewError = '';
    try {
      // Standard JSON endpoint (POST /api/admin/integrations/cloudstream/preview)
      // — same envelope as the Stremio preview endpoint. Validation only:
      // validates the URL, fetches CS.json, resolves pluginLists, parses
      // plugins.json and returns bounded extension metadata. Never persists
      // anything and never fetches/executes .cs3 artifacts.
      const res = await fetch('/api/admin/integrations/cloudstream/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryUrl }),
      });
      const json = await res.json();
      if (json.ok && json.preview) {
        repositoryPreview = json.preview;
      } else {
        repositoryPreviewError = json?.error?.message ?? 'Unable to preview the CloudStream repository.';
      }
    } catch {
      repositoryPreviewError = 'Network error — could not reach the preview endpoint.';
    } finally {
      repositoryPreviewing = false;
    }
  }

  function openDetail(addon: any) { detailAddon = addon; detailSheetOpen = true; }
  function closeDetail() { detailSheetOpen = false; detailAddon = null; }

  /** FINAL TASK: the add-on's current GLOBAL rank (fallback: the legacy
   *  0-based ordering + 1, so the input is never empty pre-backfill). */
  function addonGlobalPosition(addonId: string): number {
    const global = data.globalPositions?.[`addon:${addonId}`];
    if (typeof global === 'number') return global;
    const addon = data.addons.find((candidate) => candidate.id === addonId);
    return (addon?.ordering ?? 0) + 1;
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString(); } catch { return '—'; }
  }

  function previewAdapterLabel(status: CloudStreamAdapterStatus): string {
    if (status === 'compatible') return 'Compatible';
    if (status === 'broken') return 'Broken';
    if (status === 'unsupported') return 'Unsupported';
    return 'Adapter required';
  }

  function previewAdapterTone(status: CloudStreamAdapterStatus): 'good' | 'warn' | 'neutral' | 'bad' {
    if (status === 'compatible') return 'good';
    if (status === 'broken') return 'bad';
    if (status === 'unsupported') return 'neutral';
    return 'warn';
  }
</script>

<svelte:head><title>Integrations — Mavero Admin</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminAppShell active="integrations">
  <AdminPage
    eyebrow="System"
    title="Integrations"
    accent="cyan"
    tabs={[
      { id: 'addon', label: 'Add-on', href: '?tab=addon', active: tab === 'addon' },
      { id: 'extension', label: 'Extension', href: '?tab=extension', active: tab === 'extension' },
    ]}
  >
    {#snippet actions()}<AdminAddButton label="Add Integration" onclick={openAddSheet} />{/snippet}
    {#snippet description()}<p>Manage integrations — Stremio add-ons and CloudStream extensions. Terminology: Add-on = Stremio · Extension = CloudStream.</p>{/snippet}

    {#if data.notice}<div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>{/if}
    {#if form?.message}<div class="a2-form-error" role="alert">{form.message}</div>{/if}

    {#if tab === 'addon'}
      {#if data.addons.length === 0}
        <div class="a2-empty"><Puzzle size={32} /><h3>No integrations</h3><p>Add a Stremio addon manifest URL.</p><AdminAddButton label="Add Integration" onclick={openAddSheet} /></div>
      {:else}
        <div class="a2-addon-list">
          {#each data.addons as addon (addon.id)}
            <div class="a2-addon-row" data-enabled={addon.enabled}>
              <div class="a2-addon-row-main">
                <div class="a2-addon-row-info">
                  <div class="a2-addon-row-name">{addon.name}</div>
                  <div class="a2-addon-row-meta">
                    {#if addon.version}<span>v{addon.version}</span><span>·</span>{/if}
                    {#each addon.supportedTypes ?? [] as t}<span class="a2-addon-type">{t}</span>{/each}
                    {#if addon.lastError}<span>·</span><span class="a2-addon-error">error</span>{/if}
                  </div>
                </div>
              </div>
              <div class="a2-addon-row-actions">
                <AdminStatusBadge label={addon.enabled ? 'Enabled' : 'Disabled'} tone={addon.enabled ? 'good' : 'neutral'} />
                <form method="POST" action="?/setEnabled" style="display:inline">
                  <input type="hidden" name="id" value={addon.id} />
                  <input type="hidden" name="enabled" value={String(!addon.enabled)} />
                  <button type="submit" class="a2-icon-btn" title={addon.enabled ? 'Disable' : 'Enable'}><Power size={14} /></button>
                </form>
                <form method="POST" action="?/refreshAddon" style="display:inline">
                  <input type="hidden" name="id" value={addon.id} />
                  <button type="submit" class="a2-icon-btn" title="Refresh"><RefreshCw size={14} /></button>
                </form>
                <button type="button" class="a2-icon-btn" onclick={() => openDetail(addon)} title="Configure"><Edit3 size={14} /></button>
                <form method="POST" action="?/deleteAddon" style="display:inline" onsubmit={(e) => { if (!confirm('Delete this addon? This cannot be undone.')) e.preventDefault(); }}>
                  <input type="hidden" name="id" value={addon.id} />
                  <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete"><Trash2 size={14} /></button>
                </form>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <AdminCloudStreamManager
        repositories={data.cloudstreamRepositories}
        extensions={data.cloudstreamExtensions}
        loadError={data.cloudstreamError}
        providerTest={form?.providerTest ?? null}
        globalPositions={data.globalPositions}
      />
    {/if}
  </AdminPage>
</AdminAppShell>

<!-- Add Integration sheet (selector + per-kind flows) -->
{#if addSheetOpen}
  <AdminSheet open={addSheetOpen} title="Add Integration" onClose={closeAddSheet}>
    <div class="a2-add-flow">
      {#if addKind === null}
        <p class="a2-selector-hint">Choose the integration type to add:</p>
        <div class="a2-selector-chips" role="group" aria-label="Integration type">
          <button type="button" class="a2-chip" onclick={() => { addKind = 'stremio'; }}>
            <Puzzle size={16} />
            <span>Stremio</span>
            <span class="a2-chip-sub">Add-on · manifest URL</span>
          </button>
          <button type="button" class="a2-chip" onclick={() => { addKind = 'cloudstream'; }}>
            <Package size={16} />
            <span>CloudStream</span>
            <span class="a2-chip-sub">Extension · repository URL</span>
          </button>
        </div>
      {:else if addKind === 'stremio'}
        <div class="a2-flow-head">
          <button type="button" class="a2-back-link" onclick={() => { addKind = null; preview = null; previewError = ''; }}>← Change type</button>
        </div>
        <label class="a2-field"><span>Manifest URL</span><input type="url" bind:value={manifestUrl} placeholder="https://example.com/manifest.json" /></label>
        <button type="button" class="a2-btn-primary" onclick={doPreview} disabled={previewing || !manifestUrl.trim()}>{previewing ? 'Loading…' : 'Preview'}</button>
        {#if previewError}
          <div class="a2-form-error" role="alert">{previewError}</div>
        {/if}
        {#if preview}
          <div class="a2-preview">
            <h4>{preview.name ?? 'Unnamed'}</h4>
            {#if preview.version}<p class="mono">v{preview.version}</p>{/if}
            {#if preview.description}<p>{preview.description}</p>{/if}
            <form method="POST" action="?/confirmAddon">
              <input type="hidden" name="manifestUrl" value={manifestUrl} />
              <button type="submit" class="a2-btn-primary">Confirm Add</button>
            </form>
          </div>
        {/if}
      {:else if addKind === 'cloudstream'}
        <div class="a2-flow-head">
          <button type="button" class="a2-back-link" onclick={() => { addKind = null; repositoryPreview = null; repositoryPreviewError = ''; }}>← Change type</button>
        </div>
        <label class="a2-field"><span>Repository URL</span><input type="url" bind:value={repositoryUrl} placeholder="https://raw.githubusercontent.com/…/CS.json or …/manifest.json" /></label>
        <button type="button" class="a2-btn-primary" onclick={doRepositoryPreview} disabled={repositoryPreviewing || !repositoryUrl.trim()}>{repositoryPreviewing ? 'Loading…' : 'Preview'}</button>
        {#if repositoryPreviewError}
          <div class="a2-form-error" role="alert">{repositoryPreviewError}</div>
        {/if}
        {#if repositoryPreview}
          <div class="a2-preview">
            <h4>{repositoryPreview.name}</h4>
            {#if repositoryPreview.description}<p>{repositoryPreview.description}</p>{/if}
            <p class="mono">{repositoryPreview.integrationType === 'nuvio' ? 'Nuvio manifest' : 'CloudStream repository'} · {repositoryPreview.pluginListCount} plugin list{repositoryPreview.pluginListCount === 1 ? '' : 's'} · {repositoryPreview.extensionCount} extension{repositoryPreview.extensionCount === 1 ? '' : 's'} discovered</p>
            {#if repositoryPreview.extensions.length > 0}
              <div class="a2-cs-preview-list">
                {#each repositoryPreview.extensions as extension (extension.internalName)}
                  <div class="a2-cs-preview-row">
                    <div class="a2-cs-preview-name">{extension.name ?? extension.internalName}</div>
                    <div class="a2-cs-preview-meta">
                      <span class="mono">{extension.internalName}</span>
                      {#if extension.version}<span>·</span><span>v{extension.version}</span>{/if}
                      {#if !extension.version && extension.versionText}<span>·</span><span>v{extension.versionText}</span>{/if}
                      {#if extension.mediaTypes.length > 0}<span>·</span><span>{extension.mediaTypes.join(' / ')}</span>{/if}
                    </div>
                    <AdminStatusBadge label={previewAdapterLabel(extension.adapterStatus)} tone={previewAdapterTone(extension.adapterStatus)} dot={false} />
                  </div>
                {/each}
                {#if repositoryPreview.truncated}
                  <p class="a2-cs-preview-more">+ {repositoryPreview.extensionCount - repositoryPreview.extensions.length} more…</p>
                {/if}
              </div>
            {/if}
            <form method="POST" action="?/confirmCloudStreamRepository">
              <input type="hidden" name="repositoryUrl" value={repositoryUrl} />
              <button type="submit" class="a2-btn-primary">Confirm Add</button>
            </form>
          </div>
        {/if}
      {/if}
    </div>
  </AdminSheet>
{/if}

<!-- Detail/configure sheet -->
{#if detailSheetOpen && detailAddon}
  <AdminSheet open={detailSheetOpen} title={detailAddon.name} onClose={closeDetail}>
    <div class="a2-detail">
      <dl class="a2-dl">
        <div><dt>Version</dt><dd>{detailAddon.version ?? '—'}</dd></div>
        <div><dt>Types</dt><dd>{(detailAddon.supportedTypes ?? []).join(', ') || '—'}</dd></div>
        <div><dt>Status</dt><dd>{detailAddon.enabled ? 'Enabled' : 'Disabled'}</dd></div>
        <div><dt>Last sync</dt><dd>{formatDate(detailAddon.lastSuccessAt)}</dd></div>
        {#if detailAddon.lastError}<div><dt>Last error</dt><dd class="a2-error-text">{detailAddon.lastError}</dd></div>{/if}
      </dl>
      {#if detailAddon.description}<p class="a2-detail-desc">{detailAddon.description}</p>{/if}

      <h4 class="a2-detail-section">Download Link Types</h4>
      <form method="POST" action="?/saveLinkTypes">
        <input type="hidden" name="id" value={detailAddon.id} />
        {#each ALL_DOWNLOAD_LINK_TYPES as lt}
          <label class="a2-checkbox">
            <input type="checkbox" name={`link_${lt}`} value="1" checked={detailAddon.capabilities?.linkTypes?.[lt] ?? false} />
            <span>{linkTypeLabel(lt)}</span>
          </label>
        {/each}
        <button type="submit" class="a2-btn-primary">Save Link Types</button>
      </form>

      <h4 class="a2-detail-section">Position</h4>
      <!-- FINAL TASK: the position control now operates on the GLOBAL
           source order (add-ons + plugins interleaved) — the input shows
           the add-on's global rank, and moving it shifts plugin sources
           too. Same form-action shape as the add-on-only control it
           replaces (the action routes to the global ordering with the
           legacy add-on-only path as the pre-migration fallback). -->
      <form method="POST" action="?/setAddonPosition" style="display:flex; gap:8px; align-items:center;">
        <input type="hidden" name="id" value={detailAddon.id} />
        <input type="number" name="position" value={addonGlobalPosition(detailAddon.id)} min="1" style="width:80px" aria-label="Global position" />
        <button type="submit" class="a2-btn-secondary">Set Position</button>
      </form>
      <p class="a2-position-hint">The position spans add-ons AND plugin sources — one unified order in the Mavero Downloader.</p>
    </div>
  </AdminSheet>
{/if}

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); }
  .a2-form-error { padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
  .a2-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); }
  .a2-addon-list { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-addon-row { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-addon-row[data-enabled="false"] { opacity: 0.6; }
  .a2-addon-row-info { min-width: 0; }
  .a2-addon-row-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-addon-row-meta { display: flex; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; }
  .a2-addon-type { padding: 1px 4px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); text-transform: uppercase; }
  .a2-addon-error { color: var(--a2-red); }
  .a2-addon-row-actions { display: flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; }
  .a2-icon-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); cursor: pointer; }
  .a2-icon-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-icon-btn-danger:hover { color: var(--a2-red); border-color: var(--a2-red-border); }
  .a2-field { display: flex; flex-direction: column; gap: 2px; }
  .a2-field span { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; font-weight: 700; }
  .a2-field input { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 6px 10px; }
  .a2-add-flow { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .a2-flow-head { display: flex; }
  .a2-back-link { background: none; border: none; color: var(--a2-text-muted); font-size: var(--a2-text-2xs); cursor: pointer; padding: 0; }
  .a2-back-link:hover { color: var(--a2-cyan); }
  .a2-selector-hint { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted); }
  .a2-selector-chips { display: flex; gap: var(--a2-space-3); flex-wrap: wrap; }
  .a2-chip { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-md); color: var(--a2-text); cursor: pointer; min-width: 200px; flex: 1; text-align: left; }
  .a2-chip:hover { border-color: var(--a2-cyan-border); color: var(--a2-cyan); }
  .a2-chip span { font-size: var(--a2-text-sm); font-weight: 700; }
  .a2-chip-sub { font-size: var(--a2-text-2xs) !important; font-weight: 400 !important; color: var(--a2-text-muted); }
  .a2-preview { padding: var(--a2-space-3); background: var(--a2-surface-3); border-radius: var(--a2-radius-sm); display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-preview h4 { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-bright); }
  .a2-cs-preview-list { display: flex; flex-direction: column; gap: var(--a2-space-1); max-height: 280px; overflow-y: auto; }
  .a2-cs-preview-row { display: flex; align-items: center; justify-content: space-between; gap: var(--a2-space-2); padding: var(--a2-space-2); background: var(--a2-surface-2); border-radius: var(--a2-radius-xs); }
  .a2-cs-preview-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-cs-preview-meta { display: flex; gap: 4px; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-cs-preview-more { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); text-align: center; }
  .a2-detail { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .a2-dl { display: grid; grid-template-columns: 1fr 1fr; gap: var(--a2-space-2); margin: 0; }
  .a2-dl > div { display: flex; flex-direction: column; }
  .a2-dl dt { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; font-weight: 700; }
  .a2-dl dd { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text); }
  .a2-error-text { color: var(--a2-red); }
  .a2-detail-desc { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted); }
  .a2-position-hint { margin: 4px 0 0; font-size: var(--a2-text-xs); color: var(--a2-text-muted); }
  .a2-detail-section { font-size: var(--a2-text-xs); font-weight: 700; color: var(--a2-text-bright); margin: var(--a2-space-3) 0 var(--a2-space-1); }
  .a2-checkbox { display: flex; align-items: center; gap: var(--a2-space-2); font-size: var(--a2-text-sm); color: var(--a2-text); }
  .a2-btn-primary { padding: 10px 16px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-btn-secondary { padding: 10px 16px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }
  @media (max-width: 768px) { .a2-addon-row { flex-direction: column; align-items: stretch; } .a2-addon-row-actions { justify-content: flex-end; } .a2-dl { grid-template-columns: 1fr; } .a2-selector-chips { flex-direction: column; } }
</style>
