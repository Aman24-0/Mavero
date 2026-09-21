<script lang="ts">
  import { ArrowDown, ArrowUp, Check, ChevronDown, Puzzle, RefreshCw, Trash2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminSection from '$lib/components/admin/AdminSection.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Addon = PageData['addons'][number];
  type Preview = Extract<NonNullable<ActionData>, { preview: unknown }>['preview'];

  // Add-workflow state: the add panel and the confirmed preview. A NEW
  // preview response (fresh object identity) replaces any dismissed one.
  // Initial value captures data.addons.length at first mount — the panel
  // opens only when the registry starts empty. Subsequent data updates
  // (e.g. after a navigation back to the page) re-mount the component, so
  // this captures the correct initial state each time.
  // svelte-ignore state_referenced_locally
  let addOpen = $state(data.addons.length === 0);
  let shownPreview = $state<Preview | null>(null);
  $effect(() => {
    if (form?.preview) shownPreview = form.preview;
  });

  function cancelPreview() {
    shownPreview = null;
    addOpen = false;
  }

  // Duplicate-submission guard (spec §28/§32): while any mutation is in
  // flight every submit button is disabled and further submits are ignored.
  // The guard clears when the action responds (form set) or the redirect
  // navigation completes.
  let pending = $state('');
  $effect(() => { if (form) pending = ''; });
  function guard(action: string, confirmMessage?: string) {
    return (event: SubmitEvent) => {
      if (pending) {
        event.preventDefault();
        return;
      }
      if (confirmMessage && !confirm(confirmMessage)) {
        event.preventDefault();
        return;
      }
      pending = action;
    };
  }

  const DELETE_CONFIRM = 'Remove addon?\n\nThis will remove the addon from MAVERO. Its streams will no longer be available.';

  // Existing server-side status model (no second status system).
  const statusLabels: Record<string, string> = {
    active: 'Active',
    disabled: 'Disabled',
    maintenance: 'Maintenance',
    experimental: 'Experimental',
    unavailable: 'Unavailable',
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
</script>

<svelte:head><title>Stremio Addons — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="addons">
  <AdminPageHeader
    eyebrow="MAVERO / Stremio addon registry"
    title="Stremio"
    accent="addons."
    description="HTTP stream addons for MAVERO Player. Manifests are validated server-side by the secure manifest service — the browser never fetches addon URLs. New addons stay disabled until you enable them."
    count={`${data.addons.length} addons · ${data.addons.filter((addon) => addon.enabled).length} enabled`}
  />

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <AdminSection variant="info">
    <details class="form-panel" bind:open={addOpen}>
      <summary><span class="summary-label"><Puzzle size={15} /> Add Stremio Addon</span><ChevronDown size={16} /></summary>
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
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" disabled={pending !== ''} aria-busy={pending === 'previewAddon'}>{pending === 'previewAddon' ? 'Validating addon…' : 'Validate addon'}</button>
          <span class="hint">Fetching manifest… then a preview appears before anything is saved.</span>
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
          <form method="POST" action="?/confirmAddon" class="form-actions" onsubmit={guard('confirmAddon')}>
            <input type="hidden" name="manifestUrl" value={shownPreview.manifestUrl} />
            <button class="btn btn-primary" type="submit" disabled={pending !== ''} aria-busy={pending === 'confirmAddon'}>{pending === 'confirmAddon' ? 'Adding…' : 'Add addon'}</button>
            <button class="btn btn-secondary" type="button" onclick={cancelPreview}><X size={13} /> Cancel</button>
            <span class="hint">The manifest is re-validated server-side before saving.</span>
          </form>
        </div>
      {/if}
    </details>
  </AdminSection>

  {#if data.addons.length === 0}
    <AdminEmptyState
      icon={Puzzle}
      title="No Stremio addons configured"
      message="Add a supported Stremio HTTP addon to make additional streams available through MAVERO Player."
    >
      {#snippet actions()}
        <button class="btn btn-primary" type="button" onclick={() => (addOpen = true)}>Add Stremio Addon</button>
      {/snippet}
    </AdminEmptyState>
  {:else}
    <div class="registry-list">
      {#each data.addons as addon (addon.id)}
        <details class="record">
          <summary>
            <div class="record-main">
              <span class="provider-icon" aria-hidden="true"><Puzzle size={14} /></span>
              <div class="record-copy">
                <strong>{addon.name}</strong>
                <span class="record-sub">{addon.version ? `v${addon.version} · ` : ''}order {addon.ordering} · {addon.supportedTypes.length ? addon.supportedTypes.join(', ') : 'no types'}</span>
              </div>
            </div>
            <div class="record-meta">
              <AdminStatusBadge
                label={addon.enabled ? 'Enabled' : 'Disabled'}
                tone={addon.enabled ? 'good' : 'neutral'}
              />
              <AdminStatusBadge
                label={statusLabels[addon.status] ?? addon.status}
                tone={statusToneFor(addon.status)}
              />
              <ChevronDown size={15} />
            </div>
          </summary>
          <div class="record-body">
            <dl class="meta-grid">
              <div><dt>Description</dt><dd>{addon.description ?? '—'}</dd></div>
              <div><dt>Stream support</dt><dd class:good={addon.supportsStream}>{addon.supportsStream ? 'HTTP streams' : 'None'}</dd></div>
              <div><dt>ID prefixes</dt><dd>{addon.idPrefixes.length ? addon.idPrefixes.join(', ') : '—'}</dd></div>
              <div><dt>Resources</dt><dd>{addon.resources.length ? addon.resources.join(', ') : '—'}</dd></div>
              <div><dt>Manifest URL</dt><dd class="url">{addon.manifestUrl}</dd></div>
              <div><dt>Last successful refresh</dt><dd>{formatDate(addon.lastSuccessAt)}</dd></div>
              {#if addon.lastError}<div><dt>Refresh status</dt><dd class="bad">{addon.lastError}</dd></div>{/if}
            </dl>
            <div class="form-actions secondary-actions">
              <form method="POST" action="?/setEnabled" class="inline-form" onsubmit={guard('setEnabled')}>
                <input type="hidden" name="id" value={addon.id} />
                <input type="hidden" name="enabled" value={addon.enabled ? 'false' : 'true'} />
                <button class="btn btn-secondary" type="submit" disabled={pending !== ''} aria-busy={pending === 'setEnabled'}>{pending === 'setEnabled' ? 'Saving…' : addon.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form method="POST" action="?/refreshAddon" class="inline-form" onsubmit={guard('refreshAddon')}>
                <input type="hidden" name="id" value={addon.id} />
                <button class="btn btn-secondary" type="submit" disabled={pending !== ''} aria-busy={pending === 'refreshAddon'}><RefreshCw size={13} /> {pending === 'refreshAddon' ? 'Refreshing…' : 'Refresh'}</button>
              </form>
              <form method="POST" action="?/moveAddon" class="inline-form" onsubmit={guard('moveAddon')}>
                <input type="hidden" name="id" value={addon.id} />
                <input type="hidden" name="direction" value="up" />
                <button class="btn btn-secondary icon-btn" type="submit" disabled={pending !== ''} aria-label={`Move ${addon.name} up`}><ArrowUp size={14} /></button>
              </form>
              <form method="POST" action="?/moveAddon" class="inline-form" onsubmit={guard('moveAddon')}>
                <input type="hidden" name="id" value={addon.id} />
                <input type="hidden" name="direction" value="down" />
                <button class="btn btn-secondary icon-btn" type="submit" disabled={pending !== ''} aria-label={`Move ${addon.name} down`}><ArrowDown size={14} /></button>
              </form>
              <form method="POST" action="?/deleteAddon" class="inline-form" onsubmit={guard('deleteAddon', DELETE_CONFIRM)}>
                <input type="hidden" name="id" value={addon.id} />
                <button class="btn btn-danger" type="submit" disabled={pending !== ''} aria-busy={pending === 'deleteAddon'}><Trash2 size={14} /> {pending === 'deleteAddon' ? 'Removing…' : 'Remove'}</button>
              </form>
            </div>
          </div>
        </details>
      {/each}
    </div>
  {/if}
</AdminShell>

<style>
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; }
  .notice { color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }
  .error { color: var(--color-danger); border: 1px solid rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .07); }

  .hint { display: block; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; line-height: 1.5; letter-spacing: .04em; margin-top: 4px; }

  .form-panel { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: rgba(0, 255, 156, .015); overflow: hidden; }
  summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 18px; cursor: pointer; list-style: none; color: var(--color-text); font-size: .8rem; }
  summary::-webkit-details-marker { display: none; }
  .summary-label { display: inline-flex; align-items: center; gap: 8px; color: var(--color-primary); font-weight: 700; }
  .registry-form { display: grid; gap: 13px; padding: 0 18px 18px; }
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

  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .secondary-actions { padding: 0 18px 16px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0 14px; cursor: pointer; color: var(--color-text); background: var(--color-primary-soft); font: inherit; font-size: .74rem; font-weight: 700; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out); }
  .btn:disabled { opacity: .55; cursor: default; }
  .btn:active:not(:disabled) { transform: scale(.98); }
  .btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .btn-primary { border-color: transparent; color: #050708; background: var(--color-primary); box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary); }
  .btn-secondary:hover:not(:disabled) { border-color: var(--color-primary-border); background: var(--color-primary-soft); box-shadow: var(--glow-primary); }
  .btn-danger { color: var(--color-danger); }
  .btn-danger:hover:not(:disabled) { border-color: rgba(255, 77, 109, .45); background: rgba(255, 77, 109, .08); }
  .icon-btn { padding: 0 10px; min-height: 36px; }
  .inline-form { display: inline-flex; padding: 0; }

  .preview { margin: 0 18px 18px; padding: 16px; border: 1px solid var(--color-primary-border); border-radius: var(--radius-sm); background: rgba(0, 255, 156, .04); }
  .preview h3 { margin: 6px 0 12px; color: var(--color-text); font-size: .95rem; letter-spacing: -.01em; }
  .preview-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 0; }
  .preview-grid dt, .meta-grid dt { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .54rem; text-transform: uppercase; letter-spacing: .06em; }
  .preview-grid dd, .meta-grid dd { margin: 4px 0 0; color: var(--color-text); font-size: .72rem; line-height: 1.5; overflow-wrap: anywhere; }
  .preview-grid dd.good, .meta-grid dd.good { color: var(--color-primary); }
  .meta-grid dd.bad { color: var(--color-danger); }
  .preview-desc { margin: 12px 0 0; color: var(--color-text-muted); font-size: .72rem; line-height: 1.55; }
  .preview .form-actions { margin-top: 14px; }

  .registry-list { display: grid; gap: 12px; margin-top: 16px; }
  .record { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); overflow: hidden; transition: border-color var(--motion-fast) var(--ease-out); }
  .record[open] { border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .record summary { padding: 14px 16px; }
  .record-body { border-top: 1px solid var(--color-border); }
  .provider-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--color-primary); background: var(--color-primary-soft); border: 1px solid var(--color-primary-border); flex: 0 0 auto; }
  .record-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
  .record-copy { min-width: 0; }
  .record-copy strong { display: block; color: var(--color-text); font-size: .82rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-sub { display: block; margin-top: 3px; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-meta { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 16px 18px 6px; }
  .url { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .6rem; color: var(--color-text-muted); word-break: break-all; }

  @media (max-width: 700px) {
    .preview-grid, .meta-grid { grid-template-columns: 1fr; }
    .record-meta { gap: 4px; }
  }
</style>
