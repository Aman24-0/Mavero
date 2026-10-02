/**
 * MAVERO CloudStream domain contracts (CS-1).
 *
 * Scope: repository + extension CATALOG management only (plan
 * CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md §5, §6, §40.3). No adapter runtime,
 * no resolver, no Downloader 2 backend — those belong to CS-2/CS-3.
 *
 * SECURITY: every type in this module is inert metadata. The `.cs3` artifact
 * URL (`pluginUrl`) is persisted as metadata ONLY — Mavero never fetches or
 * executes remote plugin code (plan §2.4, §10.2).
 */

// Admin-facing view + preview models live in the SHARED type module
// (hosting-types convention: server services produce them, admin components
// consume them). Re-exported here so the server domain has one import site.
export type {
  CloudStreamRepositoryStatus,
  CloudStreamAdapterStatus,
  CloudStreamRepositoryView,
  CloudStreamExtensionView,
  CloudStreamExtensionPreview,
  CloudStreamRepositoryPreview,
} from '$lib/shared/cloudstream-types';

// CS-2 adapter-runtime contracts (plan §40.3 finalized / §40.6 — AC-003).
export type {
  MaveroCloudStreamAdapter,
  MaveroCloudStreamExtractor,
  CloudStreamResolveRequest,
  CloudStreamEpisodeRequest,
  CloudStreamLinkResult,
  CloudStreamResolutionFailure,
  CloudStreamFailureCategory,
  CloudStreamRuntimeContext,
  CloudStreamDiagnosticEvent,
  CloudStreamDiagnosticSink,
  CloudStreamDiagnosticStage,
  CloudStreamResolutionRequest,
  CloudStreamResolutionGroup,
  CloudStreamResolutionGroupStatus,
  CloudStreamResolutionResult,
} from './runtime';

export type { CloudStreamNormalizedLink, CloudStreamExtractedLink } from '../normalize/links';

import type { CloudStreamRepositoryStatus } from '$lib/shared/cloudstream-types';

// ---------------------------------------------------------------------------
// Remote document contracts (plan §40.3 — finalized at CS-0)
// ---------------------------------------------------------------------------

/** A CloudStream repository index document (CS.json — REAL format, AC-002). */
export type CloudStreamRepositoryIndex = {
  name?: string;
  description?: string;
  /** Repository icon URL (canonical field; 'icon' tolerated as legacy alias). */
  iconUrl?: string;
  /** Legacy tolerated alias for iconUrl. */
  icon?: string;
  /** Ignored (inert metadata). */
  manifestVersion?: number;
  /** CANONICAL: ABSOLUTE http(s) URLs to plugins.json documents (strings).
   * Tolerated: { plugins: string } object entries (pre-AC-002 assumption). */
  pluginLists?: Array<string | { plugins: string }>;
};

/** One entry of a plugins.json document (REAL format, AC-002). */
export type CloudStreamPluginListEntry = {
  internalName: string;
  name?: string;
  version?: number;
  description?: string;
  authors?: string[];
  language?: string;
  /** CloudStream TvType enum NAMES ('Movie', 'TvSeries', …); numeric ids tolerated. */
  tvTypes?: Array<string | number>;
  apiVersion?: number;
  /** 1 = OK, 2 = DOWN, 3 = BROKEN (best effort). */
  status?: number;
  /** .cs3 artifact URL (canonical field) — metadata ONLY, never fetched/executed. */
  url?: string;
  /** Legacy tolerated alias for the .cs3 artifact URL. */
  file?: string;
  /** Plugin icon URL (canonical; 'icon' tolerated). */
  iconUrl?: string;
  /** Legacy tolerated alias for iconUrl. */
  icon?: string;
  /** sha256-… artifact hash (inert metadata). */
  fileHash?: string;
  /** Artifact size in bytes (inert metadata). */
  fileSize?: number;
  /** Upstream source repository URL (inert metadata). */
  repositoryUrl?: string;
};

// ---------------------------------------------------------------------------
// Normalized catalog models (parser output / DB persistence shape)
// ---------------------------------------------------------------------------

/** Sanitized extension metadata normalized from plugins.json entries. */
export type NormalizedCloudStreamExtension = {
  internalName: string;
  name: string | null;
  version: number | null;
  apiVersion: number | null;
  description: string | null;
  authors: string[];
  language: string | null;
  /** CloudStream TvType enum NAMES (numeric ids normalized at parse time). */
  tvTypes: string[];
  /** .cs3 artifact URL — METADATA ONLY (never fetched). */
  pluginUrl: string | null;
  pluginStatus: number | null;
  iconUrl: string | null;
  /** sha256-… artifact hash (inert metadata). */
  fileHash: string | null;
  /** Artifact size in bytes (inert metadata). */
  fileSizeBytes: number | null;
  /** Upstream source repository URL (inert metadata). */
  sourceUrl: string | null;
};

/** Parsed repository index + resolved plugin-list URLs. */
export type ParsedCloudStreamRepository = {
  name: string;
  description: string | null;
  iconUrl: string | null;
  pluginLists: Array<{ name: string | null; url: string }>;
};

// ---------------------------------------------------------------------------
// Sync dependency injection (tests never touch the real network)
// ---------------------------------------------------------------------------

export type CloudStreamSyncDeps = {
  /** Injectable fetcher (tests). Production dispatches through the SSRF-safe agent. */
  fetcher?: typeof fetch;
  /** Injectable DNS resolver (tests never hit the real network). */
  dnsResolver?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
  now?: () => string;
  /** Per-document timeout override (default 10s per plan §40.3). */
  timeoutMs?: number;
  /** Per-document response-size cap override (default 1 MiB). */
  maxBytes?: number;
};

// ---------------------------------------------------------------------------
// Sync diagnostics (server-internal)
// ---------------------------------------------------------------------------

/** Repository sync outcome (diagnostics for the admin surface). */
export type CloudStreamSyncOutcome = {
  repositoryId: string;
  status: CloudStreamRepositoryStatus;
  /** Extensions discovered (normalized) during this sync. */
  discoveredCount: number;
  /** Extensions newly inserted. */
  insertedCount: number;
  /** Existing extensions whose metadata was updated. */
  updatedCount: number;
  /** Extensions removed (only on a fully successful sync). */
  removedCount: number;
  /** Safe error text recorded on the repository row, if any. */
  lastError: string | null;
};
