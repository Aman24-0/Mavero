<script lang="ts">
  /**
   * Admin 2.0 — Phase 4 — Integration Manager 2.0 (Extension tab content).
   *
   * Permanent Adapter Plan §11/§12/§13: the CloudStream/Nuvio Extension
   * manager redesigned for LARGE repositories (84+ extensions):
   *
   *   §11 — search (provider/repository/source name), status filters
   *         (All/Enabled/Disabled/Compatible/Adapter Required/Runtime
   *         Required/Failed), media filters (All/Movie/TV), deterministic
   *         sorting (name/status/enabled/last tested), per-repository stats
   *         headers, pagination with bounded rendering, sticky toolbar,
   *         repository-specific views (repository filter), and bulk
   *         operations (select / select-all-filtered / enable / disable /
   *         create adapters for selected where valid).
   *
   *   §12 — NO full page refresh / NO scroll jump: every toggle runs as an
   *         async fetch() against the Phase 4 JSON mutation endpoints and
   *         patches ONLY the affected rows in local state (pending state,
   *         duplicate-click guards, inline row errors, preserved
   *         search/filter/sort/page/scroll). The page's SvelteKit form
   *         actions remain as the no-JS fallback: each form still posts to
   *         `?/…` and the onsubmit handler only PREVENTS the default when
   *         JS is running. Server-side admin authorization is unchanged
   *         (requireAdmin gates every endpoint + action).
   *
   *   §13 — the closed provider-status vocabulary (ACTIVE / COMPATIBLE /
   *         ADAPTER REQUIRED / RUNTIME REQUIRED / ADAPTER FAILED + Reason +
   *         Retry), derived in the shared view-model so the UI and tests
   *         cannot drift.
   *
   * SECURITY/SCOPE: catalog METADATA management only. No plugin artifact is
   * ever fetched or executed here; `createAdapter` goes through the SAME
   * server-side orchestration as the form action (lifecycle guards, CAS,
   * artifact hash verification, atomic promotion); `testProvider` never
   * contacts the Builder. The presentation logic lives in
   * `$lib/shared/cloudstream-integration-manager-view.ts` (pure).
   */
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import { RefreshCw, Trash2, Power, Package, Layers, AlertTriangle, Box, Hammer, FlaskConical, Search, ArrowUpDown, Eye, X, StopCircle, Link2, Check, MoveVertical, Loader2 } from 'lucide-svelte';
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';
  import type {
    CloudStreamExtensionView,
    CloudStreamRepositoryView,
    ProviderTestResultView,
  } from '$lib/shared/cloudstream-types';
  import {
    projectIntegrationManager,
    providerStatusPresentation,
    summarizeRepositories,
    eligibleForBulkCreateAdapter,
    chunkBulkIds,
    INTEGRATION_STATUS_FILTERS,
    INTEGRATION_STATUS_FILTER_LABELS,
    INTEGRATION_MEDIA_FILTERS,
    INTEGRATION_MEDIA_FILTER_LABELS,
    INTEGRATION_SORT_KEYS,
    INTEGRATION_SORT_KEY_LABELS,
    type IntegrationStatusFilter,
    type IntegrationMediaFilter,
    type IntegrationSortKey,
    type IntegrationSortDir,
    type IntegrationManagerQuery,
    type RepositorySummary,
  } from '$lib/shared/cloudstream-integration-manager-view';

  let {
    repositories = [] as CloudStreamRepositoryView[],
    extensions = [] as CloudStreamExtensionView[],
    loadError = null as string | null,
    providerTest = null as ProviderTestResultView | null,
    globalPositions = {} as Record<string, number>,
  }: {
    repositories?: CloudStreamRepositoryView[];
    extensions?: CloudStreamExtensionView[];
    loadError?: string | null;
    providerTest?: ProviderTestResultView | null;
    /** FINAL TASK (PART G): canonical ordering key → current 1-based global position. */
    globalPositions?: Record<string, number>;
  } = $props();

  // ---------------------------------------------------------------------------
  // §12 targeted-update state model.
  //
  // The props ARE the page-load snapshot; post-mount mutations NEVER reload
  // the page — they record per-id PATCHES in reactive maps, and the row
  // lists are $derived by overlaying those patches onto the props. This is
  // the Svelte-5-idiomatic "props + local overrides" pattern: no prop
  // capture at init, no invalidation of unaffected rows, and the SSR render
  // still sees the pristine server data.
  // ---------------------------------------------------------------------------

  /** Local post-mutation patches keyed by extension id (fetch-path updates). */
  const rowPatches = new SvelteMap<string, CloudStreamExtensionView>();
  const repositoryPatches = new SvelteMap<string, CloudStreamRepositoryView>();
  /** §14 Copy Repo Link: repositories whose URL was just copied (2s feedback). */
  const copiedRepoIds = new SvelteSet<string>();
  let copyingRepoId = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // FINAL TASK (PART G) — global source position state.
  // ---------------------------------------------------------------------------
  /** Live global positions: the page-load snapshot overlaid with fetch-path patches (canonical key → 1-based rank). */
  let positionPatches = $state<Record<string, number>>({});
  const globalPositionOf = (canonicalKey: string | undefined): number | null => {
    if (!canonicalKey) return null;
    const patched = positionPatches[`extension:${canonicalKey}`];
    if (typeof patched === 'number') return patched;
    const initial = globalPositions[`extension:${canonicalKey}`];
    return typeof initial === 'number' ? initial : null;
  };
  /** The number inputs (row id → raw string; validated server-side). */
  const positionInputs = new SvelteMap<string, string>();
  /** Rows with a position mutation in flight (duplicate-click guard). */
  const positionPendingIds = new SvelteSet<string>();
  const positionInputValue = (extension: CloudStreamExtensionView): string =>
    positionInputs.get(extension.id) ?? String(globalPositionOf(extension.canonicalKey) ?? '');

  const rows = $derived<CloudStreamExtensionView[]>(
    extensions.map((extension) => rowPatches.get(extension.id) ?? extension),
  );
  const repos = $derived<CloudStreamRepositoryView[]>(
    repositories.map((repository) => repositoryPatches.get(repository.id) ?? repository),
  );

  /** undefined = no local test result yet → fall back to the form-action prop. */
  let testResultOverride = $state<ProviderTestResultView | null | undefined>(undefined);
  const testResult = $derived<ProviderTestResultView | null>(
    testResultOverride !== undefined ? testResultOverride : (providerTest ?? null),
  );

  // ---------------------------------------------------------------------------
  // §11 toolbar state (search / filters / sort / page)
  // ---------------------------------------------------------------------------

  let search = $state('');
  let statusFilter = $state<IntegrationStatusFilter>('all');
  let mediaFilter = $state<IntegrationMediaFilter>('all');
  let repositoryId = $state<string | 'all'>('all');
  let sortKey = $state<IntegrationSortKey>('name');
  let sortDir = $state<IntegrationSortDir>('asc');
  let page = $state(1);

  const query = $derived<IntegrationManagerQuery>({
    search,
    statusFilter,
    mediaFilter,
    repositoryId,
    sortKey,
    sortDir,
    page,
  });

  const projection = $derived(projectIntegrationManager(rows, repos, query));
  const repositorySummaries = $derived<RepositorySummary[]>(summarizeRepositories(repos, rows));

  /** The §11 stats header source: the selected repository, or the aggregate. */
  const statsHeader = $derived.by(() => {
    if (repositoryId !== 'all') {
      const summary = repositorySummaries.find((item) => item.repository.id === repositoryId);
      if (summary !== undefined) {
        return { name: summary.repository.name, counts: summary.counts };
      }
    }
    return { name: 'All repositories', counts: projection.aggregate };
  });

  function resetPage(): void {
    page = 1;
  }

  function clearFilters(): void {
    search = '';
    statusFilter = 'all';
    mediaFilter = 'all';
    repositoryId = 'all';
    sortKey = 'name';
    sortDir = 'asc';
    resetPage();
  }

  const filtersActive = $derived(
    search.trim() !== ''
      || statusFilter !== 'all'
      || mediaFilter !== 'all'
      || repositoryId !== 'all'
      || sortKey !== 'name'
      || sortDir !== 'asc',
  );

  // ---------------------------------------------------------------------------
  // §11 selection model (select / select-all-FILTERED)
  // ---------------------------------------------------------------------------

  const selectedIds = new SvelteSet<string>();

  const allFilteredSelected = $derived(
    projection.filtered.length > 0
    && projection.filtered.every((extension) => selectedIds.has(extension.id)),
  );
  const someFilteredSelected = $derived(
    !allFilteredSelected && projection.filtered.some((extension) => selectedIds.has(extension.id)),
  );

  function toggleSelectAllFiltered(): void {
    if (allFilteredSelected) {
      for (const extension of projection.filtered) selectedIds.delete(extension.id);
    } else {
      for (const extension of projection.filtered) selectedIds.add(extension.id);
    }
  }

  function toggleSelected(id: string): void {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
  }

  /** Rows that are selected AND eligible for the bulk Create Adapters action. */
  const bulkCreateTargets = $derived(
    rows.filter((extension) => selectedIds.has(extension.id) && eligibleForBulkCreateAdapter(extension)),
  );

  // ---------------------------------------------------------------------------
  // §12 mutation state (per-row pending, inline errors, local notices)
  // ---------------------------------------------------------------------------

  const pendingIds = new SvelteSet<string>();
  const pendingRepoIds = new SvelteSet<string>();
  let rowErrors = $state<Record<string, string>>({});
  let repoErrors = $state<Record<string, string>>({});
  let localNotice = $state<string | null>(null);

  // Bulk queue state (§11 create-adapters-for-selected).
  let bulkRunning = $state(false);
  let bulkStopRequested = $state(false);
  let bulkProgress = $state<{ done: number; total: number; current: string | null } | null>(null);
  let bulkResults = $state<Array<{ name: string; ok: boolean; message: string }>>([]);

  function setRowError(id: string, message: string | null): void {
    const next = { ...rowErrors };
    if (message === null) delete next[id];
    else next[id] = message;
    rowErrors = next;
  }

  function setRepoError(id: string, message: string | null): void {
    const next = { ...repoErrors };
    if (message === null) delete next[id];
    else next[id] = message;
    repoErrors = next;
  }

  /** Patches ONE row (§12 invalidate-only-affected-data). */
  function patchRow(view: CloudStreamExtensionView | null | undefined): void {
    if (view === null || view === undefined) return;
    rowPatches.set(view.id, view);
  }

  function patchRepository(view: CloudStreamRepositoryView | null | undefined): void {
    if (view === null || view === undefined) return;
    repositoryPatches.set(view.id, view);
  }

  // ---------------------------------------------------------------------------
  // JSON mutation API client (Phase 4 endpoints; the forms remain the
  // no-JS fallback — see the onsubmit interception in the markup)
  // ---------------------------------------------------------------------------

  type ExtensionsMutationResponse = {
    ok?: boolean;
    extension?: CloudStreamExtensionView | null;
    extensions?: CloudStreamExtensionView[];
    providerTest?: ProviderTestResultView;
    outcome?: { adapterVersion?: number; notes?: string; testCases?: Array<{ kind: string; linksFound: number }> };
    /** FINAL TASK: the fresh global position map after a setPosition move. */
    positions?: Record<string, number>;
    error?: { code?: string; message?: string };
  };

  async function postExtensionMutation(payload: Record<string, unknown>): Promise<ExtensionsMutationResponse> {
    try {
      const res = await fetch('/api/admin/integrations/cloudstream/extensions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return (await res.json()) as ExtensionsMutationResponse;
    } catch {
      return { ok: false, error: { code: 'NETWORK', message: 'Network error — the request could not be sent.' } };
    }
  }

  // §12 toggle: async action → targeted state update → same scroll position.
  async function toggleExtension(extension: CloudStreamExtensionView): Promise<void> {
    if (pendingIds.has(extension.id) || bulkRunning) return; // duplicate-click guard
    pendingIds.add(extension.id);
    setRowError(extension.id, null);
    localNotice = null;
    try {
      const response = await postExtensionMutation({
        action: 'setEnabled',
        id: extension.id,
        enabled: !extension.enabled,
      });
      if (response.ok) {
        patchRow(response.extension ?? null);
      } else {
        setRowError(extension.id, response.error?.message ?? 'Unable to update the extension.');
      }
    } finally {
      pendingIds.delete(extension.id);
    }
  }

  // ---------------------------------------------------------------------------
  // FINAL TASK (PART G) — global position mutation: async action → the
  // response's FRESH position map patches every displayed position (not
  // just the moved row); the moved row's view is re-patched as usual.
  // ---------------------------------------------------------------------------
  async function setExtensionPositionTo(extension: CloudStreamExtensionView): Promise<void> {
    if (positionPendingIds.has(extension.id) || pendingIds.has(extension.id) || bulkRunning) return;
    const raw = positionInputs.get(extension.id) ?? String(globalPositionOf(extension.canonicalKey) ?? '');
    const position = Number(raw);
    if (!Number.isSafeInteger(position) || position < 1) {
      setRowError(extension.id, 'Position must be a whole number starting at 1.');
      return;
    }
    positionPendingIds.add(extension.id);
    setRowError(extension.id, null);
    localNotice = null;
    try {
      const response = await postExtensionMutation({
        action: 'setPosition',
        id: extension.id,
        position,
      });
      if (response.ok) {
        patchRow(response.extension ?? null);
        if (response.positions && typeof response.positions === 'object') {
          positionPatches = { ...response.positions };
        }
        positionInputs.delete(extension.id);
      } else {
        setRowError(extension.id, response.error?.message ?? 'Unable to set the position.');
      }
    } finally {
      positionPendingIds.delete(extension.id);
    }
  }

  async function toggleRepository(repository: CloudStreamRepositoryView): Promise<void> {
    if (pendingRepoIds.has(repository.id)) return;
    pendingRepoIds.add(repository.id);
    setRepoError(repository.id, null);
    try {
      let response: { ok?: boolean; repository?: CloudStreamRepositoryView | null; error?: { message?: string } };
      try {
        const res = await fetch('/api/admin/integrations/cloudstream/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'setEnabled', id: repository.id, enabled: !repository.enabled }),
        });
        response = (await res.json()) as typeof response;
      } catch {
        response = { ok: false, error: { message: 'Network error — the request could not be sent.' } };
      }
      if (response.ok) {
        patchRepository(response.repository ?? null);
      } else {
        setRepoError(repository.id, response.error?.message ?? 'Unable to update the repository.');
      }
    } finally {
      pendingRepoIds.delete(repository.id);
    }
  }

  /**
   * §14 Copy Repo Link: copies the ACTUAL repository URL to the clipboard
   * with the modern async clipboard API, falling back to a transient
   * off-screen textarea + execCommand for non-secure contexts. Pure client
   * action — no page reload, no server round-trip. Feedback: the button
   * flips to a "Copied" state for 2s (aria-live polite).
   */
  async function copyRepoLink(repository: CloudStreamRepositoryView): Promise<void> {
    if (copyingRepoId !== null || typeof repository.url !== 'string' || repository.url.length === 0) return;
    copyingRepoId = repository.id;
    try {
      let copied = false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(repository.url);
          copied = true;
        }
      } catch {
        // Clipboard permission denied / insecure context — fall through.
      }
      if (!copied) {
        const textarea = document.createElement('textarea');
        textarea.value = repository.url;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        try {
          textarea.select();
          copied = document.execCommand('copy');
        } finally {
          textarea.remove();
        }
      }
      if (copied) {
        copiedRepoIds.add(repository.id);
        setTimeout(() => { copiedRepoIds.delete(repository.id); }, 2_000);
      } else {
        setRepoError(repository.id, 'The repository URL could not be copied — the browser blocked clipboard access.');
      }
    } finally {
      copyingRepoId = null;
    }
  }

  async function createAdapterFor(extension: CloudStreamExtensionView): Promise<void> {
    if (pendingIds.has(extension.id) || bulkRunning) return;
    if (!confirm('Create a permanent adapter through the external Adapter Builder? This runs a build and live test (up to a few minutes).')) return;
    pendingIds.add(extension.id);
    setRowError(extension.id, null);
    localNotice = null;
    try {
      const response = await postExtensionMutation({ action: 'createAdapter', id: extension.id });
      patchRow(response.extension ?? null);
      if (response.ok) {
        const summary = (response.outcome?.testCases ?? [])
          .map((testCase) => `${testCase.kind}: ${testCase.linksFound} link${testCase.linksFound === 1 ? '' : 's'}`)
          .join(', ');
        localNotice = `Adapter v${response.outcome?.adapterVersion ?? '?'} created and tested${summary.length > 0 ? ` (${summary})` : ''}. Enable it to use it in Downloader 2.`;
      } else {
        setRowError(extension.id, response.error?.message ?? 'The adapter build failed.');
      }
    } finally {
      pendingIds.delete(extension.id);
    }
  }

  async function testProviderFor(extension: CloudStreamExtensionView): Promise<void> {
    if (pendingIds.has(extension.id) || bulkRunning) return;
    pendingIds.add(extension.id);
    setRowError(extension.id, null);
    try {
      const response = await postExtensionMutation({ action: 'testProvider', id: extension.id });
      patchRow(response.extension ?? null);
      if (response.ok && response.providerTest) {
        testResultOverride = response.providerTest;
      } else {
        setRowError(extension.id, response.error?.message ?? 'The provider test failed.');
      }
    } finally {
      pendingIds.delete(extension.id);
    }
  }

  // ---------------------------------------------------------------------------
  // §11 bulk operations
  // ---------------------------------------------------------------------------

  async function bulkSetEnabled(enabled: boolean): Promise<void> {
    const ids = [...selectedIds];
    if (bulkRunning || ids.length === 0) return;
    if (!confirm(`${enabled ? 'Enable' : 'Disable'} ${ids.length} selected extension${ids.length === 1 ? '' : 's'}?`)) return;
    bulkRunning = true;
    bulkProgress = { done: 0, total: ids.length, current: null };
    bulkResults = [];
    try {
      let done = 0;
      for (const chunk of chunkBulkIds(ids)) {
        if (bulkStopRequested) break;
        for (const id of chunk) pendingIds.add(id);
        const response = await postExtensionMutation({ action: 'setEnabledBulk', ids: chunk, enabled });
        for (const id of chunk) pendingIds.delete(id);
        if (response.ok) {
          for (const view of response.extensions ?? []) patchRow(view);
          done += response.extensions?.length ?? 0;
          bulkProgress = { done, total: ids.length, current: null };
        } else {
          bulkResults = [...bulkResults, { name: `${done} updated before the failure`, ok: false, message: response.error?.message ?? 'The bulk update failed.' }];
          break;
        }
      }
      localNotice = bulkStopRequested
        ? `Bulk update stopped after ${done} of ${ids.length}.`
        : done > 0 ? `${done} extension${done === 1 ? '' : 's'} ${enabled ? 'enabled' : 'disabled'}.` : null;
    } finally {
      bulkRunning = false;
      bulkStopRequested = false;
      bulkProgress = null;
    }
  }

  async function bulkCreateAdapters(): Promise<void> {
    if (bulkRunning) return;
    const targets = bulkCreateTargets;
    if (targets.length === 0) {
      localNotice = 'None of the selected providers can enter adapter generation (only Adapter Required / Adapter Failed rows are eligible).';
      return;
    }
    if (!confirm(`Create permanent adapters for ${targets.length} selected provider${targets.length === 1 ? '' : 's'}? Each build runs a live test (up to a few minutes each, sequentially).`)) return;
    bulkRunning = true;
    bulkStopRequested = false;
    bulkProgress = { done: 0, total: targets.length, current: null };
    bulkResults = [];
    localNotice = null;
    try {
      let done = 0;
      let succeeded = 0;
      for (const target of targets) {
        if (bulkStopRequested) break;
        bulkProgress = { done, total: targets.length, current: target.name ?? target.internalName };
        const response = await postExtensionMutation({ action: 'createAdapter', id: target.id });
        patchRow(response.extension ?? null);
        if (response.ok) {
          succeeded += 1;
          const summary = (response.outcome?.testCases ?? [])
            .map((testCase) => `${testCase.kind}: ${testCase.linksFound} link${testCase.linksFound === 1 ? '' : 's'}`)
            .join(', ');
          bulkResults = [...bulkResults, {
            name: target.name ?? target.internalName,
            ok: true,
            message: `Adapter v${response.outcome?.adapterVersion ?? '?'} created${summary.length > 0 ? ` (${summary})` : ''}.`,
          }];
        } else {
          bulkResults = [...bulkResults, {
            name: target.name ?? target.internalName,
            ok: false,
            message: response.error?.message ?? 'The adapter build failed.',
          }];
        }
        done += 1;
        bulkProgress = { done, total: targets.length, current: null };
      }
      localNotice = bulkStopRequested
        ? `Stopped after ${done} of ${targets.length} builds (${succeeded} succeeded).`
        : `Adapter builds complete: ${succeeded}/${targets.length} succeeded.`;
    } finally {
      bulkRunning = false;
      bulkStopRequested = false;
      bulkProgress = null;
    }
  }

  function stopBulk(): void {
    bulkStopRequested = true;
  }

  function clearSelection(): void {
    if (bulkRunning) return;
    selectedIds.clear();
  }

  // ---------------------------------------------------------------------------
  // Display helpers
  // ---------------------------------------------------------------------------

  /** tvTypes are CloudStream enum NAMES (AC-002) — displayed verbatim with a
   * soft prettifier for the compound names. Nuvio rows carry the manifest's
   * raw supportedTypes — also displayed verbatim. */
  function tvTypeLabel(name: string): string {
    if (name === 'TvSeries') return 'Series';
    if (name === 'AsianDrama') return 'Asian drama';
    return name;
  }

  function integrationTypeLabel(type: 'cloudstream' | 'nuvio'): string {
    return type === 'nuvio' ? 'Nuvio' : 'CloudStream';
  }

  /** §13 status chip tone (shared with the §11 filter chips). */
  function statusTone(kind: string): 'good' | 'warn' | 'neutral' | 'bad' {
    switch (kind) {
      case 'active':
      case 'ready':
        return 'good';
      case 'runtime_required':
        return 'neutral';
      case 'failed':
        return 'bad';
      default:
        return 'warn';
    }
  }

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

  /** The extension the last test result belongs to (if visible). */
  const testedExtension = $derived.by(() => {
    const result = testResult;
    if (result === null) return null;
    const adapterId = result.adapterId.toLowerCase();
    return rows.find((extension) =>
      extension.internalName.toLowerCase() === adapterId
      // Generated adapters carry their canonical key as the resolver id.
      || `${extension.integrationType}:${extension.internalName.toLowerCase()}` === adapterId,
    ) ?? null;
  });

  /** Row display name (§13 rows are identified by provider name). */
  function rowName(extension: CloudStreamExtensionView): string {
    return extension.name ?? extension.internalName;
  }
