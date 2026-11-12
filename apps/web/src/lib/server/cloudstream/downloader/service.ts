/**
 * MAVERO CloudStream Downloader 2 service (CS-3 — plan §13/§26/§40.3/§40.7).
 *
 * Exposes the CS-2 resolver through a production-safe downloader backend:
 *
 *   MAVERO DOWNLOADER 2 → CloudStream Extensions → CS-2 resolver
 *       → normalized downloadable stream candidates
 *
 * Architecture (isolated from the Stremio downloader — plan §2.3/§12):
 *   * Existing: Mavero Downloader → Stremio Addons → existing resolver.
 *   * New:      Mavero Downloader 2 → CloudStream Extensions → THIS service
 *              on top of the CS-2 bounded orchestrator. The resolvers are
 *              NEVER merged; only genuinely generic shared types/utilities
 *              (StreamKind, cloudstream-types views) are shared.
 *
 * EXTENSION SELECTION (plan §26 task 5 — code registry is authoritative):
 *   An extension participates ONLY when ALL of these hold:
 *     1. a `cloudstream_extensions` row exists (repository-synced catalog);
 *     2. its repository is enabled (repository enabled is the admin's
 *        whole-source switch; sync-health `status` does NOT block — an
 *        `error` repository can still have functional extensions);
 *     3. the extension row itself is enabled;
 *     4. a Mavero adapter is REGISTERED in the code-owned registry
 *        (D-007 — DB compatibility state is never the sole authority);
 *     5. the adapter supports the requested media type.
 *   Unknown/unimplemented extensions are NEVER attempted.
 *
 * DETERMINISTIC ORDERING (plan §40.7): the all-eligible order is repository
 * creation order → internal_name (the CS-1 catalog convention). Explicitly
 * selected extensions preserve the REQUESTED order. The orchestrator
 * returns groups in completion order — this service re-emits them in the
 * SELECTION order so the response is stable (never fastest-first).
 *
 * PARTIAL SUCCESS (plan §26 task 10): one failing/timing-out provider never
 * fails the request — allSettled isolation comes from the CS-2 orchestrator;
 * this service preserves failed groups alongside successful ones.
 *
 * CONCURRENCY (plan §40.7): there is NO second fan-out layer. The API layer
 * orchestrates only; the CS-2 budgets are THE budgets (mapBounded ≤4,
 * 30s/adapter, 40s overall, 10s/page). This service never multiplies them.
 *
 * CACHING (documented decision, plan §40.7): NO caching. Resolution results
 * are dynamic (providers rotate domains, URLs expire, extractors change) —
 * every response is fresh and served `no-store`. Short-lived caching may be
 * revisited in a later phase only with a demonstrated need.
 *
 * DEDUPLICATION SEMANTICS (documented, plan §40.7): CS-2's true-URL dedup
 * applies WITHIN one extension's group (exact duplicate URLs collapse).
 * The SAME URL appearing under TWO different extensions is intentionally
 * preserved in both groups — provider/source identity stays visible to the
 * future CS-4 UI (which provider actually resolved it).
 *
 * SECURITY: extension config is read SERVER-SIDE via the admin client only
 * (CS-1 RLS posture — no public SELECT policy on cloudstream_* tables).
 * Client-supplied extension ids are NEVER trusted: they are resolved
 * through the DB + code registry before any adapter runs. Diagnostics are
 * redaction-safe (categories/counts/durations — no URLs, cookies, tokens).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { ContentType } from '$lib/server/content/types';
import { normalizeContentIdentifiers } from '$lib/server/resolver/identifiers';
import type {
  CloudStreamDownloadGroupDiagnostics,
  CloudStreamDownloadGroupView,
  CloudStreamDownloadLinkView,
  CloudStreamDownloadMediaView,
  CloudStreamDownloadStageSummary,
  CloudStreamDownloadTabView,
  CloudStreamDownloaderErrorCode,
} from '$lib/shared/cloudstream-types';
import type { MaveroCloudStreamAdapter } from '../types/runtime';
import type { CloudStreamResolutionGroup, CloudStreamResolutionResult } from '../types/runtime';
import {
  canonicalAdapterKeyForRow,
  executableAdapterForExtension,
} from '$lib/server/extensions/adapter-registry';
import { buildGeneratedAdapterMap, type GeneratedAdapterArtifactRow } from '$lib/server/extensions/builder/generated-registry';
import { resolveCloudStream } from '../resolver/service';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';
import { CloudStreamDownloaderError, downloaderErrorMessage, failureCategoryToErrorCode } from './errors';

type CloudStreamClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Request + content contracts
// ---------------------------------------------------------------------------

/** A Downloader 2 request (mirrors the Stremio AddonDownloadRequest shape). */
export type CloudStreamDownloadRequest = {
  mediaType: ContentType;
  contentId: string;
  /** Required for series/anime; must be ABSENT for movies. */
  season?: number;
  episode?: number;
};

/** The content facts the CloudStream resolution needs (CS-2 request shape). */
export type CloudStreamDownloadContent = {
  mediaType: ContentType;
  tmdbId: string;
  title: string;
  year?: number;
};

/** DB row projection for extension selection (internal — never exposed raw). */
export type CloudStreamExtensionSelectionRow = {
  repository_id: string;
  internal_name: string;
  name: string | null;
  icon_url: string | null;
  enabled: boolean;
  /** Phase 2 — the unified catalog carries cloudstream + nuvio rows; only
   * cloudstream rows can bind a native code adapter (type-aware eligibility). */
  integration_type: string;
  /** Phase 3 — persisted adapter_state + active artifact pointer (the
   * generated-binding inputs; joined in code with the artifact rows). */
  adapter_state: string;
  generated_adapter_version: number | null;
};

