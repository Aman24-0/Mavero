<script lang="ts">
  import { Check, ChevronDown, Plus, ShieldCheck, Trash2, HelpCircle, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import { integrationTypes, providerStatuses } from '$lib/shared/streaming';
  import { sandboxPolicies, sandboxPolicyDescription, sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
  import { CAPABILITY_FIELDS, CAPABILITY_LABELS, type ProviderPlaybackCapabilities } from '$lib/shared/player-capabilities';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

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
  const healthFor = (providerId: string) => data.health?.[providerId];
  const healthChecked = (providerId: string) => healthFor(providerId)?.lastCheckedAt ? new Date(healthFor(providerId)!.lastCheckedAt!).toLocaleString() : 'Not checked';

  // Phase 7: capability matrix display.
  // For each provider, look up the adapter's ProviderPlaybackCapabilities.
  // If null, the adapter is unknown — display "Unknown" (NOT unsupported).
  const capabilityFor = (providerId: string) => data.capabilityMap?.[providerId] ?? null;
  // Helper: three-state capability value for a single field.
  // 'supported' | 'unsupported' | 'unknown'
  function capabilityState(providerId: string, field: keyof ProviderPlaybackCapabilities): 'supported' | 'unsupported' | 'unknown' {
    const entry = capabilityFor(providerId);
    if (!entry) return 'unknown';
    if (entry.supported.includes(field)) return 'supported';
    return 'unsupported';
  }
</script>

<svelte:head><title>Provider Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="providers">
  <div class="eyebrow">MAVERO / Provider registry</div>
  <div class="heading-row"><div><h1>Provider <em>registry.</em></h1><p class="intro">Define the integrations that may later expose selectable playback sources. Phase 7A stores metadata only.</p></div><span class="count">{data.providers.length} records</span></div>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <details class="form-panel" open={data.providers.length === 0}>
    <summary><span><Plus size={15} /> Add provider</span><ChevronDown size={16} /></summary>
    <form method="POST" action="?/createProvider" class="registry-form">
      <div class="form-grid two"><label>Name<input name="name" required maxlength="120" placeholder="Example Provider" /></label><label>Slug<input name="slug" required maxlength="120" placeholder="example-provider" /></label></div>
      <div class="form-grid three"><label>Integration type<select name="integration_type">{#each integrationTypes as type}<option value={type}>{integrationLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status}>{providerStatusLabels[status]}</option>{/each}</select></label><label class="check"><input type="checkbox" name="enabled" /> Enabled for public config</label></div>
      <div class="form-grid two"><label>Icon / display token<input name="icon" maxlength="120" placeholder="spark / logo token" /></label><label>Adapter ID<input name="adapter_id" maxlength="80" placeholder="reserved-adapter-id" /></label></div>
      <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="Safe display description."></textarea></label>
      <label>Sandbox policy (embed only)<select name="sandbox_policy">{#each sandboxPolicies as policy}<option value={policy}>{sandboxPolicyLabels[policy]}</option>{/each}</select><small class="security-note">{sandboxPolicyDescription('required')}</small></label>
      <label>Capabilities JSON<textarea name="capabilities" rows="3" placeholder="JSON object, e.g. movies=true">&#123;&quot;movies&quot;:true&#125;</textarea></label>
      <label>Admin notes<textarea name="notes" maxlength="2000" rows="2" placeholder="Internal notes; never returned by public config."></textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create provider</button><span class="hint">No third-party calls are made.</span></div>
    </form>
  </details>

  {#if data.providers.length === 0}<div class="empty"><ShieldCheck size={22} /> <h2>No providers yet</h2><p>Create the first configuration record above. It will remain disabled until explicitly enabled.</p></div>{:else}<div class="registry-list">{#each data.providers as provider}
    <details class="record">
      <summary><div class="record-main"><span class="provider-icon">{provider.icon || 'M'}</span><div><strong>{provider.name}</strong><span>{provider.slug} · {integrationLabels[provider.integration_type as keyof typeof integrationLabels]}</span></div></div><div class="record-meta"><span class:good={provider.enabled} class:warning={!provider.enabled}>{provider.enabled ? 'Enabled' : 'Disabled'}</span><span>{providerStatusLabels[provider.status as keyof typeof providerStatusLabels]}</span><span class="health" class:health-good={healthFor(provider.id)?.state === 'healthy'} class:health-warn={healthFor(provider.id)?.state === 'degraded' || healthFor(provider.id)?.state === 'unknown'} class:health-bad={healthFor(provider.id)?.state === 'unhealthy' || healthFor(provider.id)?.state === 'cooldown'} title={`Runtime health · ${healthChecked(provider.id)}`}>Health: {healthStateLabels[healthFor(provider.id)?.state ?? 'unknown']}</span><ChevronDown size={15} /></div></summary>
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
      <div class="form-actions secondary-actions"><form method="POST" action="?/toggleProvider" class="inline-form" onsubmit={(event) => { const button = (event.currentTarget as HTMLFormElement).querySelector('button'); if (button) button.disabled = true; }}><input type="hidden" name="id" value={provider.id} /><input type="hidden" name="enabled" value={provider.enabled ? 'false' : 'true'} /><button class="btn btn-secondary" type="submit">{provider.enabled ? 'Disable' : 'Enable'}</button></form><form method="POST" action="?/deleteProvider" class="inline-form" onsubmit={() => confirm(`Delete ${provider.name}? Providers with dependent sources cannot be deleted.`)}><input type="hidden" name="id" value={provider.id} /><button class="btn btn-danger" type="submit"><Trash2 size={14} /> Delete</button></form></div>

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
  {/each}</div>{/if}
</AdminShell>


<style>
  em { color: var(--accent); font-style: normal; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  h1 { margin: 8px 0 9px; color: var(--ink); font-size: clamp(1.7rem, 3.2vw, 2.4rem); font-weight: 900; letter-spacing: -.02em; line-height: 1.1; }
  .intro { max-width: 610px; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.65; }
  .count, .hint { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; }
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: 9px; font-size: .72rem; }
  .notice { color: var(--success); border: 1px solid rgba(126,220,180,.2); background: rgba(126,220,180,.06); }
  .error { color: #ff8a8a; border: 1px solid rgba(228,133,105,.25); background: rgba(228,133,105,.07); }
  .form-panel, .record { margin-top: 19px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
  summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 17px 19px; cursor: pointer; list-style: none; color: var(--ink); font-size: .8rem; }
  summary::-webkit-details-marker { display: none; }
  summary > span, .record-main, .record-meta { display: flex; align-items: center; gap: 9px; }
  summary > span { color: var(--accent); }
  .registry-form { display: grid; gap: 13px; padding: 0 19px 19px; }
  .registry-form.compact { padding-top: 0; border-top: 1px solid var(--line); }
  .form-grid { display: grid; gap: 10px; }
  .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label { display: grid; gap: 6px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .57rem; }
  input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; color: var(--ink); background: rgba(255,255,255,.035); font: inherit; font-family: inherit; font-size: .68rem; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: rgba(155,135,245,.7); box-shadow: 0 0 0 3px rgba(155,135,245,.1); }
  textarea { resize: vertical; line-height: 1.5; }
  .check { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; }
  .check input { width: auto; accent-color: var(--accent); }
  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; cursor: pointer; color: var(--ink); background: transparent; font: inherit; font-size: .66rem; }
  .btn-primary { border-color: transparent; color: #12121a; background: var(--ink); }
  .btn-secondary:hover { border-color: rgba(155,135,245,.45); background: var(--accent-soft); }
  .btn-danger { color: #ff8a8a; }
  .btn-danger:hover { border-color: rgba(228,133,105,.35); background: rgba(228,133,105,.08); }
  .inline-form { display: inline-flex; padding: 0; }
  .registry-list { display: grid; gap: 10px; margin-top: 15px; }
  .record { margin-top: 0; }
  .record summary { padding: 14px 16px; }
  .provider-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .65rem; }
  .record-main strong { display: block; color: var(--ink); font-size: .78rem; }
  .record-main span:not(.provider-icon) { display: block; margin-top: 3px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .54rem; }
  .record-meta { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  .record-meta .good { color: var(--success); }
  .record-meta .warning { color: #ffb020; }
  .record-meta .health { padding-left: 7px; border-left: 1px solid var(--line); }
  .record-meta .health-good { color: var(--success); }
  .record-meta .health-warn { color: #ffb020; }
  .record-meta .health-bad { color: #ff8a8a; }
  .empty { margin-top: 15px; padding: 45px 20px; text-align: center; border: 1px dashed var(--line); border-radius: 14px; } .security-note { color: #ffb020; font-size: .55rem; line-height: 1.45; }
  /* Phase 12 (GOAL F): source-override warning under the provider sandbox
     policy — makes the configured-vs-effective hierarchy visible. */
  .sandbox-override-warning { display: flex; align-items: flex-start; gap: 8px; margin: -6px 0 10px; border: 1px solid rgba(255, 176, 32, 0.45); border-radius: 8px; padding: 8px 10px; color: #ffb020; font-size: .55rem; line-height: 1.45; }
  .sandbox-override-warning :global(svg) { flex: 0 0 auto; margin-top: 1px; }
  .empty h2 { margin: 10px 0 5px; font-size: 1rem; }
  .empty p { margin: 0; color: var(--muted); font-size: .72rem; }
  @media (max-width: 700px) { .heading-row { align-items: start; flex-direction: column; } .form-grid.two, .form-grid.three { grid-template-columns: 1fr; } .record-meta span:nth-child(2) { display: none; } }

  /* Phase 7: capability matrix panel */
  .capability-panel { margin: 0 19px 16px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.02); }
  .capability-panel summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 14px; cursor: pointer; list-style: none; color: var(--ink); font-size: .68rem; }
  .capability-panel summary::-webkit-details-marker { display: none; }
  .cap-label { color: var(--accent); font-size: .62rem; }
  .cap-adapter { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .54rem; }
  .cap-adapter code { color: var(--ink); }
  .cap-matrix { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; padding: 0 14px 12px; }
  .cap-cell { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  .cap-cell.ok { color: var(--success); border-color: rgba(126,220,180,.2); background: rgba(126,220,180,.04); }
  .cap-cell.no { color: #ff8a8a; border-color: rgba(228,133,105,.15); background: rgba(228,133,105,.03); }
  .cap-cell.unknown { color: var(--muted-deep); border-color: var(--line); background: rgba(255,255,255,.02); }
  .cap-note { margin: 0 14px 12px; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .56rem; line-height: 1.5; }
  .cap-note code { color: var(--ink); }
</style>
