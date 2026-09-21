<script lang="ts">
  import { Check, ChevronDown, Plus, SlidersHorizontal, Trash2, FlaskConical, Loader2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminSection from '$lib/components/admin/AdminSection.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import { integrationTypes, identifierModes, providerStatuses, sourceVisibilities } from '$lib/shared/streaming';
  import { sandboxPolicyChoices, sandboxPolicyDescription, sandboxPolicyFromCapabilities, configuredSandboxPolicy, type SandboxPolicyChoice } from '$lib/shared/sandbox-policy';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const statusLabels = { active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable' };
  const typeLabels = { template: 'Template', api: 'API', direct: 'Direct', embed: 'Embed', custom: 'Custom' };
  const visibilityLabels = { public: 'Public', internal: 'Internal', hidden: 'Hidden' };
  const identifierLabels = { tmdb_id: 'TMDB ID', anilist_id: 'AniList ID', imdb_id: 'IMDb ID', slug: 'Slug', custom: 'Custom' };
  const sandboxPolicyLabels: Record<string, string> = { required: 'Required', optional: 'Optional', unrestricted: 'Unrestricted' };
  // Phase 10 (GOAL 20): CONFIGURED vs EFFECTIVE are different values. The
  // select shows the CONFIGURED choice ('provider_default' when the source
  // stores no policy); the effective value — what runtime actually applies —
  // is displayed separately and never written back into the form state.
  const sourceConfiguredSandboxChoice = (source: PageData['sources'][number]): SandboxPolicyChoice => configuredSandboxPolicy(source.capabilities) ?? 'provider_default';
  const sourceEffectiveSandboxPolicy = (source: PageData['sources'][number]) => sandboxPolicyFromCapabilities(data.providers.find((provider) => provider.id === source.provider_id)?.capabilities, source.capabilities);
  const providerName = (id: string) => data.providers.find((provider) => provider.id === id)?.name ?? 'Unknown provider';

  function statusToneFor(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
    if (status === 'active' || status === 'experimental') return 'good';
    if (status === 'maintenance') return 'warn';
    return 'neutral';
  }
  function visibilityToneFor(visibility: string): 'good' | 'warn' | 'neutral' {
    if (visibility === 'public') return 'good';
    if (visibility === 'internal') return 'warn';
    return 'neutral';
  }

  // Phase 7: source test state — per-source panel + result.
  let testSourceId = $state('');
  let testContentId = $state('');
  let testMediaType = $state<'movie' | 'series' | 'anime'>('movie');
  let testSeason = $state('');
  let testEpisode = $state('');
  let testLoading = $state(false);
  let testResult = $state<{ ok: boolean; result?: { type: string; url: string | null }; attempts?: { sourceId: string; result: string; errorCode?: string }[]; rankingDiagnostics?: { eligible: { sourceId: string }[]; excluded: { sourceId: string; reason: string }[] }; durationMs?: number; error?: { code: string; message: string } } | null>(null);

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
  <AdminPageHeader
    eyebrow="MAVERO / Source registry"
    title="Playback"
    accent="sources."
    description="Configure selectable source records and inert templates. No URL is resolved and no third-party playback is activated in Phase 7A. Source testing is health-isolated."
    count={`${data.sources.length} records`}
  />

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <AdminSection variant="info">
    {#snippet actions()}
      <span class="hint">Templates are inert configuration in Phase 7A.</span>
    {/snippet}
    <details class="form-panel" open={data.sources.length === 0}>
      <summary><span class="summary-label"><Plus size={15} /> Add source</span><ChevronDown size={16} /></summary>
      <form method="POST" action="?/createSource" class="registry-form">
        <div class="form-grid two"><label>Name<input name="name" required maxlength="120" placeholder="Example source" /></label><label>Slug<input name="slug" required maxlength="120" placeholder="example-source" /></label></div>
        <div class="form-grid three"><label>Provider<select name="provider_id" required><option value="" disabled selected>Select provider</option>{#each data.providers as provider}<option value={provider.id}>{provider.name}</option>{/each}</select></label><label>Identifier mode<select name="identifier_mode">{#each identifierModes as mode}<option value={mode}>{identifierLabels[mode]}</option>{/each}</select></label><label>Ordering<input name="ordering" type="number" min="0" step="1" value="0" /></label></div>
        <div class="form-grid three"><label>Integration type<select name="integration_type"><option value="">Provider default</option>{#each integrationTypes as type}<option value={type}>{typeLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status}>{statusLabels[status]}</option>{/each}</select></label><label>Visibility<select name="visibility">{#each sourceVisibilities as visibility}<option value={visibility}>{visibilityLabels[visibility]}</option>{/each}</select></label></div>
        <div class="form-grid two"><label>Language<input name="language" maxlength="60" placeholder="Original" /></label><label>Audio languages<input name="audio_languages" placeholder="English, Hindi" /></label></div>
        <div class="form-grid two"><label class="check"><input type="checkbox" name="enabled" /> Enabled for public config</label><label class="check"><input type="checkbox" name="subtitle_capability" /> Subtitle capability</label></div>
        <label>Quality capability<input name="quality_capability" placeholder="HD, Full HD, 4K" /></label>
        <label>Sandbox policy (applies to embed playback)<select name="sandbox_policy">{#each sandboxPolicyChoices as choice}<option value={choice} selected={choice === 'provider_default'}>{choice === 'provider_default' ? 'Provider default — inherit' : sandboxPolicyLabels[choice]}</option>{/each}</select><small class="security-note">Provider default inherits the provider's sandbox policy; the system default is required.</small></label>
        <div class="form-grid three"><label>Movie template<textarea name="movie_template" rows="2" placeholder="Configuration only"></textarea></label><label>Series template<textarea name="series_template" rows="2" placeholder="Configuration only"></textarea></label><label>Anime template<textarea name="anime_template" rows="2" placeholder="Configuration only"></textarea></label></div>
        <label>Capabilities JSON<textarea name="capabilities" rows="3" placeholder="JSON object, e.g. movies=true">&#123;&quot;movies&quot;:true&#125;</textarea></label>
        <label>Description<textarea name="description" maxlength="500" rows="2"></textarea></label><label>Admin notes<textarea name="notes" maxlength="2000" rows="2"></textarea></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create source</button></div>
      </form>
    </details>
  </AdminSection>

  {#if data.sources.length === 0}
    <AdminEmptyState
      icon={SlidersHorizontal}
      title="No sources yet"
      message="Create a source after defining at least one provider."
    />
  {:else}
    <div class="registry-list">
      {#each data.sources as source (source.id)}
        <details class="record">
          <summary>
            <div class="record-main">
              <span class="source-icon">{source.name.slice(0, 1).toUpperCase()}</span>
              <div class="record-copy">
                <strong>{source.name}</strong>
                <span class="record-sub">{source.slug} · {providerName(source.provider_id)}</span>
              </div>
            </div>
            <div class="record-meta">
              <AdminStatusBadge
                label={source.enabled ? 'Enabled' : 'Disabled'}
                tone={source.enabled ? 'good' : 'neutral'}
              />
              <AdminStatusBadge
                label={visibilityLabels[source.visibility as keyof typeof visibilityLabels]}
                tone={visibilityToneFor(source.visibility)}
              />
              <ChevronDown size={15} />
            </div>
          </summary>
          <form method="POST" action="?/updateSource" class="registry-form compact">
            <input type="hidden" name="id" value={source.id} />
            <div class="form-grid two"><label>Name<input name="name" required maxlength="120" value={source.name} /></label><label>Slug<input name="slug" required maxlength="120" value={source.slug} /></label></div>
            <div class="form-grid three"><label>Provider<select name="provider_id" required>{#each data.providers as provider}<option value={provider.id} selected={source.provider_id === provider.id}>{provider.name}</option>{/each}</select></label><label>Identifier mode<select name="identifier_mode">{#each identifierModes as mode}<option value={mode} selected={source.identifier_mode === mode}>{identifierLabels[mode]}</option>{/each}</select></label><label>Ordering<input name="ordering" type="number" min="0" step="1" value={source.ordering} /></label></div>
            <div class="form-grid three"><label>Integration type<select name="integration_type"><option value="" selected={!source.integration_type}>Provider default</option>{#each integrationTypes as type}<option value={type} selected={source.integration_type === type}>{typeLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status} selected={source.status === status}>{statusLabels[status]}</option>{/each}</select></label><label>Visibility<select name="visibility">{#each sourceVisibilities as visibility}<option value={visibility} selected={source.visibility === visibility}>{visibilityLabels[visibility]}</option>{/each}</select></label></div>
            <div class="form-grid two"><label>Language<input name="language" maxlength="60" value={source.language ?? ''} /></label><label>Audio languages<input name="audio_languages" value={source.audio_languages?.join(', ') ?? ''} /></label></div>
            <div class="form-grid two"><label class="check"><input type="checkbox" name="enabled" checked={source.enabled} /> Enabled for public config</label><label class="check"><input type="checkbox" name="subtitle_capability" checked={source.subtitle_capability} /> Subtitle capability</label></div>
            <label>Quality capability<input name="quality_capability" value={source.quality_capability?.join(', ') ?? ''} /></label>
            <!-- Phase 13 (sandbox admin UX): the control is exposed for EVERY source
                 (not just embed-classified ones) so a stored override is always
                 visible AND clearable — the confusing "provider says Unrestricted
                 but a source silently overrides it" state can no longer hide.
                 The runtime hierarchy itself is unchanged. -->
            <label>Sandbox policy (applies to embed playback)<select name="sandbox_policy">{#each sandboxPolicyChoices as choice}<option value={choice} selected={sourceConfiguredSandboxChoice(source) === choice}>{choice === 'provider_default' ? 'Provider default — inherit' : sandboxPolicyLabels[choice]}</option>{/each}</select><small class="security-note">Configured: {sourceConfiguredSandboxChoice(source) === 'provider_default' ? 'Provider default — inherit' : sandboxPolicyLabels[sourceConfiguredSandboxChoice(source)]} · Effective: {sourceEffectiveSandboxPolicy(source)}{sourceConfiguredSandboxChoice(source) !== 'provider_default' ? ' — Source override is active' : ''} · {sandboxPolicyDescription(sourceEffectiveSandboxPolicy(source))}</small></label>
            <div class="form-grid three"><label>Movie template<textarea name="movie_template" rows="2">{source.movie_template ?? ''}</textarea></label><label>Series template<textarea name="series_template" rows="2">{source.series_template ?? ''}</textarea></label><label>Anime template<textarea name="anime_template" rows="2">{source.anime_template ?? ''}</textarea></label></div>
            <label>Capabilities JSON<textarea name="capabilities" rows="3">{JSON.stringify(source.capabilities ?? {}, null, 2)}</textarea></label>
            <label>Description<textarea name="description" maxlength="500" rows="2">{source.description ?? ''}</textarea></label><label>Admin notes<textarea name="notes" maxlength="2000" rows="2">{source.notes ?? ''}</textarea></label>
            <div class="form-actions"><button class="btn btn-primary" type="submit">Save changes</button></div>
          </form>
          <div class="form-actions secondary-actions">
            <form method="POST" action="?/toggleSource" class="inline-form" onsubmit={(event) => { const button = (event.currentTarget as HTMLFormElement).querySelector('button'); if (button) button.disabled = true; }}>
              <input type="hidden" name="id" value={source.id} />
              <input type="hidden" name="enabled" value={source.enabled ? 'false' : 'true'} />
              <button class="btn btn-secondary" type="submit">{source.enabled ? 'Disable' : 'Enable'}</button>
            </form>
            <form method="POST" action="?/deleteSource" class="inline-form" onsubmit={() => confirm(`Delete ${source.name}? Assigned category records must be removed first.`)}>
              <input type="hidden" name="id" value={source.id} />
              <button class="btn btn-danger" type="submit"><Trash2 size={14} /> Delete</button>
            </form>
            <button class="btn btn-secondary" type="button" onclick={() => openTestPanel(source.id)}><FlaskConical size={14} /> Test</button>
          </div>

          {#if testSourceId === source.id}
            <div class="test-panel" role="region" aria-label={`Test source ${source.name}`}>
              <div class="test-panel-header">
                <strong>Resolution test</strong>
                <button class="btn btn-secondary test-close" type="button" onclick={closeTestPanel} aria-label="Close test panel"><X size={14} /></button>
              </div>
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
  .source-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--color-primary); background: var(--color-primary-soft); border: 1px solid var(--color-primary-border); font-size: .68rem; font-weight: 700; flex: 0 0 auto; }
  .record-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
  .record-copy { min-width: 0; }
  .record-copy strong { display: block; color: var(--color-text); font-size: .82rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-sub { display: block; margin-top: 3px; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-meta { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

  .security-note { color: var(--color-warning); font-size: .56rem; line-height: 1.5; text-transform: none; letter-spacing: 0; font-weight: 500; }

  /* Phase 7: source test panel */
  .test-panel { margin: 0 18px 16px; padding: 14px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: rgba(0, 217, 255, .025); }
  .test-panel-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--color-text); font-size: .76rem; font-weight: 700; }
  .test-close { padding: 0 10px; min-height: 32px; }
  .test-hint { margin: 8px 0 12px; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; line-height: 1.5; }
  .test-hint code { color: #050708; background: var(--color-primary); padding: 1px 5px; border-radius: 3px; font-weight: 700; }
  .test-form { display: grid; gap: 10px; }
  .test-result { margin-top: 12px; padding: 12px 14px; border-radius: var(--radius-sm); font-size: .68rem; border: 1px solid transparent; }
  .test-result.ok { color: var(--color-primary); border-color: var(--color-primary-border); background: rgba(0, 255, 156, .05); }
  .test-result.fail { color: var(--color-danger); border-color: rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .05); }
  .test-result-header { display: flex; align-items: center; gap: 7px; }
  .test-duration { margin-left: auto; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; }
  .test-detail { margin-top: 8px; color: var(--color-text-muted); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .58rem; }
  .test-detail span { color: var(--color-text-deep); }
  .test-detail code, .test-url { color: var(--color-text); word-break: break-all; }
  .test-attempts { margin-top: 10px; }
  .test-attempts summary { cursor: pointer; color: var(--color-text-muted); font-size: .6rem; padding: 4px 0; }
  .test-attempts ul { margin: 4px 0 0; padding-left: 16px; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; }
  .test-attempts li { margin-top: 2px; }
  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 700px) {
    .form-grid.two, .form-grid.three { grid-template-columns: 1fr; }
    .record-meta { gap: 4px; }
  }
</style>
