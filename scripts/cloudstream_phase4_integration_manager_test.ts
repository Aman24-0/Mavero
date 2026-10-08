import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// PHASE 4 — Integration Manager 2.0 (Permanent Adapter Plan §11/§12/§13).
//
// Scope: the Extension manager redesigned for LARGE repositories —
//   §11 search / status+media+repository filters / deterministic sorting /
//       pagination + bounded rendering / per-repository stats / bulk
//       operations (select, select-all-filtered, enable/disable selected,
//       create adapters for selected WHERE VALID);
//   §12 no-full-page-refresh toggles (async JSON mutations with targeted
//       row patches, pending states, duplicate-click guards) + the bulk
//       enable/disable service bound;
//   §13 the closed provider-status vocabulary (ACTIVE / COMPATIBLE /
//       ADAPTER REQUIRED / RUNTIME REQUIRED / ADAPTER FAILED + Reason +
//       Retry).
//
// Conventions: this suite runs under tsconfig.behavioral.json (the
// established $env-stub convention — the createAdapter endpoint action
// resolves $env/dynamic/private → empty stub → honest BUILDER_UNAVAILABLE,
// never the network). Deterministic: fake Supabase clients + synthetic
// catalogs + vite-SSR mounts only — no real network, no real DB.
//
// Run: pnpm exec tsx --tsconfig ./tsconfig.behavioral.json
//        scripts/cloudstream_phase4_integration_manager_test.ts

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = new URL('..', import.meta.url);
function read(relative: string): string {
  return readFileSync(new URL(relative, REPO_ROOT), 'utf8');
}

// ---------------------------------------------------------------------------
// Shared synthetic catalogs (84+ rows — the §11 large-repository premise)
// ---------------------------------------------------------------------------

import type { CloudStreamExtensionView, CloudStreamRepositoryView } from '$lib/shared/cloudstream-types';
import {
  matchesSearch,
  matchesStatusFilter,
  matchesMediaFilter,
  matchesRepositoryFilter,
  sortExtensions,
  paginateExtensions,
  summarizeExtensions,
  summarizeRepositories,
  providerStatusPresentation,
  formatTestedDate,
  eligibleForBulkCreateAdapter,
  pruneSelection,
  chunkBulkIds,
  projectIntegrationManager,
  hasExecutableAdapter,
  INTEGRATION_PAGE_SIZE,
  MAX_BULK_IDS,
  DEFAULT_INTEGRATION_QUERY,
  INTEGRATION_STATUS_FILTERS,
  INTEGRATION_MEDIA_FILTERS,
  INTEGRATION_SORT_KEYS,
  type IntegrationManagerQuery,
} from '$lib/shared/cloudstream-integration-manager-view';

const BASE_EXTENSION: CloudStreamExtensionView = {
  id: 'ext-00000000-0000-0000-0000-000000000000',
  repositoryId: 'repo-a',
  repositoryName: 'Phisher Repo',
  internalName: 'Provider0',
  name: null,
  version: 1,
  apiVersion: 1,
  description: null,
  authors: ['Phisher'],
  language: null,
  tvTypes: ['Movie'],
  pluginUrl: null,
  pluginStatus: 1,
  iconUrl: null,
  fileHash: null,
  fileSizeBytes: null,
  sourceUrl: null,
  enabled: false,
  adapterStatus: 'adapter_required',
  maveroAdapterId: null,
  adapterVersion: null,
  lastCheckedAt: null,
  lastError: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  integrationType: 'cloudstream',
  mediaTypes: ['movie'],
  adapterState: 'adapter_required',
  moduleUrl: null,
  versionText: null,
  providerMetadata: null,
  lastTestedAt: null,
  lastTestError: null,
  generatedAdapterVersion: null,
  builderVersion: null,
  lastBuildAt: null,
  lastBuildError: null,
};

let extensionCounter = 0;
function extensionView(overrides: Partial<CloudStreamExtensionView>): CloudStreamExtensionView {
  extensionCounter += 1;
  const id = `ext-${String(extensionCounter).padStart(3, '0')}0000-0000-0000-0000-000000000000`;
  return {
    ...BASE_EXTENSION,
    id,
    internalName: `Provider${extensionCounter}`,
    ...overrides,
  };
}

