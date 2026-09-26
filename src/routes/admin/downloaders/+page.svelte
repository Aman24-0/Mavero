<script lang="ts">
  import { Check, ChevronRight, Download, Star, Trash2 } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import type { ActionData, PageData } from './$types';
  import { slugifyTitle } from '$lib/shared/downloader';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  function previewSlug(name: string, movieTemplate: string | null): string {
    if (!movieTemplate || !movieTemplate.includes('{titleSlug}')) return '';
    return slugifyTitle(name || 'Example Title');
  }
  function supportsMovieLabel(provider: PageData['providers'][number]): string {
    const types: string[] = [];
    if (provider.supports_movie) types.push('Movie');
    if (provider.supports_tv) types.push('TV');
    return types.length === 0 ? 'None' : types.join(' · ');
  }
  function typeLabel(provider: PageData['providers'][number]): string {
    return provider.type === 'json' ? 'JSON' : 'Embed';
  }

  // Create/Edit modal state.
  let sheetOpen = $state(false);
  let editingProvider = $state<PageData['providers'][number] | null>(null);

  function openCreate(event?: Event) {
    editingProvider = null;
    sheetOpen = true;
  }
  function openEdit(provider: PageData['providers'][number], event?: Event) {
    editingProvider = provider;
    sheetOpen = true;
  }
  function closeSheet() {
    sheetOpen = false;
    editingProvider = null;
  }
</script>

