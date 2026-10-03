<script lang="ts">
  /**
   * Admin 2.0 — CS-1 — CloudStream Extension Manager (Extension tab content).
   *
   * Isolated component hosting the CloudStream repository + extension
   * catalog inside System → Integrations → [ Extension ] (AC-001). Uses the
   * existing Admin 2.0 design tokens and the parent page's form actions
   * (`?/syncCloudStreamRepository`, `?/setCloudStreamRepositoryEnabled`,
   * `?/deleteCloudStreamRepository`, `?/setCloudStreamExtensionEnabled`)
   * so no new API surface is introduced.
   *
   * SECURITY/SCOPE: this is catalog METADATA management only. Extension
   * discovery never implies runtime compatibility — the compatibility badge
   * reflects the code-owned Mavero adapter registry (empty in CS-1), so
   * every freshly discovered extension shows "Adapter required" until CS-2
   * ports adapters. No raw plugin execution controls exist here.
   */
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import { RefreshCw, Trash2, Power, Package, Layers, AlertTriangle, Box, Hammer, FlaskConical } from 'lucide-svelte';
  import type {
    CloudStreamAdapterStatus,
    CloudStreamExtensionView,
    CloudStreamRepositoryView,
    ProviderTestResultView,
  } from '$lib/shared/cloudstream-types';

  let {
    repositories = [] as CloudStreamRepositoryView[],
    extensions = [] as CloudStreamExtensionView[],
    loadError = null as string | null,
    providerTest = null as ProviderTestResultView | null,
  }: {
    repositories?: CloudStreamRepositoryView[];
    extensions?: CloudStreamExtensionView[];
    loadError?: string | null;
    providerTest?: ProviderTestResultView | null;
  } = $props();

  // ---------------------------------------------------------------------------
  // Display helpers
  // ---------------------------------------------------------------------------

  /** tvTypes are CloudStream enum NAMES (AC-002) — displayed verbatim with a
   * soft prettifier for the compound names (e.g. AsianDrama → Asian drama).
   * Nuvio rows carry the manifest's raw supportedTypes (lowercase) — also
   * displayed verbatim. */
  function tvTypeLabel(name: string): string {
    if (name === 'TvSeries') return 'Series';
    if (name === 'AsianDrama') return 'Asian drama';
    return name;
  }

  /** Phase 2: integration type chip label (unified Extension catalog). */
  function integrationTypeLabel(type: 'cloudstream' | 'nuvio'): string {
    return type === 'nuvio' ? 'Nuvio' : 'CloudStream';
  }

  /** Phase 2: derived operational adapter state label (unified registry). */
  function adapterStateLabel(state: string): string {
    switch (state) {
      case 'active': return 'Active';
      case 'disabled': return 'Disabled';
      case 'native': return 'Native adapter';
      case 'generated': return 'Generated adapter';
      case 'runtime_required': return 'Runtime required';
      case 'failed': return 'Adapter failed';
      case 'building': return 'Building';
      case 'testing': return 'Testing';
      default: return 'Adapter required';
    }
  }

  function adapterStateTone(state: string): 'good' | 'warn' | 'neutral' | 'bad' {
    switch (state) {
      case 'active': return 'good';
      case 'native':
      case 'generated': return 'good';
      case 'runtime_required': return 'neutral';
      case 'failed': return 'bad';
      default: return 'warn';
    }
  }

  const ADAPTER_STATUS_LABELS: Record<CloudStreamAdapterStatus, { label: string; tone: 'good' | 'warn' | 'neutral' | 'bad' }> = {
    compatible: { label: 'Compatible', tone: 'good' },
    adapter_required: { label: 'Adapter required', tone: 'warn' },
    unsupported: { label: 'Unsupported', tone: 'neutral' },
    broken: { label: 'Broken', tone: 'bad' },
  };

  const REPOSITORY_STATUS_TONES: Record<string, 'good' | 'warn' | 'neutral' | 'bad'> = {
    active: 'good',
    error: 'bad',
    invalid: 'bad',
    disabled: 'neutral',
  };

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try {
      const date = new Date(iso);
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return '—';
    }
  }

  /** Extensions grouped per repository, keyed by repository id. */
  const extensionsByRepository = $derived.by(() => {
    const groups = new Map<string, CloudStreamExtensionView[]>();
    for (const extension of extensions) {
      const list = groups.get(extension.repositoryId) ?? [];
      list.push(extension);
      groups.set(extension.repositoryId, list);
    }
    return groups;
  });

  /** The count of extensions an admin has explicitly enabled. */
  const enabledExtensionCount = $derived(extensions.filter((extension) => extension.enabled).length);

  /** Phase 3: whether a row offers the Create Adapter action (plan §13). */
  function canCreateAdapter(extension: CloudStreamExtensionView): boolean {
    const state = extension.adapterState;
    return state === 'adapter_required' || state === 'failed';
  }

  /** Phase 3: whether a row has an executable adapter to Test (plan §9/§15). */
  function canTestProvider(extension: CloudStreamExtensionView): boolean {
    const state = extension.adapterState;
    return state === 'native' || state === 'generated' || state === 'active' || state === 'disabled';
  }

  /** Phase 3: the extension the last test result belongs to (if visible). */
  const testedExtension = $derived(
    providerTest !== null
      ? extensions.find((extension) =>
          extension.internalName.toLowerCase() === providerTest.adapterId.toLowerCase()
          // Generated adapters carry their canonical key as the resolver id.
          || `${extension.integrationType}:${extension.internalName.toLowerCase()}` === providerTest.adapterId.toLowerCase(),
        ) ?? null
      : null,
  );
