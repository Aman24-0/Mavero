<script lang="ts">
  import { ArrowDown, ArrowUp, Check, ChevronRight, Puzzle, RefreshCw, Trash2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import { ALL_DOWNLOAD_LINK_TYPES, linkTypeLabel, linkTypeDescription, getLinkTypesConfig, DEFAULT_LINK_TYPES_CONFIG, type DownloadLinkType } from '$lib/shared/download-link-types';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Preview = Extract<NonNullable<ActionData>, { preview: unknown }>['preview'];

  // Add-workflow state — the add sheet + the confirmed preview.
  // svelte-ignore state_referenced_locally — captures initial registry
  // state at first mount; subsequent data updates re-mount the page so
  // the initial state remains correct.
  let addSheetOpen = $state(data.addons.length === 0);
  let shownPreview = $state<Preview | null>(null);
  $effect(() => {
    if (form?.preview) shownPreview = form.preview;
  });

  function cancelPreview() {
    shownPreview = null;
    addSheetOpen = false;
  }

  function openAddSheet() {
    addSheetOpen = true;
  }
  function closeAddSheet() {
    addSheetOpen = false;
    shownPreview = null;
  }

  // Duplicate-submission guard.
  let pending = $state('');
  $effect(() => { if (form) pending = ''; });
  function guard(action: string, confirmMessage?: string) {
    return (event: SubmitEvent) => {
      if (pending) { event.preventDefault(); return; }
      if (confirmMessage && !confirm(confirmMessage)) { event.preventDefault(); return; }
      pending = action;
    };
  }

  const DELETE_CONFIRM = 'Remove addon?\n\nThis will remove the addon from MAVERO. Its streams will no longer be available.';

  const statusLabels: Record<string, string> = {
    active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable',
  };
  function statusToneFor(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
    if (status === 'active' || status === 'experimental') return 'good';
    if (status === 'maintenance') return 'warn';
    if (status === 'unavailable') return 'bad';
    return 'neutral';
  }
  function formatDate(value: string | undefined): string {
    if (!value) return 'Never';
    return new Date(value).toLocaleString();
  }

  // Detail modal — replaces the inline <details> accordion for each addon.
  let detailSheetOpen = $state(false);
  let detailAddon = $state<PageData['addons'][number] | null>(null);
  function openDetail(addon: PageData['addons'][number]) {
    detailAddon = addon;
    detailSheetOpen = true;
  }
  function closeDetail() {
    detailSheetOpen = false;
    detailAddon = null;
  }
</script>

<svelte:head><title>Stremio Addons — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="addons">
  <AdminPageHeader
    eyebrow="MAVERO / Addon registry"
    title="Stremio"
    accent="addons."
    count={`${data.addons.length} addons · ${data.addons.filter((addon) => addon.enabled).length} enabled`}
  >
    {#snippet actions()}
      <AdminAddButton label="Add Stremio Addon" onclick={openAddSheet} />
    {/snippet}
  </AdminPageHeader>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  {#if data.addons.length === 0}
    <AdminEmptyState
      icon={Puzzle}
      title="No Stremio addons configured"
      message="Add a supported Stremio HTTP addon to make additional streams available through MAVERO Player."
    >
      {#snippet actions()}
        <button class="btn btn-primary" type="button" onclick={openAddSheet}>Add Stremio Addon</button>
      {/snippet}
    </AdminEmptyState>
  {:else}
    <div class="registry-list">
      {#each data.addons as addon (addon.id)}
        <article class="record">
          <div class="record-head" onclick={() => openDetail(addon)} role="button" tabindex="0"
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(addon); } }}
                 aria-label={`View ${addon.name}`}>
            <span class="provider-icon" aria-hidden="true"><Puzzle size={14} /></span>
            <div class="record-copy">
              <strong class="record-name">{addon.name}</strong>
              <span class="record-sub">{addon.version ? `v${addon.version} · ` : ''}order {addon.ordering} · {addon.supportedTypes.length ? addon.supportedTypes.join(', ') : 'no types'}</span>
            </div>
            <span class="record-chevron"><ChevronRight size={18} /></span>
          </div>
          <div class="record-badges">
            <AdminStatusBadge
              label={addon.enabled ? 'Enabled' : 'Disabled'}
              tone={addon.enabled ? 'good' : 'neutral'}
            />
            <AdminStatusBadge
              label={statusLabels[addon.status] ?? addon.status}
              tone={statusToneFor(addon.status)}
            />
            <span class="record-actions">
              <form method="POST" action="?/setEnabled" class="inline-form" onsubmit={guard('setEnabled')}>
                <input type="hidden" name="id" value={addon.id} />
                <input type="hidden" name="enabled" value={addon.enabled ? 'false' : 'true'} />
                <button class="mini-btn" type="submit" disabled={pending !== ''} aria-busy={pending === 'setEnabled'}>{pending === 'setEnabled' ? 'Saving…' : addon.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form method="POST" action="?/refreshAddon" class="inline-form" onsubmit={guard('refreshAddon')}>
                <input type="hidden" name="id" value={addon.id} />
                <button class="mini-btn" type="submit" disabled={pending !== ''} aria-busy={pending === 'refreshAddon'}><RefreshCw size={12} /> {pending === 'refreshAddon' ? 'Refreshing…' : 'Refresh'}</button>
              </form>
              <form method="POST" action="?/moveAddon" class="inline-form" onsubmit={guard('moveAddon')}>
                <input type="hidden" name="id" value={addon.id} />
                <input type="hidden" name="direction" value="up" />
                <button class="mini-btn mini-btn-icon" type="submit" disabled={pending !== ''} aria-label={`Move ${addon.name} up`}><ArrowUp size={13} /></button>
              </form>
              <form method="POST" action="?/moveAddon" class="inline-form" onsubmit={guard('moveAddon')}>
                <input type="hidden" name="id" value={addon.id} />
                <input type="hidden" name="direction" value="down" />
                <button class="mini-btn mini-btn-icon" type="submit" disabled={pending !== ''} aria-label={`Move ${addon.name} down`}><ArrowDown size={13} /></button>
              </form>
              <form method="POST" action="?/deleteAddon" class="inline-form" onsubmit={guard('deleteAddon', DELETE_CONFIRM)}>
                <input type="hidden" name="id" value={addon.id} />
                <button class="mini-btn mini-btn-danger" type="submit" disabled={pending !== ''} aria-busy={pending === 'deleteAddon'} aria-label={`Remove ${addon.name}`}><Trash2 size={13} /> {pending === 'deleteAddon' ? 'Removing…' : 'Remove'}</button>
              </form>
            </span>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</AdminShell>

<!-- ============================================================
     ADD ADDON MODAL — preview-then-confirm flow preserved.
     ============================================================ -->
<AdminSheet
  open={addSheetOpen}
  title="Add Stremio Addon"
  description="Manifests are validated server-side — the browser never fetches addon URLs."
  onClose={closeAddSheet}
  closeOnBackdrop={false}
  size="wide"
>
  <form method="POST" action="?/previewAddon" class="registry-form" onsubmit={guard('previewAddon')}>
    <label for="addon-manifest-url">Manifest URL</label>
    <input
      id="addon-manifest-url"
      name="manifestUrl"
      type="url"
      required
      maxlength="2048"
      placeholder="https://example.com/manifest.json"
      aria-describedby="addon-manifest-hint"
    />
    <small class="hint" id="addon-manifest-hint">HTTP or HTTPS Stremio manifest. The URL is validated and fetched by the server (SSRF-checked); only HTTP stream addons are accepted.</small>
    <div class="sheet-actions">
      <button class="btn btn-primary" type="submit" disabled={pending !== ''} aria-busy={pending === 'previewAddon'}>{pending === 'previewAddon' ? 'Validating addon…' : 'Validate addon'}</button>
      <button class="btn btn-secondary" type="button" onclick={closeAddSheet}>Cancel</button>
    </div>
  </form>

  {#if shownPreview}
    <div class="preview" aria-live="polite">
      <div class="eyebrow">Addon detected</div>
      <h3>{shownPreview.name}</h3>
      <dl class="preview-grid">
        <div><dt>Version</dt><dd>{shownPreview.version}</dd></div>
        <div><dt>Stream support</dt><dd class:good={shownPreview.supportsStream}>{shownPreview.supportsStream ? 'HTTP streams' : 'None'}</dd></div>
        <div><dt>Supported types</dt><dd>{shownPreview.supportedTypes.length ? shownPreview.supportedTypes.join(', ') : '—'}</dd></div>
        <div><dt>ID prefixes</dt><dd>{shownPreview.idPrefixes.length ? shownPreview.idPrefixes.join(', ') : '—'}</dd></div>
      </dl>
      {#if shownPreview.description}<p class="preview-desc">{shownPreview.description}</p>{/if}
      <form method="POST" action="?/confirmAddon" class="sheet-actions" onsubmit={guard('confirmAddon')}>
        <input type="hidden" name="manifestUrl" value={shownPreview.manifestUrl} />
        <button class="btn btn-primary" type="submit" disabled={pending !== ''} aria-busy={pending === 'confirmAddon'}>{pending === 'confirmAddon' ? 'Adding…' : 'Add addon'}</button>
        <button class="btn btn-secondary" type="button" onclick={cancelPreview}><X size={13} /> Cancel</button>
      </form>
    </div>
  {/if}
</AdminSheet>

<!-- ============================================================
     ADDON DETAIL MODAL — replaces the inline <details> accordion.
     Identity / status / configuration / actions are clearly separated.
     ============================================================ -->
<AdminSheet
  open={detailSheetOpen}
  title={detailAddon ? detailAddon.name : 'Addon'}
  onClose={closeDetail}
  size="wide"
>
  {#if detailAddon}
    <dl class="meta-grid">
      <div><dt>Description</dt><dd>{detailAddon.description ?? '—'}</dd></div>
      <div><dt>Stream support</dt><dd class:good={detailAddon.supportsStream}>{detailAddon.supportsStream ? 'HTTP streams' : 'None'}</dd></div>
      <div><dt>ID prefixes</dt><dd>{detailAddon.idPrefixes.length ? detailAddon.idPrefixes.join(', ') : '—'}</dd></div>
      <div><dt>Resources</dt><dd>{detailAddon.resources.length ? detailAddon.resources.join(', ') : '—'}</dd></div>
      <div><dt>Manifest URL</dt><dd class="url">{detailAddon.manifestUrl}</dd></div>
      <div><dt>Last successful refresh</dt><dd>{formatDate(detailAddon.lastSuccessAt)}</dd></div>
      {#if detailAddon.lastError}<div><dt>Refresh status</dt><dd class="bad">{detailAddon.lastError}</dd></div>{/if}
    </dl>

    <!-- Phase E V2: Downloader Link Types configuration. -->
    <div class="link-types-section">
      <h4 class="link-types-heading">DOWNLOADER · Link Types</h4>
      <p class="link-types-desc">Choose which link types the Mavero Downloader exposes for this addon.</p>
      <form method="POST" action="?/saveLinkTypes" class="link-types-form" onsubmit={guard('saveLinkTypes')}>
        <input type="hidden" name="id" value={detailAddon.id} />
        <div class="link-types-grid">
          {#each ALL_DOWNLOAD_LINK_TYPES as type (type)}
            <div class="link-type-row">
              <label class="link-type-toggle">
                <input type="checkbox" name={`linkType_${type}`} checked={getLinkTypesConfig(detailAddon.capabilities)[type as DownloadLinkType]} />
                <span class="link-type-label">{linkTypeLabel(type)}</span>
              </label>
              <span class="link-type-desc">{linkTypeDescription(type)}</span>
            </div>
          {/each}
        </div>
        <div class="sheet-actions">
          <button class="btn btn-primary" type="submit" disabled={pending !== ''} aria-busy={pending === 'saveLinkTypes'}>{pending === 'saveLinkTypes' ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </div>
  {/if}
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
    flex: 0 0 auto;
  }
  .record-copy { min-width: 0; flex: 1; }
  .record-name {
    display: block;
    color: var(--color-text);
    font-size: .86rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
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
    flex-wrap: wrap;
    justify-content: flex-end;
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
    transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out);
  }
  .mini-btn:disabled { opacity: .55; cursor: default; }
  .mini-btn:not(:disabled):hover { color: var(--color-text); border-color: var(--color-primary-border); background: var(--color-primary-soft); }
  .mini-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .mini-btn-icon { padding: 0 9px; min-width: 32px; }
  .mini-btn-danger { color: var(--color-danger); border-color: rgba(255, 77, 109, .3); }
  .mini-btn-danger:not(:disabled):hover { color: var(--color-danger); border-color: rgba(255, 77, 109, .5); background: rgba(255, 77, 109, .08); }
  .inline-form { display: inline-flex; padding: 0; }

  /* Form (inside the add modal) */
  .registry-form { display: grid; gap: 13px; }
  label { display: grid; gap: 6px; color: var(--color-text-muted); font-size: .58rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  input {
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
  input:focus { border-color: var(--color-primary); background: var(--color-surface-raised); box-shadow: var(--glow-primary); }

  .hint { display: block; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; line-height: 1.5; }

  .sheet-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0 14px; cursor: pointer; color: var(--color-text); background: var(--color-primary-soft); font: inherit; font-size: .74rem; font-weight: 700; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out); }
  .btn:disabled { opacity: .55; cursor: default; }
  .btn:not(:disabled):active { transform: scale(.98); }
  .btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .btn-primary { border-color: transparent; color: #050708; background: var(--color-primary); box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary); }
  .btn-primary:not(:disabled):hover { filter: brightness(1.06); }
  .btn-secondary:not(:disabled):hover { border-color: var(--color-primary-border); background: var(--color-primary-soft); box-shadow: var(--glow-primary); }

  /* Preview (inside the add modal) */
  .preview { margin-top: 14px; padding: 14px; border: 1px solid var(--color-primary-border); border-radius: var(--radius-sm); background: rgba(0, 255, 156, .04); }
  .preview h3 { margin: 6px 0 12px; color: var(--color-text); font-size: .95rem; letter-spacing: -.01em; }
  .preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; }
  .preview-grid dt { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .54rem; text-transform: uppercase; letter-spacing: .06em; }
  .preview-grid dd { margin: 4px 0 0; color: var(--color-text); font-size: .72rem; line-height: 1.5; overflow-wrap: anywhere; }
  .preview-grid dd.good { color: var(--color-primary); }
  .preview-desc { margin: 12px 0 0; color: var(--color-text-muted); font-size: .72rem; line-height: 1.55; }

  /* Detail modal meta grid */
  .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; }
  .meta-grid dt { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .54rem; text-transform: uppercase; letter-spacing: .06em; }
  .meta-grid dd { margin: 4px 0 0; color: var(--color-text); font-size: .72rem; line-height: 1.5; overflow-wrap: anywhere; }
  .meta-grid dd.good { color: var(--color-primary); }
  .meta-grid dd.bad { color: var(--color-danger); }
  .url { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .6rem; color: var(--color-text-muted); word-break: break-all; }

  @media (max-width: 640px) {
    .record-badges { gap: 4px; }
    .record-actions { gap: 4px; }
    .preview-grid, .meta-grid { grid-template-columns: 1fr; }
  }

  /* Phase E V2: link-types config UI */
  .link-types-section { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--color-border); }
  .link-types-heading { margin: 0 0 4px; color: var(--color-primary); font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  .link-types-desc { margin: 0 0 10px; color: var(--color-text-muted); font-size: .72rem; }
  .link-types-grid { display: grid; gap: 8px; }
  .link-type-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); }
  .link-type-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 0 0 auto; }
  .link-type-toggle input { width: 18px; height: 18px; accent-color: var(--color-primary); cursor: pointer; }
  .link-type-label { color: var(--color-text); font-size: .76rem; font-weight: 700; white-space: nowrap; }
  .link-type-desc { color: var(--color-text-muted); font-size: .68rem; }
</style>
