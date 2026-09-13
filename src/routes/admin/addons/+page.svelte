<script lang="ts">
  import { ArrowDown, ArrowUp, Check, ChevronDown, Puzzle, RefreshCw, Trash2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  type Addon = PageData['addons'][number];
  type Preview = Extract<NonNullable<ActionData>, { preview: unknown }>['preview'];

  // Add-workflow state: the add panel and the confirmed preview. A NEW
  // preview response (fresh object identity) replaces any dismissed one.
  let addOpen = data.addons.length === 0;
  let shownPreview: Preview | null = null;
  $: if (form?.preview && form.preview !== shownPreview) shownPreview = form.preview;
  function cancelPreview() {
    shownPreview = null;
    addOpen = false;
  }

  // Duplicate-submission guard (spec §28/§32): while any mutation is in
  // flight every submit button is disabled and further submits are ignored.
  // The guard clears when the action responds (form set) or the redirect
  // navigation completes.
  let pending = '';
  $: if (form) pending = '';
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

  function formatDate(value: string | undefined): string {
    if (!value) return 'Never';
    return new Date(value).toLocaleString();
  }
</script>

<svelte:head><title>Stremio Addons — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="addons">
  <div class="eyebrow">MAVERO / Stremio addon registry</div>
  <div class="heading-row">
    <div>
      <h1>Stremio <em>addons.</em></h1>
      <p class="intro">HTTP stream addons for MAVERO Player. Manifests are validated server-side by the secure manifest service — the browser never fetches addon URLs. New addons stay disabled until you enable them.</p>
    </div>
    <span class="count">{data.addons.length} addons · {data.addons.filter((addon) => addon.enabled).length} enabled</span>
  </div>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <details class="form-panel" bind:open={addOpen}>
    <summary><span><Puzzle size={15} /> Add Stremio Addon</span><ChevronDown size={16} /></summary>
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

  {#if data.addons.length === 0}
    <div class="empty">
      <Puzzle size={22} />
      <h2>No Stremio addons configured</h2>
      <p>Add a supported Stremio HTTP addon to make additional streams available through MAVERO Player.</p>
      <button class="btn btn-primary" type="button" onclick={() => (addOpen = true)}>Add Stremio Addon</button>
    </div>
  {:else}
    <div class="registry-list">
      {#each data.addons as addon (addon.id)}
        <details class="record">
          <summary>
            <div class="record-main">
              <span class="provider-icon" aria-hidden="true"><Puzzle size={14} /></span>
              <div>
                <strong>{addon.name}</strong>
                <span>{addon.version ? `v${addon.version} · ` : ''}order {addon.ordering} · {addon.supportedTypes.length ? addon.supportedTypes.join(', ') : 'no types'}</span>
              </div>
            </div>
            <div class="record-meta">
              <span class:good={addon.enabled} class:warning={!addon.enabled}>{addon.enabled ? 'Enabled' : 'Disabled'}</span>
              <span class={addon.status === 'active' ? 'good' : addon.status === 'unavailable' ? 'bad' : 'muted'}>{statusLabels[addon.status] ?? addon.status}</span>
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
  em { color: var(--accent); font-style: normal; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  h1 { margin: 8px 0 9px; color: var(--ink); font-size: clamp(1.7rem, 3.2vw, 2.4rem); font-weight: 900; letter-spacing: -.02em; line-height: 1.1; }
  .intro { max-width: 640px; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.65; }
  .count, .hint { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; }
  .hint { display: block; margin-top: 4px; line-height: 1.5; }
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: 9px; font-size: .72rem; }
  .notice { color: var(--success); border: 1px solid rgba(126,220,180,.2); background: rgba(126,220,180,.06); }
  .error { color: #ff8a8a; border: 1px solid rgba(228,133,105,.25); background: rgba(228,133,105,.07); }
  .form-panel, .record { margin-top: 19px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
  summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 17px 19px; cursor: pointer; list-style: none; color: var(--ink); font-size: .8rem; }
  summary::-webkit-details-marker { display: none; }
  summary > span, .record-main, .record-meta { display: flex; align-items: center; gap: 9px; }
  summary > span { color: var(--accent); }
  .registry-form { display: grid; gap: 13px; padding: 0 19px 19px; }
  label { display: grid; gap: 6px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .57rem; }
  .registry-form label { display: grid; }
  input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; color: var(--ink); background: rgba(255,255,255,.035); font: inherit; font-family: inherit; font-size: .68rem; outline: none; }
  input:focus { border-color: rgba(155,135,245,.7); box-shadow: 0 0 0 3px rgba(155,135,245,.1); }
  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .secondary-actions { padding: 0 19px 16px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; cursor: pointer; color: var(--ink); background: transparent; font: inherit; font-size: .66rem; }
  .btn:disabled { opacity: .55; cursor: default; }
  .btn-primary { border-color: transparent; color: #12121a; background: var(--ink); }
  .btn-secondary:hover { border-color: rgba(155,135,245,.45); background: var(--accent-soft); }
  .btn-danger { color: #ff8a8a; }
  .btn-danger:hover { border-color: rgba(228,133,105,.35); background: rgba(228,133,105,.08); }
  .icon-btn { padding: 9px 10px; }
  .inline-form { display: inline-flex; padding: 0; }
  .preview { margin: 0 19px 19px; padding: 15px; border: 1px solid rgba(155,135,245,.3); border-radius: 10px; background: rgba(155,135,245,.05); }
  .preview h3 { margin: 6px 0 12px; color: var(--ink); font-size: .92rem; letter-spacing: -.035em; }
  .preview-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 0; }
  .preview-grid dt, .meta-grid dt { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .54rem; text-transform: uppercase; letter-spacing: .06em; }
  .preview-grid dd, .meta-grid dd { margin: 4px 0 0; color: var(--ink); font-size: .68rem; line-height: 1.5; overflow-wrap: anywhere; }
  .preview-desc { margin: 12px 0 0; color: var(--muted); font-size: .68rem; line-height: 1.55; }
  .preview .form-actions { margin-top: 14px; }
  .registry-list { display: grid; gap: 10px; margin-top: 15px; }
  .record summary { padding: 14px 16px; }
  .record-body { border-top: 1px solid var(--line); }
  .provider-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); }
  .record-main strong { display: inline-flex; align-items: center; gap: 8px; color: var(--ink); font-size: .78rem; }
  .record-main span:not(.provider-icon) { display: block; margin-top: 3px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .54rem; }
  .record-meta { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  .record-meta .good, dd.good { color: var(--success); }
  .record-meta .warning { color: #ffb020; }
  .record-meta .muted { color: var(--muted-deep); }
  .record-meta .bad, dd.bad { color: #ff8a8a; }
  .meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 15px 19px 4px; }
  .url { font-family: 'JetBrains Mono', monospace; font-size: .6rem; color: var(--muted); }
  .empty { margin-top: 15px; padding: 45px 20px; text-align: center; border: 1px dashed var(--line); border-radius: 14px; }
  .empty h2 { margin: 10px 0 5px; font-size: 1rem; }
  .empty p { margin: 0 0 14px; color: var(--muted); font-size: .72rem; }
  .empty .btn { margin: 0 auto; }
  @media (max-width: 700px) {
    .heading-row { align-items: start; flex-direction: column; }
    .preview-grid, .meta-grid { grid-template-columns: 1fr; }
    .record-meta { flex-wrap: wrap; justify-content: flex-end; }
  }
</style>