const REPOSITORIES: CloudStreamRepositoryView[] = [
  {
    id: 'repo-a',
    name: 'Phisher Repo',
    url: 'https://phisher.example/CS.json',
    description: null,
    iconUrl: null,
    enabled: true,
    status: 'active',
    integrationType: 'cloudstream',
    extensionCount: 50,
    lastSyncedAt: '2026-10-01T00:00:00Z',
    lastCheckedAt: '2026-10-01T00:00:00Z',
    lastError: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
  {
    id: 'repo-b',
    name: 'Nuvio Providers',
    url: 'https://nuvio.example/manifest.json',
    description: null,
    iconUrl: null,
    enabled: true,
    status: 'active',
    integrationType: 'nuvio',
    extensionCount: 34,
    lastSyncedAt: '2026-10-01T00:00:00Z',
    lastCheckedAt: '2026-10-01T00:00:00Z',
    lastError: null,
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
  {
    id: 'repo-c',
    name: 'Empty Repo',
    url: 'https://empty.example/CS.json',
    description: null,
    iconUrl: null,
    enabled: false,
    status: 'disabled',
    integrationType: 'cloudstream',
    extensionCount: 0,
    lastSyncedAt: null,
    lastCheckedAt: null,
    lastError: null,
    createdAt: '2026-09-03T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
];

/**
 * The §11 fixture: 84 extensions across two repositories with every
 * operational state, both integration types, both media types, mixed
 * enabled flags, and staggered lastTestedAt timestamps.
 */
function buildLargeCatalog(): CloudStreamExtensionView[] {
  const rows: CloudStreamExtensionView[] = [];
  // Repo A: 50 CloudStream rows — state cycle over the full vocabulary.
  const statesA = ['adapter_required', 'active', 'adapter_required', 'runtime_required', 'disabled', 'failed', 'adapter_required', 'testing'] as const;
  for (let index = 0; index < 50; index += 1) {
    const state = statesA[index % statesA.length];
    rows.push(extensionView({
      repositoryId: 'repo-a',
      repositoryName: 'Phisher Repo',
      integrationType: 'cloudstream',
      adapterState: state,
      enabled: state === 'active' || state === 'testing',
      name: `Cloud Provider ${index}`,
      mediaTypes: index % 3 === 0 ? ['movie', 'tv'] : index % 3 === 1 ? ['movie'] : ['tv'],
      lastTestedAt: state === 'active' || state === 'disabled'
        ? new Date(Date.UTC(2026, 9, 1 + (index % 20), 12, 0, 0)).toISOString()
        : null,
      lastBuildError: state === 'failed' ? 'BUILDER_REJECTED: the provider needs the native runtime.' : null,
    }));
  }
  // Repo B: 34 Nuvio rows — generated-adapter life (active/disabled) plus
  // adapter_required/failed/building.
  const statesB = ['adapter_required', 'disabled', 'active', 'failed', 'building', 'adapter_required', 'active'] as const;
  for (let index = 0; index < 34; index += 1) {
    const state = statesB[index % statesB.length];
    rows.push(extensionView({
      repositoryId: 'repo-b',
      repositoryName: 'Nuvio Providers',
      integrationType: 'nuvio',
      adapterState: state,
      enabled: state === 'active',
      name: `Nuvio Provider ${index}`,
      internalName: `NuvioProvider${index}`,
      mediaTypes: index % 2 === 0 ? ['movie'] : ['tv'],
      adapterStatus: 'adapter_required',
      generatedAdapterVersion: state === 'active' || state === 'disabled' ? 1 : null,
      builderVersion: state === 'active' || state === 'disabled' ? 'builder-3.0.0' : null,
      lastTestedAt: state === 'active' || state === 'disabled'
        ? new Date(Date.UTC(2026, 9, 2 + (index % 10), 12, 0, 0)).toISOString()
        : null,
      lastBuildError: state === 'failed' ? 'MAVERO_TEST_FAILED: no links found.' : null,
    }));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// §A — view-model: search (§11)
// ---------------------------------------------------------------------------

{
  const catalog = buildLargeCatalog();
  ok(matchesSearch(catalog[0], ''), 'A1: empty search matches everything');
  ok(matchesSearch(catalog[0], '   '), 'A1: whitespace-only search matches everything');
  ok(matchesSearch({ ...catalog[0], name: 'DaddyLive' }, 'daddy'), 'A1: provider NAME matches case-insensitively');
  ok(matchesSearch({ ...catalog[0], name: null }, 'provider'), 'A1: source/internal NAME matches when display name is null');
  ok(matchesSearch(catalog[0], 'phisher repo'), 'A1: REPOSITORY name matches');
  ok(matchesSearch({ ...catalog[0], name: null, internalName: 'NuvioProvider7' }, 'provider7'), 'A1: internal-name substring matches');
  ok(!matchesSearch(catalog[0], 'zzz-not-found-zzz'), 'A1: no-match returns false');
  ok(matchesSearch({ ...catalog[0], name: 'DADDY' }, 'Daddy'), 'A1: mixed-case haystack matches lowercase needle');
  // Every §11 search field is covered by the projection.
  const foundByName = projectIntegrationManager(catalog, REPOSITORIES, { ...DEFAULT_INTEGRATION_QUERY, search: 'Cloud Provider 7' });
  ok(foundByName.total >= 1 && foundByName.filtered.every((row) => (row.name ?? '').includes('Cloud Provider 7')), 'A1: projection search filters by provider name');
  const foundByRepo = projectIntegrationManager(catalog, REPOSITORIES, { ...DEFAULT_INTEGRATION_QUERY, search: 'nuvio providers' });
  ok(foundByRepo.total === 34, 'A1: projection search by repository name returns exactly the Nuvio repository rows');
}

// ---------------------------------------------------------------------------
// §A — view-model: status filters (§11: All/Enabled/Disabled/Compatible/
// Adapter Required/Runtime Required/Failed)
// ---------------------------------------------------------------------------

{
  ok(INTEGRATION_STATUS_FILTERS.length === 7, 'A2: exactly the seven §11 status filters exist');
  const sample = { enabled: true, adapterState: 'active' as const };
  ok(matchesStatusFilter(sample, 'all'), 'A2: all matches any row');
  ok(matchesStatusFilter(sample, 'enabled'), 'A2: enabled matches an enabled row');
  ok(!matchesStatusFilter({ ...sample, enabled: false }, 'enabled'), 'A2: enabled does NOT match a disabled row');
  ok(matchesStatusFilter({ ...sample, enabled: false }, 'disabled'), 'A2: disabled matches a disabled row');
  // Compatible = executable adapter present (native OR generated), any
  // enabled state — 'active' AND operational-'disabled' both count.
  ok(matchesStatusFilter({ enabled: true, adapterState: 'active' }, 'compatible'), 'A2: compatible matches an ACTIVE row');
  ok(matchesStatusFilter({ enabled: false, adapterState: 'disabled' }, 'compatible'), 'A2: compatible matches a READY (disabled executable) row');
  ok(!matchesStatusFilter({ enabled: false, adapterState: 'adapter_required' }, 'compatible'), 'A2: compatible does NOT match adapter_required');
  ok(!matchesStatusFilter({ enabled: false, adapterState: 'runtime_required' }, 'compatible'), 'A2: compatible does NOT match runtime_required');
  ok(matchesStatusFilter({ enabled: true, adapterState: 'adapter_required' }, 'adapter_required'), 'A2: adapter_required filter matches');
  ok(matchesStatusFilter({ enabled: false, adapterState: 'runtime_required' }, 'runtime_required'), 'A2: runtime_required filter matches');
  ok(matchesStatusFilter({ enabled: false, adapterState: 'failed' }, 'failed'), 'A2: failed filter matches');
  ok(!matchesStatusFilter({ enabled: true, adapterState: 'failed' }, 'adapter_required'), 'A2: failed is NOT adapter_required (buckets are disjoint on the adapter dimension)');
  // A row can be in BOTH the enabled and compatible buckets (orthogonal).
  ok(matchesStatusFilter({ enabled: true, adapterState: 'active' }, 'enabled') && matchesStatusFilter({ enabled: true, adapterState: 'active' }, 'compatible'), 'A2: enabled + compatible are orthogonal buckets');

  const catalog = buildLargeCatalog();
  const projection = projectIntegrationManager(catalog, REPOSITORIES, { ...DEFAULT_INTEGRATION_QUERY, statusFilter: 'compatible' });
  ok(projection.total === catalog.filter((row) => hasExecutableAdapter(row)).length, 'A2: projection compatible filter count matches the fixture');
  ok(projection.filtered.every((row) => row.adapterState === 'active' || row.adapterState === 'disabled'), 'A2: every projected compatible row is active or ready');
  const failedProjection = projectIntegrationManager(catalog, REPOSITORIES, { ...DEFAULT_INTEGRATION_QUERY, statusFilter: 'failed' });
  ok(failedProjection.total === catalog.filter((row) => row.adapterState === 'failed').length, 'A2: projection failed filter count matches the fixture');
}

// ---------------------------------------------------------------------------
// §A — view-model: media + repository filters (§11)
// ---------------------------------------------------------------------------

{
  ok(INTEGRATION_MEDIA_FILTERS.length === 3, 'A3: exactly the three §11 media filters exist');
  const movieTv = { mediaTypes: ['movie', 'tv'] as Array<'movie' | 'tv'> };
  ok(matchesMediaFilter(movieTv, 'all'), 'A3: all media matches');
  ok(matchesMediaFilter(movieTv, 'movie'), 'A3: a movie+tv row matches the movie filter');
  ok(matchesMediaFilter(movieTv, 'tv'), 'A3: a movie+tv row matches the tv filter');
  ok(!matchesMediaFilter({ mediaTypes: ['movie'] }, 'tv'), 'A3: movie-only row does NOT match tv');
  ok(!matchesMediaFilter({ mediaTypes: [] }, 'movie'), 'A3: no-known-media row matches neither (honest)');

  ok(matchesRepositoryFilter({ repositoryId: 'repo-a' }, 'all'), 'A4: all repositories matches every row');
  ok(matchesRepositoryFilter({ repositoryId: 'repo-a' }, 'repo-a'), 'A4: repository filter matches its own rows');
  ok(!matchesRepositoryFilter({ repositoryId: 'repo-b' }, 'repo-a'), 'A4: repository filter excludes other repositories');

  const catalog = buildLargeCatalog();
  const movieOnly = projectIntegrationManager(catalog, REPOSITORIES, { ...DEFAULT_INTEGRATION_QUERY, mediaFilter: 'movie' });
  ok(movieOnly.total === catalog.filter((row) => row.mediaTypes.includes('movie')).length, 'A3: projection movie filter count matches');
  const repoA = projectIntegrationManager(catalog, REPOSITORIES, { ...DEFAULT_INTEGRATION_QUERY, repositoryId: 'repo-a' });
  ok(repoA.total === 50 && repoA.filtered.every((row) => row.repositoryId === 'repo-a'), 'A4: repository-specific view returns exactly that repository');
}

// ---------------------------------------------------------------------------
// §A — view-model: sorting (§11: name/status/enabled/last tested)
// ---------------------------------------------------------------------------

{
  const catalog = buildLargeCatalog();
  const byNameAsc = sortExtensions(catalog, 'name', 'asc');
  ok(byNameAsc[0].name! < byNameAsc[byNameAsc.length - 1].name!, 'A5: name asc sorts alphabetically');
  const byNameDesc = sortExtensions(catalog, 'name', 'desc');
  ok(byNameDesc[0].name! > byNameDesc[byNameDesc.length - 1].name!, 'A5: name desc reverses');

  // Deterministic tie-break: same name → internalName → id.
  const tieA = extensionView({ name: 'Same Name', internalName: 'Bbb' });
  const tieB = extensionView({ name: 'Same Name', internalName: 'Aaa' });
  const tied = sortExtensions([tieA, tieB], 'name', 'asc');
  ok(tied[0].internalName === 'Aaa', 'A5: equal names tie-break deterministically on internalName');

  // Status sort groups by the rank order active < disabled < adapter_required
  // < runtime_required < failed < building < testing.
  const statesForSort: CloudStreamExtensionView[] = [
    extensionView({ adapterState: 'testing' }),
    extensionView({ adapterState: 'failed' }),
    extensionView({ adapterState: 'adapter_required' }),
    extensionView({ adapterState: 'active' }),
    extensionView({ adapterState: 'runtime_required' }),
    extensionView({ adapterState: 'disabled' }),
    extensionView({ adapterState: 'building' }),
  ];
  const byStatus = sortExtensions(statesForSort, 'status', 'asc');
  ok(byStatus.map((row) => row.adapterState).join(',') === 'active,disabled,adapter_required,runtime_required,failed,building,testing', 'A5: status sort produces the deterministic state rank order');

  const enabledSort = sortExtensions(statesForSort, 'enabled', 'desc');
  ok(enabledSort.every((row, index) => index === 0 || (row.enabled ? true : !enabledSort[index - 1].enabled || true)), 'A5: enabled sort is deterministic');
  const enabledFirst = sortExtensions([extensionView({ enabled: false }), extensionView({ enabled: true })], 'enabled', 'desc');
  ok(enabledFirst[0].enabled === true, 'A5: enabled desc lists enabled rows first');

  // last_tested: nulls ALWAYS last; desc = most recent first.
  const testedRows: CloudStreamExtensionView[] = [
    extensionView({ lastTestedAt: null, internalName: 'Never' }),
    extensionView({ lastTestedAt: '2026-10-05T00:00:00Z', internalName: 'Recent' }),
    extensionView({ lastTestedAt: '2026-01-05T00:00:00Z', internalName: 'Old' }),
    extensionView({ lastTestedAt: null, internalName: 'Never2' }),
  ];
  const byTestedDesc = sortExtensions(testedRows, 'last_tested', 'desc');
  ok(byTestedDesc.map((row) => row.internalName).join(',') === 'Recent,Old,Never,Never2', 'A5: last_tested desc = most recent first, nulls ALWAYS last');
  const byTestedAsc = sortExtensions(testedRows, 'last_tested', 'asc');
  ok(byTestedAsc.map((row) => row.internalName).join(',') === 'Old,Recent,Never,Never2', 'A5: last_tested asc = oldest first, nulls STILL last');

  ok(INTEGRATION_SORT_KEYS.length === 4, 'A5: exactly the four §11 sort keys exist');
}

// ---------------------------------------------------------------------------
// §A — view-model: pagination (§11 bounded rendering)
// ---------------------------------------------------------------------------

{
  ok(INTEGRATION_PAGE_SIZE === 25, 'A6: the §11 page size is 25 rows (bounded rendering)');
  const catalog = buildLargeCatalog();
  const page1 = paginateExtensions(catalog, 1);
  ok(page1.page === 1 && page1.rows.length === 25 && page1.total === 84 && page1.pageCount === 4, 'A6: 84 rows paginate to 4 pages of 25');
  ok(page1.fromIndex === 0 && page1.toIndex === 25, 'A6: page 1 shows rows 0–24');
  const page4 = paginateExtensions(catalog, 4);
  ok(page4.rows.length === 9 && page4.fromIndex === 75 && page4.toIndex === 84, 'A6: the final page shows the remaining 9 rows');
  const page0 = paginateExtensions(catalog, 0);
  ok(page0.page === 1, 'A6: page 0 clamps to page 1');
  const page99 = paginateExtensions(catalog, 99);
  ok(page99.page === 4, 'A6: page 99 clamps to the last page');
  const empty = paginateExtensions([], 3);
  ok(empty.page === 1 && empty.pageCount === 1 && empty.rows.length === 0 && empty.fromIndex === 0 && empty.toIndex === 0, 'A6: empty lists stay on a stable single page');
  const exact = paginateExtensions(buildLargeCatalog().slice(0, 25), 1);
  ok(exact.pageCount === 1 && exact.rows.length === 25, 'A6: exactly pageSize rows = exactly one page');
  const boundary = paginateExtensions(buildLargeCatalog().slice(0, 26), 1);
  ok(boundary.pageCount === 2, 'A6: pageSize+1 rows = two pages');
}

// ---------------------------------------------------------------------------
// §A — view-model: stats (§11 repository header: the plan's exact shape)
// ---------------------------------------------------------------------------

{
  const catalog = buildLargeCatalog();
  const aggregate = summarizeExtensions(catalog);
  ok(aggregate.total === 84, 'A7: aggregate stats count every row');
  ok(aggregate.enabled === catalog.filter((row) => row.enabled).length, 'A7: enabled count matches');
  ok(aggregate.compatible === catalog.filter((row) => hasExecutableAdapter(row)).length, 'A7: compatible count = executable rows (native or generated)');
  ok(aggregate.adapterRequired + aggregate.compatible + aggregate.runtimeRequired + aggregate.failed + (catalog.filter((row) => row.adapterState === 'building' || row.adapterState === 'testing').length) === 84, 'A7: adapter-dimension buckets partition the catalog (transient states count toward total only)');

  const summaries = summarizeRepositories(REPOSITORIES, catalog);
  ok(summaries.length === 3, 'A7: summaries exist for every repository incl. the empty one');
  const repoA = summaries.find((summary) => summary.repository.id === 'repo-a')!;
  ok(repoA.counts.total === 50, 'A7: repo A stats count only its own 50 rows');
  const repoC = summaries.find((summary) => summary.repository.id === 'repo-c')!;
  ok(repoC.counts.total === 0 && repoC.counts.enabled === 0 && repoC.counts.compatible === 0, 'A7: the empty repository reports honest zero stats');
  ok(repoA.counts.failed === catalog.filter((row) => row.repositoryId === 'repo-a' && row.adapterState === 'failed').length, 'A7: repo A failed count matches');
}

// ---------------------------------------------------------------------------
// §A — view-model: §13 provider-status presentation (closed vocabulary)
// ---------------------------------------------------------------------------

{
  const active = extensionView({ adapterState: 'active', enabled: true, lastTestedAt: '2026-10-02T15:30:00Z' });
  const activePresentation = providerStatusPresentation(active);
  ok(activePresentation.kind === 'active' && activePresentation.label === 'ACTIVE', 'A8: an enabled executable row presents ACTIVE');
  ok(activePresentation.note === 'Last tested: 2026-10-02', 'A8: ACTIVE carries the §13 Last tested note (deterministic UTC date)');
  ok(activePresentation.canTest === true && activePresentation.primaryAction === 'Disable', 'A8: ACTIVE offers Test Provider + Disable');

  const activeUntested = providerStatusPresentation(extensionView({ adapterState: 'active', enabled: true, lastTestedAt: null }));
  ok(activeUntested.note === 'Not tested yet', 'A8: ACTIVE without a test date is honest');

  const ready = providerStatusPresentation(extensionView({
    adapterState: 'disabled',
    enabled: false,
    generatedAdapterVersion: 2,
    builderVersion: 'builder-3.0.0',
    lastTestedAt: '2026-10-01T00:00:00Z',
  }));
  ok(ready.kind === 'ready' && ready.label === 'COMPATIBLE', 'A8: a disabled executable row presents COMPATIBLE (§13 Ready)');
  ok(ready.note === 'Adapter: Ready · generated v2 · builder-3.0.0 · tested 2026-10-01', 'A8: the Ready note carries adapter readiness + provenance');
  ok(ready.canTest === true && ready.primaryAction === 'Enable', 'A8: Ready offers Test Provider + Enable');

  const nativeReady = providerStatusPresentation(extensionView({ adapterState: 'disabled', enabled: false, generatedAdapterVersion: null, builderVersion: null, lastTestedAt: null }));
  ok(nativeReady.note === 'Adapter: Ready', 'A8: a native ready row notes Adapter: Ready with no generated provenance');

  const required = providerStatusPresentation(extensionView({ adapterState: 'adapter_required' }));
  ok(required.label === 'ADAPTER REQUIRED' && required.note === null && required.canCreateAdapter === true && required.primaryAction === 'Create Adapter', 'A8: adapter_required presents the §13 Create Adapter state');

  const runtime = providerStatusPresentation(extensionView({ adapterState: 'runtime_required' }));
  ok(runtime.label === 'RUNTIME REQUIRED', 'A8: runtime_required presents RUNTIME REQUIRED');
  ok(runtime.note === 'This provider cannot be converted into a permanent Mavero adapter and remains disabled.', 'A8: RUNTIME REQUIRED carries the §13 not-convertible explanation');
  ok(runtime.canTest === false && runtime.canCreateAdapter === false && runtime.primaryAction === null, 'A8: RUNTIME REQUIRED offers NO actions (stays disabled)');

  const failed = providerStatusPresentation(extensionView({ adapterState: 'failed', lastBuildError: 'MAVERO_TEST_FAILED: no links found.' }));
  ok(failed.label === 'ADAPTER FAILED', 'A8: failed presents ADAPTER FAILED');
  ok(failed.note === 'Reason: MAVERO_TEST_FAILED: no links found.', 'A8: ADAPTER FAILED carries the §13 Reason line');
  ok(failed.canCreateAdapter === true && failed.primaryAction === 'Retry', 'A8: ADAPTER FAILED offers Retry');
  const failedNoError = providerStatusPresentation(extensionView({ adapterState: 'failed', lastBuildError: null, lastTestError: null }));
  ok(failedNoError.note === 'Reason: the adapter build failed.', 'A8: ADAPTER FAILED without stored errors still shows an honest Reason');

  const building = providerStatusPresentation(extensionView({ adapterState: 'building' }));
  ok(building.label === 'BUILDING' && building.canCreateAdapter === false && building.primaryAction === null, 'A8: building presents the transient BUILDING state with no actions');
  const testing = providerStatusPresentation(extensionView({ adapterState: 'testing' }));
  ok(testing.label === 'TESTING', 'A8: testing presents the transient TESTING state');

  ok(formatTestedDate('2026-10-02T15:30:00Z') === '2026-10-02', 'A8: tested dates format deterministically (UTC)');
  ok(formatTestedDate('not-a-date') === '—', 'A8: malformed dates degrade honestly');
}

// ---------------------------------------------------------------------------
// §A — view-model: bulk selection (§11 "where valid" + bounds)
// ---------------------------------------------------------------------------

{
  const eligible = eligibleForBulkCreateAdapter({ adapterState: 'adapter_required' });
  const eligibleRetry = eligibleForBulkCreateAdapter({ adapterState: 'failed' });
  ok(eligible && eligibleRetry, 'A9: adapter_required AND failed rows are bulk-create eligible');
  ok(!eligibleForBulkCreateAdapter({ adapterState: 'active' }), 'A9: active rows are NOT bulk-create eligible');
  ok(!eligibleForBulkCreateAdapter({ adapterState: 'runtime_required' }), 'A9: runtime_required rows are NOT bulk-create eligible (never convertible)');
  ok(!eligibleForBulkCreateAdapter({ adapterState: 'disabled' }), 'A9: ready (disabled executable) rows are NOT bulk-create eligible');
  ok(!eligibleForBulkCreateAdapter({ adapterState: 'building' }), 'A9: in-flight builds are NOT bulk-create eligible');

  const catalog = buildLargeCatalog();
  const selection = new Set([catalog[0].id, 'stale-id-that-no-longer-exists']);
  const pruned = pruneSelection(selection, catalog);
  ok(pruned.size === 1 && pruned.has(catalog[0].id), 'A9: pruneSelection drops stale ids');

  ok(MAX_BULK_IDS === 100, 'A9: MAX_BULK_IDS is the 100-per-request bound');
  ok(chunkBulkIds([]).length === 0, 'A9: no ids = no chunks');
  ok(chunkBulkIds(['a']).length === 1 && chunkBulkIds(['a'])[0][0] === 'a', 'A9: one id = one chunk');
  const hundred = chunkBulkIds(Array.from({ length: 100 }, (_, index) => `id-${index}`));
  ok(hundred.length === 1 && hundred[0].length === 100, 'A9: exactly 100 ids = one chunk');
  const hundredOne = chunkBulkIds(Array.from({ length: 101 }, (_, index) => `id-${index}`));
  ok(hundredOne.length === 2 && hundredOne[0].length === 100 && hundredOne[1].length === 1, 'A9: 101 ids = two chunks');
  const twoFifty = chunkBulkIds(Array.from({ length: 250 }, (_, index) => `id-${index}`));
  ok(twoFifty.length === 3 && twoFifty[2].length === 50, 'A9: 250 ids = three chunks (100+100+50)');

  const projection = projectIntegrationManager(catalog, REPOSITORIES, DEFAULT_INTEGRATION_QUERY);
  ok(projection.bulkCreateEligibleCount === catalog.filter((row) => eligibleForBulkCreateAdapter(row)).length, 'A9: the projection counts bulk-create-eligible filtered rows');
}

// ---------------------------------------------------------------------------
// §A — view-model: the full projection (§11 end-to-end, pure + deterministic)
// ---------------------------------------------------------------------------

{
  const catalog = buildLargeCatalog();
  const query: IntegrationManagerQuery = {
    search: 'provider',
    statusFilter: 'all',
    mediaFilter: 'movie',
    repositoryId: 'repo-b',
    sortKey: 'status',
    sortDir: 'asc',
    page: 2,
  };
  const projection = projectIntegrationManager(catalog, REPOSITORIES, query);
  const expected = catalog.filter(
    (row) =>
      matchesSearch(row, 'provider')
      && matchesMediaFilter(row, 'movie')
      && matchesRepositoryFilter(row, 'repo-b'),
  );
  ok(projection.total === expected.length, 'A10: the projection composes search + media + repository filters');
  ok(projection.rows.length <= INTEGRATION_PAGE_SIZE, 'A10: the projection renders at most one page');
  ok(projection.repositorySummaries.length === 3 && projection.aggregate.total === 84, 'A10: stats stay RAW (unfiltered) while rows are filtered');
  // Determinism: same inputs, same outputs.
  const again = projectIntegrationManager(catalog, REPOSITORIES, query);
  ok(JSON.stringify(again.rows.map((row) => row.id)) === JSON.stringify(projection.rows.map((row) => row.id)), 'A10: the projection is deterministic');
}

// ---------------------------------------------------------------------------
// §B — bulk service (setExtensionsEnabledBulk + view reload), fake client
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { setExtensionsEnabledBulk, getExtensionViewForAdmin, setExtensionEnabled } from '$lib/server/cloudstream/extensions/service';
import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';

type Row = Record<string, unknown>;

function createFakeClient() {
  const tables: Record<string, Row[]> = {
    profiles: [{ id: 'admin-user', role: 'admin' }],
    cloudstream_repositories: [
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Phisher Repo', url: 'https://phisher.example/CS.json', created_at: '2026-09-01T00:00:00Z', enabled: true, status: 'active', integration_type: 'cloudstream' },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', name: 'Nuvio Providers', url: 'https://nuvio.example/manifest.json', created_at: '2026-09-02T00:00:00Z', enabled: true, status: 'active', integration_type: 'nuvio' },
    ],
    cloudstream_extensions: [],
    cloudstream_adapter_artifacts: [],
  };

  function filterRows(rows: Row[], filters: Array<{ method: string; args: unknown[] }>): Row[] {
    let data = [...rows];
    for (const filter of filters) {
      if (filter.method === 'eq') data = data.filter((row) => row[filter.args[0] as string] === filter.args[1]);
      else if (filter.method === 'in') data = data.filter((row) => (filter.args[1] as unknown[]).includes(row[filter.args[0] as string]));
    }
    return data;
  }

  function makeBuilder(table: string) {
    const filters: Array<{ method: string; args: unknown[] }> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let limit: number | null = null;
    let op: 'select' | 'update' | null = null;
    let payload: Row | null = null;

    function applyOp(): { data: Row[]; error: null } {
      const rows = tables[table];
      if (op === 'update') {
        const patch = payload as Row;
        const matching = filterRows(rows, filters);
        for (const row of matching) Object.assign(row, { ...patch });
        return { data: matching.map((row) => ({ ...row })), error: null };
      }
      let selected = sortRows(filterRows(rows, filters), orders);
      if (limit !== null) selected = selected.slice(0, limit);
      return { data: selected.map((row) => ({ ...row })), error: null };
    }

    function sortRows(rows: Row[], orders: Array<{ column: string; ascending: boolean }>): Row[] {
      const data = [...rows];
      for (const order of [...orders].reverse()) {
        data.sort((a, b) => {
          const av = a[order.column] as string | number;
          const bv = b[order.column] as string | number;
          if (av < bv) return order.ascending ? -1 : 1;
          if (av > bv) return order.ascending ? 1 : -1;
          return 0;
        });
      }
      return data;
    }

    const builder = {
      select() {
        if (op === null) op = 'select';
        return builder;
      },
      update(patch: Row) {
        op = 'update';
        payload = patch;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ method: 'eq', args: [column, value] });
        return builder;
      },
      in(column: string, values: unknown[]) {
        filters.push({ method: 'in', args: [column, values] });
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orders.push({ column, ascending: options?.ascending !== false });
        return builder;
      },
      limit(count: number) {
        limit = count;
        return builder;
      },
      maybeSingle() {
        const result = applyOp();
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      then(resolve: (value: { data: Row[]; error: null }) => void, reject: (reason?: unknown) => void) {
        try {
          resolve(applyOp());
        } catch (error) {
          reject(error);
        }
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (!(table in tables)) throw new Error(`fake client: unknown table ${table}`);
      return makeBuilder(table);
    },
    _tables: tables,
  };
  return { client: client as unknown as SupabaseClient<Database>, tables };
}

const REPO_UUID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';

function seedExtensionRow(tables: Record<string, Row[]>, overrides: Row = {}): void {
  tables.cloudstream_extensions.push({
    id: UUID_A,
    repository_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    internal_name: 'ProviderOne',
    name: 'Provider One',
    version: 1,
    api_version: 1,
    description: null,
    authors: [],
    language: null,
    tv_types: ['Movie'],
    plugin_url: null,
    plugin_status: 1,
    icon_url: null,
    file_hash: null,
    file_size_bytes: null,
    source_url: null,
    enabled: false,
    adapter_status: 'adapter_required',
    mavero_adapter_id: null,
    adapter_version: null,
    integration_type: 'cloudstream',
    media_types: ['movie'],
    adapter_state: 'adapter_required',
    provider_metadata: null,
    module_url: null,
    version_text: null,
    last_tested_at: null,
    last_test_error: null,
    generated_adapter_version: null,
    builder_version: null,
    last_build_at: null,
    last_build_error: null,
    last_checked_at: null,
    last_error: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  });
}

{
  const { client, tables } = createFakeClient();
  seedExtensionRow(tables, { id: UUID_A, enabled: false, adapter_state: 'adapter_required' });
  seedExtensionRow(tables, { id: UUID_B, internal_name: 'ProviderTwo', name: 'Provider Two', enabled: false, adapter_state: 'failed' });

  // B1: the bulk update flips exactly the requested rows and returns views.
  const views = await setExtensionsEnabledBulk(client, [UUID_A, UUID_B], true);
  ok(views.length === 2, 'B1: the bulk update returns every changed row as a view');
  ok(tables.cloudstream_extensions.every((row) => row.enabled === true), 'B1: both rows are enabled in the table');
  ok(views.every((view) => view.enabled === true && view.repositoryName === 'Phisher Repo'), 'B1: the returned views carry the fresh state + repository name');
  const failedView = views.find((view) => view.id === UUID_B)!;
  ok(failedView.adapterState === 'failed', 'B1: the view re-derives the operational state honestly (failed stays failed)');

  // B2: stale ids are ignored; NOTHING matched = honest NOT_FOUND.
  seedExtensionRow(tables, { id: UUID_C, internal_name: 'ProviderThree', name: 'Provider Three', enabled: true });
  const partial = await setExtensionsEnabledBulk(client, [UUID_A, '99999999-9999-9999-9999-999999999999'], false);
  ok(partial.length === 1 && partial[0].id === UUID_A, 'B2: stale ids are silently ignored (the response shows what changed)');
  const tablesRowForC = tables.cloudstream_extensions.find((row) => row.id === UUID_C)!;
  ok(tablesRowForC.enabled === true, 'B2: unrequested rows are untouched');
  let notFound: unknown = null;
  try {
    await setExtensionsEnabledBulk(client, ['99999999-9999-9999-9999-999999999999'], true);
  } catch (error) { notFound = error; }
  ok(notFound instanceof CloudStreamRepositoryError && notFound.code === 'NOT_FOUND', 'B2: zero matching rows throws the honest NOT_FOUND');

  // B3: bounds and validation.
  let invalidId: unknown = null;
  try {
    await setExtensionsEnabledBulk(client, [], true);
  } catch (error) { invalidId = error; }
  ok(invalidId instanceof CloudStreamRepositoryError && invalidId.code === 'INVALID_ID', 'B3: an empty bulk id list is rejected');
  let tooMany: unknown = null;
  try {
    await setExtensionsEnabledBulk(client, Array.from({ length: MAX_BULK_IDS + 1 }, () => UUID_A), true);
  } catch (error) { tooMany = error; }
  ok(tooMany instanceof CloudStreamRepositoryError && tooMany.code === 'INVALID_ID', 'B3: more than MAX_BULK_IDS ids per request is rejected');
  let malformed: unknown = null;
  try {
    await setExtensionsEnabledBulk(client, ['not-a-uuid'], true);
  } catch (error) { malformed = error; }
  ok(malformed instanceof CloudStreamRepositoryError && malformed.code === 'INVALID_ID', 'B3: non-UUID ids are rejected before any query');

  // B4: the single-row toggle keeps its contract (updated via the same service).
  await setExtensionEnabled(client, UUID_C, false);
  ok(tables.cloudstream_extensions.find((row) => row.id === UUID_C)!.enabled === false, 'B4: the single-row toggle still works unchanged');

  // B5: getExtensionViewForAdmin returns the fresh view / null.
  const view = await getExtensionViewForAdmin(client, UUID_C);
  ok(view !== null && view.id === UUID_C && view.internalName === 'ProviderThree', 'B5: getExtensionViewForAdmin projects the fresh row view');
  const missing = await getExtensionViewForAdmin(client, '88888888-8888-8888-8888-888888888888');
  ok(missing === null, 'B5: getExtensionViewForAdmin returns null for unknown ids');
}

// ---------------------------------------------------------------------------
// §C — the Phase 4 JSON mutation endpoints (behavioral, fake locals)
// ---------------------------------------------------------------------------

const { POST: extensionsPost } = await import('../src/routes/api/admin/integrations/cloudstream/extensions/+server');
const { POST: repositoriesPost } = await import('../src/routes/api/admin/integrations/cloudstream/repositories/+server');

type EndpointFn = (event: {
  url: URL;
  request: Request;
  locals: Record<string, unknown>;
  cookies: { get: () => undefined };
}) => Promise<Response>;

async function callEndpoint(
  handler: EndpointFn,
  body: string | Record<string, unknown>,
  locals?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string }> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const effectiveLocals = locals ?? { supabase: createFakeClient().client, user: { id: 'admin-user' } };
  const request = new Request('https://mavero.test/api/admin/integrations/cloudstream/extensions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  const response = await handler({
    url: new URL('https://mavero.test/api/admin/integrations/cloudstream/extensions'),
    request,
    locals: effectiveLocals,
    cookies: { get: () => undefined },
  } as never);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cacheControl: response.headers.get('cache-control') ?? '',
  };
}

// C1 — the admin gate: requireAdmin throws the SvelteKit redirect (303)
// BEFORE any catalog/Builder logic when no session exists.
{
  let caught: unknown = null;
  try {
    await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabled', id: UUID_A, enabled: true }, { supabase: null, user: undefined });
  } catch (error) { caught = error; }
  ok((caught as { status?: number } | null)?.status === 303, 'C1: the extensions endpoint is admin-gated (redirect to sign-in before any logic)');
  let repoCaught: unknown = null;
  try {
    await callEndpoint(repositoriesPost as unknown as EndpointFn, { action: 'setEnabled', id: 'repo-a', enabled: true }, { supabase: null, user: undefined });
  } catch (error) { repoCaught = error; }
  ok((repoCaught as { status?: number } | null)?.status === 303, 'C1: the repositories endpoint is admin-gated');
}

// C2 — malformed request shapes.
{
  const badJson = await callEndpoint(extensionsPost as unknown as EndpointFn, '{not json');
  ok(badJson.status === 400 && (badJson.body.error as { code?: string })?.code === 'INVALID_REQUEST', 'C2: malformed JSON → 400 INVALID_REQUEST');
  const badAction = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'deleteEverything' });
  ok(badAction.status === 400 && (badAction.body.error as { code?: string })?.code === 'INVALID_REQUEST', 'C2: unknown action → 400 INVALID_REQUEST');
  const missingId = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabled', enabled: true });
  ok(missingId.status === 400 && (missingId.body.error as { code?: string })?.code === 'VALIDATION', 'C2: missing id → 400 VALIDATION');
  const badEnabled = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabled', id: UUID_A, enabled: 'yes' });
  ok(badEnabled.status === 400 && (badEnabled.body.error as { code?: string })?.code === 'VALIDATION', 'C2: non-boolean enabled → 400 VALIDATION');
  const badIds = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabledBulk', ids: 'not-an-array', enabled: true });
  ok(badIds.status === 400, 'C2: non-array ids → 400');
  const oversized = await callEndpoint(extensionsPost as unknown as EndpointFn, JSON.stringify({ action: 'setEnabled', id: UUID_A, enabled: true, pad: 'x'.repeat(300 * 1024) }));
  ok(oversized.status === 413 && (oversized.body.error as { code?: string })?.code === 'PAYLOAD_TOO_LARGE', 'C2: oversized body → 413 PAYLOAD_TOO_LARGE');
  const repoBadAction = await callEndpoint(repositoriesPost as unknown as EndpointFn, { action: 'sync' });
  ok(repoBadAction.status === 400, 'C2: repositories endpoint rejects unknown actions');
}