</script>

{#if loadError}
  <div class="cs-error-banner" role="alert">
    <AlertTriangle size={16} />
    <span>{loadError}</span>
  </div>
{/if}

{#if repos.length === 0}
  <div class="cs-empty">
    <Box size={32} />
    <h3>No extension repositories</h3>
    <p>Add a CloudStream repository URL (a CS.json index) or a Nuvio provider manifest URL to discover extensions.</p>
  </div>
{:else}
  <!-- Repositories (§11: per-repository stats line on every card) -->
  <section class="cs-section" aria-label="CloudStream repositories">
    <h4 class="cs-section-title"><Layers size={14} /> Repositories ({repos.length})</h4>
    <div class="cs-repo-list">
      {#each repos as repository (repository.id)}
        {@const summary = repositorySummaries.find((item) => item.repository.id === repository.id)}
        {@const repoPending = pendingRepoIds.has(repository.id)}
        <div class="cs-repo-card" data-enabled={repository.enabled} data-pending={repoPending} aria-busy={repoPending}>
          <div class="cs-repo-head">
            <div class="cs-repo-name">{repository.name}</div>
            <div class="cs-repo-badges">
              <AdminStatusBadge label={repository.enabled ? 'Enabled' : 'Disabled'} tone={repository.enabled ? 'good' : 'neutral'} />
              <AdminStatusBadge label={repository.status} tone={REPOSITORY_STATUS_TONES[repository.status] ?? 'neutral'} />
            </div>
          </div>
          <!-- §14: ONE full-width action row immediately below the status tags.
               Labeled, consistently sized buttons; wraps only when genuinely
               necessary (tablet/mobile). Copy Repo Link is a pure client
               action (no page reload, honest copied feedback). -->
          <div class="cs-repo-action-row" role="group" aria-label="Repository actions for {repository.name}">
            <button
              type="button"
              class="cs-repo-action"
              aria-pressed={repositoryId === repository.id}
              title="View this repository's extensions"
              aria-label="View {repository.name} extensions"
              onclick={() => { repositoryId = repositoryId === repository.id ? 'all' : repository.id; resetPage(); }}
            ><Eye size={13} /> <span>View</span></button>
            <form method="POST" action="?/setCloudStreamRepositoryEnabled" class="cs-repo-action-form"
                  onsubmit={(event) => { event.preventDefault(); void toggleRepository(repository); }}>
              <input type="hidden" name="id" value={repository.id} />
              <input type="hidden" name="enabled" value={String(!repository.enabled)} />
              <button type="submit" class="cs-repo-action" disabled={repoPending} title={repository.enabled ? 'Disable repository' : 'Enable repository'} aria-label="{repository.enabled ? 'Disable' : 'Enable'} repository {repository.name}"><Power size={13} /> <span>{repository.enabled ? 'Disable' : 'Enable'}</span></button>
            </form>
            <form method="POST" action="?/syncCloudStreamRepository" class="cs-repo-action-form">
              <input type="hidden" name="id" value={repository.id} />
              <button type="submit" class="cs-repo-action" title="Sync repository (re-fetch the repository document and reconcile extensions)" aria-label="Sync repository {repository.name}"><RefreshCw size={13} /> <span>Sync</span></button>
            </form>
            <button
              type="button"
              class="cs-repo-action"
              data-copied={copiedRepoIds.has(repository.id)}
              title="Copy the repository URL to the clipboard"
              aria-label="Copy repository URL for {repository.name}"
              aria-live="polite"
              disabled={copyingRepoId === repository.id}
              onclick={() => { void copyRepoLink(repository); }}
            >
              {#if copiedRepoIds.has(repository.id)}
                <Check size={13} /> <span>Copied</span>
              {:else}
                <Link2 size={13} /> <span>Copy Repo Link</span>
              {/if}
            </button>
            <form method="POST" action="?/deleteCloudStreamRepository" class="cs-repo-action-form" onsubmit={(e) => { if (!confirm('Delete this repository and its discovered extensions?')) e.preventDefault(); }}>
              <input type="hidden" name="id" value={repository.id} />
              <button type="submit" class="cs-repo-action cs-repo-action-danger" title="Delete repository" aria-label="Delete repository {repository.name}"><Trash2 size={13} /> <span>Delete</span></button>
            </form>
          </div>
          <div class="cs-repo-main">
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
            {#if summary}
              <div class="cs-repo-stats">
                <span>Enabled: {summary.counts.enabled}</span>
                <span>·</span>
                <span>Compatible: {summary.counts.compatible}</span>
                <span>·</span>
                <span>Adapter Required: {summary.counts.adapterRequired}</span>
                <span>·</span>
                <span>Runtime Required: {summary.counts.runtimeRequired}</span>
                <span>·</span>
                <span>Failed: {summary.counts.failed}</span>
              </div>
            {/if}
            {#if repository.lastError}
              <div class="cs-repo-error" role="alert"><AlertTriangle size={12} /> {repository.lastError}</div>
            {/if}
            {#if repoErrors[repository.id]}
              <div class="cs-repo-error" role="alert"><AlertTriangle size={12} /> {repoErrors[repository.id]}</div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>

  <!-- Extensions (§11 manager view) -->
  <section class="cs-section" aria-label="Discovered CloudStream extensions">
    <h4 class="cs-section-title">
      <Package size={14} /> Extensions ({projection.total} shown{selectedIds.size > 0 ? `, ${selectedIds.size} selected` : ''})
    </h4>
    <p class="cs-compat-note">
      Discovered extensions are catalog metadata only. Runtime compatibility requires a Mavero adapter
      (Add-on = Stremio · Extension = CloudStream or Nuvio).
    </p>

    <!-- §11 STICKY toolbar: search + status/media/repository filters + sort -->
    <div class="cs-toolbar" role="group" aria-label="Extension filters and search">
      <div class="cs-toolbar-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          bind:value={search}
          oninput={resetPage}
          placeholder="Search providers, sources, repositories…"
          aria-label="Search extensions by provider, source, or repository name"
        />
        {#if search !== ''}
          <button type="button" class="cs-toolbar-clear" onclick={() => { search = ''; resetPage(); }} title="Clear search" aria-label="Clear search"><X size={12} /></button>
        {/if}
      </div>
      <label class="cs-toolbar-field">
        <span>Status</span>
        <select bind:value={statusFilter} onchange={resetPage} aria-label="Filter extensions by status">
          {#each INTEGRATION_STATUS_FILTERS as filter (filter)}
            <option value={filter}>{INTEGRATION_STATUS_FILTER_LABELS[filter]}</option>
          {/each}
        </select>
      </label>
      <label class="cs-toolbar-field">
        <span>Media</span>
        <select bind:value={mediaFilter} onchange={resetPage} aria-label="Filter extensions by media support">
          {#each INTEGRATION_MEDIA_FILTERS as filter (filter)}
            <option value={filter}>{INTEGRATION_MEDIA_FILTER_LABELS[filter]}</option>
          {/each}
        </select>
      </label>
      <label class="cs-toolbar-field">
        <span>Repository</span>
        <select bind:value={repositoryId} onchange={resetPage} aria-label="Filter extensions by repository">
          <option value="all">All repositories</option>
          {#each repositorySummaries as summary (summary.repository.id)}
            <option value={summary.repository.id}>{summary.repository.name} ({summary.counts.total})</option>
          {/each}
        </select>
      </label>
      <label class="cs-toolbar-field">
        <span>Sort</span>
        <select bind:value={sortKey} onchange={resetPage} aria-label="Sort extensions">
          {#each INTEGRATION_SORT_KEYS as key (key)}
            <option value={key}>{INTEGRATION_SORT_KEY_LABELS[key]}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        class="a2-icon-btn cs-sort-dir"
        onclick={() => { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; }}
        title={sortDir === 'asc' ? 'Sort ascending — switch to descending' : 'Sort descending — switch to ascending'}
        aria-label="Toggle sort direction ({sortDir === 'asc' ? 'currently ascending' : 'currently descending'})"
        aria-pressed={sortDir === 'desc'}
      ><ArrowUpDown size={14} /></button>
    </div>

    <!-- §11 stats header (the selected repository's, or the aggregate) -->
    <div class="cs-stats" role="status" aria-live="polite">
      <span class="cs-stats-name">{statsHeader.name}</span>
      <span>{statsHeader.counts.total} extensions</span>
      <span class="cs-stat"><span class="cs-stat-label">Enabled:</span> {statsHeader.counts.enabled}</span>
      <span class="cs-stat"><span class="cs-stat-label">Compatible:</span> {statsHeader.counts.compatible}</span>
      <span class="cs-stat"><span class="cs-stat-label">Adapter Required:</span> {statsHeader.counts.adapterRequired}</span>
      <span class="cs-stat"><span class="cs-stat-label">Runtime Required:</span> {statsHeader.counts.runtimeRequired}</span>
      <span class="cs-stat"><span class="cs-stat-label">Failed:</span> {statsHeader.counts.failed}</span>
    </div>

    <!-- §12 local notice (async mutation feedback; no page reload) -->
    {#if localNotice}
      <div class="cs-local-notice" role="status" aria-live="polite">
        <span>{localNotice}</span>
        <button type="button" class="cs-toolbar-clear" onclick={() => { localNotice = null; }} title="Dismiss" aria-label="Dismiss notice"><X size={12} /></button>
      </div>
    {/if}

    <!-- §11 bulk action bar -->
    <div class="cs-bulkbar" data-visible={selectedIds.size > 0 || bulkRunning}>
      <span class="cs-bulk-count">{selectedIds.size} selected{bulkCreateTargets.length > 0 ? ` · ${bulkCreateTargets.length} adapter-eligible` : ''}</span>
      <div class="cs-bulk-actions">
        <button type="button" class="cs-bulk-btn" disabled={bulkRunning || selectedIds.size === 0} onclick={() => void bulkSetEnabled(true)}>Enable Selected</button>
        <button type="button" class="cs-bulk-btn" disabled={bulkRunning || selectedIds.size === 0} onclick={() => void bulkSetEnabled(false)}>Disable Selected</button>
        <button type="button" class="cs-bulk-btn cs-bulk-build" disabled={bulkRunning || bulkCreateTargets.length === 0} onclick={() => void bulkCreateAdapters()}>
          Create Adapters{bulkCreateTargets.length > 0 ? ` (${bulkCreateTargets.length})` : ''}
        </button>
        {#if bulkRunning}
          <button type="button" class="cs-bulk-btn cs-bulk-stop" onclick={stopBulk} title="Stop after the current item"><StopCircle size={12} /> Stop</button>
        {:else}
          <button type="button" class="cs-bulk-btn" disabled={selectedIds.size === 0} onclick={clearSelection}>Clear</button>
        {/if}
      </div>
    </div>

    <!-- Bulk queue progress + per-item results (§11) -->
    {#if bulkProgress !== null || bulkResults.length > 0}
      <div class="cs-bulk-progress" role="status" aria-live="polite">
        {#if bulkProgress !== null}
          <div class="cs-bulk-progress-line">
            {#if bulkProgress.current !== null}
              <span class="cs-bulk-current">Building {bulkProgress.current}…</span>
            {:else}
              <span>Working… {bulkProgress.done}/{bulkProgress.total}</span>
            {/if}
          </div>
        {/if}
        {#if bulkResults.length > 0}
          <div class="cs-bulk-results">
            {#each bulkResults as result (result.name)}
              <div class="cs-bulk-result" data-ok={result.ok}>
                <span class="cs-bulk-result-name">{result.name}</span>
                <span>{result.message}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Phase 3/§9 — Test Provider result panel (normalized results) -->
    {#if testResult !== null}
      <div class="cs-test-panel" data-passed={testResult.passed}>
        <div class="cs-test-header">
          <FlaskConical size={14} />
          <span class="cs-test-title">
            Test results — {testedExtension?.name ?? testedExtension?.internalName ?? testResult.adapterId}
            ({testResult.adapterKind === 'generated' ? `generated adapter v${testResult.adapterVersion}` : `native adapter v${testResult.adapterVersion}`})
          </span>
          <AdminStatusBadge label={testResult.passed ? 'Passed' : 'Failed'} tone={testResult.passed ? 'good' : 'bad'} />
        </div>
        {#each testResult.cases as testCase (testCase.kind)}
          <div class="cs-test-case">
            <span>{testCase.kind === 'movie' ? 'Movie' : 'Episode'}</span>
            <span>{testCase.linksFound} link{testCase.linksFound === 1 ? '' : 's'}</span>
            <span>· {Math.round(testCase.durationMs)} ms</span>
            {#if testCase.note}<span class="cs-test-note">· {testCase.note}</span>{/if}
          </div>
        {/each}
        {#if testResult.links.length > 0}
          <div class="cs-test-links">
            {#each testResult.links.slice(0, 8) as link (link.url)}
              <div class="cs-test-link">
                <span class="cs-test-link-name">{link.sourceName}</span>
                {#if link.quality}<span class="cs-ext-type">{link.quality}</span>{/if}
                <span class="mono">{link.host ?? link.url.slice(0, 60)}</span>
              </div>
            {/each}
            {#if testResult.links.length > 8}<div class="cs-test-case">+ {testResult.links.length - 8} more…</div>{/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if projection.total === 0}
      <div class="cs-empty cs-empty-filtered">
        <Package size={24} />
        <h3>No extensions match</h3>
        <p>{filtersActive ? 'No extensions match the current search and filters.' : 'This repository has no discovered extensions yet — sync it to discover providers.'}</p>
        {#if filtersActive}
          <button type="button" class="cs-bulk-btn" onclick={clearFilters}>Clear Filters</button>
        {/if}
      </div>
    {:else}
      <!-- §11 select-all-FILTERED + bounded page list -->
      <div class="cs-list-head">
        <label class="cs-select-all">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            indeterminate={someFilteredSelected}
            onchange={toggleSelectAllFiltered}
            disabled={bulkRunning}
            aria-label="Select all {projection.total} filtered extensions"
          />
          <span>Select all {projection.total} filtered</span>
        </label>
        <span class="cs-list-count">
          {#if projection.pageCount > 1}Page {projection.page} of {projection.pageCount}{/if}
        </span>
      </div>
      <div class="cs-ext-list">
        {#each projection.rows as extension (extension.id)}
          {@const status = providerStatusPresentation(extension)}
          {@const pending = pendingIds.has(extension.id)}
          <div class="cs-ext-row" data-enabled={extension.enabled} data-pending={pending} aria-busy={pending}>
            <input
              type="checkbox"
              class="cs-row-select"
              checked={selectedIds.has(extension.id)}
              onchange={() => toggleSelected(extension.id)}
              disabled={bulkRunning}
              aria-label="Select {rowName(extension)}"
            />
            <div class="cs-ext-main">
              <div class="cs-ext-name">{rowName(extension)}</div>
              <div class="cs-ext-meta">
                <span class="cs-ext-type">{integrationTypeLabel(extension.integrationType)}</span>
                <span class="mono">{extension.internalName}</span>
                {#if extension.repositoryId !== repositoryId}
                  <span>·</span><span>{extension.repositoryName}</span>
                {/if}
                {#if extension.version}<span>·</span><span>v{extension.version}</span>{/if}
                {#if !extension.version && extension.versionText}<span>·</span><span>v{extension.versionText}</span>{/if}
                {#if extension.language}<span>·</span><span>{extension.language}</span>{/if}
                {#if extension.tvTypes.length > 0}
                  <span>·</span>
                  {#each extension.tvTypes.slice(0, 4) as tvType}<span class="cs-ext-type">{tvTypeLabel(tvType)}</span>{/each}
                {/if}
                {#if extension.authors.length > 0}<span>·</span><span>{extension.authors[0]}</span>{/if}
              </div>
              {#if status.note}
                <div class="cs-state-note" data-kind={status.kind}>{status.note}</div>
              {/if}
              {#if extension.lastError}
                <div class="cs-repo-error" role="alert"><AlertTriangle size={12} /> {extension.lastError}</div>
              {/if}
              {#if rowErrors[extension.id]}
                <div class="cs-repo-error" role="alert"><AlertTriangle size={12} /> {rowErrors[extension.id]}</div>
              {/if}
              {#if pending}
                <div class="cs-pending-note" role="status">Updating…</div>
              {/if}
            </div>
            <div class="cs-ext-actions">
              <!-- §13 status chip (closed vocabulary) -->
              <AdminStatusBadge label={status.label} tone={statusTone(status.kind)} dot={false} />
              {#if extension.enabled && status.kind !== 'active'}
                <AdminStatusBadge label="Enabled" tone="good" dot={false} />
              {/if}
              <!-- FINAL TASK (PART G): the global position control — the
                   plugin counterpart of the add-on position UX ("Position:
                   [N] Set Position"), operating in the ONE unified ordering
                   namespace. Shown for rows that CAN be user-facing sources
                   (native/generated adapter + enabled). -->
              {#if extension.enabled && (extension.adapterState === 'native' || extension.adapterState === 'generated')}
                <div class="cs-position" data-pending={positionPendingIds.has(extension.id)}>
                  <label class="cs-position-label" for={`position-${extension.id}`}>Position</label>
                  <input
                    id={`position-${extension.id}`}
                    class="cs-position-input"
                    type="number"
                    inputmode="numeric"
                    min="1"
                    step="1"
                    value={positionInputValue(extension)}
                    oninput={(event) => { positionInputs.set(extension.id, (event.currentTarget as HTMLInputElement).value); }}
                    disabled={positionPendingIds.has(extension.id) || bulkRunning}
                    aria-label={`Global position for ${rowName(extension)}`}
                  />
                  <button
                    type="button"
                    class="a2-icon-btn cs-position-btn"
                    disabled={positionPendingIds.has(extension.id) || pending || bulkRunning}
                    onclick={() => { void setExtensionPositionTo(extension); }}
                    title="Set the global position (unified add-on + plugin order)"
                    aria-label={`Set global position for ${rowName(extension)}`}
                  >
                    {#if positionPendingIds.has(extension.id)}
                      <span class="cs-position-spin" role="status" aria-label="Setting position"><Loader2 size={14} class="cs-spin" /></span>
                    {:else}
                      <MoveVertical size={14} />
                    {/if}
                  </button>
                </div>
              {/if}
              {#if status.canCreateAdapter}
                <form method="POST" action="?/createCloudStreamAdapter" style="display:inline"
                      onsubmit={(event) => { event.preventDefault(); void createAdapterFor(extension); }}>
                  <input type="hidden" name="id" value={extension.id} />
                  <button type="submit" class="a2-icon-btn cs-build-btn" disabled={pending || bulkRunning}
                          title={status.kind === 'failed' ? 'Retry adapter creation (external Builder + live test)' : 'Create Adapter (external Builder + live test)'}
                          aria-label="{status.kind === 'failed' ? 'Retry adapter creation for' : 'Create adapter for'} {rowName(extension)}">
                    <Hammer size={14} />
                  </button>
                </form>
              {/if}
              {#if status.canTest}
                <form method="POST" action="?/testCloudStreamProvider" style="display:inline"
                      onsubmit={(event) => { event.preventDefault(); void testProviderFor(extension); }}>
                  <input type="hidden" name="id" value={extension.id} />
                  <button type="submit" class="a2-icon-btn" disabled={pending || bulkRunning}
                          title="Test Provider (representative resolution)"
                          aria-label="Test provider {rowName(extension)}">
                    <FlaskConical size={14} />
                  </button>
                </form>
              {/if}
              {#if status.primaryAction === 'Enable' || status.primaryAction === 'Disable'}
                <form method="POST" action="?/setCloudStreamExtensionEnabled" style="display:inline"
                      onsubmit={(event) => { event.preventDefault(); void toggleExtension(extension); }}>
                  <input type="hidden" name="id" value={extension.id} />
                  <input type="hidden" name="enabled" value={String(!extension.enabled)} />
                  <button type="submit" class="a2-icon-btn" disabled={pending || bulkRunning}
                          title={status.primaryAction === 'Enable' ? 'Enable extension' : 'Disable extension'}
                          aria-label="{status.primaryAction} {rowName(extension)}">
                    <Power size={14} />
                  </button>
                </form>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <!-- §11 pagination footer (bounded rendering) -->
      {#if projection.pageCount > 1}
        <div class="cs-pager" role="navigation" aria-label="Extension pages">
          <span class="cs-pager-info">
            Showing {projection.fromIndex + 1}–{projection.toIndex} of {projection.total}
          </span>
          <div class="cs-pager-controls">
            <button type="button" class="cs-bulk-btn" disabled={projection.page <= 1} onclick={() => { page = projection.page - 1; }} aria-label="Previous page">Prev</button>
            <span class="cs-pager-current">Page {projection.page} of {projection.pageCount}</span>
            <button type="button" class="cs-bulk-btn" disabled={projection.page >= projection.pageCount} onclick={() => { page = projection.page + 1; }} aria-label="Next page">Next</button>
          </div>
        </div>
      {/if}
    {/if}
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
  .cs-empty-filtered { padding: var(--a2-space-6); }
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
  /* §14 repository card: a COLUMN — header (name + status badges), ONE
     full-width action row immediately below the tags, then the meta/stats.
     The old side-by-side actions column stacked awkwardly on narrow screens
     (right-aligned controls + large blank space). */
  .cs-repo-card {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
    padding: var(--a2-space-3) var(--a2-space-4);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    min-width: 0;
  }
  .cs-ext-row {
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
  .cs-repo-card[data-pending="true"], .cs-ext-row[data-pending="true"] { opacity: 0.75; }
  .cs-repo-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--a2-space-2);
    min-width: 0;
  }
  .cs-repo-name {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text-bright);
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .cs-repo-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  /* ONE clean full-width action row: equal-growth labeled buttons. Desktop =
     one row; tablet/mobile = compact wrapping only when genuinely necessary
     (each button keeps ≥96px usable width — never horizontal overflow). */
  .cs-repo-action-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--a2-space-1);
    width: 100%;
    min-width: 0;
  }
  .cs-repo-action-form { display: flex; flex: 1 1 96px; min-width: 0; }
  .cs-repo-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 1 1 96px;
    min-width: 0;
    min-height: 40px;
    padding: 6px 10px;
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-2xs);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .cs-repo-action:disabled { opacity: 0.45; cursor: default; }
  .cs-repo-action span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .cs-repo-action:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .cs-repo-action-danger:hover { color: var(--a2-red); border-color: var(--a2-red-border); }
  .cs-repo-action[data-copied='true'] { color: var(--a2-green); border-color: rgba(0, 255, 156, 0.35); }
  .cs-repo-main, .cs-ext-main { min-width: 0; display: flex; flex-direction: column; gap: var(--a2-space-1); flex: 1; }
  .cs-ext-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .cs-repo-meta, .cs-ext-meta {
    display: flex;
    gap: var(--a2-space-1);
    flex-wrap: wrap;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
  }
  .cs-repo-stats {
    display: flex;
    gap: var(--a2-space-1);
    flex-wrap: wrap;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text);
    background: var(--a2-surface-4);
    border-radius: var(--a2-radius-xs);
    padding: 2px 6px;
    width: fit-content;
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
  .cs-ext-actions { display: flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
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
  .a2-icon-btn:disabled { opacity: 0.45; cursor: default; }
  .a2-icon-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .cs-build-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .cs-row-select, .cs-select-all input { width: 18px; height: 18px; accent-color: var(--a2-cyan); flex-shrink: 0; }
  .cs-select-all {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
    cursor: pointer;
    min-height: 32px;
  }
  .cs-list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-2);
    flex-wrap: wrap;
    padding: var(--a2-space-1) var(--a2-space-2);
  }
  .cs-list-count { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }

  /* §11 sticky toolbar */
  .cs-toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    gap: var(--a2-space-2);
    align-items: flex-end;
    flex-wrap: wrap;
    padding: var(--a2-space-2);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .cs-toolbar-search {
    display: flex;
    align-items: center;
    gap: var(--a2-space-1);
    flex: 1 1 220px;
    min-width: 200px;
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    padding: 0 var(--a2-space-2);
    color: var(--a2-text-muted);
    min-height: 44px;
  }
  .cs-toolbar-search input {
    flex: 1;
    background: none;
    border: none;
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    outline: none;
    min-width: 0;
  }
  .cs-toolbar-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 110px;
  }
  .cs-toolbar-field span {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    text-transform: uppercase;
    font-weight: 700;
  }
  .cs-toolbar-field select {
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    padding: 6px 8px;
    min-height: 32px;
    cursor: pointer;
  }
  .cs-toolbar-clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--a2-text-muted);
    cursor: pointer;
    padding: 4px;
    min-width: 28px;
    min-height: 28px;
  }
  .cs-toolbar-clear:hover { color: var(--a2-cyan); }
  .cs-sort-dir { min-width: 44px; min-height: 44px; }

  /* §11 stats header */
  .cs-stats {
    display: flex;
    gap: var(--a2-space-2);
    flex-wrap: wrap;
    align-items: baseline;
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border-radius: var(--a2-radius-sm);
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
  }
  .cs-stats-name { font-weight: 700; color: var(--a2-text-bright); }
  .cs-stat-label { color: var(--a2-text-dim); font-weight: 700; }

  /* §12 local notice */
  .cs-local-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-green-soft);
    border: 1px solid var(--a2-green-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-green);
    font-size: var(--a2-text-2xs);
  }

  /* §11 bulk bar */
  .cs-bulkbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-2);
    flex-wrap: wrap;
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
  }
  .cs-bulkbar[data-visible="false"] { display: none; }
  .cs-bulk-count { font-size: var(--a2-text-2xs); color: var(--a2-text); font-weight: 600; }
  .cs-bulk-actions { display: flex; gap: var(--a2-space-2); flex-wrap: wrap; }
  .cs-bulk-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    min-height: 36px;
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-2xs);
    font-weight: 600;
    cursor: pointer;
  }
  .cs-bulk-btn:disabled { opacity: 0.45; cursor: default; }
  .cs-bulk-btn:hover:not(:disabled) { border-color: var(--a2-cyan-border); color: var(--a2-cyan); }
  .cs-bulk-build:hover:not(:disabled) { border-color: var(--a2-cyan-border); }
  .cs-bulk-stop { color: var(--a2-red); border-color: var(--a2-red-border); }
  .cs-bulk-progress {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
  }
  .cs-bulk-progress-line { font-size: var(--a2-text-2xs); color: var(--a2-text-bright); }
  .cs-bulk-current { font-weight: 600; }
  .cs-bulk-results {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 180px;
    overflow-y: auto;
  }
  .cs-bulk-result {
    display: flex;
    gap: var(--a2-space-2);
    flex-wrap: wrap;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
  }
  .cs-bulk-result[data-ok="false"] { color: var(--a2-red); }
  .cs-bulk-result[data-ok="true"] { color: var(--a2-green); }
  .cs-bulk-result-name { font-weight: 600; }

  /* §13 state notes */
  .cs-state-note {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
    line-height: 1.5;
  }
  .cs-state-note[data-kind="runtime_required"] { color: var(--a2-text-dim); }
  .cs-state-note[data-kind="failed"] { color: var(--a2-red); }
  .cs-pending-note {
    font-size: var(--a2-text-2xs);
    color: var(--a2-cyan);
  }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  /* §11 pagination */
  .cs-pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-2);
    flex-wrap: wrap;
    padding: var(--a2-space-2) var(--a2-space-3);
  }
  .cs-pager-info { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .cs-pager-controls { display: flex; align-items: center; gap: var(--a2-space-2); }
  .cs-pager-current { font-size: var(--a2-text-2xs); color: var(--a2-text); }

  /* §15 test panel (unchanged presentation) */
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
    /* §14: repository cards are already column-shaped with a full-width
       action row; on narrow phones the badges wrap under the name and the
       action buttons wrap 3+2 while staying evenly sized and reachable. */
    .cs-repo-head { flex-direction: column; align-items: stretch; }
    .cs-repo-badges { justify-content: flex-start; }
    .cs-repo-action { flex: 1 1 calc(50% - var(--a2-space-1)); }
    .cs-repo-action-form { flex: 1 1 calc(50% - var(--a2-space-1)); }
    .cs-ext-row { flex-direction: column; align-items: stretch; }
    .cs-ext-actions { justify-content: flex-start; }
    .cs-toolbar { position: static; }
    .cs-toolbar-field { flex: 1 1 45%; min-width: 0; }
    .cs-pager { justify-content: center; }
  }

  /* ===== FINAL TASK (PART G) — global source position control ===== */
  .cs-position { display: inline-flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; }
  .cs-position[data-pending='true'] { opacity: 0.75; }
  .cs-position-label { font-size: var(--a2-text-xs); font-weight: 700; color: var(--a2-text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .cs-position-input {
    width: 64px;
    padding: 6px 8px;
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-3);
    color: var(--a2-text);
    font: inherit;
    font-size: var(--a2-text-sm);
    text-align: center;
  }
  .cs-position-input:focus-visible { outline: none; border-color: var(--a2-cyan); box-shadow: 0 0 0 2px var(--a2-cyan-soft); }
  .cs-position-input:disabled { opacity: 0.6; }
  .cs-position-btn { min-width: 36px; min-height: 36px; }
  .cs-position-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .cs-position-spin { display: inline-flex; animation: cs-position-spin 0.9s linear infinite; }
  @keyframes cs-position-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .cs-position-spin { animation: none; } }
</style>
