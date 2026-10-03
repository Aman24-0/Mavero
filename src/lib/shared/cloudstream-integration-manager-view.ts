/**
 * MAVERO — Permanent Adapter Plan Phase 4 — Integration Manager 2.0 shared
 * view-model (pure).
 *
 * The SINGLE source of truth for the Extension manager (System →
 * Integrations → [ Extension ]) presentation logic: search matching, status/
 * media/repository filters, deterministic sorting, bounded pagination,
 * per-repository stats headers (plan §11), the §13 provider-status
 * vocabulary, and the bulk-selection model. Both the Svelte component and
 * the Phase 4 test suite import from here so the rules can never drift
 * between the UI and the tests (the same architecture as
 * `cloudstream-download-view.ts` for the Downloader 2 panel).
 *
 * PLAN CONTRACTS IMPLEMENTED HERE:
 *   * §11 search      — provider name, repository, source name (case-
 *                        insensitive substring over `name` +
 *                        `internalName` + `repositoryName`).
 *   * §11 filters     — status: All | Enabled | Disabled | Compatible |
 *                        Adapter Required | Runtime Required | Failed;
 *                        media: All | Movie | TV.
 *   * §11 sorting     — name, status, enabled, last tested (each with
 *                        deterministic tie-breakers: internalName, then id).
 *   * §11 performance — client-side pagination over the filtered+sorted
 *                        list (the plan's "pagination is sufficient" note —
 *                        no virtualization complexity), bounded rendering.
 *   * §11 stats       — per-repository counts header (the exact
 *                        "Phisher Repo / 84 Extensions / Enabled: 12 /
 *                        Compatible: 27 / Adapter Required: 41 / Failed: 4"
 *                        shape) computed over the RAW repository catalog
 *                        (never the search-filtered subset — the stats
 *                        answer "what is in this repository").
 *   * §13 status UX   — the closed presentation vocabulary:
 *                        ACTIVE (Last tested: …) [Test Provider] [Disable]
 *                        COMPATIBLE (Adapter: Ready) [Test Provider] [Enable]
 *                        ADAPTER REQUIRED [Create Adapter]
 *                        RUNTIME REQUIRED (cannot-be-converted explanation)
 *                        ADAPTER FAILED (Reason: …) [Retry]
 *   * §11 bulk        — selection helpers + the create-adapter eligibility
 *                        rule ("where valid" = adapter_required | failed),
 *                        bounded by MAX_BULK_IDS per server request.
 *
 * Pure module: no DOM, no network, no Svelte, no server imports.
 */

import type {
  CloudStreamExtensionView,
  CloudStreamRepositoryView,
} from '$lib/shared/cloudstream-types';

// ---------------------------------------------------------------------------
// Filter/sort vocabulary (closed sets — the §11 filter chips)
// ---------------------------------------------------------------------------

export type IntegrationStatusFilter =
  | 'all'
  | 'enabled'
  | 'disabled'
  | 'compatible'
  | 'adapter_required'
  | 'runtime_required'
  | 'failed';

export type IntegrationMediaFilter = 'all' | 'movie' | 'tv';

export type IntegrationSortKey = 'name' | 'status' | 'enabled' | 'last_tested';

export type IntegrationSortDir = 'asc' | 'desc';

/** The §11 status filter chips, in display order. */
export const INTEGRATION_STATUS_FILTERS: readonly IntegrationStatusFilter[] = [
  'all',
  'enabled',
  'disabled',
  'compatible',
  'adapter_required',
  'runtime_required',
  'failed',
];

/** Human labels for the status filter chips (§11 vocabulary). */
export const INTEGRATION_STATUS_FILTER_LABELS: Readonly<Record<IntegrationStatusFilter, string>> = {
  all: 'All',
  enabled: 'Enabled',
  disabled: 'Disabled',
  compatible: 'Compatible',
  adapter_required: 'Adapter Required',
  runtime_required: 'Runtime Required',
  failed: 'Failed',
};

/** The §11 media filter chips. */
export const INTEGRATION_MEDIA_FILTERS: readonly IntegrationMediaFilter[] = ['all', 'movie', 'tv'];

/** Human labels for the media filter chips. */
export const INTEGRATION_MEDIA_FILTER_LABELS: Readonly<Record<IntegrationMediaFilter, string>> = {
  all: 'All Media',
  movie: 'Movie',
  tv: 'TV',
};

/** The §11 sort keys, in selector display order. */
export const INTEGRATION_SORT_KEYS: readonly IntegrationSortKey[] = ['name', 'status', 'enabled', 'last_tested'];