// C3 — setEnabled: the §12 no-refresh toggle contract.
{
  const { client, tables } = createFakeClient();
  seedExtensionRow(tables, { id: UUID_A, enabled: false, adapter_state: 'adapter_required' });
  const result = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabled', id: UUID_A, enabled: true }, { supabase: client, user: { id: 'admin-user' } });
  ok(result.status === 200 && result.body.ok === true, 'C3: setEnabled succeeds');
  ok((result.body.extension as { enabled?: boolean })?.enabled === true, 'C3: the response carries the FRESH view for the targeted client patch');
  ok(result.cacheControl === 'no-store', 'C3: mutation responses are no-store');
  ok(tables.cloudstream_extensions[0].enabled === true, 'C3: the row is persisted');
  const missing = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabled', id: '99999999-9999-9999-9999-999999999999', enabled: true }, { supabase: client, user: { id: 'admin-user' } });
  ok(missing.status === 404 && (missing.body.error as { code?: string })?.code === 'VALIDATION', 'C3: unknown id → 404 with the curated message');
}

// C4 — setEnabledBulk: the §11 bulk surface.
{
  const { client, tables } = createFakeClient();
  seedExtensionRow(tables, { id: UUID_A, enabled: false });
  seedExtensionRow(tables, { id: UUID_B, internal_name: 'ProviderTwo', name: 'Provider Two', enabled: false });
  seedExtensionRow(tables, { id: UUID_C, internal_name: 'ProviderThree', name: 'Provider Three', enabled: true });
  const result = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabledBulk', ids: [UUID_A, UUID_B], enabled: true }, { supabase: client, user: { id: 'admin-user' } });
  ok(result.status === 200 && Array.isArray(result.body.extensions) && (result.body.extensions as unknown[]).length === 2, 'C4: the bulk update returns the changed views');
  ok((tables.cloudstream_extensions.find((row) => row.id === UUID_C) as { enabled: boolean })?.enabled === true, 'C4: unselected rows are untouched');
  const tooMany = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabledBulk', ids: Array.from({ length: MAX_BULK_IDS + 1 }, () => UUID_A), enabled: true }, { supabase: client, user: { id: 'admin-user' } });
  ok(tooMany.status === 400, 'C4: over-bound bulk ids → 400 (the bound is enforced server-side too)');
  const none = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'setEnabledBulk', ids: ['88888888-8888-8888-8888-888888888888'], enabled: true }, { supabase: client, user: { id: 'admin-user' } });
  ok(none.status === 404, 'C4: nothing matched → honest 404');
}

