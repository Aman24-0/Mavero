<script lang="ts">
  import { Check, ChevronDown, Plus, SlidersHorizontal, Trash2, FlaskConical, Loader2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import { integrationTypes, identifierModes, providerStatuses, sourceVisibilities } from '$lib/shared/streaming';
  import { sandboxPolicies, sandboxPolicyDescription, sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
  import { playbackAdProtectionDescription, playbackAdProtectionFromCapabilities } from '$lib/shared/playback-ad-protection';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  const statusLabels = { active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable' };
  const typeLabels = { template: 'Template', api: 'API', direct: 'Direct', embed: 'Embed', custom: 'Custom' };
  const visibilityLabels = { public: 'Public', internal: 'Internal', hidden: 'Hidden' };
  const identifierLabels = { tmdb_id: 'TMDB ID', anilist_id: 'AniList ID', imdb_id: 'IMDb ID', slug: 'Slug', custom: 'Custom' };
  const sandboxPolicyLabels = { required: 'Required — secure sandbox', optional: 'Optional — secure by default', unrestricted: 'Unrestricted — warning' };
  const sourceSandboxPolicy = (source: PageData['sources'][number]) => sandboxPolicyFromCapabilities(data.providers.find((provider) => provider.id === source.provider_id)?.capabilities, source.capabilities);
  // Effective Ad Protection = source override → provider default → OFF.
  const sourceAdProtection = (source: PageData['sources'][number]) => playbackAdProtectionFromCapabilities(data.providers.find((provider) => provider.id === source.provider_id)?.capabilities, source.capabilities).enabled;
  const providerName = (id: string) => data.providers.find((provider) => provider.id === id)?.name ?? 'Unknown provider';

  // Phase 7: source test state — per-source panel + result.
  let testSourceId = '';
  let testContentId = '';
  let testMediaType: 'movie' | 'series' | 'anime' = 'movie';
  let testSeason = '';
  let testEpisode = '';
  let testLoading = false;
  let testResult: { ok: boolean; result?: { type: string; url: string | null }; attempts?: { sourceId: string; result: string; errorCode?: string }[]; rankingDiagnostics?: { eligible: { sourceId: string }[]; excluded: { sourceId: string; reason: string }[] }; durationMs?: number; error?: { code: string; message: string } } | null = null;

  function openTestPanel(sourceId: string) {
    testSourceId = sourceId;
    testResult = null;
  }

  function closeTestPanel() {
    testSourceId = '';
    testResult = null;
    testContentId = '';
    testSeason = '';
    testEpisode = '';
    testMediaType = 'movie';
  }

  async function runTest(event: SubmitEvent) {
    event.preventDefault();
    if (!testSourceId || !testContentId) return;
    testLoading = true;
    testResult = null;
    try {
      const body: { sourceId: string; contentId: string; mediaType: 'movie' | 'series' | 'anime'; season?: number; episode?: number } = {
        sourceId: testSourceId,
        contentId: testContentId,
        mediaType: testMediaType,
      };
      if (testMediaType !== 'movie' && testSeason && testEpisode) {
        body.season = Number(testSeason);
        body.episode = Number(testEpisode);
      }
      const response = await fetch('/api/admin/sources/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      testResult = await response.json();
    } catch (err) {
      testResult = { ok: false, error: { code: 'NETWORK_ERROR', message: String(err instanceof Error ? err.message : err) } };
    } finally {
      testLoading = false;
    }
  }
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
      <label class="check"><input type="checkbox" name="playback_ad_protection" /> Ad Protection — overrides the provider default for this source only</label>
      <small class="security-note">{playbackAdProtectionDescription(false)}</small>
      <div class="form-grid three"><label>Movie template<textarea name="movie_template" rows="2" placeholder="Configuration only"></textarea></label><label>Series template<textarea name="series_template" rows="2" placeholder="Configuration only"></textarea></label><label>Anime template<textarea name="anime_template" rows="2" placeholder="Configuration only"></textarea></label></div>
      <label>Capabilities JSON<textarea name="capabilities" rows="3" placeholder="JSON object, e.g. movies=true">&#123;&quot;movies&quot;:true&#125;</textarea></label>
      <label>Description<textarea name="description" maxlength="500" rows="2"></textarea></label><label>Admin notes<textarea name="notes" maxlength="2000" rows="2"></textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create source</button><span class="hint">Templates are inert configuration in Phase 7A.</span></div>
    </form>
  </details>

  {#if data.sources.length === 0}<div class="empty"><SlidersHorizontal size={22} /><h2>No sources yet</h2><p>Create a source after defining at least one provider.</p></div>{:else}<div class="registry-list">{#each data.sources as source}
    <details class="record">
      <summary><div class="record-main"><span class="source-icon">{source.name.slice(0, 1).toUpperCase()}</span><div><strong>{source.name}</strong><span>{source.slug} · {providerName(source.provider_id)}</span></div></div><div class="record-meta"><span class:good={source.enabled} class:warning={!source.enabled}>{source.enabled ? 'Enabled' : 'Disabled'}</span><span>{visibilityLabels[source.visibility as keyof typeof visibilityLabels]}</span><span>Ad Protection: {sourceAdProtection(source) ? 'ON' : 'OFF'}</span><ChevronDown size={15} /></div></summary>
      <form method="POST" action="?/updateSource" class="registry-form compact">
        <input type="hidden" name="id" value={source.id} />
        <div class="form-grid two"><label>Name<input name="name" required maxlength="120" value={source.name} /></label><label>Slug<input name="slug" required maxlength="120" value={source.slug} /></label></div>
        <div class="form-grid three"><label>Provider<select name="provider_id" required>{#each data.providers as provider}<option value={provider.id} selected={source.provider_id === provider.id}>{provider.name}</option>{/each}</select></label><label>Identifier mode<select name="identifier_mode">{#each identifierModes as mode}<option value={mode} selected={source.identifier_mode === mode}>{identifierLabels[mode]}</option>{/each}</select></label><label>Ordering<input name="ordering" type="number" min="0" step="1" value={source.ordering} /></label></div>
        <div class="form-grid three"><label>Integration type<select name="integration_type"><option value="" selected={!source.integration_type}>Provider default</option>{#each integrationTypes as type}<option value={type} selected={source.integration_type === type}>{typeLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status} selected={source.status === status}>{statusLabels[status]}</option>{/each}</select></label><label>Visibility<select name="visibility">{#each sourceVisibilities as visibility}<option value={visibility} selected={source.visibility === visibility}>{visibilityLabels[visibility]}</option>{/each}</select></label></div>
        <div class="form-grid two"><label>Language<input name="language" maxlength="60" value={source.language ?? ''} /></label><label>Audio languages<input name="audio_languages" value={source.audio_languages?.join(', ') ?? ''} /></label></div>
        <div class="form-grid two"><label class="check"><input type="checkbox" name="enabled" checked={source.enabled} /> Enabled for public config</label><label class="check"><input type="checkbox" name="subtitle_capability" checked={source.subtitle_capability} /> Subtitle capability</label></div>
        <label>Quality capability<input name="quality_capability" value={source.quality_capability?.join(', ') ?? ''} /></label>
        {#if source.integration_type === 'embed' || data.providers.find((provider) => provider.id === source.provider_id)?.integration_type === 'embed'}<label>Sandbox policy (embed only)<select name="sandbox_policy">{#each sandboxPolicies as candidate}<option value={candidate} selected={sourceSandboxPolicy(source) === candidate}>{sandboxPolicyLabels[candidate]}</option>{/each}</select><small class="security-note">{sandboxPolicyDescription(sourceSandboxPolicy(source))}</small></label>{/if}
        <label class="check"><input type="checkbox" name="playback_ad_protection" checked={sourceAdProtection(source)} /> Ad Protection — overrides the provider default for this source only</label>
        <small class="security-note">{playbackAdProtectionDescription(sourceAdProtection(source))}</small>
        <div class="form-grid three"><label>Movie template<textarea name="movie_template" rows="2">{source.movie_template ?? ''}</textarea></label><label>Series template<textarea name="series_template" rows="2">{source.series_template ?? ''}</textarea></label><label>Anime template<textarea name="anime_template" rows="2">{source.anime_template ?? ''}</textarea></label></div>
        <label>Capabilities JSON<textarea name="capabilities" rows="3">{JSON.stringify(source.capabilities ?? {}, null, 2)}</textarea></label>
        <label>Description<textarea name="description" maxlength="500" rows="2">{source.description ?? ''}</textarea></label><label>Admin notes<textarea name="notes" maxlength="2000" rows="2">{source.notes ?? ''}</textarea></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save changes</button></div>
      </form>
      <div class="form-actions secondary-actions"><form method="POST" action="?/toggleSource" class="inline-form" onsubmit={(event) => { const button = (event.currentTarget as HTMLFormElement).querySelector('button'); if (button) button.disabled = true; }}><input type="hidden" name="id" value={source.id} /><input type="hidden" name="enabled" value={source.enabled ? 'false' : 'true'} /><button class="btn btn-secondary" type="submit">{source.enabled ? 'Disable' : 'Enable'}</button></form><form method="POST" action="?/deleteSource" class="inline-form" onsubmit={() => confirm(`Delete ${source.name}? Assigned category records must be removed first.`)}><input type="hidden" name="id" value={source.id} /><button class="btn btn-danger" type="submit"><Trash2 size={14} /> Delete</button></form><button class="btn btn-secondary" type="button" onclick={() => openTestPanel(source.id)}><FlaskConical size={14} /> Test</button></div>

      {#if testSourceId === source.id}
        <div class="test-panel" role="region" aria-label={`Test source ${source.name}`}>
          <div class="test-panel-header"><strong>Resolution test</strong><button class="btn btn-secondary test-close" type="button" onclick={closeTestPanel} aria-label="Close test panel"><X size={14} /></button></div>
          <p class="test-hint">Tests ONLY this source. Does NOT mutate health, defaults, or public config. <code>skipHealthMutation=true</code>.</p>
          <form class="test-form" onsubmit={runTest}>
            <div class="form-grid two"><label>Content ID<input bind:value={testContentId} required placeholder="e.g. tt1375666 or 550" /></label><label>Media type<select bind:value={testMediaType}><option value="movie">Movie</option><option value="series">Series</option><option value="anime">Anime</option></select></label></div>
            {#if testMediaType !== 'movie'}<div class="form-grid two"><label>Season<input bind:value={testSeason} type="number" min="1" step="1" placeholder="1" /></label><label>Episode<input bind:value={testEpisode} type="number" min="1" step="1" placeholder="1" /></label></div>{/if}
            <div class="form-actions"><button class="btn btn-primary" type="submit" disabled={testLoading}>{#if testLoading}<Loader2 size={14} class="spin" /> Testing…{:else}<FlaskConical size={14} /> Run test{/if}</button></div>
          </form>
          {#if testResult}
            <div class="test-result" class:ok={testResult.ok} class:fail={!testResult.ok} role="status">
              <div class="test-result-header">{#if testResult.ok}<Check size={15} /> <strong>Resolution succeeded</strong>{:else}<X size={15} /> <strong>Resolution failed</strong>{/if}{#if testResult.durationMs !== undefined}<span class="test-duration">{testResult.durationMs}ms</span>{/if}</div>
              {#if testResult.result}<div class="test-detail"><span>Type:</span> <code>{testResult.result.type}</code></div>{#if testResult.result.url}<div class="test-detail"><span>URL:</span> <code class="test-url">{testResult.result.url}</code></div>{/if}{/if}
              {#if testResult.error}<div class="test-detail"><span>Error:</span> <code>{testResult.error.code}</code> — {testResult.error.message}</div>{/if}
              {#if testResult.attempts && testResult.attempts.length}<details class="test-attempts"><summary>Attempts ({testResult.attempts.length})</summary><ul>{#each testResult.attempts as attempt}<li><code>{attempt.sourceId.slice(0, 8)}…</code> — {attempt.result}{#if attempt.errorCode} (err: {attempt.errorCode}){/if}</li>{/each}</ul></details>{/if}
              {#if testResult.rankingDiagnostics?.excluded.length}<details class="test-attempts"><summary>Excluded ({testResult.rankingDiagnostics.excluded.length})</summary><ul>{#each testResult.rankingDiagnostics.excluded as ex}<li><code>{ex.sourceId.slice(0, 8)}…</code> — {ex.reason}</li>{/each}</ul></details>{/if}
            </div>
          {/if}
        </div>
      {/if}
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

  /* Phase 7: source test panel */
  .test-panel { margin: 0 19px 16px; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.02); }
  .test-panel-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--ink); font-size: .72rem; }
  .test-close { padding: 5px 8px; }
  .test-hint { margin: 6px 0 11px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; line-height: 1.5; }
  .test-hint code { color: var(--accent); background: var(--accent-soft); padding: 1px 4px; border-radius: 3px; }
  .test-form { display: grid; gap: 10px; }
  .test-result { margin-top: 12px; padding: 11px 13px; border-radius: 9px; font-size: .64rem; }
  .test-result.ok { color: var(--success); border: 1px solid rgba(126,220,180,.25); background: rgba(126,220,180,.06); }
  .test-result.fail { color: #ff8a8a; border: 1px solid rgba(228,133,105,.25); background: rgba(228,133,105,.07); }
  .test-result-header { display: flex; align-items: center; gap: 7px; }
  .test-duration { margin-left: auto; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  .test-detail { margin-top: 6px; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .56rem; }
  .test-detail span { color: var(--muted-deep); }
  .test-detail code, .test-url { color: var(--ink); word-break: break-all; }
  .test-attempts { margin-top: 8px; }
  .test-attempts summary { cursor: pointer; color: var(--muted); font-size: .58rem; padding: 4px 0; }
  .test-attempts ul { margin: 4px 0 0; padding-left: 16px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .54rem; }
  .test-attempts li { margin-top: 2px; }
  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