/** Human labels for the sort selector. */
export const INTEGRATION_SORT_KEY_LABELS: Readonly<Record<IntegrationSortKey, string>> = {
  name: 'Name',
  status: 'Status',
  enabled: 'Enabled',
  last_tested: 'Last Tested',
};

// ---------------------------------------------------------------------------
// Bounds (shared with the server bulk endpoint — single source of truth)
// ---------------------------------------------------------------------------

/** Rows rendered per page (§11 bounded rendering). */
export const INTEGRATION_PAGE_SIZE = 25;

/**
 * Maximum extension ids accepted by ONE bulk server request. The client
 * chunks larger selections into sequential requests of this size (§11 bulk
 * operations; the bound keeps request bodies and DB work bounded).
 */
export const MAX_BULK_IDS = 100;

// ---------------------------------------------------------------------------
// Query shape (the component's toolbar state)
// ---------------------------------------------------------------------------

export type IntegrationManagerQuery = {
  /** Raw search text (trimmed+lowercased before matching). */
  search: string;
  statusFilter: IntegrationStatusFilter;
  mediaFilter: IntegrationMediaFilter;
  /** 'all' = every repository; otherwise a repository id. */
  repositoryId: string | 'all';
  sortKey: IntegrationSortKey;
  sortDir: IntegrationSortDir;
  /** 1-based page number (clamped by the projection). */
  page: number;
};

export const DEFAULT_INTEGRATION_QUERY: IntegrationManagerQuery = {
  search: '',
  statusFilter: 'all',
  mediaFilter: 'all',
  repositoryId: 'all',
  sortKey: 'name',
  sortDir: 'asc',
  page: 1,
};

// ---------------------------------------------------------------------------
// Stats (§11 repository header: the exact plan example shape)
// ---------------------------------------------------------------------------

export type ExtensionBucketCounts = {
  total: number;
  enabled: number;
  disabled: number;
  /** Has an executable Mavero adapter (native or generated), any enabled state. */
  compatible: number;
  adapterRequired: number;
  runtimeRequired: number;
  failed: number;
};

/** One repository's §11 header summary (raw catalog stats, not filtered). */
export type RepositorySummary = {
  repository: CloudStreamRepositoryView;
  counts: ExtensionBucketCounts;
};

// ---------------------------------------------------------------------------
// §13 provider-status presentation (closed vocabulary, no ambiguity)
// ---------------------------------------------------------------------------

export type ProviderStatusKind =
  | 'active'
  | 'ready'
  | 'adapter_required'
  | 'runtime_required'
  | 'failed'
  | 'building'
  | 'testing';

export type ProviderStatusPresentation = {
  kind: ProviderStatusKind;
  /** §13 exact status text ('ACTIVE', 'COMPATIBLE', …). */
  label: string;
  /** §13 explanation line (null when none applies). */
  note: string | null;
  /** Whether [Test Provider] applies (an executable adapter exists). */
  canTest: boolean;
  /** Whether [Create Adapter]/[Retry] applies. */
  canCreateAdapter: boolean;
  /** The primary §13 action button label ('Enable' | 'Disable' | 'Create Adapter' | 'Retry' | null). */
  primaryAction: 'Enable' | 'Disable' | 'Create Adapter' | 'Retry' | null;
};

// ---------------------------------------------------------------------------
// Operational-state helpers (single derivation site)
// ---------------------------------------------------------------------------

/**
 * Operational states that mean "an executable Mavero adapter is present"
 * ('active' = enabled native/generated; 'disabled' = disabled
 * native/generated — the registry collapses native/generated into these two
 * at view time). This is the honest "Compatible" bucket for §11/§13.
 */
const EXECUTABLE_OPERATIONAL_STATES: ReadonlySet<string> = new Set(['active', 'disabled']);

/** Deterministic status rank for the §11 status sort (stable grouping). */
const STATUS_SORT_RANK: Readonly<Record<string, number>> = {
  active: 0,
  disabled: 1,
  adapter_required: 2,
  runtime_required: 3,
  failed: 4,
  building: 5,
  testing: 6,
};

/** Whether the row has an executable adapter (native or generated). */
export function hasExecutableAdapter(extension: Pick<CloudStreamExtensionView, 'adapterState'>): boolean {
  return EXECUTABLE_OPERATIONAL_STATES.has(extension.adapterState);
}