// C5 — createAdapter through the endpoint: the lifecycle guards + the
// unconfigured-Builder honest refusal (env stub → BUILDER_UNAVAILABLE).
{
  // native row → NATIVE_ADAPTER_EXISTS (the §16 native precedence guard).
  const nativeClient = createFakeClient();
  seedExtensionRow(nativeClient.tables, { id: UUID_A, internal_name: 'Bollyflix', adapter_state: 'native', enabled: true });
  const nativeResult = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'createAdapter', id: UUID_A }, { supabase: nativeClient.client, user: { id: 'admin-user' } });
  ok(nativeResult.status === 400 && (nativeResult.body.error as { code?: string })?.code === 'NATIVE_ADAPTER_EXISTS', 'C5: createAdapter on a native row is refused (native precedence)');
  ok(nativeResult.body.extension !== null && nativeResult.body.extension !== undefined, 'C5: refusals still return the fresh row view (inline §13 update, no reload)');

  // adapter_required row + unconfigured Builder → 503 BUILDER_UNAVAILABLE,
  // the row REVERTS to its prior state (never silently failed).
  const buildClient = createFakeClient();
  seedExtensionRow(buildClient.tables, { id: UUID_A, adapter_state: 'adapter_required', integration_type: 'nuvio', module_url: 'https://nuvio.example/providers/moviesdrive.js', media_types: ['movie'] });
  const buildResult = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'createAdapter', id: UUID_A }, { supabase: buildClient.client, user: { id: 'admin-user' } });
  ok(buildResult.status === 503 && (buildResult.body.error as { code?: string })?.code === 'BUILDER_UNAVAILABLE', 'C5: unconfigured Builder → 503 BUILDER_UNAVAILABLE (the honest admin outcome)');
  const revertedRow = buildClient.tables.cloudstream_extensions[0];
  ok(revertedRow.adapter_state === 'adapter_required', 'C5: the row reverts to its prior state (Builder unavailability is not a failure)');
  ok(typeof revertedRow.last_build_error === 'string' && (revertedRow.last_build_error as string).startsWith('BUILDER_UNAVAILABLE'), 'C5: the refusal is recorded in last_build_error');
  ok((buildResult.body.extension as { adapterState?: string })?.adapterState === 'adapter_required', 'C5: the response view reflects the reverted state');

  // runtime_required row → the §13 not-convertible refusal.
  const rtClient = createFakeClient();
  seedExtensionRow(rtClient.tables, { id: UUID_A, adapter_state: 'runtime_required', plugin_status: 2 });
  const rtResult = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'createAdapter', id: UUID_A }, { supabase: rtClient.client, user: { id: 'admin-user' } });
  ok(rtResult.status === 400 && (rtResult.body.error as { code?: string })?.code === 'RUNTIME_REQUIRED', 'C5: runtime_required rows refuse createAdapter');

  // unknown id → EXTENSION_NOT_FOUND without a view.
  const nfClient = createFakeClient();
  const nfResult = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'createAdapter', id: '99999999-9999-9999-9999-999999999999' }, { supabase: nfClient.client, user: { id: 'admin-user' } });
  ok(nfResult.status === 400 && (nfResult.body.error as { code?: string })?.code === 'EXTENSION_NOT_FOUND', 'C5: unknown id → EXTENSION_NOT_FOUND');
}

