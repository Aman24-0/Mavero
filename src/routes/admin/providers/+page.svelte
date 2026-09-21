<script lang="ts">
  import { Check, ChevronDown, Plus, ShieldCheck, Trash2, HelpCircle, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminSection from '$lib/components/admin/AdminSection.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import { integrationTypes, providerStatuses } from '$lib/shared/streaming';
  import { sandboxPolicies, sandboxPolicyDescription, sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
  import { CAPABILITY_FIELDS, CAPABILITY_LABELS, type ProviderPlaybackCapabilities } from '$lib/shared/player-capabilities';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const providerStatusLabels = { active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable' };
  const integrationLabels = { template: 'Template', api: 'API', direct: 'Direct', embed: 'Embed', custom: 'Custom' };
  const sandboxPolicyLabels = { required: 'Required — secure sandbox', optional: 'Optional — secure by default', unrestricted: 'Unrestricted — warning' };
  const providerSandboxPolicy = (provider: PageData['providers'][number]) => sandboxPolicyFromCapabilities(provider.capabilities);
  // Phase 12 (GOAL F): explicit SOURCE-level sandbox overrides that outrank
  // this provider's policy (source > provider > system default). When the
  // admin sets provider=Unrestricted but a source still carries an explicit
  // override, the runtime applies the OVERRIDE — the console must say so
  // instead of silently contradicting the player.
  const sourceOverridesFor = (providerId: string) => data.sourceSandboxOverrides?.[providerId] ?? [];
  const healthStateLabels = { healthy: 'Healthy', degraded: 'Degraded', unhealthy: 'Unhealthy', cooldown: 'Cooldown', unknown: 'Unknown' } as const;
  const healthToneFor = (state?: string): 'good' | 'warn' | 'bad' | 'neutral' =>
    state === 'healthy' ? 'good' :
    state === 'degraded' || state === 'unknown' ? 'warn' :
    state === 'unhealthy' || state === 'cooldown' ? 'bad' :
    'neutral';
  const healthFor = (providerId: string) => data.health?.[providerId];
  const healthChecked = (providerId: string) => healthFor(providerId)?.lastCheckedAt ? new Date(healthFor(providerId)!.lastCheckedAt!).toLocaleString() : 'Not checked';

  // Phase 7: capability matrix display.
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
</script>

<svelte:head><title>Provider Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="providers">
  <AdminPageHeader
    eyebrow="MAVERO / Provider registry"
    title="Provider"
    accent="registry."
    description="Define the integrations that may later expose selectable playback sources. Phase 7A stores metadata only — no provider is called from this admin."
    count={`${data.providers.length} records`}
  />

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <AdminSection variant="info">
    {#snippet actions()}
      <span class="hint">No third-party calls are made.</span>
    {/snippet}
    <details class="form-panel" open={data.providers.length === 0}>
      <summary><span class="summary-label"><Plus size={15} /> Add provider</span><ChevronDown size={16} /></summary>
      <form method="POST" action="?/createProvider" class="registry-form">
        <div class="form-grid two"><label>Name<input name="name" required maxlength="120" placeholder="Example Provider" /></label><label>Slug<input name="slug" required maxlength="120" placeholder="example-provider" /></label></div>
        <div class="form-grid three"><label>Integration type<select name="integration_type">{#each integrationTypes as type}<option value={type}>{integrationLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status}>{providerStatusLabels[status]}</option>{/each}</select></label><label class="check"><input type="checkbox" name="enabled" /> Enabled for public config</label></div>
        <div class="form-grid two"><label>Icon / display token<input name="icon" maxlength="120" placeholder="spark / logo token" /></label><label>Adapter ID<input name="adapter_id" maxlength="80" placeholder="reserved-adapter-id" /></label></div>
        <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="Safe display description."></textarea></label>
        <label>Sandbox policy (embed only)<select name="sandbox_policy">{#each sandboxPolicies as policy}<option value={policy}>{sandboxPolicyLabels[policy]}</option>{/each}</select><small class="security-note">{sandboxPolicyDescription('required')}</small></label>
        <label>Capabilities JSON<textarea name="capabilities" rows="3" placeholder="JSON object, e.g. movies=true">&#123;&quot;movies&quot;:true&#125;</textarea></label>
        <label>Admin notes<textarea name="notes" maxlength="2000" rows="2" placeholder="Internal notes; never returned by public config."></textarea></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create provider</button></div>
      </form>
    </details>
  </AdminSection>

  {#if data.providers.length === 0}
    <AdminEmptyState
      icon={ShieldCheck}
      title="No providers yet"
      message="Create the first configuration record above. It will remain disabled until explicitly enabled."
    />
  {:else}
    <div class="registry-list">
      {#each data.providers as provider (provider.id)}
        <details class="record">
          <summary>
            <div class="record-main">
              <span class="provider-icon">{provider.icon || 'M'}</span>
              <div class="record-copy">
                <strong>{provider.name}</strong>
                <span class="record-sub">{provider.slug} · {integrationLabels[provider.integration_type as keyof typeof integrationLabels]}</span>
              </div>
            </div>
            <div class="record-meta">
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
                  label={`Health: ${healthStateLabels[healthFor(provider.id)?.state ?? 'unknown']}`}
                  tone={healthToneFor(healthFor(provider.id)?.state)}
                />
              </span>
              <ChevronDown size={15} />
            </div>
          </summary>
          <form method="POST" action="?/updateProvider" class="registry-form compact">
            <input type="hidden" name="id" value={provider.id} />
            <div class="form-grid two"><label>Name<input name="name" required maxlength="120" value={provider.name} /></label><label>Slug<input name="slug" required maxlength="120" value={provider.slug} /></label></div>
            <div class="form-grid three"><label>Integration type<select name="integration_type">{#each integrationTypes as type}<option value={type} selected={provider.integration_type === type}>{integrationLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status} selected={provider.status === status}>{providerStatusLabels[status]}</option>{/each}</select></label><label class="check"><input type="checkbox" name="enabled" checked={provider.enabled} /> Enabled for public config</label></div>
            <div class="form-grid two"><label>Icon / display token<input name="icon" maxlength="120" value={provider.icon ?? ''} /></label><label>Adapter ID<input name="adapter_id" maxlength="80" value={provider.adapter_id ?? ''} /></label></div>
            <label>Description<textarea name="description" maxlength="500" rows="2">{provider.description ?? ''}</textarea></label>
            <label>Sandbox policy (embed only)<select name="sandbox_policy">{#each sandboxPolicies as candidate}<option value={candidate} selected={providerSandboxPolicy(provider) === candidate}>{sandboxPolicyLabels[candidate]}</option>{/each}</select><small class="security-note">{sandboxPolicyDescription(providerSandboxPolicy(provider))}</small></label>
            {#if sourceOverridesFor(provider.id).length}
              <div class="sandbox-override-warning" role="alert">
                <ShieldCheck size={14} />
                <span>{sourceOverridesFor(provider.id).length} source{sourceOverridesFor(provider.id).length === 1 ? '' : 's'} of this provider carr{sourceOverridesFor(provider.id).length === 1 ? 'ies' : 'y'} an explicit sandbox override ({sourceOverridesFor(provider.id).map((override) => `${override.name}: ${override.policy}`).join(', ')}), which outranks the provider policy at runtime. Clear it on the source (choose “Provider default — inherit”) if the provider choice should apply.</span>
              </div>
            {/if}
            <label>Capabilities JSON<textarea name="capabilities" rows="3">{JSON.stringify(provider.capabilities ?? {}, null, 2)}</textarea></label>
            <label>Admin notes<textarea name="notes" maxlength="2000" rows="2">{provider.notes ?? ''}</textarea></label>
            <div class="form-actions"><button class="btn btn-primary" type="submit">Save changes</button></div>
          </form>
          <div class="form-actions secondary-actions">
            <form method="POST" action="?/toggleProvider" class="inline-form" onsubmit={(event) => { const button = (event.currentTarget as HTMLFormElement).querySelector('button'); if (button) button.disabled = true; }}>
              <input type="hidden" name="id" value={provider.id} />
              <input type="hidden" name="enabled" value={provider.enabled ? 'false' : 'true'} />
              <button class="btn btn-secondary" type="submit">{provider.enabled ? 'Disable' : 'Enable'}</button>
            </form>
            <form method="POST" action="?/deleteProvider" class="inline-form" onsubmit={() => confirm(`Delete ${provider.name}? Providers with dependent sources cannot be deleted.`)}>
              <input type="hidden" name="id" value={provider.id} />
              <button class="btn btn-danger" type="submit"><Trash2 size={14} /> Delete</button>
            </form>
          </div>

          {#if provider.adapter_id}
            <details class="capability-panel">
              <summary><span class="cap-label">Playback capabilities</span><span class="cap-adapter">adapter: <code>{provider.adapter_id}</code></span><ChevronDown size={14} /></summary>
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
          {:else}
            <details class="capability-panel">
              <summary><span class="cap-label">Playback capabilities</span><span class="cap-adapter">no adapter_id set</span><ChevronDown size={14} /></summary>
              <div class="cap-matrix">
                {#each CAPABILITY_FIELDS as field}
                  <div class="cap-cell unknown"><HelpCircle size={12} /><span>{CAPABILITY_LABELS[field]}</span></div>
                {/each}
              </div>
              <p class="cap-note">No <code>adapter_id</code> configured — all capabilities are <strong>Unknown</strong>. The generic template adapter will be used; no postMessage events are normalized.</p>
            </details>
          {/if}
        </details>
      {/each}
    </div>
  {/if}
</AdminShell>

<style>
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; }
  .notice { color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }
  .error { color: var(--color-danger); border: 1px solid rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .07); }

  .hint { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; letter-spacing: .04em; }

  .form-panel { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: rgba(0, 255, 156, .015); overflow: hidden; }
  summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 18px; cursor: pointer; list-style: none; color: var(--color-text); font-size: .8rem; }
  summary::-webkit-details-marker { display: none; }
  .summary-label { display: inline-flex; align-items: center; gap: 8px; color: var(--color-primary); font-weight: 700; }
  .registry-form { display: grid; gap: 13px; padding: 0 18px 18px; }
  .registry-form.compact { padding-top: 14px; border-top: 1px solid var(--color-border); }
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

  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .secondary-actions { padding: 0 18px 16px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0 14px; cursor: pointer; color: var(--color-text); background: var(--color-primary-soft); font: inherit; font-size: .74rem; font-weight: 700; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .btn:active { transform: scale(.98); }
  .btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .btn-primary { border-color: transparent; color: #050708; background: var(--color-primary); box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary); }
  .btn-primary:hover { filter: brightness(1.06); }
  .btn-secondary:hover { border-color: var(--color-primary-border); background: var(--color-primary-soft); box-shadow: var(--glow-primary); }
  .btn-danger { color: var(--color-danger); }
  .btn-danger:hover { border-color: rgba(255, 77, 109, .45); background: rgba(255, 77, 109, .08); }
  .inline-form { display: inline-flex; padding: 0; }

  .registry-list { display: grid; gap: 12px; margin-top: 16px; }
  .record { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); overflow: hidden; transition: border-color var(--motion-fast) var(--ease-out); }
  .record[open] { border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .record summary { padding: 14px 16px; }
  .provider-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--color-primary); background: var(--color-primary-soft); border: 1px solid var(--color-primary-border); font-size: .68rem; font-weight: 700; flex: 0 0 auto; }
  .record-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
  .record-copy { min-width: 0; }
  .record-copy strong { display: block; color: var(--color-text); font-size: .82rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-sub { display: block; margin-top: 3px; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-meta { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

  .security-note { color: var(--color-warning); font-size: .56rem; line-height: 1.5; text-transform: none; letter-spacing: 0; font-weight: 500; }

  /* Phase 12 (GOAL F): source-override warning under the provider sandbox
     policy — makes the configured-vs-effective hierarchy visible. */
  .sandbox-override-warning { display: flex; align-items: flex-start; gap: 8px; margin: -6px 0 10px; border: 1px solid rgba(255, 194, 71, .45); border-radius: var(--radius-sm); padding: 10px 12px; color: var(--color-warning); font-size: .58rem; line-height: 1.5; background: rgba(255, 194, 71, .04); }
  .sandbox-override-warning :global(svg) { flex: 0 0 auto; margin-top: 1px; }

  /* Phase 7: capability matrix panel */
  .capability-panel { margin: 0 18px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: rgba(0, 255, 156, .012); }
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

  /* Responsive — tablet/mobile stacks the form grids. */
  @media (max-width: 700px) {
    .form-grid.two, .form-grid.three { grid-template-columns: 1fr; }
    .record-meta { gap: 4px; }
  }
</style>
