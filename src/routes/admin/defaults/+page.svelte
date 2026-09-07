<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, AlertTriangle, Star, ShieldCheck } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const contentTypes = [
    { key: 'movie', label: 'Movie', description: 'Default source for movies (single video, no season/episode).' },
    { key: 'series', label: 'Series', description: 'Default source for TV series (season + episode required).' },
    { key: 'anime', label: 'Anime', description: 'Default source for anime (season + episode required).' },
  ] as const;

  // Helper: find the current default source for a content type.
  const defaultFor = (contentType: string) => data.defaults.find((d) => d.content_type === contentType);

  // Helper: find the source row for a source id.
  const sourceById = (sourceId: string | undefined) => (sourceId ? data.sources.find((s) => s.id === sourceId) : undefined);

  // Helper: find the provider name for a source.
  const providerName = (providerId: string) => data.providers.find((p) => p.id === providerId)?.name ?? 'Unknown provider';

  // Helper: check if a source is eligible for public config (enabled + public + active/experimental).
  const isEligible = (source: { enabled: boolean; visibility: string; status: string }) =>
    source.enabled && source.visibility === 'public' && (source.status === 'active' || source.status === 'experimental');

  // Helper: label for a source's eligibility status.
  const eligibilityLabel = (source: { enabled: boolean; visibility: string; status: string }) => {
    if (!source.enabled) return 'Disabled';
    if (source.visibility !== 'public') return source.visibility;
    if (source.status !== 'active' && source.status !== 'experimental') return source.status;
    return 'Eligible';
  };

  // Adult Mode admin policy state (API-driven, not form-action).
  let adultPolicy = $state<{ allowLoggedIn: boolean; allowGuest: boolean }>({ allowLoggedIn: false, allowGuest: false });
  let adultPolicyLoading = $state(false);
  let adultPolicySaved = $state(false);

  async function loadAdultPolicy() {
    try {
      const response = await fetch('/api/admin/adult-mode');
      if (!response.ok) return;
      const payload = await response.json();
      if (payload.ok && payload.policy) {
        adultPolicy = { ...payload.policy };
      }
    } catch { /* ignore */ }
  }

  async function toggleAdultPolicy(field: 'allowLoggedIn' | 'allowGuest') {
    adultPolicyLoading = true;
    adultPolicySaved = false;
    try {
      const response = await fetch('/api/admin/adult-mode', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: !adultPolicy[field] }),
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (payload.ok && payload.policy) {
        adultPolicy = { ...payload.policy };
        adultPolicySaved = true;
        setTimeout(() => { adultPolicySaved = false; }, 2500);
      }
    } catch { /* ignore */ }
    adultPolicyLoading = false;
  }

  onMount(() => { void loadAdultPolicy(); });
</script>

