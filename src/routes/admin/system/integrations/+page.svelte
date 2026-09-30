<script lang="ts">
  /**
   * Admin 2.0 — Phase 1 — Integrations workspace.
   * Full CRUD for Stremio addons. No redirects to legacy UI.
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import { Puzzle, Check, RefreshCw, Trash2, Power, Edit3 } from 'lucide-svelte';
  import { ALL_DOWNLOAD_LINK_TYPES, linkTypeLabel, getLinkTypesConfig, type DownloadLinkType } from '$lib/shared/download-link-types';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let addSheetOpen = $state(false);
  let detailSheetOpen = $state(false);
  let detailAddon: any = $state(null);
  let manifestUrl = $state('');
  let preview = $state<any>(null);
  let previewing = $state(false);

  async function doPreview() {
    if (!manifestUrl.trim()) return;
    previewing = true;
    preview = null;
    try {
      const res = await fetch('/admin/system/integrations?/previewAddon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ manifestUrl }),
      });
      const json = await res.json();
      if (json.form?.preview) preview = json.form.preview;
      else if (json.form?.message) alert(json.form.message);
    } catch { alert('Network error'); }
    previewing = false;
  }

  function openDetail(addon: any) { detailAddon = addon; detailSheetOpen = true; }
  function closeDetail() { detailSheetOpen = false; detailAddon = null; }

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString(); } catch { return '—'; }
  }
</script>

<svelte:head><title>Integrations — Mavero Admin</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminAppShell active="integrations">
  <AdminPage eyebrow="System" title="Integrations" accent="cyan">
    {#snippet actions()}<AdminAddButton label="Add addon" onclick={() => { addSheetOpen = true; }} />{/snippet}
    {#snippet description()}<p>Manage Stremio addon integrations. Full CRUD available — no redirects to legacy UI.</p>{/snippet}

    {#if data.notice}<div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>{/if}
    {#if form?.message}<div class="a2-form-error" role="alert">{form.message}</div>{/if}

    {#if data.addons.length === 0}
      <div class="a2-empty"><Puzzle size={32} /><h3>No integrations</h3><p>Add a Stremio addon manifest URL.</p><AdminAddButton label="Add addon" onclick={() => { addSheetOpen = true; }} /></div>
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
              <form method="POST" action="?/deleteAddon" style="display:inline" onsubmit={() => confirm('Delete this addon?')}>
                <input type="hidden" name="id" value={addon.id} />
                <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete"><Trash2 size={14} /></button>
              </form>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </AdminPage>
</AdminAppShell>

<!-- Add addon sheet -->
{#if addSheetOpen}
  <AdminSheet open={addSheetOpen} title="Add Stremio Addon" onClose={() => { addSheetOpen = false; preview = null; manifestUrl = ''; }}>
    <div class="a2-add-flow">
      <label class="a2-field"><span>Manifest URL</span><input type="url" bind:value={manifestUrl} placeholder="https://example.com/manifest.json" /></label>
      <button type="button" class="a2-btn-primary" onclick={doPreview} disabled={previewing || !manifestUrl.trim()}>{previewing ? 'Loading…' : 'Preview'}</button>
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
      <form method="POST" action="?/setAddonPosition" style="display:flex; gap:8px; align-items:center;">
        <input type="hidden" name="id" value={detailAddon.id} />
        <input type="number" name="position" value={detailAddon.ordering ?? 0} style="width:80px" />
        <button type="submit" class="a2-btn-secondary">Set Position</button>
      </form>
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
  .a2-preview { padding: var(--a2-space-3); background: var(--a2-surface-3); border-radius: var(--a2-radius-sm); display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-preview h4 { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-bright); }
  .a2-detail { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .a2-dl { display: grid; grid-template-columns: 1fr 1fr; gap: var(--a2-space-2); margin: 0; }
  .a2-dl > div { display: flex; flex-direction: column; }
  .a2-dl dt { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; font-weight: 700; }
  .a2-dl dd { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text); }
  .a2-error-text { color: var(--a2-red); }
  .a2-detail-desc { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted); }
  .a2-detail-section { font-size: var(--a2-text-xs); font-weight: 700; color: var(--a2-text-bright); margin: var(--a2-space-3) 0 var(--a2-space-1); }
  .a2-checkbox { display: flex; align-items: center; gap: var(--a2-space-2); font-size: var(--a2-text-sm); color: var(--a2-text); }
  .a2-btn-primary { padding: 10px 16px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-btn-secondary { padding: 10px 16px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }
  @media (max-width: 768px) { .a2-addon-row { flex-direction: column; align-items: stretch; } .a2-addon-row-actions { justify-content: flex-end; } .a2-dl { grid-template-columns: 1fr; } }
</style>