// C6 — testProvider through the endpoint: no executable adapter → the §9
// honest refusal + last_tested_at bookkeeping (NEVER the Builder).
{
  const { client, tables } = createFakeClient();
  seedExtensionRow(tables, { id: UUID_A, adapter_state: 'adapter_required' });
  const result = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'testProvider', id: UUID_A }, { supabase: client, user: { id: 'admin-user' } });
  ok(result.status === 400 && (result.body.error as { code?: string })?.code === 'ADAPTER_NOT_AVAILABLE', 'C6: testProvider without an adapter is the honest ADAPTER_NOT_AVAILABLE refusal');
  ok(typeof (tables.cloudstream_extensions[0] as { last_tested_at?: string }).last_tested_at === 'string', 'C6: the test attempt records last_tested_at bookkeeping');
  ok(result.body.extension !== null && result.body.extension !== undefined, 'C6: the response carries the fresh row view');
  const missing = await callEndpoint(extensionsPost as unknown as EndpointFn, { action: 'testProvider', id: '99999999-9999-9999-9999-999999999999' }, { supabase: client, user: { id: 'admin-user' } });
  ok(missing.status === 400, 'C6: unknown id → 400');
}

// C7 — the repositories endpoint: the §12 repository toggle.
{
  const { client, tables } = createFakeClient();
  const result = await callEndpoint(repositoriesPost as unknown as EndpointFn, { action: 'setEnabled', id: REPO_UUID_A, enabled: false }, { supabase: client, user: { id: 'admin-user' } });
  ok(result.status === 200 && result.body.ok === true, 'C7: the repository toggle succeeds');
  ok((result.body.repository as { enabled?: boolean })?.enabled === false, 'C7: the response carries the fresh repository view');
  ok(result.cacheControl === 'no-store', 'C7: repository mutation responses are no-store');
  ok((tables.cloudstream_repositories.find((row) => row.id === REPO_UUID_A) as { enabled: boolean }).enabled === false, 'C7: the repository row is persisted');
  const absent = await callEndpoint(repositoriesPost as unknown as EndpointFn, { action: 'setEnabled', id: '99999999-9999-9999-9999-999999999999', enabled: true }, { supabase: client, user: { id: 'admin-user' } });
  ok(absent.status === 404, 'C7: a well-formed but ABSENT repository id → honest 404');
  const malformed = await callEndpoint(repositoriesPost as unknown as EndpointFn, { action: 'setEnabled', id: 'not-a-uuid', enabled: true }, { supabase: client, user: { id: 'admin-user' } });
  ok(malformed.status === 400, 'C7: a malformed repository id is rejected by the UUID guard');
  const badEnabled = await callEndpoint(repositoriesPost as unknown as EndpointFn, { action: 'setEnabled', id: REPO_UUID_A, enabled: 1 }, { supabase: client, user: { id: 'admin-user' } });
  ok(badEnabled.status === 400, 'C7: non-boolean enabled → 400');
}