<svelte:head><title>Default Sources — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="defaults">
  <div class="eyebrow">MAVERO / Default sources</div>
  <div class="heading-row"><div><h1>Playback <em>defaults.</em></h1><p class="intro">Configure the default playback source for each content type. Defaults are sorted to the front of the fallback candidate list — they do not receive an artificial health boost, and ineligible defaults are silently omitted from public configuration.</p></div></div>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <div class="defaults-grid">
    {#each contentTypes as ct}
      {@const current = defaultFor(ct.key)}
      {@const currentSource = sourceById(current?.source_id)}
      {@const ineligible = currentSource ? !isEligible(currentSource) : false}
      <div class="default-card">
        <div class="card-header">
          <div class="card-title"><Star size={16} /> <strong>{ct.label}</strong></div>
          {#if current}<span class="badge set">Default set</span>{:else}<span class="badge unset">No default</span>{/if}
        </div>
        <p class="card-desc">{ct.description}</p>

        {#if currentSource}
          <div class="current-default" class:ineligible>
            <div class="current-label">Current default</div>
            <div class="current-name">{currentSource.name}</div>
            <div class="current-meta">{providerName(currentSource.provider_id)} · {eligibilityLabel(currentSource)}</div>
          </div>
          {#if ineligible}
            <div class="warning" role="alert"><AlertTriangle size={14} /> <span>This source is currently <strong>{eligibilityLabel(currentSource)}</strong>. Public configuration will omit it until the source becomes eligible again. The default is preserved so it auto-activates when re-enabled.</span></div>
          {/if}
        {:else}
          <div class="current-default none"><div class="current-label">No default configured</div><div class="current-meta">The resolver will use health-ranked fallback ordering.</div></div>
        {/if}

        <form method="POST" action="?/saveDefault" class="default-form">
          <input type="hidden" name="content_type" value={ct.key} />
          <label>
            <span>Select source</span>
            <select name="source_id" required>
              <option value="" disabled selected>Choose a source…</option>
              {#each data.sources as source}
                {@const provider = providerName(source.provider_id)}
                {@const selected = current?.source_id === source.id}
                {@const eligible = isEligible(source)}
                <option value={source.id} {selected}>{source.name} · {provider}{!eligible ? ` (${eligibilityLabel(source)})` : ''}</option>
              {/each}
            </select>
          </label>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Save {ct.label.toLowerCase()} default</button>
            {#if current}
              <button class="btn btn-danger" type="submit" formaction="?/clearDefault" onsubmit={() => confirm(`Clear the ${ct.label.toLowerCase()} default?`)}>Clear</button>
            {/if}
          </div>
        </form>
      </div>
    {/each}
  </div>

  <!-- Adult Mode admin controls -->
  <div class="adult-section">
    <div class="eyebrow"><ShieldCheck size={13} /> MAVERO / Adult Mode</div>
    <div class="heading-row"><div><h2>Adult Mode <em>policy.</em></h2><p class="intro">Control whether Adult Mode is available for logged-in users and guests. When disabled for a user type, the setting disappears from their UI and adult content is blocked server-side.</p></div></div>
    {#if adultPolicySaved}<div class="notice" role="status"><Check size={15} /> Adult mode policy updated.</div>{/if}
    <div class="adult-toggles">
      <label class="adult-toggle-row">
        <span class="toggle-copy"><strong>Allow for logged-in users</strong><small>Authenticated users can enable Adult Mode in their settings.</small></span>
        <span class="toggle-switch">
          <input type="checkbox" checked={adultPolicy.allowLoggedIn} disabled={adultPolicyLoading} onchange={() => toggleAdultPolicy('allowLoggedIn')} />
          <i aria-hidden="true"></i>
        </span>
      </label>
      <label class="adult-toggle-row">
        <span class="toggle-copy"><strong>Allow for users without login</strong><small>Guest users can access Adult Mode. Requires server-side guest preference if no auth session exists.</small></span>
        <span class="toggle-switch">
          <input type="checkbox" checked={adultPolicy.allowGuest} disabled={adultPolicyLoading} onchange={() => toggleAdultPolicy('allowGuest')} />
          <i aria-hidden="true"></i>
        </span>
      </label>
    </div>
  </div>
</AdminShell>

<style>
  em { color: var(--accent); font-style: normal; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  h1 { margin: 8px 0 9px; color: var(--ink); font-size: clamp(1.7rem, 3.2vw, 2.4rem); font-weight: 900; letter-spacing: -.02em; line-height: 1.1; }
  .intro { max-width: 650px; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.65; }
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: 9px; font-size: .72rem; }
  .notice { color: var(--success); border: 1px solid rgba(126,220,180,.2); background: rgba(126,220,180,.06); }
  .error { color: #ff8a8a; border: 1px solid rgba(228,133,105,.25); background: rgba(228,133,105,.07); }

  .defaults-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; margin-top: 22px; }
  .default-card { display: grid; gap: 13px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
  .card-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .card-title { display: flex; align-items: center; gap: 8px; color: var(--ink); font-size: .85rem; }
  .card-title :global(svg) { color: var(--accent); }
  .card-desc { margin: 0; color: var(--muted); font-size: .66rem; line-height: 1.55; }
  .badge { padding: 4px 9px; border-radius: 999px; font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .52rem; text-transform: uppercase; letter-spacing: .05em; }
  .badge.set { color: var(--success); background: rgba(126,220,180,.1); border: 1px solid rgba(126,220,180,.2); }
  .badge.unset { color: var(--muted-deep); background: rgba(255,255,255,.04); border: 1px solid var(--line); }

  .current-default { padding: 11px 13px; border: 1px solid var(--line); border-radius: 9px; background: rgba(255,255,255,.025); }
  .current-default.ineligible { border-color: rgba(255,176,32,.35); background: rgba(255,176,32,.05); }
  .current-default.none { border-style: dashed; }
  .current-label { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .52rem; text-transform: uppercase; letter-spacing: .08em; }
  .current-name { margin-top: 4px; color: var(--ink); font-size: .78rem; font-weight: 700; }
  .current-meta { margin-top: 2px; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .56rem; }

  .warning { display: flex; align-items: start; gap: 8px; padding: 10px 12px; border: 1px solid rgba(255,176,32,.3); border-radius: 9px; color: #ffb020; background: rgba(255,176,32,.06); font-size: .62rem; line-height: 1.5; }

  .default-form { display: grid; gap: 10px; }
  label { display: grid; gap: 5px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  select { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; color: var(--ink); background: rgba(255,255,255,.035); font: inherit; font-family: inherit; font-size: .68rem; outline: none; }
  select:focus { border-color: rgba(155,135,245,.7); box-shadow: 0 0 0 3px rgba(155,135,245,.1); }
  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; cursor: pointer; color: var(--ink); background: transparent; font: inherit; font-size: .66rem; }
  .btn-primary { border-color: transparent; color: #12121a; background: var(--ink); }
  .btn-danger { color: #ff8a8a; }

  .adult-section { margin-top: 40px; padding-top: 28px; border-top: 1px solid var(--line); }
  .adult-toggles { display: grid; gap: 14px; margin-top: 16px; }
  .adult-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.02); cursor: pointer; }
  .adult-toggle-row .toggle-copy { display: grid; gap: 3px; }
  .adult-toggle-row .toggle-copy strong { color: var(--ink); font-size: .76rem; }
  .adult-toggle-row .toggle-copy small { color: var(--muted); font-size: .58rem; line-height: 1.4; }
  .toggle-switch { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
  .toggle-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .toggle-switch i { display: block; width: 100%; height: 100%; border-radius: 999px; background: rgba(255,255,255,.12); transition: background 200ms ease; position: relative; }
  .toggle-switch i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #f5f5f5; transition: transform 200ms ease; }
  .toggle-switch input:checked ~ i { background: var(--accent); }
  .toggle-switch input:checked ~ i::after { transform: translateX(18px); }

  @media (max-width: 700px) { .heading-row { align-items: start; flex-direction: column; } .defaults-grid { grid-template-columns: 1fr; } }
</style>
