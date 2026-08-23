<script lang="ts">
  import { Check, ChevronDown, Plus, SlidersHorizontal, Trash2 } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import { integrationTypes, identifierModes, providerStatuses, sourceVisibilities } from '$lib/shared/streaming';
  import { sandboxPolicies, sandboxPolicyDescription, sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  const statusLabels = { active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable' };
  const typeLabels = { template: 'Template', api: 'API', direct: 'Direct', embed: 'Embed', custom: 'Custom' };
  const visibilityLabels = { public: 'Public', internal: 'Internal', hidden: 'Hidden' };
  const identifierLabels = { tmdb_id: 'TMDB ID', anilist_id: 'AniList ID', imdb_id: 'IMDb ID', slug: 'Slug', custom: 'Custom' };
  const sandboxPolicyLabels = { required: 'Required — secure sandbox', optional: 'Optional — secure by default', unrestricted: 'Unrestricted — warning' };
  const sourceSandboxPolicy = (source: PageData['sources'][number]) => sandboxPolicyFromCapabilities(data.providers.find((provider) => provider.id === source.provider_id)?.capabilities, source.capabilities);
  const providerName = (id: string) => data.providers.find((provider) => provider.id === id)?.name ?? 'Unknown provider';
</script>

<svelte:head><title>Source Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="sources">
  <div class="eyebrow">MAVERO / Source registry</div>
  <div class="heading-row"><div><h1>Playback <em>sources.</em></h1><p class="intro">Configure selectable source records and inert templates. No URL is resolved and no third-party playback is activated in Phase 7A.</p></div><span class="count">{data.sources.length} records</span></div>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <details class="form-panel" open={data.sources.length === 0}>
    <summary><span><Plus size={15} /> Add source</span><ChevronDown size={16} /></summary>
    <form method="POST" action="?/createSource" class="registry-form">
      <div class="form-grid two"><label>Name<input name="name" required maxlength="120" placeholder="Example source" /></label><label>Slug<input name="slug" required maxlength="120" placeholder="example-source" /></label></div>
      <div class="form-grid three"><label>Provider<select name="provider_id" required><option value="" disabled selected>Select provider</option>{#each data.providers as provider}<option value={provider.id}>{provider.name}</option>{/each}</select></label><label>Identifier mode<select name="identifier_mode">{#each identifierModes as mode}<option value={mode}>{identifierLabels[mode]}</option>{/each}</select></label><label>Ordering<input name="ordering" type="number" min="0" step="1" value="0" /></label></div>
      <div class="form-grid three"><label>Integration type<select name="integration_type"><option value="">Provider default</option>{#each integrationTypes as type}<option value={type}>{typeLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status}>{statusLabels[status]}</option>{/each}</select></label><label>Visibility<select name="visibility">{#each sourceVisibilities as visibility}<option value={visibility}>{visibilityLabels[visibility]}</option>{/each}</select></label></div>
      <div class="form-grid two"><label>Language<input name="language" maxlength="60" placeholder="Original" /></label><label>Audio languages<input name="audio_languages" placeholder="English, Hindi" /></label></div>
      <div class="form-grid two"><label class="check"><input type="checkbox" name="enabled" /> Enabled for public config</label><label class="check"><input type="checkbox" name="subtitle_capability" /> Subtitle capability</label></div>
      <label>Quality capability<input name="quality_capability" placeholder="HD, Full HD, 4K" /></label>
      <label>Sandbox policy (embed only)<select name="sandbox_policy">{#each sandboxPolicies as policy}<option value={policy}>{sandboxPolicyLabels[policy]}</option>{/each}</select><small class="security-note">{sandboxPolicyDescription('required')}</small></label>
      <div class="form-grid three"><label>Movie template<textarea name="movie_template" rows="2" placeholder="Configuration only"></textarea></label><label>Series template<textarea name="series_template" rows="2" placeholder="Configuration only"></textarea></label><label>Anime template<textarea name="anime_template" rows="2" placeholder="Configuration only"></textarea></label></div>
      <label>Capabilities JSON<textarea name="capabilities" rows="3" placeholder="JSON object, e.g. movies=true">&#123;&quot;movies&quot;:true&#125;</textarea></label>
      <label>Description<textarea name="description" maxlength="500" rows="2"></textarea></label><label>Admin notes<textarea name="notes" maxlength="2000" rows="2"></textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create source</button><span class="hint">Templates are inert configuration in Phase 7A.</span></div>
    </form>
  </details>

  {#if data.sources.length === 0}<div class="empty"><SlidersHorizontal size={22} /><h2>No sources yet</h2><p>Create a source after defining at least one provider.</p></div>{:else}<div class="registry-list">{#each data.sources as source}
    <details class="record">
      <summary><div class="record-main"><span class="source-icon">{source.name.slice(0, 1).toUpperCase()}</span><div><strong>{source.name}</strong><span>{source.slug} · {providerName(source.provider_id)}</span></div></div><div class="record-meta"><span class:good={source.enabled} class:warning={!source.enabled}>{source.enabled ? 'Enabled' : 'Disabled'}</span><span>{visibilityLabels[source.visibility as keyof typeof visibilityLabels]}</span><ChevronDown size={15} /></div></summary>
      <form method="POST" action="?/updateSource" class="registry-form compact">
        <input type="hidden" name="id" value={source.id} />
        <div class="form-grid two"><label>Name<input name="name" required maxlength="120" value={source.name} /></label><label>Slug<input name="slug" required maxlength="120" value={source.slug} /></label></div>
        <div class="form-grid three"><label>Provider<select name="provider_id" required>{#each data.providers as provider}<option value={provider.id} selected={source.provider_id === provider.id}>{provider.name}</option>{/each}</select></label><label>Identifier mode<select name="identifier_mode">{#each identifierModes as mode}<option value={mode} selected={source.identifier_mode === mode}>{identifierLabels[mode]}</option>{/each}</select></label><label>Ordering<input name="ordering" type="number" min="0" step="1" value={source.ordering} /></label></div>
        <div class="form-grid three"><label>Integration type<select name="integration_type"><option value="" selected={!source.integration_type}>Provider default</option>{#each integrationTypes as type}<option value={type} selected={source.integration_type === type}>{typeLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status} selected={source.status === status}>{statusLabels[status]}</option>{/each}</select></label><label>Visibility<select name="visibility">{#each sourceVisibilities as visibility}<option value={visibility} selected={source.visibility === visibility}>{visibilityLabels[visibility]}</option>{/each}</select></label></div>
        <div class="form-grid two"><label>Language<input name="language" maxlength="60" value={source.language ?? ''} /></label><label>Audio languages<input name="audio_languages" value={source.audio_languages?.join(', ') ?? ''} /></label></div>
        <div class="form-grid two"><label class="check"><input type="checkbox" name="enabled" checked={source.enabled} /> Enabled for public config</label><label class="check"><input type="checkbox" name="subtitle_capability" checked={source.subtitle_capability} /> Subtitle capability</label></div>
        <label>Quality capability<input name="quality_capability" value={source.quality_capability?.join(', ') ?? ''} /></label>
        {#if source.integration_type === 'embed' || data.providers.find((provider) => provider.id === source.provider_id)?.integration_type === 'embed'}<label>Sandbox policy (embed only)<select name="sandbox_policy">{#each sandboxPolicies as candidate}<option value={candidate} selected={sourceSandboxPolicy(source) === candidate}>{sandboxPolicyLabels[candidate]}</option>{/each}</select><small class="security-note">{sandboxPolicyDescription(sourceSandboxPolicy(source))}</small></label>{/if}
        <div class="form-grid three"><label>Movie template<textarea name="movie_template" rows="2">{source.movie_template ?? ''}</textarea></label><label>Series template<textarea name="series_template" rows="2">{source.series_template ?? ''}</textarea></label><label>Anime template<textarea name="anime_template" rows="2">{source.anime_template ?? ''}</textarea></label></div>
        <label>Capabilities JSON<textarea name="capabilities" rows="3">{JSON.stringify(source.capabilities ?? {}, null, 2)}</textarea></label>
        <label>Description<textarea name="description" maxlength="500" rows="2">{source.description ?? ''}</textarea></label><label>Admin notes<textarea name="notes" maxlength="2000" rows="2">{source.notes ?? ''}</textarea></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save changes</button></div>
      </form>
      <div class="form-actions secondary-actions"><form method="POST" action="?/toggleSource" class="inline-form" onsubmit={(event) => { const button = (event.currentTarget as HTMLFormElement).querySelector('button'); if (button) button.disabled = true; }}><input type="hidden" name="id" value={source.id} /><input type="hidden" name="enabled" value={source.enabled ? 'false' : 'true'} /><button class="btn btn-secondary" type="submit">{source.enabled ? 'Disable' : 'Enable'}</button></form><form method="POST" action="?/deleteSource" class="inline-form" onsubmit={() => confirm(`Delete ${source.name}? Assigned category records must be removed first.`)}><input type="hidden" name="id" value={source.id} /><button class="btn btn-danger" type="submit"><Trash2 size={14} /> Delete</button></form></div>
    </details>
  {/each}</div>{/if}
</AdminShell>

<style>
  em { color: var(--accent); font-style: normal; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; } h1 { margin: 8px 0 9px; color: var(--ink); font-size: clamp(1.7rem, 3.2vw, 2.4rem); font-weight: 900; letter-spacing: -.02em; line-height: 1.1; } .intro { max-width: 650px; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.65; } .count, .hint { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; }
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: 9px; font-size: .72rem; } .notice { color: var(--success); border: 1px solid rgba(126,220,180,.2); background: rgba(126,220,180,.06); } .error { color: #ff8a8a; border: 1px solid rgba(228,133,105,.25); background: rgba(228,133,105,.07); }
  .form-panel, .record { margin-top: 19px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); } summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 17px 19px; cursor: pointer; list-style: none; color: var(--ink); font-size: .8rem; } summary::-webkit-details-marker { display: none; } summary > span, .record-main, .record-meta { display: flex; align-items: center; gap: 9px; } summary > span { color: var(--accent); }
  .registry-form { display: grid; gap: 13px; padding: 0 19px 19px; } .registry-form.compact { padding-top: 0; border-top: 1px solid var(--line); } .form-grid { display: grid; gap: 10px; } .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); } .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label { display: grid; gap: 6px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .57rem; } input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; color: var(--ink); background: rgba(255,255,255,.035); font: inherit; font-family: inherit; font-size: .68rem; outline: none; } input:focus, select:focus, textarea:focus { border-color: rgba(155,135,245,.7); box-shadow: 0 0 0 3px rgba(155,135,245,.1); } textarea { resize: vertical; line-height: 1.5; } .check { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; } .check input { width: auto; accent-color: var(--accent); }
  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; } .secondary-actions { padding: 0 19px 16px; } .btn { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; cursor: pointer; color: var(--ink); background: transparent; font: inherit; font-size: .66rem; } .btn-primary { border-color: transparent; color: #12121a; background: var(--ink); } .btn-secondary:hover { border-color: rgba(155,135,245,.45); background: var(--accent-soft); } .btn-danger { color: #ff8a8a; } .inline-form { display: inline-flex; padding: 0; }
  .registry-list { display: grid; gap: 10px; margin-top: 15px; } .record { margin-top: 0; } .record summary { padding: 14px 16px; } .source-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .65rem; } .record-main strong { display: block; color: var(--ink); font-size: .78rem; } .record-main span:not(.source-icon) { display: block; margin-top: 3px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .54rem; } .record-meta { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; } .record-meta .good { color: var(--success); } .record-meta .warning { color: #ffb020; }   .empty { margin-top: 15px; padding: 45px 20px; text-align: center; border: 1px dashed var(--line); border-radius: 14px; } .empty h2 { margin: 10px 0 5px; font-size: 1rem; } .empty p { margin: 0; color: var(--muted); font-size: .72rem; } .security-note { color: #ffb020; font-size: .55rem; line-height: 1.45; }

  @media (max-width: 700px) { .heading-row { align-items: start; flex-direction: column; } .form-grid.two, .form-grid.three { grid-template-columns: 1fr; } .record-meta span:nth-child(2) { display: none; } }
</style>