</script>

{#if loadError}
  <div class="cs-error-banner" role="alert">
    <AlertTriangle size={16} />
    <span>{loadError}</span>
  </div>
{/if}

{#if repositories.length === 0}
  <div class="cs-empty">
    <Box size={32} />
    <h3>No extension repositories</h3>
    <p>Add a CloudStream repository URL (a CS.json index) or a Nuvio provider manifest URL to discover extensions.</p>
  </div>
{:else}
  <!-- Repositories -->
  <section class="cs-section" aria-label="CloudStream repositories">
    <h4 class="cs-section-title"><Layers size={14} /> Repositories ({repositories.length})</h4>
    <div class="cs-repo-list">
      {#each repositories as repository (repository.id)}
        <div class="cs-repo-card" data-enabled={repository.enabled}>
          <div class="cs-repo-main">
            <div class="cs-repo-name">{repository.name}</div>
            <div class="cs-repo-meta">
              <span class="cs-ext-type">{integrationTypeLabel(repository.integrationType)}</span>
              <span class="mono">{hostOf(repository.url)}</span>
              <span>·</span>
              <span>{repository.extensionCount} extensions</span>
              {#if repository.description}<span>·</span><span class="cs-repo-desc">{repository.description}</span>{/if}
            </div>
            <div class="cs-repo-meta">
              <span>Last sync: {formatDate(repository.lastSyncedAt)}</span>
              <span>·</span>
              <span>Checked: {formatDate(repository.lastCheckedAt)}</span>
            </div>
            {#if repository.lastError}
              <div class="cs-repo-error" role="alert"><AlertTriangle size={12} /> {repository.lastError}</div>
            {/if}
          </div>
          <div class="cs-repo-actions">
            <AdminStatusBadge label={repository.enabled ? 'Enabled' : 'Disabled'} tone={repository.enabled ? 'good' : 'neutral'} />
            <AdminStatusBadge label={repository.status} tone={REPOSITORY_STATUS_TONES[repository.status] ?? 'neutral'} />
            <form method="POST" action="?/setCloudStreamRepositoryEnabled" style="display:inline">
              <input type="hidden" name="id" value={repository.id} />
              <input type="hidden" name="enabled" value={String(!repository.enabled)} />
              <button type="submit" class="a2-icon-btn" title={repository.enabled ? 'Disable repository' : 'Enable repository'}><Power size={14} /></button>
            </form>
            <form method="POST" action="?/syncCloudStreamRepository" style="display:inline">
              <input type="hidden" name="id" value={repository.id} />
              <button type="submit" class="a2-icon-btn" title="Sync repository (re-fetch the repository document and reconcile extensions)"><RefreshCw size={14} /></button>
            </form>
            <form method="POST" action="?/deleteCloudStreamRepository" style="display:inline" onsubmit={(e) => { if (!confirm('Delete this repository and its discovered extensions?')) e.preventDefault(); }}>
              <input type="hidden" name="id" value={repository.id} />
              <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete repository"><Trash2 size={14} /></button>
            </form>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <!-- Extensions -->
  <section class="cs-section" aria-label="Discovered CloudStream extensions">
    <h4 class="cs-section-title">
      <Package size={14} /> Extensions ({extensions.length}{enabledExtensionCount > 0 ? `, ${enabledExtensionCount} enabled` : ''})
    </h4>
    <p class="cs-compat-note">
      Discovered extensions are catalog metadata only. Runtime compatibility requires a Mavero adapter
      (Add-on = Stremio · Extension = CloudStream or Nuvio).
    </p>

    <!-- Phase 3 — Test Provider result panel (plan §9: normalized results) -->
    {#if providerTest !== null}
      <div class="cs-test-panel" data-passed={providerTest.passed}>
        <div class="cs-test-header">
          <FlaskConical size={14} />
          <span class="cs-test-title">
            Test results — {testedExtension?.name ?? testedExtension?.internalName ?? providerTest.adapterId}
            ({providerTest.adapterKind === 'generated' ? `generated adapter v${providerTest.adapterVersion}` : `native adapter v${providerTest.adapterVersion}`})
          </span>
          <AdminStatusBadge label={providerTest.passed ? 'Passed' : 'Failed'} tone={providerTest.passed ? 'good' : 'bad'} />
        </div>
        {#each providerTest.cases as testCase (testCase.kind)}
          <div class="cs-test-case">
            <span>{testCase.kind === 'movie' ? 'Movie' : 'Episode'}</span>
            <span>{testCase.linksFound} link{testCase.linksFound === 1 ? '' : 's'}</span>
            <span>· {Math.round(testCase.durationMs)} ms</span>
            {#if testCase.note}<span class="cs-test-note">· {testCase.note}</span>{/if}
          </div>
        {/each}
        {#if providerTest.links.length > 0}
          <div class="cs-test-links">
            {#each providerTest.links.slice(0, 8) as link (link.url)}
              <div class="cs-test-link">
                <span class="cs-test-link-name">{link.sourceName}</span>
                {#if link.quality}<span class="cs-ext-type">{link.quality}</span>{/if}
                <span class="mono">{link.host ?? link.url.slice(0, 60)}</span>
              </div>
            {/each}
            {#if providerTest.links.length > 8}<div class="cs-test-case">+ {providerTest.links.length - 8} more…</div>{/if}
          </div>
        {/if}
      </div>
    {/if}
    {#each repositories as repository (repository.id)}
      {@const repoExtensions = extensionsByRepository.get(repository.id) ?? []}
      {#if repoExtensions.length > 0}
        <div class="cs-ext-group">
          <div class="cs-ext-group-header">{repository.name}</div>
          <div class="cs-ext-list">
            {#each repoExtensions as extension (extension.id)}
              <div class="cs-ext-row" data-enabled={extension.enabled}>
                <div class="cs-ext-main">
                  <div class="cs-ext-name">{extension.name ?? extension.internalName}</div>
                  <div class="cs-ext-meta">
                    <span class="cs-ext-type">{integrationTypeLabel(extension.integrationType)}</span>
                    <span class="mono">{extension.internalName}</span>
                    {#if extension.version}<span>·</span><span>v{extension.version}</span>{/if}
                    {#if !extension.version && extension.versionText}<span>·</span><span>v{extension.versionText}</span>{/if}
                    {#if extension.language}<span>·</span><span>{extension.language}</span>{/if}
                    {#if extension.tvTypes.length > 0}
                      <span>·</span>
                      {#each extension.tvTypes.slice(0, 4) as tvType}<span class="cs-ext-type">{tvTypeLabel(tvType)}</span>{/each}
                    {/if}
                    {#if extension.authors.length > 0}<span>·</span><span>{extension.authors[0]}</span>{/if}
                  </div>
                  {#if extension.lastError}
                    <div class="cs-repo-error" role="alert"><AlertTriangle size={12} /> {extension.lastError}</div>
                  {/if}
                  {#if extension.adapterState === 'runtime_required'}
                    <div class="cs-state-note">This provider cannot be converted into a permanent Mavero adapter and remains disabled.</div>
                  {/if}
                  {#if extension.adapterState === 'failed' && extension.lastBuildError}
                    <div class="cs-repo-error" role="alert"><AlertTriangle size={12} /> {extension.lastBuildError}</div>
                  {/if}
                  {#if (extension.adapterState === 'generated' || extension.adapterState === 'active') && extension.generatedAdapterVersion !== null}
                    <div class="cs-state-note">Generated adapter v{extension.generatedAdapterVersion}{extension.builderVersion ? ` · ${extension.builderVersion}` : ''}{extension.lastTestedAt ? ` · tested ${formatDate(extension.lastTestedAt)}` : ''}</div>
                  {/if}
                </div>
                <div class="cs-ext-actions">
                  <AdminStatusBadge
                    label={extension.enabled ? 'Enabled' : ADAPTER_STATUS_LABELS[extension.adapterStatus].label}
                    tone={extension.enabled ? 'good' : ADAPTER_STATUS_LABELS[extension.adapterStatus].tone}
                  />
                  {#if !extension.enabled}
                    <AdminStatusBadge
                      label={adapterStateLabel(extension.adapterState)}
                      tone={adapterStateTone(extension.adapterState)}
                    />
                  {/if}
                  {#if canCreateAdapter(extension)}
                    <form method="POST" action="?/createCloudStreamAdapter" style="display:inline"
                          onsubmit={(e) => { if (!confirm('Create a permanent adapter through the external Adapter Builder? This runs a build and live test (up to a few minutes).')) e.preventDefault(); }}>
                      <input type="hidden" name="id" value={extension.id} />
                      <button type="submit" class="a2-icon-btn cs-build-btn" title="Create Adapter (external Builder + live test)"><Hammer size={14} /></button>
                    </form>
                  {/if}
                  {#if canTestProvider(extension)}
                    <form method="POST" action="?/testCloudStreamProvider" style="display:inline">
                      <input type="hidden" name="id" value={extension.id} />
                      <button type="submit" class="a2-icon-btn" title="Test Provider (representative resolution)"><FlaskConical size={14} /></button>
                    </form>
                  {/if}
                  <form method="POST" action="?/setCloudStreamExtensionEnabled" style="display:inline">
                    <input type="hidden" name="id" value={extension.id} />
                    <input type="hidden" name="enabled" value={String(!extension.enabled)} />
                    <button type="submit" class="a2-icon-btn" title={extension.enabled ? 'Disable extension' : 'Enable extension'}><Power size={14} /></button>
                  </form>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/each}
  </section>
{/if}

<style>
  .cs-error-banner {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-3);
    background: var(--a2-red-soft);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-red);
    font-size: var(--a2-text-sm);
  }
  .cs-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-8);
    text-align: center;
    color: var(--a2-text-muted);
  }
  .cs-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .cs-empty p { margin: 0; font-size: var(--a2-text-sm); }
  .cs-section { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .cs-section-title {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    margin: var(--a2-space-2) 0 0;
    font-size: var(--a2-text-xs);
    font-weight: 700;
    color: var(--a2-text-bright);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .cs-compat-note {
    margin: 0;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
    line-height: 1.5;
  }
  .cs-repo-list, .cs-ext-list { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .cs-repo-card, .cs-ext-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-3) var(--a2-space-4);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .cs-repo-card[data-enabled="false"], .cs-ext-row[data-enabled="false"] { opacity: 0.6; }
  .cs-repo-main, .cs-ext-main { min-width: 0; display: flex; flex-direction: column; gap: var(--a2-space-1); }
  .cs-repo-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .cs-ext-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .cs-repo-meta, .cs-ext-meta {
    display: flex;
    gap: var(--a2-space-1);
    flex-wrap: wrap;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
  }
  .cs-repo-desc { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cs-ext-type {
    padding: 1px 4px;
    background: var(--a2-surface-4);
    border-radius: var(--a2-radius-xs);
    text-transform: uppercase;
  }
  .cs-repo-error {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--a2-text-2xs);
    color: var(--a2-red);
  }
  .cs-repo-actions, .cs-ext-actions { display: flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
  .a2-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    cursor: pointer;
  }
  .a2-icon-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-icon-btn-danger:hover { color: var(--a2-red); border-color: var(--a2-red-border); }
  .cs-ext-group { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .cs-ext-group-header {
    font-size: var(--a2-text-xs);
    font-weight: 700;
    color: var(--a2-text);
    padding-top: var(--a2-space-2);
  }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }
  .cs-state-note {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
    line-height: 1.5;
  }
  .cs-build-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .cs-test-panel {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
    padding: var(--a2-space-3) var(--a2-space-4);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .cs-test-panel[data-passed="false"] { border-color: var(--a2-red-border); }
  .cs-test-header { display: flex; align-items: center; gap: var(--a2-space-2); color: var(--a2-text-bright); font-size: var(--a2-text-sm); }
  .cs-test-title { flex: 1; min-width: 0; }
  .cs-test-case {
    display: flex;
    gap: var(--a2-space-2);
    flex-wrap: wrap;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
  }
  .cs-test-links { display: flex; flex-direction: column; gap: var(--a2-space-1); }
  .cs-test-link {
    display: flex;
    gap: var(--a2-space-2);
    align-items: center;
    flex-wrap: wrap;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text);
  }
  .cs-test-link-name { font-weight: 600; }
  .cs-test-note { color: var(--a2-red); }
  @media (max-width: 768px) {
    .cs-repo-card, .cs-ext-row { flex-direction: column; align-items: stretch; }
    .cs-repo-actions, .cs-ext-actions { justify-content: flex-end; }
  }
</style>
