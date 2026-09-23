<script lang="ts">
  import { Check, ChevronRight, ShieldCheck, Trash2, HelpCircle, X, Edit3, Plus } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import { integrationTypes, providerStatuses } from '$lib/shared/streaming';
  import { sandboxPolicies, sandboxPolicyDescription, sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
  // Phase 8: sandbox is a simple ON/OFF toggle. ON = 'required', OFF = 'unrestricted'.
  // The 4-option (required/optional/unrestricted/provider_default) UI is removed.
  const providerSandboxOn = (provider: PageData['providers'][number]) => sandboxPolicyFromCapabilities(provider.capabilities) === 'required';
  import { CAPABILITY_FIELDS, CAPABILITY_LABELS, type ProviderPlaybackCapabilities } from '$lib/shared/player-capabilities';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const providerStatusLabels = { active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable' };
  const integrationLabels = { template: 'Template', api: 'API', direct: 'Direct', embed: 'Embed', custom: 'Custom' };
  const sandboxPolicyLabels = { required: 'Required — secure sandbox', optional: 'Optional — secure by default', unrestricted: 'Unrestricted — warning' };
  const providerSandboxPolicy = (provider: PageData['providers'][number]) => sandboxPolicyFromCapabilities(provider.capabilities);
  const sourceOverridesFor = (providerId: string) => data.sourceSandboxOverrides?.[providerId] ?? [];
  const healthStateLabels = { healthy: 'Healthy', degraded: 'Degraded', unhealthy: 'Unhealthy', cooldown: 'Cooldown', unknown: 'Unknown' } as const;
  const healthToneFor = (state?: string): 'good' | 'warn' | 'bad' | 'neutral' =>
    state === 'healthy' ? 'good' :
    state === 'degraded' || state === 'unknown' ? 'warn' :
    state === 'unhealthy' || state === 'cooldown' ? 'bad' :
    'neutral';
  const healthFor = (providerId: string) => data.health?.[providerId];
  const healthChecked = (providerId: string) => healthFor(providerId)?.lastCheckedAt ? new Date(healthFor(providerId)!.lastCheckedAt!).toLocaleString() : 'Not checked';

  const capabilityFor = (providerId: string) => data.capabilityMap?.[providerId] ?? null;
  function capabilityState(providerId: string, field: keyof ProviderPlaybackCapabilities): 'supported' | 'unsupported' | 'unknown' {
    const entry = capabilityFor(providerId);
    if (!entry) return 'unknown';
    if (entry.supported.includes(field)) return 'supported';
    return 'unsupported';
  }

  function statusToneFor(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
    if (status === 'active' || status === 'experimental') return 'good';
    if (status === 'maintenance') return 'warn';
    if (status === 'unavailable' || status === 'disabled') return 'neutral';
    return 'neutral';
  }

  // ============================================================
  // Create/Edit modal state — replaces the inline <details> accordion.
  //
  // `editingProvider` is null when the modal is in CREATE mode, the
  // provider record when in EDIT mode. The same form fields render in
  // both modes — the only difference is the action attribute and the
  // initial values. Existing server actions (?/createProvider and
  // ?/updateProvider) are preserved unchanged.
  // ============================================================
  let sheetOpen = $state(false);
  let editingProvider = $state<PageData['providers'][number] | null>(null);
  let sheetTrigger: HTMLElement | null = null;

  function openCreate(event?: Event) {
    if (event) sheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingProvider = null;
    sheetOpen = true;
  }
  function openEdit(provider: PageData['providers'][number], event?: Event) {
    if (event) sheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingProvider = provider;
    sheetOpen = true;
  }
  function closeSheet() {
    sheetOpen = false;
    editingProvider = null;
    // Focus restored to the trigger by AdminSheet's $effect cleanup.
  }
</script>

<svelte:head><title>Provider Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="providers">
  <AdminPageHeader
    eyebrow="MAVERO / Provider registry"
    title="Provider"
    accent="registry."
    count={`${data.providers.length} records`}
  >
    {#snippet actions()}
      <AdminAddButton label="Add provider" onclick={openCreate} />
    {/snippet}
  </AdminPageHeader>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  {#if data.providers.length === 0}
    <AdminEmptyState
      icon={ShieldCheck}
      title="No providers yet"
      message="Create the first provider. It remains disabled until explicitly enabled."
    />
  {:else}
    <div class="registry-list">
      {#each data.providers as provider (provider.id)}
        {@const health = healthFor(provider.id)}
        <article class="record">
          <div class="record-head" onclick={(e) => openEdit(provider, e)} role="button" tabindex="0"
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(provider, e); } }}
                 aria-label={`Edit ${provider.name}`}>
            <span class="provider-icon">{provider.icon || 'M'}</span>
            <div class="record-copy">
              <strong class="record-name">{provider.name}</strong>
              <span class="record-sub">{provider.slug} · {integrationLabels[provider.integration_type as keyof typeof integrationLabels]}</span>
            </div>
            <span class="record-chevron"><ChevronRight size={18} /></span>
          </div>
          <div class="record-badges">
            <AdminStatusBadge
              label={provider.enabled ? 'Enabled' : 'Disabled'}
              tone={provider.enabled ? 'good' : 'neutral'}
            />
            <AdminStatusBadge
              label={providerStatusLabels[provider.status as keyof typeof providerStatusLabels]}
              tone={statusToneFor(provider.status)}
            />
            <span class="health" title={`Runtime health · ${healthChecked(provider.id)}`}>
              <AdminStatusBadge
                label={`Health: ${healthStateLabels[health?.state ?? 'unknown']}`}
                tone={healthToneFor(health?.state)}
              />
            </span>
            <span class="record-actions">
              <form method="POST" action="?/toggleProvider" class="inline-form" onsubmit={(event) => { const button = (event.currentTarget as HTMLFormElement).querySelector('button'); if (button) button.disabled = true; }}>
                <input type="hidden" name="id" value={provider.id} />
                <input type="hidden" name="enabled" value={provider.enabled ? 'false' : 'true'} />
                <button class="mini-btn" type="submit">{provider.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form method="POST" action="?/deleteProvider" class="inline-form" onsubmit={() => confirm(`Delete ${provider.name}? Providers with dependent sources cannot be deleted.`)}>
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

<!-- ============================================================
     CREATE / EDIT MODAL — AdminSheet.
     Same form fields as the previous inline accordion, but now rendered
     inside a modal that scrolls internally on mobile. Existing server
     actions (?/createProvider / ?/updateProvider) preserved unchanged.
     ============================================================ -->
<AdminSheet
  open={sheetOpen}
  title={editingProvider ? `Edit ${editingProvider.name}` : 'Add provider'}
  onClose={closeSheet}
  closeOnBackdrop={false}
>
  <form method="POST" action={editingProvider ? '?/updateProvider' : '?/createProvider'} class="registry-form">
    {#if editingProvider}
      <input type="hidden" name="id" value={editingProvider.id} />
    {/if}
    <div class="form-grid two">
      <label>Name<input name="name" required maxlength="120" placeholder="Example Provider" value={editingProvider?.name ?? ''} /></label>
      <label>Slug<input name="slug" required maxlength="120" placeholder="example-provider" value={editingProvider?.slug ?? ''} /></label>
    </div>
    <div class="form-grid three">
      <label>Integration type<select name="integration_type">{#each integrationTypes as type}<option value={type} selected={editingProvider?.integration_type === type}>{integrationLabels[type]}</option>{/each}</select></label>
      <label>Status<select name="status">{#each providerStatuses as status}<option value={status} selected={editingProvider?.status === status}>{providerStatusLabels[status]}</option>{/each}</select></label>
      <label class="check"><input type="checkbox" name="enabled" checked={editingProvider?.enabled ?? false} /> Enabled</label>
    </div>
    <div class="form-grid two">
      <label>Icon / display token<input name="icon" maxlength="120" placeholder="spark / logo token" value={editingProvider?.icon ?? ''} /></label>
      <label>Adapter ID<input name="adapter_id" maxlength="80" placeholder="reserved-adapter-id" value={editingProvider?.adapter_id ?? ''} /></label>
    </div>
    <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="Safe display description.">{editingProvider?.description ?? ''}</textarea></label>
    <!-- Phase 8: simple sandbox ON/OFF toggle. ON = required (secure iframe sandbox).
         OFF = unrestricted (no sandbox). The stored policy is 'required' or 'unrestricted'.
         No source-level sandbox configuration exists anymore. -->
    <label>Sandbox
      <select name="sandbox_policy">
        <option value="required" selected={editingProvider ? providerSandboxOn(editingProvider) : true}>ON — Secure iframe sandbox</option>
        <option value="unrestricted" selected={editingProvider ? !providerSandboxOn(editingProvider) : false}>OFF — Sandbox disabled</option>
      </select>
      <small class="security-note">Controls the iframe sandbox for all sources of this provider.</small>
    </label>
    <!-- Phase 8: the raw Capabilities JSON textarea is removed for EDIT mode to
         prevent data loss (the previous blank-textarea pattern silently overwrote
         allowed_embed_origins, result_type, supports_* fields). For CREATE mode,
         a minimal capabilities object is acceptable (the form default {"movies":true}).
         The server-side parseProviderForm merges the sandbox_policy into the
         capabilities JSON; existing capability keys are preserved server-side. -->
    {#if !editingProvider}
      <input type="hidden" name="capabilities" value='{{"movies":true}}' />
    {/if}
    <label>Admin notes<textarea name="notes" maxlength="2000" rows="2" placeholder="Internal notes; never returned by public config.">{editingProvider?.notes ?? ''}</textarea></label>
    <div class="sheet-actions">
      <button class="btn btn-primary" type="submit">{editingProvider ? 'Save changes' : 'Create provider'}</button>
      <button class="btn btn-secondary" type="button" onclick={closeSheet}>Cancel</button>
    </div>
  </form>

  {#if editingProvider && editingProvider.adapter_id}
    {@const provider = editingProvider}
    <details class="capability-panel">
      <summary><span class="cap-label">Playback capabilities</span><span class="cap-adapter">adapter: <code>{provider.adapter_id}</code></span></summary>
      <div class="cap-matrix">
        {#each CAPABILITY_FIELDS as field}
          {@const state = capabilityState(provider.id, field)}
          <div class="cap-cell" class:ok={state === 'supported'} class:no={state === 'unsupported'} class:unknown={state === 'unknown'}>
            {#if state === 'supported'}<Check size={12} />{:else if state === 'unsupported'}<X size={12} />{:else}<HelpCircle size={12} />{/if}
            <span>{CAPABILITY_LABELS[field]}</span>
          </div>
        {/each}
      </div>
      {#if !capabilityFor(provider.id)}<p class="cap-note">No dedicated adapter registered — capabilities are <strong>Unknown</strong>. The provider may still work via the generic template adapter; values are not assumed.</p>{/if}
    </details>
  {:else if editingProvider}
    {@const provider = editingProvider}
    <details class="capability-panel">
      <summary><span class="cap-label">Playback capabilities</span><span class="cap-adapter">no adapter_id set</span></summary>
      <div class="cap-matrix">
        {#each CAPABILITY_FIELDS as field}
          <div class="cap-cell unknown"><HelpCircle size={12} /><span>{CAPABILITY_LABELS[field]}</span></div>
        {/each}
      </div>
      <p class="cap-note">No <code>adapter_id</code> configured — all capabilities are <strong>Unknown</strong>. The generic template adapter will be used; no postMessage events are normalized.</p>
    </details>
  {/if}
</AdminSheet>

<!-- Per-record destructive actions (Enable/Disable + Delete) live on the row
     itself (see record-actions); the Edit modal owns the form mutations
     AND the capability matrix (read-only display). -->

<style>
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; }
  .notice { color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }
  .error { color: var(--color-danger); border: 1px solid rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .07); }

  /* Registry list — every record is a compact two-row card. Row 1 carries
     the icon + name + chevron (the identity + the click target). Row 2
     carries the status badges so they never push the name off-screen. */
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
    font-size: .68rem;
    font-weight: 700;
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

  /* Form (inside the modal) */
  .registry-form { display: grid; gap: 13px; }
  .form-grid { display: grid; gap: 10px; }
  .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label { display: grid; gap: 6px; color: var(--color-text-muted); font-size: .58rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  input, select, textarea {
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
  input:focus, select:focus, textarea:focus {
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

  .security-note { color: var(--color-warning); font-size: .56rem; line-height: 1.5; text-transform: none; letter-spacing: 0; font-weight: 500; }

  /* Phase 8: sandbox-override-warning CSS removed (no source-level sandbox). */

  /* Phase 7: capability matrix panel (rendered inside the Edit modal). */
  .capability-panel { margin-top: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: rgba(0, 255, 156, .012); }
  .capability-panel summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; cursor: pointer; list-style: none; color: var(--color-text); font-size: .68rem; }
  .capability-panel summary::-webkit-details-marker { display: none; }
  .cap-label { color: var(--color-primary); font-size: .62rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .cap-adapter { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .54rem; }
  .cap-adapter code { color: var(--color-text); }
  .cap-matrix { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; padding: 0 14px 12px; }
  .cap-cell { display: flex; align-items: center; gap: 6px; padding: 8px 9px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: .56rem; }
  .cap-cell.ok { color: var(--color-primary); border-color: var(--color-primary-border); background: rgba(0, 255, 156, .04); }
  .cap-cell.no { color: var(--color-danger); border-color: rgba(255, 77, 109, .15); background: rgba(255, 77, 109, .03); }
  .cap-cell.unknown { color: var(--color-text-deep); border-color: var(--color-border); background: rgba(255, 255, 255, .015); }
  .cap-note { margin: 0 14px 12px; color: var(--color-text-muted); font-size: .58rem; line-height: 1.5; }
  .cap-note code { color: var(--color-text); }

  /* Mobile — stack form grids, compact record badges. */
  @media (max-width: 640px) {
    .form-grid.two, .form-grid.three { grid-template-columns: 1fr; }
    .record-badges { gap: 4px; }
  }
</style>
