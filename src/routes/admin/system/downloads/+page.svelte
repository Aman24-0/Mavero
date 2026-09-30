<script lang="ts">
  /**
   * Admin 2.0 — Phase 1 — Downloads workspace.
   * Full CRUD for downloader providers. No redirects to legacy UI.
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import { Download, Check, Edit3, Trash2, Power, Star } from 'lucide-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let sheetOpen = $state(false);
  let editing: any = $state(null);

  function openCreate() { editing = null; sheetOpen = true; }
  function openEdit(p: any) { editing = p; sheetOpen = true; }
  function closeSheet() { sheetOpen = false; editing = null; }
</script>

<svelte:head><title>Downloads — Mavero Admin</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminAppShell active="downloads">
  <AdminPage eyebrow="System" title="Downloads" accent="cyan">
    {#snippet actions()}<AdminAddButton label="Add downloader" onclick={openCreate} />{/snippet}
    {#snippet description()}<p>Manage embed and JSON download providers. Full CRUD available.</p>{/snippet}

    {#if data.notice}<div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>{/if}
    {#if form?.message}<div class="a2-form-error" role="alert">{form.message}</div>{/if}

    {#if data.providers.length === 0}
      <div class="a2-empty"><Download size={32} /><h3>No downloaders</h3><p>Add a download provider.</p><AdminAddButton label="Add downloader" onclick={openCreate} /></div>
    {:else}
      <div class="a2-dl-list">
        {#each data.providers as p (p.id)}
          <div class="a2-dl-row" data-enabled={p.enabled}>
            <div class="a2-dl-row-main">
              <span class="a2-dl-row-icon">{p.icon ?? '📦'}</span>
              <div class="a2-dl-row-info">
                <div class="a2-dl-row-name">{p.name} {#if p.is_default}<span class="a2-dl-default-badge">DEFAULT</span>{/if}</div>
                <div class="a2-dl-row-meta">
                  <span class="mono">{p.slug}</span><span>·</span>
                  <span class="a2-dl-type-badge" data-type={p.type}>{p.type}</span><span>·</span>
                  {#if p.supports_movie}<span>Movie</span>{/if}
                  {#if p.supports_tv}<span>TV</span>{/if}
                </div>
              </div>
            </div>
            <div class="a2-dl-row-actions">
              <AdminStatusBadge label={p.enabled ? 'Enabled' : 'Disabled'} tone={p.enabled ? 'good' : 'neutral'} />
              {#if !p.is_default}
                <form method="POST" action="?/setDefault" style="display:inline">
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" class="a2-icon-btn" title="Set default"><Star size={14} /></button>
                </form>
              {/if}
              <form method="POST" action="?/toggleProvider" style="display:inline">
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="enabled" value={String(!p.enabled)} />
                <button type="submit" class="a2-icon-btn" title={p.enabled ? 'Disable' : 'Enable'}><Power size={14} /></button>
              </form>
              <button type="button" class="a2-icon-btn" onclick={() => openEdit(p)} title="Edit"><Edit3 size={14} /></button>
              <form method="POST" action="?/deleteProvider" style="display:inline" onsubmit={() => confirm('Delete this downloader?')}>
                <input type="hidden" name="id" value={p.id} />
                <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete"><Trash2 size={14} /></button>
              </form>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </AdminPage>
</AdminAppShell>

{#if sheetOpen}
  <AdminSheet open={sheetOpen} title={editing ? `Edit ${editing.name}` : 'Add Downloader'} onClose={closeSheet}>
    <form method="POST" action={editing ? '?/updateProvider' : '?/createProvider'} class="a2-crud-form">
      {#if editing}<input type="hidden" name="id" value={editing.id} />{/if}
      <AdminFormSection heading="Identity">
        <label class="a2-field"><span>Name</span><input name="name" required value={editing?.name ?? ''} /></label>
        <label class="a2-field"><span>Slug</span><input name="slug" required value={editing?.slug ?? ''} /></label>
        <label class="a2-field"><span>Type</span>
          <select name="type">
            <option value="embed" selected={editing?.type === 'embed'}>Embed</option>
            <option value="json" selected={editing?.type === 'json'}>JSON</option>
          </select>
        </label>
        <label class="a2-field"><span>Icon</span><input name="icon" value={editing?.icon ?? ''} /></label>
        <label class="a2-field"><span>Ordering</span><input type="number" name="ordering" value={editing?.ordering ?? 0} /></label>
      </AdminFormSection>
      <AdminFormSection heading="Support">
        <label class="a2-field"><span>Supports Movie</span><input type="checkbox" name="supports_movie" value="true" checked={editing ? editing.supports_movie : true} /></label>
        <label class="a2-field"><span>Supports TV</span><input type="checkbox" name="supports_tv" value="true" checked={editing ? editing.supports_tv : true} /></label>
        <label class="a2-field"><span>Enabled</span><input type="checkbox" name="enabled" value="true" checked={editing ? editing.enabled : true} /></label>
        <label class="a2-field"><span>Is Default</span><input type="checkbox" name="is_default" value="true" checked={editing?.is_default ?? false} /></label>
      </AdminFormSection>
      <AdminFormSection heading="URL Templates">
        <label class="a2-field"><span>Movie URL Template</span><input name="movie_url_template" value={editing?.movie_url_template ?? ''} placeholder={'https://example.com/{tmdbId}'} /></label>
        <label class="a2-field"><span>TV URL Template</span><input name="tv_url_template" value={editing?.tv_url_template ?? ''} placeholder={'https://example.com/{tmdbId}/{season}/{episode}'} /></label>
      </AdminFormSection>
      <AdminFormSection heading="Metadata">
        <label class="a2-field"><span>Description</span><input name="description" value={editing?.description ?? ''} /></label>
      </AdminFormSection>
      <div class="a2-form-actions">
        <button type="submit" class="a2-btn-primary">{editing ? 'Save' : 'Create'}</button>
        <button type="button" class="a2-btn-secondary" onclick={closeSheet}>Cancel</button>
      </div>
    </form>
  </AdminSheet>
{/if}

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); }
  .a2-form-error { padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
  .a2-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); }
  .a2-dl-list { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-dl-row { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-dl-row[data-enabled="false"] { opacity: 0.6; }
  .a2-dl-row-main { display: flex; align-items: center; gap: var(--a2-space-3); min-width: 0; }
  .a2-dl-row-icon { font-size: 20px; }
  .a2-dl-row-info { min-width: 0; }
  .a2-dl-row-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); display: flex; align-items: center; gap: var(--a2-space-2); }
  .a2-dl-default-badge { font-size: 9px; padding: 1px 4px; background: var(--a2-cyan-soft); border: 1px solid var(--a2-cyan-border); border-radius: var(--a2-radius-xs); color: var(--a2-cyan); font-weight: 700; }
  .a2-dl-row-meta { display: flex; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; }
  .a2-dl-type-badge { padding: 1px 4px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); text-transform: uppercase; color: var(--a2-cyan); }
  .a2-dl-type-badge[data-type="json"] { color: var(--a2-amber); }
  .a2-dl-row-actions { display: flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; }
  .a2-icon-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); cursor: pointer; }
  .a2-icon-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-icon-btn-danger:hover { color: var(--a2-red); border-color: var(--a2-red-border); }
  .a2-crud-form { display: flex; flex-direction: column; gap: var(--a2-space-4); }
  .a2-field { display: flex; flex-direction: column; gap: 2px; }
  .a2-field span { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-field input, .a2-field select { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 6px 10px; }
  .a2-field input:focus, .a2-field select:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-form-actions { display: flex; gap: var(--a2-space-2); justify-content: flex-end; padding-top: var(--a2-space-3); border-top: 1px solid var(--a2-border); }
  .a2-btn-primary { padding: 10px 16px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-btn-secondary { padding: 10px 16px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }
  @media (max-width: 768px) { .a2-dl-row { flex-direction: column; align-items: stretch; } .a2-dl-row-actions { justify-content: flex-end; } }
</style>
