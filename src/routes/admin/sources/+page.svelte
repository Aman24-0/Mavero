<script lang="ts">
  import { Check, ChevronRight, SlidersHorizontal, Trash2, FlaskConical, Loader2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import SourceIcon from '$lib/components/source/SourceIcon.svelte';
  import { integrationTypes, identifierModes, providerStatuses, sourceVisibilities } from '$lib/shared/streaming';
  // Task 13: presentation metadata — constrained badge enum + safe icon keys.
  import { sourceBadgeLabelFor, sourceIconKeys, sourceIconLabels, DEFAULT_SOURCE_ICON } from '$lib/shared/source-presentation';
  // Phase 8: sandbox is provider-level only. Source forms no longer have
  // any sandbox-related imports or UI controls.
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const statusLabels = { active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable' };
  const typeLabels = { template: 'Template', api: 'API', direct: 'Direct', embed: 'Embed', custom: 'Custom' };
  const visibilityLabels = { public: 'Public', internal: 'Internal', hidden: 'Hidden' };
  const identifierLabels = { tmdb_id: 'TMDB ID', anilist_id: 'AniList ID', imdb_id: 'IMDb ID', slug: 'Slug', custom: 'Custom' };
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

  // Create/Edit modal state — same pattern as providers.
  let sheetOpen = $state(false);
  let editingSource = $state<PageData['sources'][number] | null>(null);

  function openCreate(event?: Event) {
    editingSource = null;
    // Task 13: new sources default to the default source icon; no badge.
    iconChoice = DEFAULT_SOURCE_ICON;
    sheetOpen = true;
  }
  function openEdit(source: PageData['sources'][number], event?: Event) {
    editingSource = source;
    iconChoice = source.icon ?? '';
    sheetOpen = true;
  }
  function closeSheet() {
    sheetOpen = false;
    editingSource = null;
  }

  // Task 13: icon picker state — a controlled select bound to the safe icon
  // key allowlist, with a live preview next to it.
  let iconChoice = $state<string>('');

  // Phase 7: source test state — per-source modal.
  let testSourceId = $state('');
  let testContentId = $state('');
  let testMediaType = $state<'movie' | 'series' | 'anime'>('movie');
  let testSeason = $state('');
  let testEpisode = $state('');
  let testLoading = $state(false);
  let testResult = $state<{ ok: boolean; result?: { type: string; url: string | null }; attempts?: { sourceId: string; result: string; errorCode?: string }[]; rankingDiagnostics?: { eligible: { sourceId: string }[]; excluded: { sourceId: string; reason: string }[] }; durationMs?: number; error?: { code: string; message: string } } | null>(null);

  let testSheetOpen = $state(false);
  let testingSource = $state<PageData['sources'][number] | null>(null);

  function openTestPanel(source: PageData['sources'][number]) {
    testingSource = source;
    testSourceId = source.id;
    testResult = null;
    testSheetOpen = true;
  }
  function closeTestPanel() {
    testSheetOpen = false;
    testingSource = null;
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
    count={`${data.sources.length} records`}
  >
    {#snippet actions()}
      <AdminAddButton label="Add source" onclick={openCreate} />
    {/snippet}
  </AdminPageHeader>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  {#if data.sources.length === 0}
    <AdminEmptyState
      icon={SlidersHorizontal}
      title="No sources yet"
      message="Create a source after defining at least one provider."
    />
  {:else}
    <div class="registry-list">
      {#each data.sources as source (source.id)}
        <article class="record">
          <div class="record-head" onclick={(e) => openEdit(source, e)} role="button" tabindex="0"
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(source, e); } }}
                 aria-label={`Edit ${source.name}`}>
            <span class="source-icon" aria-hidden="true"><SourceIcon icon={source.icon} size={16} /></span>
            <div class="record-copy">
              <strong class="record-name">{source.name}</strong>
              <span class="record-sub">{source.slug} · {providerName(source.provider_id)}</span>
            </div>
            <span class="record-chevron"><ChevronRight size={18} /></span>
          </div>
          <div class="record-badges">
            <AdminStatusBadge
              label={source.enabled ? 'Enabled' : 'Disabled'}
              tone={source.enabled ? 'good' : 'neutral'}
            />
            <AdminStatusBadge
              label={visibilityLabels[source.visibility as keyof typeof visibilityLabels]}
              tone={visibilityToneFor(source.visibility)}
            />
            {#if source.badge}
              <AdminStatusBadge
                label={sourceBadgeLabelFor(source.badge) ?? 'Tag'}
                tone={source.badge === 'ads' ? 'warn' : 'good'}
              />
            {/if}
            <span class="record-actions">
              <form method="POST" action="?/toggleSource" class="inline-form" onsubmit={(event) => { const button = (event.currentTarget as HTMLFormElement).querySelector('button'); if (button) button.disabled = true; }}>
                <input type="hidden" name="id" value={source.id} />
                <input type="hidden" name="enabled" value={source.enabled ? 'false' : 'true'} />
                <button class="mini-btn" type="submit">{source.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <button class="mini-btn" type="button" onclick={() => openTestPanel(source)}><FlaskConical size={13} /> Test</button>
              <form method="POST" action="?/deleteSource" class="inline-form" onsubmit={() => confirm(`Delete ${source.name}? All category assignments will be removed.`)}>
                <input type="hidden" name="id" value={source.id} />
                <button class="mini-btn mini-btn-danger" type="submit" aria-label={`Delete ${source.name}`}><Trash2 size={13} /></button>
              </form>
            </span>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</AdminShell>

<!-- ============================================================
     CREATE / EDIT MODAL — same form fields as the previous inline
     accordion, now inside an AdminSheet. Existing server actions
     (?/createSource / ?/updateSource) preserved unchanged.
     ============================================================ -->
<AdminSheet
  open={sheetOpen}
  title={editingSource ? `Edit ${editingSource.name}` : 'Add source'}
  onClose={closeSheet}
  closeOnBackdrop={false}
  size="wide"
>
  <form method="POST" action={editingSource ? '?/updateSource' : '?/createSource'} class="registry-form">
    {#if editingSource}
      <input type="hidden" name="id" value={editingSource.id} />
    {/if}
    <div class="form-grid two"><label>Name<input name="name" required maxlength="120" placeholder="Example source" value={editingSource?.name ?? ''} /></label><label>Slug<input name="slug" required maxlength="120" placeholder="example-source" value={editingSource?.slug ?? ''} /></label></div>
    <!-- Task 13: presentation metadata (icon + user tag) next to Name/Slug. -->
    <div class="form-grid two">
      <label>Source icon
        <div class="icon-field">
          <select name="icon" bind:value={iconChoice}>
            <option value="">Default</option>
            {#each sourceIconKeys as iconKey}
              <option value={iconKey}>{sourceIconLabels[iconKey]}</option>
            {/each}
          </select>
          <span class="icon-preview" aria-hidden="true"><SourceIcon icon={iconChoice} size={16} /></span>
        </div>
      </label>
      <label>User tag
        <select name="badge">
          <option value="" selected={!editingSource?.badge}>None</option>
          <option value="ads" selected={editingSource?.badge === 'ads'}>Ads</option>
          <option value="ad-free" selected={editingSource?.badge === 'ad-free'}>Ad-free</option>
        </select>
      </label>
    </div>
    <div class="form-grid three"><label>Provider<select name="provider_id" required><option value="" disabled selected={!editingSource}>Select provider</option>{#each data.providers as provider}<option value={provider.id} selected={editingSource?.provider_id === provider.id}>{provider.name}</option>{/each}</select></label><label>Identifier mode<select name="identifier_mode">{#each identifierModes as mode}<option value={mode} selected={editingSource?.identifier_mode === mode}>{identifierLabels[mode]}</option>{/each}</select></label><label>Ordering<input name="ordering" type="number" min="0" step="1" value={editingSource?.ordering ?? 0} /></label></div>
    <div class="form-grid three"><label>Integration type<select name="integration_type"><option value="" selected={!editingSource?.integration_type}>Provider default</option>{#each integrationTypes as type}<option value={type} selected={editingSource?.integration_type === type}>{typeLabels[type]}</option>{/each}</select></label><label>Status<select name="status">{#each providerStatuses as status}<option value={status} selected={editingSource?.status === status}>{statusLabels[status]}</option>{/each}</select></label><label>Visibility<select name="visibility">{#each sourceVisibilities as visibility}<option value={visibility} selected={editingSource?.visibility === visibility}>{visibilityLabels[visibility]}</option>{/each}</select></label></div>
    <div class="form-grid two"><label>Language<input name="language" maxlength="60" placeholder="Original" value={editingSource?.language ?? ''} /></label><label>Audio languages<input name="audio_languages" placeholder="English, Hindi" value={editingSource?.audio_languages?.join(', ') ?? ''} /></label></div>
    <div class="form-grid two"><label class="check"><input type="checkbox" name="enabled" checked={editingSource?.enabled ?? false} /> Enabled</label><label class="check"><input type="checkbox" name="subtitle_capability" checked={editingSource?.subtitle_capability ?? false} /> Subtitle capability</label></div>
    <label>Quality capability<input name="quality_capability" placeholder="HD, Full HD, 4K" value={editingSource?.quality_capability?.join(', ') ?? ''} /></label>
    <div class="form-grid three"><label>Movie template<textarea name="movie_template" rows="2" placeholder="Configuration only">{editingSource?.movie_template ?? ''}</textarea></label><label>Series template<textarea name="series_template" rows="2" placeholder="Configuration only">{editingSource?.series_template ?? ''}</textarea></label><label>Anime template<textarea name="anime_template" rows="2" placeholder="Configuration only">{editingSource?.anime_template ?? ''}</textarea></label></div>
    <label>Capabilities JSON<textarea name="capabilities" rows="3" placeholder="JSON object, e.g. movies=true">&#123;&quot;movies&quot;:true&#125;</textarea>{#if editingSource}<small class="security-note">Current: {JSON.stringify(editingSource.capabilities ?? {}, null, 2)}</small>{/if}</label>
    <label>Description<textarea name="description" maxlength="500" rows="2">{editingSource?.description ?? ''}</textarea></label>
    <label>Admin notes<textarea name="notes" maxlength="2000" rows="2">{editingSource?.notes ?? ''}</textarea></label>
    <div class="sheet-actions">
      <button class="btn btn-primary" type="submit">{editingSource ? 'Save changes' : 'Create source'}</button>
      <button class="btn btn-secondary" type="button" onclick={closeSheet}>Cancel</button>
    </div>
  </form>
</AdminSheet>

<!-- ============================================================
     SOURCE TEST MODAL — health-isolated test (skipHealthMutation=true
     contract intact). Test state preserved from the previous inline
     panel; only the container changed.
     ============================================================ -->
<AdminSheet
  open={testSheetOpen}
  title={testingSource ? `Test ${testingSource.name}` : 'Test source'}
  description="Tests ONLY this source. Does NOT mutate health, defaults, or public config. skipHealthMutation=true."
  onClose={closeTestPanel}
>
  <form class="test-form" onsubmit={runTest}>
    <div class="form-grid two"><label>Content ID<input bind:value={testContentId} required placeholder="e.g. tt1375666 or 550" /></label><label>Media type<select bind:value={testMediaType}><option value="movie">Movie</option><option value="series">Series</option><option value="anime">Anime</option></select></label></div>
    {#if testMediaType !== 'movie'}<div class="form-grid two"><label>Season<input bind:value={testSeason} type="number" min="1" step="1" placeholder="1" /></label><label>Episode<input bind:value={testEpisode} type="number" min="1" step="1" placeholder="1" /></label></div>{/if}
    <div class="sheet-actions">
      <button class="btn btn-primary" type="submit" disabled={testLoading}>{#if testLoading}<Loader2 size={14} class="spin" /> Testing…{:else}<FlaskConical size={14} /> Run test{/if}</button>
      <button class="btn btn-secondary" type="button" onclick={closeTestPanel}>Close</button>
    </div>
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
</AdminSheet>

<style>
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; }
  .notice { color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }
  .error { color: var(--color-danger); border: 1px solid rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .07); }

  /* Registry list — same two-row card pattern as providers. */
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
  .source-icon {
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
  /* Task 13: icon picker + live preview */
  .icon-field { display: flex; align-items: center; gap: 8px; }
  .icon-field select { flex: 1; min-width: 0; }
  .icon-preview { display: grid; place-items: center; flex: 0 0 36px; width: 36px; height: 36px; border-radius: var(--radius-sm); color: var(--color-primary); background: var(--color-primary-soft); border: 1px solid var(--color-primary-border); }
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

  /* Forms (inside the modals) */
  .registry-form, .test-form { display: grid; gap: 13px; }
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

  /* Test result panel (inside the test modal) */
  .test-result { margin-top: 14px; padding: 12px 14px; border-radius: var(--radius-sm); font-size: .68rem; border: 1px solid transparent; }
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

  @media (max-width: 640px) {
    .form-grid.two, .form-grid.three { grid-template-columns: 1fr; }
    .record-badges { gap: 4px; }
  }
</style>