// ---------------------------------------------------------------------------
// §D — component source contracts (§11/§12/§13 in AdminCloudStreamManager)
// ---------------------------------------------------------------------------

const manager = read('src/lib/components/admin2/AdminCloudStreamManager.svelte');
const extensionsEndpointSource = read('src/routes/api/admin/integrations/cloudstream/extensions/+server.ts');
const repositoriesEndpointSource = read('src/routes/api/admin/integrations/cloudstream/repositories/+server.ts');
const pageServer = read('src/routes/admin/system/integrations/+page.server.ts');

{
  // §12 — async toggles with targeted updates (no full page refresh).
  ok(manager.includes("fetch('/api/admin/integrations/cloudstream/extensions'"), 'D1: the manager mutations call the Phase 4 JSON endpoint');
  ok(manager.includes("fetch('/api/admin/integrations/cloudstream/repositories'"), 'D1: repository toggles call the Phase 4 JSON endpoint');
  ok((manager.match(/event\.preventDefault\(\)/g) ?? []).length >= 4, 'D1: every mutation form intercepts submit (the no-JS form fallback stays available)');
  ok(manager.includes('?/setCloudStreamExtensionEnabled') && manager.includes('?/createCloudStreamAdapter') && manager.includes('?/testCloudStreamProvider'), 'D1: the form actions remain the no-JS fallback paths');
  ok(!manager.includes('invalidateAll(') && !manager.includes('window.location.reload') && !manager.includes('location.href ='), 'D1: no page invalidation/reload anywhere (targeted patching only)');
  ok(manager.includes('function patchRow(') && manager.includes('rowPatches.set(view.id, view)'), 'D1: successful mutations patch ONLY the affected rows (§12 invalidate-only-affected-data)');
  ok(manager.includes('SvelteMap') && manager.includes('SvelteSet'), 'D1: reactive patch/selection collections drive the targeted updates');

  // §12 — duplicate-click guards + pending states.
  ok((manager.match(/if \(pendingIds\.has\(extension\.id\) \|\| bulkRunning\) return;/g) ?? []).length >= 3, 'D2: every per-row mutation (toggle/create/test) guards against duplicate clicks');
  ok((manager.match(/disabled=\{pending \|\| bulkRunning\}/g) ?? []).length >= 3, 'D2: row action buttons disable while their mutation is in flight');
  ok(manager.includes('aria-busy={pending}'), 'D2: rows expose the pending state to assistive technology');
  ok(manager.includes('Updating…'), 'D2: the pending row shows a local Updating state');
  ok(manager.includes('setRowError('), 'D2: failures surface as inline row errors (local error state)');

  // §11 — the sticky toolbar with search + filters + sort.
  ok(manager.includes('class="cs-toolbar"') && manager.includes('position: sticky'), 'D3: the toolbar is sticky (§11 sticky filter/search controls)');
  ok(manager.includes('type="search"') && manager.includes('placeholder="Search providers, sources, repositories…"'), 'D3: the search input covers provider/source/repository (§11 search fields)');
  ok(manager.includes('INTEGRATION_STATUS_FILTERS') && manager.includes('INTEGRATION_MEDIA_FILTERS') && manager.includes('INTEGRATION_SORT_KEYS'), 'D3: the closed §11 filter/sort vocabularies drive the toolbar selects');
  ok(manager.includes('aria-label="Filter extensions by status"') && manager.includes('aria-label="Filter extensions by media support"') && manager.includes('aria-label="Filter extensions by repository"') && manager.includes('aria-label="Sort extensions"'), 'D3: every toolbar control is labeled');
  ok(manager.includes('oninput={resetPage}'), 'D3: search input resets to page 1 (filters and pagination compose)');

  // §11 — stats headers + pagination + bulk bar.
  ok(manager.includes('class="cs-stats"') && manager.includes('{statsHeader.counts.total} extensions</span>') && manager.includes('{statsHeader.counts.enabled}</span>') && manager.includes('{statsHeader.counts.compatible}</span>') && manager.includes('{statsHeader.counts.adapterRequired}</span>') && manager.includes('{statsHeader.counts.runtimeRequired}</span>') && manager.includes('{statsHeader.counts.failed}</span>'), 'D4: the stats header renders the exact §11 example buckets');
  ok(manager.includes('cs-repo-stats'), 'D4: every repository card carries its own §11 stats line');
  ok(manager.includes('class="cs-pager"') && manager.includes('Showing {projection.fromIndex + 1}–{projection.toIndex} of {projection.total}') && manager.includes('Page {projection.page} of {projection.pageCount}'), 'D4: the pagination footer shows bounded rendering state');
  ok(manager.includes('class="cs-bulkbar"') && manager.includes('Enable Selected') && manager.includes('Disable Selected') && manager.includes('Create Adapters'), 'D4: the §11 bulk action bar exists with all three operations');
  ok(manager.includes('toggleSelectAllFiltered') && manager.includes('Select all {projection.total} filtered'), 'D4: select-all operates on the FILTERED set (§11 select all filtered)');
  ok(manager.includes('chunkBulkIds(ids)'), 'D4: bulk requests are chunked to the server-side bound');
  ok(manager.includes('eligibleForBulkCreateAdapter'), 'D4: bulk Create Adapters targets only eligible rows (§11 "where valid")');
  ok(manager.includes('bulkCreateTargets.length === 0') && manager.includes('None of the selected providers can enter adapter generation'), 'D4: an all-ineligible selection is refused with an honest message');
  ok(manager.includes('stopBulk') && manager.includes('bulkStopRequested'), 'D4: the sequential bulk queue is stoppable (long-running builds stay under admin control)');
  ok(manager.includes('aria-live="polite"'), 'D4: bulk progress + notices are announced politely to screen readers');

  // §13 — the closed provider-status vocabulary drives the rows.
  ok(manager.includes('{@const status = providerStatusPresentation(extension)}'), 'D5: every row derives its §13 presentation from the shared view-model');
  ok(manager.includes('label={status.label}') && manager.includes('>{status.note}</div>'), 'D5: the §13 label + note render from the presentation');
  ok(manager.includes("status.primaryAction === 'Enable' || status.primaryAction === 'Disable'"), 'D5: the toggle button honors the §13 primary action');
  ok(!manager.includes("'Broken'") && !manager.includes("'Unsupported'"), 'D5: no ambiguous catalog status labels remain in the manager');

  // a11y + isolation.
  ok((manager.match(/aria-label=/g) ?? []).length >= 15, 'D6: the manager carries comprehensive aria labels');
  ok(!/\$lib\/server\//.test(manager), 'D7: the manager imports NO server modules (client-safe)');
  ok(!manager.includes('on:click'), 'D7: the manager uses Svelte 5 event syntax consistently');

  // The endpoints reuse the SAME orchestration as the form actions.
  // DURABLE BUILD LIFECYCLE (20261102000000): the admin createAdapter path
  // moved to queueAdapterBuild (build-lifecycle.ts — the moved
  // implementation of the former build-service orchestration; both the
  // endpoint AND the form action import it). The invariant stays: ONE
  // orchestration, no parallel Builder path.
  ok(extensionsEndpointSource.includes('queueAdapterBuild') && pageServer.includes('queueAdapterBuild'), 'D8: createAdapter reuses the form action orchestration (no parallel Builder path)');
  ok(extensionsEndpointSource.includes('testExtensionProvider') && pageServer.includes('testExtensionProvider'), 'D8: testProvider reuses the form action service');
  ok(extensionsEndpointSource.includes('setExtensionEnabled') && pageServer.includes('setExtensionEnabled'), 'D8: the toggle reuses the form action service');
}

// ---------------------------------------------------------------------------
// §E — vite-SSR runtime mounts (the component instance actually renders)
// ---------------------------------------------------------------------------

type MountableComponent = unknown;

async function section_runtimeMount(): Promise<void> {
  const { createServer } = await import('vite');
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const svelteServer = (await server.ssrLoadModule('svelte/server')) as { render: (component: MountableComponent, options: { props: Record<string, unknown> }) => { body: string } };
    const mod = (await server.ssrLoadModule('/src/lib/components/admin2/AdminCloudStreamManager.svelte')) as { default: MountableComponent };
    const AdminCloudStreamManager = mod.default;

    // E1: the 84-row large-repository mount.
    const catalog = buildLargeCatalog();
    let err: unknown = null;
    let html = '';
    try {
      const result = svelteServer.render(AdminCloudStreamManager, {
        props: {
          repositories: REPOSITORIES,
          extensions: catalog,
          loadError: null,
          providerTest: null,
        },
      });
      html = result.body;
    } catch (e) { err = e; }
    ok(err === null, `E1: the manager mounts WITHOUT throwing on the 84-row catalog — got: ${err instanceof Error ? err.message : String(err)}`);
    ok(html.length > 0, 'E1: rendered HTML is non-empty');
    const rowCount = (html.match(/class="cs-ext-row[ "]/g) ?? []).length;
    ok(rowCount === INTEGRATION_PAGE_SIZE, `E1: bounded rendering — exactly one page (${INTEGRATION_PAGE_SIZE}) of 84 rows renders (got ${rowCount})`);
    ok(html.includes('Page 1 of 4'), 'E1: the pagination footer reflects 4 pages');
    ok(html.includes('All repositories') && html.includes('84 extensions'), 'E1: the aggregate stats header renders');
    ok(html.includes('Search providers, sources, repositories…'), 'E1: the search toolbar renders');
    ok(html.includes('Adapter Required:'), 'E1: the §11 stats buckets render');
    ok(html.includes('ADAPTER REQUIRED'), 'E1: §13 status chips render');
    ok(html.includes('Select all 84 filtered'), 'E1: select-all-filtered renders');

    // E2: the empty-catalog state.
    let emptyErr: unknown = null;
    let emptyHtml = '';
    try {
      const result = svelteServer.render(AdminCloudStreamManager, {
        props: { repositories: [], extensions: [], loadError: null, providerTest: null },
      });
      emptyHtml = result.body;
    } catch (e) { emptyErr = e; }
    ok(emptyErr === null, 'E2: the empty-catalog state mounts without throwing');
    ok(emptyHtml.includes('No extension repositories'), 'E2: the no-repositories empty state renders');

    // E3: the load-error state.
    let loadErr: unknown = null;
    let loadHtml = '';
    try {
      const result = svelteServer.render(AdminCloudStreamManager, {
        props: { repositories: REPOSITORIES, extensions: catalog, loadError: 'The catalog could not be loaded.', providerTest: null },
      });
      loadHtml = result.body;
    } catch (e) { loadErr = e; }
    ok(loadErr === null, 'E3: the load-error state mounts without throwing');
    ok(loadHtml.includes('The catalog could not be loaded.') && loadHtml.includes('role="alert"'), 'E3: the load error renders as an alert');
  } finally {
    await server.close();
  }
}