// ---------------------------------------------------------------------------
// Search (§11: provider name, repository, source name)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring match over the three §11 fields: provider
 * display name, repository name, and source/internal name. Empty/whitespace
 * search matches everything.
 */
export function matchesSearch(
  extension: Pick<CloudStreamExtensionView, 'name' | 'internalName' | 'repositoryName'>,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystacks = [
    extension.name ?? '',
    extension.internalName ?? '',
    extension.repositoryName ?? '',
  ];
  return haystacks.some((hay) => hay.toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Filters (§11)
// ---------------------------------------------------------------------------

/** Status-filter membership (enabled/disabled are orthogonal to compatibility). */
export function matchesStatusFilter(
  extension: Pick<CloudStreamExtensionView, 'enabled' | 'adapterState'>,
  filter: IntegrationStatusFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'enabled':
      return extension.enabled;
    case 'disabled':
      return !extension.enabled;
    case 'compatible':
      return hasExecutableAdapter(extension);
    case 'adapter_required':
      return extension.adapterState === 'adapter_required';
    case 'runtime_required':
      return extension.adapterState === 'runtime_required';
    case 'failed':
      return extension.adapterState === 'failed';
  }
}

/** Media-filter membership (rows supporting both movie and TV match either). */
export function matchesMediaFilter(
  extension: Pick<CloudStreamExtensionView, 'mediaTypes'>,
  filter: IntegrationMediaFilter,
): boolean {
  if (filter === 'all') return true;
  return extension.mediaTypes.includes(filter);
}

/** Repository-filter membership ('all' matches every row). */
export function matchesRepositoryFilter(
  extension: Pick<CloudStreamExtensionView, 'repositoryId'>,
  repositoryId: string | 'all',
): boolean {
  if (repositoryId === 'all') return true;
  return extension.repositoryId === repositoryId;
}

// ---------------------------------------------------------------------------
// Sorting (§11: deterministic with tie-breakers)
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareByDirection(comparison: number, dir: IntegrationSortDir): number {
  return dir === 'asc' ? comparison : -comparison;
}

/** The deterministic name comparator (name ?? internalName, then internalName, then id). */
function nameKey(extension: CloudStreamExtensionView): string {
  return extension.name ?? extension.internalName;
}

/**
 * Sorts the filtered list by the §11 keys. Every comparator ends in the
 * deterministic tie-break chain internalName → id, so the output order is
 * stable regardless of input order.
 */
export function sortExtensions(
  extensions: readonly CloudStreamExtensionView[],
  sortKey: IntegrationSortKey,
  sortDir: IntegrationSortDir,
): CloudStreamExtensionView[] {
  const rows = [...extensions];
  rows.sort((a, b) => {
    let primary = 0;
    if (sortKey === 'name') {
      primary = compareByDirection(compareStrings(nameKey(a), nameKey(b)), sortDir);
    } else if (sortKey === 'status') {
      primary = compareByDirection(
        (STATUS_SORT_RANK[a.adapterState] ?? 99) - (STATUS_SORT_RANK[b.adapterState] ?? 99),
        sortDir,
      );
    } else if (sortKey === 'enabled') {
      // Enabled-first is the useful direction under 'desc'; 'asc' lists
      // disabled rows first.
      primary = compareByDirection((a.enabled ? 1 : 0) - (b.enabled ? 1 : 0), sortDir);
    } else {
      // last_tested: nulls ALWAYS last (both directions — an untested row
      // never claims recency); dates compared as timestamps.
      const aTime = timestampOf(a.lastTestedAt);
      const bTime = timestampOf(b.lastTestedAt);
      if (aTime === null && bTime === null) primary = 0;
      else if (aTime === null) primary = 1;
      else if (bTime === null) primary = -1;
      else primary = compareByDirection(aTime - bTime, sortDir);
    }
    if (primary !== 0) return primary;
    const tie = compareStrings(a.internalName, b.internalName);
    if (tie !== 0) return tie;
    return compareStrings(a.id, b.id);
  });
  return rows;
}

function timestampOf(iso: string | null): number | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

// ---------------------------------------------------------------------------
// Pagination (§11 bounded rendering)
// ---------------------------------------------------------------------------

export type IntegrationPage = {
  /** The rows of the (clamped) current page. */
  rows: CloudStreamExtensionView[];
  /** Total filtered row count. */
  total: number;
  /** The clamped 1-based current page. */
  page: number;
  /** Page count (>= 1 even when empty, so controls stay stable). */
  pageCount: number;
  /** 0-based inclusive index of the first row on the page. */
  fromIndex: number;
  /** 0-based exclusive index after the last row on the page. */
  toIndex: number;
};

/** Paginates a list; clamps page into [1, pageCount] (pageCount >= 1). */
export function paginateExtensions(
  extensions: readonly CloudStreamExtensionView[],
  page: number,
  pageSize: number = INTEGRATION_PAGE_SIZE,
): IntegrationPage {
  const total = extensions.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const fromIndex = Math.min((clamped - 1) * pageSize, total);
  const toIndex = Math.min(fromIndex + pageSize, total);
  return {
    rows: extensions.slice(fromIndex, toIndex),
    total,
    page: clamped,
    pageCount,
    fromIndex,
    toIndex,
  };
}

// ---------------------------------------------------------------------------
// Stats (§11 repository header)
// ---------------------------------------------------------------------------

/** Counts one extension list into the §11 buckets. */
export function summarizeExtensions(
  extensions: readonly CloudStreamExtensionView[],
): ExtensionBucketCounts {
  const counts: ExtensionBucketCounts = {
    total: extensions.length,
    enabled: 0,
    disabled: 0,
    compatible: 0,
    adapterRequired: 0,
    runtimeRequired: 0,
    failed: 0,
  };
  for (const extension of extensions) {
    if (extension.enabled) counts.enabled += 1;
    else counts.disabled += 1;
    if (hasExecutableAdapter(extension)) counts.compatible += 1;
    else if (extension.adapterState === 'adapter_required') counts.adapterRequired += 1;
    else if (extension.adapterState === 'runtime_required') counts.runtimeRequired += 1;
    else if (extension.adapterState === 'failed') counts.failed += 1;
    // 'building'/'testing' (transient) count toward total only — honest.
  }
  return counts;
}

/**
 * Per-repository §11 summaries over the RAW catalog (repository order
 * preserved; repositories with zero extensions included with zero counts).
 */
export function summarizeRepositories(
  repositories: readonly CloudStreamRepositoryView[],
  extensions: readonly CloudStreamExtensionView[],
): RepositorySummary[] {
  return repositories.map((repository) => ({
    repository,
    counts: summarizeExtensions(extensions.filter((extension) => extension.repositoryId === repository.id)),
  }));
}

// ---------------------------------------------------------------------------
// §13 provider-status presentation
// ---------------------------------------------------------------------------

/**
 * The §13 presentation for one row. The mapping is CLOSED:
 *
 *   active          → ACTIVE            [Test Provider] [Disable]
 *   disabled*       → COMPATIBLE        Adapter: Ready …   [Test Provider] [Enable]
 *   adapter_required→ ADAPTER REQUIRED  [Create Adapter]
 *   runtime_required→ RUNTIME REQUIRED  (not convertible explanation)
 *   failed          → ADAPTER FAILED    Reason: …   [Retry]
 *   building/testing→ BUILDING/TESTING  (transient, no actions)
 *
 *   *operational 'disabled' = an executable adapter exists but the row is
 *   switched off (§13 "Ready").
 */
export function providerStatusPresentation(extension: CloudStreamExtensionView): ProviderStatusPresentation {
  switch (extension.adapterState) {
    case 'active':
      return {
        kind: 'active',
        label: 'ACTIVE',
        note: extension.lastTestedAt !== null ? `Last tested: ${formatTestedDate(extension.lastTestedAt)}` : 'Not tested yet',
        canTest: true,
        canCreateAdapter: false,
        primaryAction: 'Disable',
      };
    case 'disabled':
      return {
        kind: 'ready',
        label: 'COMPATIBLE',
        note: readyAdapterNote(extension),
        canTest: true,
        canCreateAdapter: false,
        primaryAction: 'Enable',
      };
    case 'runtime_required':
      return {
        kind: 'runtime_required',
        label: 'RUNTIME REQUIRED',
        note: 'This provider cannot be converted into a permanent Mavero adapter and remains disabled.',
        canTest: false,
        canCreateAdapter: false,
        primaryAction: null,
      };
    case 'failed':
      return {
        kind: 'failed',
        label: 'ADAPTER FAILED',
        note: `Reason: ${extension.lastBuildError ?? extension.lastTestError ?? 'the adapter build failed.'}`,
        canTest: false,
        canCreateAdapter: true,
        primaryAction: 'Retry',
      };
    case 'building':
    case 'testing':
      return {
        kind: extension.adapterState,
        label: extension.adapterState === 'building' ? 'BUILDING' : 'TESTING',
        note: 'An adapter build is in progress.',
        canTest: false,
        canCreateAdapter: false,
        primaryAction: null,
      };
    case 'adapter_required':
    default:
      return {
        kind: 'adapter_required',
        label: 'ADAPTER REQUIRED',
        note: null,
        canTest: false,
        canCreateAdapter: true,
        primaryAction: 'Create Adapter',
      };
  }
}

/** The §13 "Adapter: Ready" note with generated provenance when present. */
function readyAdapterNote(extension: CloudStreamExtensionView): string {
  const parts: string[] = ['Adapter: Ready'];
  if (extension.generatedAdapterVersion !== null) {
    parts.push(`generated v${extension.generatedAdapterVersion}`);
  }
  if (extension.builderVersion !== null && extension.builderVersion.length > 0) {
    parts.push(extension.builderVersion);
  }
  if (extension.lastTestedAt !== null) {
    parts.push(`tested ${formatTestedDate(extension.lastTestedAt)}`);
  }
  return parts.join(' · ');
}

/** Deterministic UTC date label (tests depend on TZ-independence). */
export function formatTestedDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  const date = new Date(time);
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Bulk selection (§11: select, select-all-filtered, enable/disable selected,
// create adapters for selected where valid)
// ---------------------------------------------------------------------------

/**
 * Whether a row is eligible for the bulk "Create Adapters" action
 * ("where valid" — only adapter_required/failed rows can enter the Builder
 * pipeline; the same rule as the single-row Create Adapter button).
 */
export function eligibleForBulkCreateAdapter(
  extension: Pick<CloudStreamExtensionView, 'adapterState'>,
): boolean {
  return extension.adapterState === 'adapter_required' || extension.adapterState === 'failed';
}

/** The subset of `ids` that still exists in `extensions` (prunes stale ids). */
export function pruneSelection(
  ids: ReadonlySet<string>,
  extensions: readonly CloudStreamExtensionView[],
): Set<string> {
  const valid = new Set(extensions.map((extension) => extension.id));
  return new Set([...ids].filter((id) => valid.has(id)));
}

/** Chunks ids into server-request-sized batches (MAX_BULK_IDS each). */
export function chunkBulkIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += MAX_BULK_IDS) {
    chunks.push(ids.slice(index, index + MAX_BULK_IDS));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// The full projection (one pure call the component derives its DOM from)
// ---------------------------------------------------------------------------

export type IntegrationManagerProjection = {
  /** Rows matching search + status + media + repository filters (pre-sort count source). */
  filtered: CloudStreamExtensionView[];
  /** The current page's rows (sorted + paginated — what the DOM renders). */
  rows: CloudStreamExtensionView[];
  /** Filtered total (pre-pagination). */
  total: number;
  /** Clamped current page (1-based). */
  page: number;
  pageCount: number;
  /** 0-based inclusive first-row index for the "showing X–Y of Z" line. */
  fromIndex: number;
  /** 0-based exclusive last-row index. */
  toIndex: number;
  /** §11 per-repository summaries over the RAW catalog. */
  repositorySummaries: RepositorySummary[];
  /** §11 aggregate stats over the RAW catalog (the All-repositories header). */
  aggregate: ExtensionBucketCounts;
  /** Rows matching the filters AND eligible for bulk create-adapter. */
  bulkCreateEligibleCount: number;
};

/**
 * Projects the whole manager view state from the catalog + query. Pure and
 * deterministic: same inputs → same output, no clock, no random, no DOM.
 */
export function projectIntegrationManager(
  extensions: readonly CloudStreamExtensionView[],
  repositories: readonly CloudStreamRepositoryView[],
  query: IntegrationManagerQuery,
): IntegrationManagerProjection {
  const filtered = extensions.filter(
    (extension) =>
      matchesSearch(extension, query.search)
      && matchesStatusFilter(extension, query.statusFilter)
      && matchesMediaFilter(extension, query.mediaFilter)
      && matchesRepositoryFilter(extension, query.repositoryId),
  );
  const sorted = sortExtensions(filtered, query.sortKey, query.sortDir);
  const page = paginateExtensions(sorted, query.page);
  return {
    filtered,
    rows: page.rows,
    total: page.total,
    page: page.page,
    pageCount: page.pageCount,
    fromIndex: page.fromIndex,
    toIndex: page.toIndex,
    repositorySummaries: summarizeRepositories(repositories, extensions),
    aggregate: summarizeExtensions(extensions),
    bulkCreateEligibleCount: filtered.filter((extension) => eligibleForBulkCreateAdapter(extension)).length,
  };
}