/** Repository rows needed for participation + deterministic ordering. */
export type CloudStreamRepositorySelectionRow = {
  id: string;
  enabled: boolean;
  created_at: string;
};

/** The joined selection state (rows + repository order, joined in code). */
export type CloudStreamExtensionCatalog = {
  repositories: CloudStreamRepositorySelectionRow[];
  extensions: CloudStreamExtensionSelectionRow[];
  /** Phase 3 (D-P3-8): READY artifact rows for generated extensions — the
   * ONLY source of generated adapter instances (persisted artifacts, never
   * the Builder). Empty array = native-only behavior, byte-identical. */
  generatedArtifacts: GeneratedAdapterArtifactRow[];
};

export type CloudStreamDownloaderDeps = {
  /** Injectable content lookup (tests); defaults to the content pipeline. */
  loadContent?: (mediaType: ContentType, contentId: string) => Promise<CloudStreamDownloadContent>;
  /** Injectable catalog loader (tests); defaults to the two-plain-select query. */
  loadCatalog?: (client: CloudStreamClient) => Promise<CloudStreamExtensionCatalog>;
  /** Injectable fetcher → CS-2 orchestrator (tests never touch the network). */
  fetcher?: typeof fetch;
  /** Injectable DNS resolver → CS-2 orchestrator (tests). */
  dnsResolver?: SafeDnsResolver;
  /** Per-adapter timeout override (tests). */
  adapterTimeoutMs?: number;
  /** Overall timeout override (tests). */
  overallTimeoutMs?: number;
  /**
   * External cancellation (Permanent Adapter Plan Phase 1): forwarded into
   * the resolver's overall controller — the API layer passes the client's
   * request signal so an abandoned request stops server-side resolution.
   */
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Tabs endpoint result (plan §40.3: `{ ok: true, consideredExtensions, tabs }`). */
export type CloudStreamDownloadTabsResult = {
  media: CloudStreamDownloadMediaView;
  tabs: CloudStreamDownloadTabView[];
  /** Enabled extensions CONSIDERED (the participation baseline). */
  consideredExtensions: number;
};

/** Main resolution endpoint result (all eligible, or explicitly selected). */
export type CloudStreamDownloadResolveResult = {
  media: CloudStreamDownloadMediaView;
  groups: CloudStreamDownloadGroupView[];
  /** Enabled extensions CONSIDERED (the participation baseline). */
  consideredExtensions: number;
};

/** Single-extension endpoint result. */
export type CloudStreamExtensionDownloadResult = {
  media: CloudStreamDownloadMediaView;
  group: CloudStreamDownloadGroupView;
};

/** Maximum explicitly-selected extensions per request (bounded fan-in). */
export const MAX_SELECTED_EXTENSIONS = 16;
/** Per-group diagnostic stage bound (response safety; CS-2 caps at 256 total). */
export const MAX_GROUP_DIAGNOSTIC_STAGES = 32;

// ---------------------------------------------------------------------------
// Request validation (mirrors the audited downloader + resolver conventions)
// ---------------------------------------------------------------------------

/**
 * Validates the request shape. Series/anime REQUIRE season+episode
 * (1..10000 safe integers, both or neither); movies must NOT carry episode
 * context (the request contract distinguishes movie vs series episode — a
 * series is never accidentally resolved as a movie, plan §13).
 */
export function assertValidCloudStreamDownloadRequest(request: CloudStreamDownloadRequest): void {
  if (!request.contentId || request.contentId.length > 200) {
    throw new CloudStreamDownloaderError('INVALID_REQUEST', downloaderErrorMessage('INVALID_REQUEST'));
  }
  if (request.mediaType !== 'movie' && request.mediaType !== 'series' && request.mediaType !== 'anime') {
    throw new CloudStreamDownloaderError('INVALID_REQUEST', downloaderErrorMessage('INVALID_REQUEST'));
  }
  const { season, episode } = request;
  if (request.mediaType === 'movie') {
    if (season !== undefined || episode !== undefined) {
      throw new CloudStreamDownloaderError('INVALID_REQUEST', downloaderErrorMessage('INVALID_REQUEST'));
    }
    return;
  }
  // series / anime: season+episode required, both-or-neither, 1..10000.
  if (
    !Number.isSafeInteger(season) || !Number.isSafeInteger(episode)
    || (season as number) < 1 || (season as number) > 10000
    || (episode as number) < 1 || (episode as number) > 10000
  ) {
    throw new CloudStreamDownloaderError('INVALID_REQUEST', downloaderErrorMessage('INVALID_REQUEST'));
  }
}

// ---------------------------------------------------------------------------
// Eligibility (plan §26 task 5 — selection over DB rows + code registry)
// ---------------------------------------------------------------------------

/** Adapter media-type support for one request shape. */
export function adapterSupportsMediaType(
  adapter: MaveroCloudStreamAdapter,
  mediaType: ContentType,
): boolean {
  switch (mediaType) {
    case 'movie':
      return adapter.supports.movie;
    case 'series':
      return adapter.supports.series;
    case 'anime':
      // Anime content rides the normal movie/series pipeline (content
      // types §NormalizedMediaItem.isAnime) — a series-capable adapter can
      // resolve series-shaped anime; an anime-flagged adapter always can.
      return adapter.supports.anime || adapter.supports.series;
    default:
      return false;
  }
}

/** Media types the registered adapter supports (tab metadata — code authority). */
export function adapterSupportedMediaTypes(adapter: MaveroCloudStreamAdapter): Array<'movie' | 'series' | 'anime'> {
  const types: Array<'movie' | 'series' | 'anime'> = [];
  if (adapter.supports.movie) types.push('movie');
  if (adapter.supports.series) types.push('series');
  if (adapter.supports.anime) types.push('anime');
  return types;
}

/** One eligible extension (row + registered adapter + deterministic order key). */
export type EligibleCloudStreamExtension = {
  row: CloudStreamExtensionSelectionRow;
  adapter: MaveroCloudStreamAdapter;
  /** Repository creation order (deterministic ordering key). */
  repositoryOrder: number;
};

/**
 * Selects the ELIGIBLE extensions for a media type from the catalog:
 * repository enabled AND extension enabled AND adapter registered AND
 * media-type support. Ordered by repository creation order → internal_name.
 *
 * PHASE 2 (type-aware + canonical dedup):
 *   * Adapter binding goes through the unified permanent adapter registry —
 *     ONLY cloudstream rows bind native code adapters. A Nuvio row whose
 *     provider id collides with a native adapter id (e.g. 'MoviesDrive')
 *     is honestly ineligible until a Nuvio adapter exists (Phase 3+).
 *   * Selection deduplicates by CANONICAL adapter key — the same provider
 *     registered in multiple enabled repositories resolves exactly once
 *     (deterministic: repository creation order), so the same adapter never
 *     burns budget twice. Catalog rows are NOT merged (repository-level
 *     identity preserved — no premature cross-repo dedup).
 *
 * PHASE 3 (D-P3-8): generated adapters bind from PERSISTED artifacts
 * (catalog.generatedArtifacts → generated-registry instances) with NATIVE
 * precedence — a healthy native binding is never overridden (plan §16).
 * Absent artifacts = Phase 2 behavior, byte-identical.
 */
export function selectEligibleExtensions(
  catalog: CloudStreamExtensionCatalog,
  mediaType: ContentType,
): EligibleCloudStreamExtension[] {
  const repoOrder = new Map(catalog.repositories.map((repo, index) => [repo.id, index]));
  const repoEnabled = new Set(catalog.repositories.filter((repo) => repo.enabled).map((repo) => repo.id));
  const generatedAdapters = (catalog.generatedArtifacts ?? []).length > 0
    ? buildGeneratedAdapterMap(catalog.generatedArtifacts)
    : undefined;
  const eligible: EligibleCloudStreamExtension[] = [];
  const seenCanonicalKeys = new Set<string>();
  for (const row of catalog.extensions) {
    if (!repoEnabled.has(row.repository_id)) continue;
    if (!row.enabled) continue;
    const adapter = executableAdapterForExtension(row, generatedAdapters);
    if (adapter === null) continue;
    // Canonical dedup: same provider across repositories resolves once.
    const canonicalKey = canonicalAdapterKeyForRow(row);
    if (seenCanonicalKeys.has(canonicalKey)) continue;
    seenCanonicalKeys.add(canonicalKey);
    if (!adapterSupportsMediaType(adapter, mediaType)) continue;
    eligible.push({ row, adapter, repositoryOrder: repoOrder.get(row.repository_id) ?? 0 });
  }
  return eligible.sort((a, b) =>
    a.repositoryOrder - b.repositoryOrder || a.row.internal_name.localeCompare(b.row.internal_name));
}

/** Counts the participation baseline: repo-enabled + extension-enabled rows. */
export function countEnabledExtensions(catalog: CloudStreamExtensionCatalog): number {
  const repoEnabled = new Set(catalog.repositories.filter((repo) => repo.enabled).map((repo) => repo.id));
  return catalog.extensions.filter((row) => repoEnabled.has(row.repository_id) && row.enabled).length;
}

// ---------------------------------------------------------------------------
// Deterministic row resolution by REQUESTED EXTENSION ID (audit fix)
// ---------------------------------------------------------------------------

/**
 * Sorts catalog rows into the deterministic catalog order (repository
 * creation order → internal_name — the CS-1/CS-3 selection convention).
 *
 * Rationale (source-discovery audit): `defaultLoadCatalog` selects rows
 * WITHOUT an ORDER BY (PostgREST returns an unspecified physical order),
 * and the Phase 2 unified catalog lets the SAME provider name exist in
 * MULTIPLE repositories AND under BOTH integration types (e.g. the enabled
 * cloudstream 'MoviesDrive' row plus disabled nuvio 'moviesdrive' rows).
 * Any first-wins/last-wins pick over the raw array is therefore order-
 * dependent and can resolve a requested extension id to a DIFFERENT row
 * than the eligibility selection would pick — producing EXTENSION_DISABLED
 * for a source that is active in Downloader 2 tabs (the MoviesDrive
 * Admin-Test-passes-but-Downloader-2-fails class). Sorting first makes every
 * id resolution deterministic regardless of DB row order.
 */
function catalogOrder(catalog: CloudStreamExtensionCatalog): CloudStreamExtensionSelectionRow[] {
  // The repository order is DATA-DERIVED (created_at, then id as the stable
  // tie-break) — never the caller's array position. defaultLoadCatalog
  // selects repositories ordered by created_at, but the deterministic
  // guarantee must not silently depend on that (order-independent under any
  // caller's array order — pinned by the audit regression suite).
  const orderedRepos = [...catalog.repositories].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const repoOrder = new Map(orderedRepos.map((repo, index) => [repo.id, index]));
  return [...catalog.extensions].sort((a, b) =>
    (repoOrder.get(a.repository_id) ?? 0) - (repoOrder.get(b.repository_id) ?? 0)
    || a.internal_name.localeCompare(b.internal_name));
}

/** Rank classes for resolving one requested id to a catalog row (lower wins). */
const ROW_RESOLUTION_RANK = { executableEnabled: 0, executable: 1, enabled: 2, other: 3 } as const;

/**
 * Resolves ONE requested extension id to its authoritative catalog row.
 *
 * Matching (same surface the Phase 2/3 contract exposes):
 *   1. CANONICAL KEY exact match ('cloudstream:moviesdrive' | 'nuvio:…')
 *      — unambiguous, integration-type-qualified.
 *   2. BARE internal name (case-insensitive) — the legacy Phase 2 address.
 *
 * Selection among multiple matches (deterministic, audit fix):
 *   a. rows that bind an EXECUTABLE adapter (native registry, or an ACTIVE
 *      generated artifact — the canonical key is SHARED by same-provider rows
 *      from multiple repositories) AND are repo-enabled + row-enabled win
 *      first: this is exactly the row the eligibility selection and the
 *      tabs/batch path resolve (first-eligible-row-wins), so the
 *      single-extension RETRY addresses the same row the tab shows;
 *   b. then executable-but-disabled rows (binding exists, row switched off);
 *   c. then enabled rows without a binding (honest EXTENSION_DISABLED /
 *      ADAPTER_NOT_AVAILABLE for the right identity);
 *   d. then everything else — first in deterministic catalog order.
 *
 * The within-class tie-break is the deterministic catalog order (repository
 * creation → internal_name) — identical to the eligibility discipline, so
 * id resolution and eligibility can never disagree.
 */
export function resolveExtensionRow(
  catalog: CloudStreamExtensionCatalog,
  requestedId: string,
): CloudStreamExtensionSelectionRow | null {
  if (typeof requestedId !== 'string' || requestedId.length === 0 || requestedId.length > 200) return null;
  const key = requestedId.trim().toLowerCase();
  if (key.length === 0) return null;

  const generatedAdapters = (catalog.generatedArtifacts ?? []).length > 0
    ? buildGeneratedAdapterMap(catalog.generatedArtifacts)
    : undefined;
  const repoEnabled = new Set(catalog.repositories.filter((repo) => repo.enabled).map((repo) => repo.id));

  const ranked = catalogOrder(catalog)
    .filter((row) => row.internal_name.toLowerCase() === key || canonicalAdapterKeyForRow(row) === key)
    .map((row) => {
      const executable = executableAdapterForExtension(row, generatedAdapters) !== null;
      const enabled = repoEnabled.has(row.repository_id) && row.enabled;
      const rank = executable && enabled ? ROW_RESOLUTION_RANK.executableEnabled
        : executable ? ROW_RESOLUTION_RANK.executable
        : enabled ? ROW_RESOLUTION_RANK.enabled
        : ROW_RESOLUTION_RANK.other;
      return { row, rank };
    })
    .sort((a, b) => a.rank - b.rank);

  return ranked.length > 0 ? ranked[0]!.row : null;
}

/**
 * Builds the requested-id → row map for Mode 2 (explicit selection).
 *
 * Canonical keys are collision-free per row set but the SAME canonical key
 * legitimately exists for one provider in multiple repositories; the BARE
 * name additionally collides ACROSS integration types. Every key maps
 * through `resolveExtensionRow` so the map picks the same authoritative row
 * the single-extension endpoint and the eligibility selection would pick
 * (previously a plain last-wins overwrite — the deterministic EXTENSION_DISABLED
 * MoviesDrive defect).
 */
export function buildRequestedRowMap(
  catalog: CloudStreamExtensionCatalog,
): Map<string, CloudStreamExtensionSelectionRow> {
  const map = new Map<string, CloudStreamExtensionSelectionRow>();
  const keysFor = (row: CloudStreamExtensionSelectionRow): string[] => [
    row.internal_name.toLowerCase(),
    canonicalAdapterKeyForRow(row),
  ];
  for (const row of catalogOrder(catalog)) {
    for (const key of keysFor(row)) {
      const resolved = resolveExtensionRow(catalog, key);
      if (resolved !== null) map.set(key, resolved);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Group shaping (normalization → Downloader 2 response views)
// ---------------------------------------------------------------------------

/** Maps one normalized link into the response view (no invented fields). */
function toLinkView(link: CloudStreamResolutionGroup['links'][number]): CloudStreamDownloadLinkView {
  const view: CloudStreamDownloadLinkView = {
    url: link.url,
    kind: link.kind,
    provider: link.provider,
    sourceName: link.sourceName,
  };
  if (link.quality !== undefined) view.quality = link.quality;
  if (link.codec !== undefined) view.codec = link.codec;
  if (link.container !== undefined) view.container = link.container;
  if (link.filename !== undefined) view.filename = link.filename;
  if (link.sizeBytes !== undefined) view.sizeBytes = link.sizeBytes;
  if (link.audioLanguages !== undefined && link.audioLanguages.length > 0) view.audioLanguages = link.audioLanguages;
  if (link.host !== undefined) view.host = link.host;
  if (link.extractor !== undefined) view.extractor = link.extractor;
  return view;
}

/** Builds the redaction-safe per-group diagnostics summary (≤32 stages). */
function toGroupDiagnostics(
  events: CloudStreamResolutionResult['diagnostics'],
  adapterId: string,
): CloudStreamDownloadGroupDiagnostics | undefined {
  const own = events.filter((event) => event.adapterId === adapterId);
  if (own.length === 0) return undefined;
  const resolveEvent = own.find((event) => event.stage === 'resolve');
  const stages: CloudStreamDownloadStageSummary[] = own.slice(0, MAX_GROUP_DIAGNOSTIC_STAGES).map((event) => {
    const stage: CloudStreamDownloadStageSummary = {
      stage: event.stage,
      success: event.success,
      durationMs: event.durationMs,
    };
    if (event.httpStatus !== undefined) stage.httpStatus = event.httpStatus;
    if (event.resultCount !== undefined) stage.resultCount = event.resultCount;
    if (event.extractorId !== undefined) stage.extractorId = event.extractorId;
    if (event.retries !== undefined) stage.retries = event.retries;
    return stage;
  });
  const durationMs = resolveEvent !== undefined
    ? resolveEvent.durationMs
    : own.reduce((total, event) => total + event.durationMs, 0);
  return { durationMs, stages };
}

/** Maps one CS-2 resolution group into the Downloader 2 view. */
function toGroupView(
  group: CloudStreamResolutionGroup,
  extensionName: string,
  diagnostics: CloudStreamResolutionResult['diagnostics'],
): CloudStreamDownloadGroupView {
  const view: CloudStreamDownloadGroupView = {
    extensionId: group.adapterId,
    extensionName,
    status: group.status,
    links: group.links.map(toLinkView),
  };
  if (group.failure !== undefined) {
    view.errorCode = failureCategoryToErrorCode(group.failure.category);
    view.errorMessage = downloaderErrorMessage(view.errorCode);
  }
  if (group.matchedTitle !== undefined && group.matchedTitle.length > 0) view.matchedTitle = group.matchedTitle;
  const groupDiagnostics = toGroupDiagnostics(diagnostics, group.adapterId);
  if (groupDiagnostics !== undefined) view.diagnostics = groupDiagnostics;
  return view;
}

/** Builds a failed group for a requested-but-ineligible extension (no fetch). */
function toIneligibleGroupView(
  extensionId: string,
  errorCode: CloudStreamDownloaderErrorCode,
): CloudStreamDownloadGroupView {
  return {
    extensionId,
    extensionName: extensionId,
    status: 'failed',
    links: [],
    errorCode,
    errorMessage: downloaderErrorMessage(errorCode),
  };
}

/** Builds the media context echo from the content lookup + request. */
function toMediaView(
  content: CloudStreamDownloadContent,
  request: CloudStreamDownloadRequest,
): CloudStreamDownloadMediaView {
  const media: CloudStreamDownloadMediaView = {
    mediaType: content.mediaType,
    tmdbId: content.tmdbId,
    title: content.title,
  };
  if (content.year !== undefined) media.year = content.year;
  if (request.season !== undefined) media.season = request.season;
  if (request.episode !== undefined) media.episode = request.episode;
  return media;
}

/** Safe display name for an extension row (DB name, else adapter display). */
function extensionDisplayName(row: CloudStreamExtensionSelectionRow | undefined, adapter: MaveroCloudStreamAdapter): string {
  if (row !== undefined && typeof row.name === 'string' && row.name.length > 0) return row.name;
  return adapter.displayName;
}

// ---------------------------------------------------------------------------
// Observability (plan §21 — safe fields only, matches existing conventions)
// ---------------------------------------------------------------------------

function logResolutionSummary(
  request: CloudStreamDownloadRequest,
  tmdbId: string,
  groups: CloudStreamDownloadGroupView[],
  considered: number,
  durationMs: number,
): void {
  const loaded = groups.filter((group) => group.status === 'loaded').length;
  const empty = groups.filter((group) => group.status === 'empty').length;
  const failed = groups.filter((group) => group.status === 'failed').length;
  console.info(
    `[MaveroDownloader2] resolve mediaType=${request.mediaType} tmdbId=${tmdbId}`
    + ` considered=${considered} groups=${groups.length} loaded=${loaded} empty=${empty} failed=${failed}`
    + ` durationMs=${durationMs}`,
  );
  for (const group of groups) {
    if (group.status === 'failed' && group.errorCode !== undefined) {
      console.info(`[MaveroDownloader2] extension failed extension=${group.extensionId} code=${group.errorCode}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Default loaders (production wiring; tests inject their own)
// ---------------------------------------------------------------------------

async function defaultLoadContent(mediaType: ContentType, contentId: string): Promise<CloudStreamDownloadContent> {
  const { getDetail } = await import('$lib/server/content/service');
  const content = await getDetail(mediaType, contentId);
  const identifiers = normalizeContentIdentifiers(content, {
    sourceId: 'mavero-downloader-2',
    contentId,
    mediaType,
  });
  if (!identifiers.tmdbId) {
    throw new CloudStreamDownloaderError('INVALID_REQUEST', 'This title could not be loaded for downloading.');
  }
  return {
    mediaType,
    tmdbId: identifiers.tmdbId,
    title: content.title,
    ...(Number.isInteger(content.year) && content.year > 0 ? { year: content.year } : {}),
  };
}

async function defaultLoadCatalog(client: CloudStreamClient): Promise<CloudStreamExtensionCatalog> {
  // Two plain selects joined in code (CS-1 convention — no PostgREST embeds,
  // easy to fake in tests). Reads happen through the ADMIN client only: the
  // cloudstream_* tables have no public SELECT policy (CS-1 RLS posture).
  const { data: repoData, error: repoError } = await client
    .from('cloudstream_repositories')
    .select('id, enabled, created_at')
    .order('created_at', { ascending: true });
  if (repoError) throw repoError;
  const repositories = (repoData ?? []) as unknown as CloudStreamRepositorySelectionRow[];

  const { data: extData, error: extError } = await client
    .from('cloudstream_extensions')
    .select('repository_id, internal_name, name, icon_url, enabled, integration_type, adapter_state, generated_adapter_version');
  if (extError) throw extError;
  const extensions = (extData ?? []) as unknown as CloudStreamExtensionSelectionRow[];

  // Phase 3 (D-P3-8): one additional plain select for the ACTIVE artifacts
  // of generated rows — the ONLY source of generated adapter instances.
  // Skipped entirely when no row is generated (pure-cloudstream catalogs:
  // behavior byte-identical to Phase 2, no extra query).
  let generatedArtifacts: GeneratedAdapterArtifactRow[] = [];
  const activeGenerated = extensions.filter(
    (row) => row.adapter_state === 'generated' && row.generated_adapter_version !== null,
  );
  if (activeGenerated.length > 0) {
    // Phase 5 (Session 13) FIX — ACTIVE-version binding: select ONLY each
    // canonical key's ACTIVE artifact version (the row's
    // generated_adapter_version pointer; rollback = pointer re-version,
    // plan §12/§13). The previous shape fetched EVERY version of a key
    // unordered and let buildGeneratedAdapterMap's first-wins binding pick
    // arbitrarily — after a rollback (pointer moved to an older version) or
    // a fresh rebuild (pointer moved to a newer version) Downloader 2 could
    // resolve a NON-active version, nondeterministically, diverging from
    // the admin Test Provider path (test-service filters by the pointer).
    // The active version per canonical key follows the selection's own
    // first-ELIGIBLE-row-wins discipline (repo enabled + row enabled,
    // repository creation order → internal_name), so the map and the
    // selection agree on which row's pointer is authoritative.
    const repoOrder = new Map(repositories.map((repo, index) => [repo.id, index]));
    const repoEnabled = new Set(repositories.filter((repo) => repo.enabled).map((repo) => repo.id));
    const activeVersionByKey = new Map<string, number>();
    for (const row of [...activeGenerated].sort((a, b) =>
      (repoOrder.get(a.repository_id) ?? 0) - (repoOrder.get(b.repository_id) ?? 0)
      || a.internal_name.localeCompare(b.internal_name))) {
      if (!repoEnabled.has(row.repository_id) || !row.enabled) continue;
      const key = canonicalAdapterKeyForRow(row);
      if (!activeVersionByKey.has(key)) activeVersionByKey.set(key, row.generated_adapter_version!);
    }
    const keys = [...activeVersionByKey.keys()];
    if (keys.length > 0) {
      const { data: artifactData, error: artifactError } = await client
        .from('cloudstream_adapter_artifacts')
        .select('canonical_key, integration_type, provider_id, adapter_version, strategy, artifact, artifact_hash')
        .in('canonical_key', keys);
      if (artifactError) throw artifactError;
      const rows = (artifactData ?? []) as unknown as GeneratedAdapterArtifactRow[];
      generatedArtifacts = rows.filter(
        (row) => activeVersionByKey.get(row.canonical_key) === row.adapter_version,
      );
    }
  }

  return { repositories, extensions, generatedArtifacts };
}

// ---------------------------------------------------------------------------
// Internal shared resolution core
// ---------------------------------------------------------------------------

/** Resolves the given adapters through the CS-2 orchestrator (no DB here). */
async function resolveThroughOrchestrator(
  content: CloudStreamDownloadContent,
  request: CloudStreamDownloadRequest,
  adapterIds: string[],
  deps: CloudStreamDownloaderDeps,
  adapterInstances?: ReadonlyMap<string, MaveroCloudStreamAdapter>,
): Promise<CloudStreamResolutionResult> {
  return resolveCloudStream(
    {
      media: { tmdbId: content.tmdbId, title: content.title, ...(content.year !== undefined ? { year: content.year } : {}) },
      ...(request.season !== undefined && request.episode !== undefined
        ? { season: request.season, episode: request.episode }
        : {}),
      adapterIds,
    },
    {
      ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
      ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
      ...(deps.adapterTimeoutMs !== undefined ? { adapterTimeoutMs: deps.adapterTimeoutMs } : {}),
      ...(deps.overallTimeoutMs !== undefined ? { overallTimeoutMs: deps.overallTimeoutMs } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(adapterInstances !== undefined ? { adapterInstances } : {}),
    },
  );
}

/** Content + catalog load with typed error wrapping (Stremio parity). */
async function loadContentAndCatalog(
  client: CloudStreamClient,
  request: CloudStreamDownloadRequest,
  deps: CloudStreamDownloaderDeps,
): Promise<{ content: CloudStreamDownloadContent; catalog: CloudStreamExtensionCatalog }> {
  let content: CloudStreamDownloadContent;
  try {
    content = await (deps.loadContent ?? defaultLoadContent)(request.mediaType, request.contentId);
  } catch (error) {
    if (error instanceof CloudStreamDownloaderError) throw error;
    throw new CloudStreamDownloaderError('INVALID_REQUEST', 'This title could not be loaded for downloading.');
  }
  let catalog: CloudStreamExtensionCatalog;
  try {
    catalog = await (deps.loadCatalog ?? defaultLoadCatalog)(client);
  } catch (error) {
    if (error instanceof CloudStreamDownloaderError) throw error;
    throw new CloudStreamDownloaderError('INTERNAL_ERROR', downloaderErrorMessage('INTERNAL_ERROR'));
  }
  return { content, catalog };
}

// ---------------------------------------------------------------------------
// Public API — tabs
// ---------------------------------------------------------------------------

/**
 * Lists the eligible CloudStream source tabs for one title (NO provider
 * fetches). The future CS-4 UI renders tabs immediately and fires the
 * extension endpoint per tab independently.
 */
export async function listCloudStreamDownloadTabs(
  client: CloudStreamClient,
  request: CloudStreamDownloadRequest,
  deps: CloudStreamDownloaderDeps = {},
): Promise<CloudStreamDownloadTabsResult> {
  assertValidCloudStreamDownloadRequest(request);
  const { content, catalog } = await loadContentAndCatalog(client, request, deps);

  const eligible = selectEligibleExtensions(catalog, request.mediaType);
  const tabs: CloudStreamDownloadTabView[] = eligible.map(({ row, adapter }) => ({
    extensionId: adapter.id,
    extensionName: extensionDisplayName(row, adapter),
    iconUrl: typeof row.icon_url === 'string' && row.icon_url.length > 0 ? row.icon_url : null,
    supportedMediaTypes: adapterSupportedMediaTypes(adapter),
    // Only eligible sources are listed — both flags are structurally true;
    // kept in the contract for CS-4 shape stability (plan §40.3 tabs sketch).
    enabled: true,
    compatible: true,
    // FINAL TASK (unified downloader): the global-ordering identity — the
    // same type-aware canonical key the eligibility selection deduped on, so
    // the ordering key and the user-visible source identity never disagree.
    canonicalKey: canonicalAdapterKeyForRow(row),
  }));

  return {
    media: toMediaView(content, request),
    tabs,
    consideredExtensions: countEnabledExtensions(catalog),
  };
}

// ---------------------------------------------------------------------------
// Public API — batch resolution (all eligible, or explicitly selected)
// ---------------------------------------------------------------------------

/**
 * Resolves one title through the eligible CloudStream extensions.
 *
 * Selection modes (plan §13/§40.3):
 *   * `options.extensionIds` ABSENT/empty → resolve ALL eligible extensions
 *     (deterministic catalog order: repository creation → internal_name).
 *   * `options.extensionIds` present → resolve ONLY those extensions in the
 *     REQUESTED order. Each requested id is validated through the DB + code
 *     registry; ineligible ones produce failed groups with closed-vocabulary
 *     error codes (EXTENSION_NOT_FOUND / EXTENSION_DISABLED /
 *     ADAPTER_NOT_AVAILABLE / UNSUPPORTED_MEDIA) — partial-success contract,
 *     one invalid selection never fails the whole request.
 */
export async function resolveCloudStreamDownloads(
  client: CloudStreamClient,
  request: CloudStreamDownloadRequest,
  options: { extensionIds?: string[] } = {},
  deps: CloudStreamDownloaderDeps = {},
): Promise<CloudStreamDownloadResolveResult> {
  assertValidCloudStreamDownloadRequest(request);
  const startedAt = Date.now();
  const { content, catalog } = await loadContentAndCatalog(client, request, deps);
  const considered = countEnabledExtensions(catalog);

  const requestedIds = Array.isArray(options.extensionIds) ? options.extensionIds : [];
  if (requestedIds.length > MAX_SELECTED_EXTENSIONS) {
    throw new CloudStreamDownloaderError('INVALID_REQUEST', downloaderErrorMessage('INVALID_REQUEST'));
  }

  let groups: CloudStreamDownloadGroupView[];

  if (requestedIds.length === 0) {
    // Mode 1: all eligible extensions in deterministic catalog order.
    const eligible = selectEligibleExtensions(catalog, request.mediaType);
    // Phase 3: generated adapter instances travel with the resolution —
    // the resolver binds native FIRST, then these (plan §16 precedence).
    const adapterInstances = new Map<string, MaveroCloudStreamAdapter>();
    for (const { adapter } of eligible) adapterInstances.set(adapter.id.toLowerCase(), adapter);
    const result = eligible.length > 0
      ? await resolveThroughOrchestrator(
          content,
          request,
          eligible.map(({ adapter }) => adapter.id),
          deps,
          adapterInstances,
        )
      : null;
    const byAdapter = new Map(result?.groups.map((group) => [group.adapterId, group]) ?? []);
    groups = eligible.map(({ row, adapter }) => {
      const group = byAdapter.get(adapter.id);
      if (group === undefined) {
        // Defensive: the orchestrator always emits one group per adapter id.
        return toIneligibleGroupView(adapter.id, 'INTERNAL_ERROR');
      }
      return toGroupView(group, extensionDisplayName(row, adapter), result?.diagnostics ?? []);
    });
  } else {
    // Mode 2: explicitly selected extensions in REQUESTED order. De-duplicate
    // case-insensitively (first occurrence wins), never trusting client ids.
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const rawId of requestedIds) {
      if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > 200) continue;
      const key = rawId.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      ordered.push(rawId.trim());
    }

    // Audit fix: deterministic, collision-free row resolution. The previous
    // plain last-wins map let a DISABLED same-name row (e.g. a nuvio
    // 'moviesdrive' clone) shadow the ENABLED cloudstream row the
    // eligibility/tabs path would pick — an explicit selection then failed
    // with EXTENSION_DISABLED despite the source being active.
    const rowByKey = buildRequestedRowMap(catalog);
    const repoEnabled = new Set(catalog.repositories.filter((repo) => repo.enabled).map((repo) => repo.id));
    const generatedAdapters = (catalog.generatedArtifacts ?? []).length > 0
      ? buildGeneratedAdapterMap(catalog.generatedArtifacts)
      : undefined;

    const resolvable: Array<{ row: CloudStreamExtensionSelectionRow; adapter: MaveroCloudStreamAdapter }> = [];
    const structured: Array<{ extensionId: string; code: CloudStreamDownloaderErrorCode }> = [];
    const selectedInstances = new Map<string, MaveroCloudStreamAdapter>();
    for (const requestedId of ordered) {
      const row = rowByKey.get(requestedId.toLowerCase());
      if (row === undefined) {
        structured.push({ extensionId: requestedId, code: 'EXTENSION_NOT_FOUND' });
        continue;
      }
      if (!repoEnabled.has(row.repository_id) || !row.enabled) {
        structured.push({ extensionId: requestedId, code: 'EXTENSION_DISABLED' });
        continue;
      }
      // Type-aware binding with generated fallback (native FIRST — §16):
      // a Nuvio row binds only its generated artifact; a cloudstream row
      // binds its native adapter or its generated artifact.
      const adapter = executableAdapterForExtension(row, generatedAdapters);
      if (adapter === null) {
        structured.push({ extensionId: requestedId, code: 'ADAPTER_NOT_AVAILABLE' });
        continue;
      }
      if (!adapterSupportsMediaType(adapter, request.mediaType)) {
        structured.push({ extensionId: requestedId, code: 'UNSUPPORTED_MEDIA' });
        continue;
      }
      resolvable.push({ row, adapter });
      selectedInstances.set(adapter.id.toLowerCase(), adapter);
    }

    const result = resolvable.length > 0
      ? await resolveThroughOrchestrator(content, request, resolvable.map(({ adapter }) => adapter.id), deps, selectedInstances)
      : null;
    const byAdapter = new Map(result?.groups.map((group) => [group.adapterId, group]) ?? []);
    const structuredByCanonical = new Map<string, CloudStreamDownloaderErrorCode>();
    for (const item of structured) structuredByCanonical.set(item.extensionId, item.code);

    // Emit groups in the REQUESTED order (stable — never completion order).
    groups = ordered.map((requestedId) => {
      const canonical = structuredByCanonical.get(requestedId);
      if (canonical !== undefined) return toIneligibleGroupView(requestedId, canonical);
      // Eligible: find the resolvable entry whose canonical id matches.
      const match = resolvable.find(
        ({ adapter }) => adapter.id.toLowerCase() === requestedId.toLowerCase(),
      );
      if (match === undefined) return toIneligibleGroupView(requestedId, 'EXTENSION_NOT_FOUND');
      const group = byAdapter.get(match.adapter.id);
      if (group === undefined) return toIneligibleGroupView(match.adapter.id, 'INTERNAL_ERROR');
      return toGroupView(group, extensionDisplayName(match.row, match.adapter), result?.diagnostics ?? []);
    });
  }

  logResolutionSummary(request, content.tmdbId, groups, considered, Date.now() - startedAt);
  return { media: toMediaView(content, request), groups, consideredExtensions: considered };
}

// ---------------------------------------------------------------------------
// Public API — single targeted extension
// ---------------------------------------------------------------------------

/**
 * Resolves ONE extension for a title (the future per-tab CS-4 flow).
 *
 * Validation failures surface as typed `CloudStreamDownloaderError`s the
 * endpoint maps to structured envelope errors (404/409/400) — the client
 * supplied extension id is resolved through the DB + code registry FIRST:
 * arbitrary unregistered adapter ids are never executed.
 * Resolution failures (timeout/extractor/network) are GROUP results
 * (partial-success contract), not envelope errors.
 */
export async function resolveCloudStreamExtensionDownload(
  client: CloudStreamClient,
  request: CloudStreamDownloadRequest,
  extensionId: string,
  deps: CloudStreamDownloaderDeps = {},
): Promise<CloudStreamExtensionDownloadResult> {
  assertValidCloudStreamDownloadRequest(request);
  if (typeof extensionId !== 'string' || extensionId.length === 0 || extensionId.length > 200) {
    throw new CloudStreamDownloaderError('INVALID_REQUEST', downloaderErrorMessage('INVALID_REQUEST'));
  }
  const startedAt = Date.now();
  const { content, catalog } = await loadContentAndCatalog(client, request, deps);

  // Audit fix: deterministic id resolution — the previous raw `find` over the
  // UNORDERED catalog array could land on a disabled same-name row from
  // another repository/integration type (e.g. a nuvio 'vegamovies' clone
  // shadowing the enabled cloudstream row on the per-tab RETRY path).
  const row = resolveExtensionRow(catalog, extensionId);
  if (row === null) {
    throw new CloudStreamDownloaderError('EXTENSION_NOT_FOUND', downloaderErrorMessage('EXTENSION_NOT_FOUND'));
  }
  const repoEnabled = new Set(catalog.repositories.filter((repo) => repo.enabled).map((repo) => repo.id));
  if (!repoEnabled.has(row.repository_id) || !row.enabled) {
    throw new CloudStreamDownloaderError('EXTENSION_DISABLED', downloaderErrorMessage('EXTENSION_DISABLED'));
  }
  // Type-aware binding with generated fallback (native FIRST — §16).
  const generatedAdapters = (catalog.generatedArtifacts ?? []).length > 0
    ? buildGeneratedAdapterMap(catalog.generatedArtifacts)
    : undefined;
  const adapter = executableAdapterForExtension(row, generatedAdapters);
  if (adapter === null) {
    throw new CloudStreamDownloaderError('ADAPTER_NOT_AVAILABLE', downloaderErrorMessage('ADAPTER_NOT_AVAILABLE'));
  }
  if (!adapterSupportsMediaType(adapter, request.mediaType)) {
    throw new CloudStreamDownloaderError('UNSUPPORTED_MEDIA', downloaderErrorMessage('UNSUPPORTED_MEDIA'));
  }

  const result = await resolveThroughOrchestrator(content, request, [adapter.id], deps, new Map([[adapter.id.toLowerCase(), adapter]]));
  const group = result.groups.find((candidate) => candidate.adapterId === adapter.id);
  if (group === undefined) {
    // Defensive: the orchestrator always emits one group per adapter id.
    throw new CloudStreamDownloaderError('INTERNAL_ERROR', downloaderErrorMessage('INTERNAL_ERROR'));
  }
  const groupView = toGroupView(group, extensionDisplayName(row, adapter), result.diagnostics);
  logResolutionSummary(
    request,
    content.tmdbId,
    [groupView],
    countEnabledExtensions(catalog),
    Date.now() - startedAt,
  );
  return { media: toMediaView(content, request), group: groupView };
}