<svelte:head><title>Downloader Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="downloaders">
  <AdminPageHeader
    eyebrow="MAVERO / Downloader registry"
    title="Downloaders"
    accent="registry."
    count={`${data.providers.length} records · ${data.overview.enabledCount} enabled`}
  >
    {#snippet actions()}
      <AdminAddButton label="Add downloader" onclick={openCreate} />
    {/snippet}
  </AdminPageHeader>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  {#if data.providers.length === 0}
    <AdminEmptyState
      icon={Download}
      title="No downloaders yet"
      message="Create the first downloader. It remains disabled until explicitly enabled."
    />
  {:else}
    <div class="registry-list">
      {#each data.providers as provider (provider.id)}
        <article class="record">
          <div class="record-head" onclick={(e) => openEdit(provider, e)} role="button" tabindex="0"
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(provider, e); } }}
                 aria-label={`Edit ${provider.name}`}>
            <span class="provider-icon">{provider.icon || 'DL'}</span>
            <div class="record-copy">
              <strong class="record-name">{provider.name}{#if provider.is_default}<span class="default-badge"><Star size={11} fill="currentColor" strokeWidth={0} /> Default</span>{/if}</strong>
              <span class="record-sub">{provider.slug} · {typeLabel(provider)} · {supportsMovieLabel(provider)} · order {provider.ordering}</span>
            </div>
            <span class="record-chevron"><ChevronRight size={18} /></span>
          </div>
          <div class="record-badges">
            <AdminStatusBadge
              label={provider.enabled ? 'Enabled' : 'Disabled'}
              tone={provider.enabled ? 'good' : 'neutral'}
            />
            <span class="record-actions">
              <form method="POST" action="?/toggleProvider" class="inline-form">
                <input type="hidden" name="id" value={provider.id} />
                <input type="hidden" name="enabled" value={provider.enabled ? 'false' : 'true'} />
                <button class="mini-btn" type="submit">{provider.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              {#if !provider.is_default}
                <form method="POST" action="?/setDefault" class="inline-form" onsubmit={() => confirm(`Make ${provider.name} the default downloader?`)}>
                  <input type="hidden" name="id" value={provider.id} />
                  <button class="mini-btn" type="submit"><Star size={12} /> Default</button>
                </form>
              {/if}
              <form method="POST" action="?/deleteProvider" class="inline-form" onsubmit={() => confirm(`Delete ${provider.name}?`)}>
                <input type="hidden" name="id" value={provider.id} />
                <button class="mini-btn mini-btn-danger" type="submit" aria-label={`Delete ${provider.name}`}><Trash2 size={13} /></button>
              </form>
            </span>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</AdminShell>

<AdminSheet
  open={sheetOpen}
  title={editingProvider ? `Edit ${editingProvider.name}` : 'Add downloader'}
  onClose={closeSheet}
  closeOnBackdrop={false}
  size="wide"
>
  <form method="POST" action={editingProvider ? '?/updateProvider' : '?/createProvider'} class="registry-form">
    {#if editingProvider}
      <input type="hidden" name="id" value={editingProvider.id} />
    {/if}
    <div class="form-grid two">
      <label>Name<input name="name" required maxlength="120" placeholder="02Movie Downloader" value={editingProvider?.name ?? ''} /></label>
      <label>Slug<input name="slug" required maxlength="120" placeholder="02movie" value={editingProvider?.slug ?? ''} /></label>
    </div>
    <div class="form-grid three">
      <label>Ordering<input name="ordering" type="number" min="0" step="1" value={editingProvider?.ordering ?? 0} /></label>
      <label>Icon / display token<input name="icon" maxlength="120" placeholder="download" value={editingProvider?.icon ?? ''} /></label>
      <label class="check"><input type="checkbox" name="enabled" checked={editingProvider?.enabled ?? false} /> Enabled</label>
    </div>
    <div class="form-grid two">
      <label class="check"><input type="checkbox" name="supports_movie" checked={editingProvider?.supports_movie ?? true} /> Supports movie</label>
      <label class="check"><input type="checkbox" name="supports_tv" checked={editingProvider?.supports_tv ?? true} /> Supports TV</label>
    </div>
    <div>
      <label>Type
        <select name="type" value={editingProvider?.type ?? 'embed'}>
          <option value="embed">Embed</option>
          <option value="json">JSON</option>
        </select>
      </label>
      <small class="hint">Embed loads the provider page in an iframe. JSON fetches the provider API server-side and lists its download links inline (no iframe).</small>
    </div>
    <label class="check"><input type="checkbox" name="is_default" checked={editingProvider?.is_default ?? false} /> Set as default downloader</label>
    <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="Safe display description shown to users.">{editingProvider?.description ?? ''}</textarea></label>
    <label>Movie URL template (HTTPS only)<input name="movie_url_template" maxlength="500" placeholder={'https://example.com/movie/{tmdbId}'} value={editingProvider?.movie_url_template ?? ''} /></label>
    {#if editingProvider && previewSlug(editingProvider.name, editingProvider.movie_url_template)}
      <small class="hint">Slug preview for "{editingProvider.name}": <code>{previewSlug(editingProvider.name, editingProvider.movie_url_template)}</code></small>
    {/if}
    <label>TV URL template (HTTPS only)<input name="tv_url_template" maxlength="500" placeholder={'https://example.com/tv/{tmdbId}/{season}/{episode}'} value={editingProvider?.tv_url_template ?? ''} /></label>
    <small class="hint">Allowed placeholders: <code>{'{' + 'tmdbId}'}</code> <code>{'{' + 'season}'}</code> <code>{'{' + 'episode}'}</code> <code>{'{' + 'season2}'}</code> <code>{'{' + 'episode2}'}</code> <code>{'{' + 'titleSlug}'}</code>. <code>{'{' + 'season2}'}</code>/<code>{'{' + 'episode2}'}</code> are zero-padded (s02e05). <code>{'{' + 'titleSlug}'}</code> is generated from the title.</small>
    <div class="sheet-actions">
      <button class="btn btn-primary" type="submit">{editingProvider ? 'Save changes' : 'Create downloader'}</button>
      <button class="btn btn-secondary" type="button" onclick={closeSheet}>Cancel</button>
    </div>
  </form>
</AdminSheet>

<style>
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; }
  .notice { color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }
  .error { color: var(--color-danger); border: 1px solid rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .07); }

  .registry-list { display: grid; gap: 10px; margin-top: 12px; }
  .record {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    transition: border-color var(--motion-fast) var(--ease-out);
  }
  .record:hover { border-color: var(--color-primary-border); }
  .record-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    cursor: pointer;
    min-height: 56px;
    outline: none;
  }
  .record-head:hover { background: rgba(0, 255, 156, .025); }
  .record-head:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
  .provider-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary-border);
    font-size: .58rem;
    font-weight: 800;
    flex: 0 0 auto;
  }
  .record-copy { min-width: 0; flex: 1; }
  .record-name {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--color-text);
    font-size: .86rem;
    font-weight: 700;
  }
  .default-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; color: #050708; background: var(--color-primary); border: 1px solid var(--color-primary-border); font-size: .5rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; box-shadow: var(--glow-primary); }
  .record-sub {
    display: block;
    margin-top: 3px;
    color: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .56rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .record-chevron {
    display: inline-flex;
    color: var(--color-text-deep);
    flex: 0 0 auto;
    transition: color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .record-head:hover .record-chevron { color: var(--color-primary); transform: translateX(2px); }

  .record-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 0 14px 12px;
    border-top: 1px solid var(--color-border);
    padding-top: 10px;
    margin-top: 2px;
  }
  .record-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    flex-wrap: nowrap;
  }
  .mini-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 32px;
    padding: 0 11px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    color: var(--color-text-muted);
    background: transparent;
    font: inherit;
    font-size: .64rem;
    font-weight: 700;
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  }
  .mini-btn:hover { color: var(--color-text); border-color: var(--color-primary-border); background: var(--color-primary-soft); }
  .mini-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .mini-btn-danger { color: var(--color-danger); border-color: rgba(255, 77, 109, .3); }
  .mini-btn-danger:hover { color: var(--color-danger); border-color: rgba(255, 77, 109, .5); background: rgba(255, 77, 109, .08); }
  .inline-form { display: inline-flex; padding: 0; }

  /* Form */
  .registry-form { display: grid; gap: 13px; }
  .form-grid { display: grid; gap: 10px; }
  .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label { display: grid; gap: 6px; color: var(--color-text-muted); font-size: .58rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  input, textarea, select {
    width: 100%; box-sizing: border-box;
    min-height: 44px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--color-text);
    background: var(--color-surface-elevated);
    font: inherit;
    font-family: inherit;
    font-size: .78rem;
    outline: none;
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  input:focus, textarea:focus, select:focus {
    border-color: var(--color-primary);
    background: var(--color-surface-raised);
    box-shadow: var(--glow-primary);
  }
  textarea { resize: vertical; line-height: 1.55; min-height: 64px; }
  .check { display: flex; align-items: center; justify-content: flex-start; gap: 10px; min-height: 44px; padding: 10px 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface-elevated); text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--color-text); font-size: .76rem; }
  .check input { width: auto; min-height: 0; accent-color: var(--color-primary); }

  .sheet-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0 14px; cursor: pointer; color: var(--color-text); background: var(--color-primary-soft); font: inherit; font-size: .74rem; font-weight: 700; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .btn:active { transform: scale(.98); }
  .btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .btn-primary { border-color: transparent; color: #050708; background: var(--color-primary); box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary); }
  .btn-primary:hover { filter: brightness(1.06); }
  .btn-secondary:hover { border-color: var(--color-primary-border); background: var(--color-primary-soft); box-shadow: var(--glow-primary); }

  .hint { display: block; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; line-height: 1.5; }
  .hint code { color: var(--color-text); background: var(--color-surface-elevated); padding: 1px 5px; border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .54rem; }

  @media (max-width: 640px) {
    .form-grid.two, .form-grid.three { grid-template-columns: 1fr; }
    .record-badges { gap: 4px; }
  }
</style>