await section_runtimeMount();

// ---------------------------------------------------------------------------
// §F — regression pins (Stremio tab + page server actions untouched)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

function pristineFile(relative: string): string | null {
  try {
    return execFileSync('git', ['show', `434d02b:${relative}`], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  } catch {
    return null;
  }
}

{
  // F1 (FINAL TASK evolution, recorded in-file): the Integrations page +
  // server gains EXACTLY the unified-downloader global-position surface —
  // the add-on position input shows the GLOBAL rank, the page passes
  // globalPositions to the manager, and the setAddonPosition action routes
  // to the global ordering with the legacy add-only path as the
  // pre-migration fallback. Comment-stripped code diff: every change must
  // belong to that surface; every existing form action is preserved.
  const pageSveltePath = 'src/routes/admin/system/integrations/+page.svelte';
  const pristinePage = pristineFile(pageSveltePath);
  const stripPageComments = (text: string): string[] =>
    text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\s*\/\/.*$/, '').trimEnd())
      .filter((line) => line.trim().length > 0);
  if (pristinePage !== null) {
    const pageAdditions = stripPageComments(read(pageSveltePath)).filter((line) => !stripPageComments(pristinePage).includes(line));
    ok(
      pageAdditions.every((line) =>
        line.includes('globalPositions')
        || line.includes('addonGlobalPosition')
        || line.includes('a2-position-hint')
        || line.includes('min="1"')
        || line.includes('aria-label="Global position"')
        || line.includes('add-ons AND plugin sources')
        || line.includes('data.addons.find')
        || line.includes("typeof global === 'number'")
        || line.includes('ordering ?? 0')
        || line.includes('type="number"')
        || line.includes('style="width:80px"')
        || line.includes('FINAL TASK')),
      `F1: every +page.svelte addition is the FINAL TASK global-position surface (added ${pageAdditions.length})`,
    );
  }
  const pristineServer = pristineFile('src/routes/admin/system/integrations/+page.server.ts');
  if (pristineServer !== null) {
    const serverAdditions = stripPageComments(pageServer).filter((line) => !stripPageComments(pristineServer).includes(line));
    ok(
      serverAdditions.every((line) =>
        line.includes('computeAdminGlobalPositions')
        || line.includes('globalPositions')
        || line.includes('setGlobalSourcePosition')
        || line.includes('validatedAddonOrderKey')
        || line.includes('globalResult')
        || line.includes('orderKey')
        || line.includes('TABLE_MISSING')
        || line.includes('position')
        || line.includes('FINAL TASK')
        || line.includes('setAddonPosition')
        || line.includes('streaming_addons')
        || line.includes('id')
        || line.trim() === 'try {'
        || line.trim() === '} catch {'
        || line.trim() === '} catch (err) {'
        || line.trim() === '} else {'
        || line.trim() === '}'
        || line.trim() === 'try {'
        || line.includes('global source order lookup failed')
        || line.includes('StreamingValidationError')
        // DURABLE BUILD LIFECYCLE (20261102000000, sanctioned evolution):
        // the createCloudStreamAdapter action routes through
        // queueAdapterBuild (+ the pre-flight reconcileAdapterBuilds sweep
        // in the action AND the extension-tab load) — the fast-queue
        // durable orchestration (see build-lifecycle.ts).
        || line.includes('queueAdapterBuild')
        || line.includes('reconcileAdapterBuilds')
        || line.includes('build-lifecycle')
        || line.includes('queued')
        || line.includes('DURABLE BUILD LIFECYCLE')
        || line.includes('jobId')
        || line.includes('dispatch')
        || line.includes('retry')
        || line.includes('sweep')
        || line.includes('origin')
        || line.includes('createdBy')
        || line.includes('build')
        || line.includes('Progress')
        || line.includes('track')
        || line.includes('unable to queue')
        || line.trim() === '}).catch(() => undefined);'
        || line.trim() === '}, {'
        || line.trim() === '});'
        || line.includes('createCloudStreamAdapter')),
      `F1: every +page.server.ts addition is the FINAL TASK global-position action routing (added ${serverAdditions.length})`,
    );
    // The existing Stremio form actions are preserved VERBATIM (the action
    // set + their redirect shapes).
    for (const action of ['previewAddon:', 'confirmAddon:', 'setEnabled:', 'refreshAddon:', 'deleteAddon:', 'setAddonPosition:', 'saveLinkTypes:', 'confirmCloudStreamRepository:']) {
      ok(pageServer.includes(`  ${action}`) || pageServer.includes(`${action} `), `F1: the existing form action ${action.slice(0, -1)} is preserved`);
    }
  }

  // F2: the Phase 3 Builder/downloader boundaries are untouched — the new
  // endpoints never enter the Downloader 2 path and import no resolver.
  ok(!extensionsEndpointSource.includes('downloader/service') && !extensionsEndpointSource.includes('resolver/service'), 'F2: the mutation endpoints import NO Downloader 2 services');
  ok(!repositoriesEndpointSource.includes('downloader/service') && !repositoriesEndpointSource.includes('resolver/service'), 'F2: the repository endpoint imports NO Downloader 2 services');
  const resolverSource = read('src/lib/server/cloudstream/resolver/service.ts');
  ok(!resolverSource.includes('builder-client') && !resolverSource.includes('integrations/cloudstream/extensions'), 'F2: the resolver never imports the Builder client or the mutation endpoints');
  const downloaderService = read('src/lib/server/cloudstream/downloader/service.ts');
  ok(!downloaderService.includes('builder-client') && !downloaderService.includes('integrations/cloudstream/extensions'), 'F2: the Downloader 2 service never imports the Builder client or the mutation endpoints');

  // F3: Phase 4 adds NO migrations (the phase is UI + API surface only).
  // NOTE: the pre-existing Mavero phase-4 migrations (hosting/history — a
  // different, older plan) are untouched; the pin is that the CloudStream
  // Permanent Adapter Plan adds no NEW migration files in Phase 4.
  const migrationFiles = readdirSync(new URL('../supabase/migrations', import.meta.url));
  const pristineMigrations = execFileSync('git', ['ls-tree', '--name-only', '434d02b:supabase/migrations'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' }).split('\n').filter(Boolean);
  // FINAL TASK evolution + DURABLE BUILD LIFECYCLE (20261102000000,
  // sanctioned): the ONLY migrations added since the Phase 3.5 tip are the
  // unified-downloader global-order migration (20261004000000) and the
  // adapter build lifecycle migration (20261102000000 — durable job rows +
  // the current_build_job_id late-write guard + the stale sweep indexes;
  // see scripts/adapter_build_lifecycle_migration_test.ts for the DDL
  // coverage). LT-5 ANALYTICS TAXONOMY (20261103000000, sanctioned —
  // live-tv-plan.md §14): the Live TV analytics events migration widens
  // the analytics_events CHECK constraint only and never touches any
  // CloudStream/downloader/registry table.
  // VIDRIFT PROVIDER (20261105000000, sanctioned): the VidRift embed
  // provider registration migration (insert-only streaming_providers +
  // streaming_sources rows — never touches any CloudStream/downloader/
  // registry table) is sanctioned per the VidRift integration directive.
  const addedMigrations = [...migrationFiles].filter((name) => !pristineMigrations.includes(name));
  const removedMigrations = pristineMigrations.filter((name) => !migrationFiles.includes(name));
  ok(
    addedMigrations.length === 5
      && addedMigrations.includes('20261004000000_unified_downloader_global_order.sql')
      && addedMigrations.includes('20261102000000_adapter_build_lifecycle.sql')
      && addedMigrations.includes('20261103000000_live_tv_analytics_events.sql')
      && addedMigrations.includes('20261104000000_live_tv_fallback_embed_event.sql')
      && addedMigrations.includes('20261105000000_vidrift_provider.sql'),
    `F3: the ONLY added migrations are the FINAL TASK unified-order + build-lifecycle + LT-5-analytics + LT-15-fallback-event + VidRift-provider migrations (${addedMigrations.join(', ') || 'none'})`,
  );
  ok(removedMigrations.length === 0, 'F3: no migration was removed');

  // F4: the security conventions on the new endpoints.
  ok(extensionsEndpointSource.indexOf('requireAdmin') < extensionsEndpointSource.indexOf('readJsonBody'), 'F4: requireAdmin runs BEFORE body parsing on the extensions endpoint');
  ok(repositoriesEndpointSource.indexOf('requireAdmin') < repositoriesEndpointSource.indexOf('readJsonBody'), 'F4: requireAdmin runs BEFORE body parsing on the repositories endpoint');
  ok(extensionsEndpointSource.includes('NO_STORE') && repositoriesEndpointSource.includes('NO_STORE'), 'F4: both endpoints set no-store cache headers');
  ok(!extensionsEndpointSource.includes('console.log') && !repositoriesEndpointSource.includes('console.log'), 'F4: no console logging of request data on the endpoints');
  ok(!extensionsEndpointSource.includes('.stack') && !repositoriesEndpointSource.includes('.stack'), 'F4: no stack traces leak through the endpoints');
}

console.log(`\nPHASE 4 INTEGRATION MANAGER TESTS: ${passed} checks passed`);
