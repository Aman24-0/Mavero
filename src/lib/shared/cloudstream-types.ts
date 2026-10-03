/**
 * MAVERO CloudStream shared type contracts (CS-1).
 *
 * Pure TYPE definitions shared between the CloudStream server domain
 * (`src/lib/server/cloudstream/**`) and the admin UI (Integrations Extension
 * tab + Add Integration CloudStream flow). Mirrors the `hosting-types`
 * convention: server services produce these views; admin components consume
 * them. NO runtime code lives here — importing this module is safe on both
 * the server and the client.
 *
 * SECURITY: these models carry catalog METADATA only. Plugin artifact URLs
 * (`pluginUrl`) are inert metadata — never fetched or executed.
 */

/** Repository sync health (plan §6.1). */
export type CloudStreamRepositoryStatus = 'active' | 'disabled' | 'error' | 'invalid';

/**
 * Mavero-side compatibility state (plan §6.2). 'disabled' is NOT stored —
 * it is derived from the extension `enabled` flag at display time.
 */
export type CloudStreamAdapterStatus = 'compatible' | 'adapter_required' | 'unsupported' | 'broken';

// ---------------------------------------------------------------------------
// Unified Extension catalog contracts (Permanent Adapter Plan Phase 2).
// The SAME catalog tables/views serve BOTH integration types — one
// Extension system, one Extension tab, no separate Nuvio surface.
// ---------------------------------------------------------------------------

export type {
  ExtensionIntegrationType,
  PermanentAdapterState,
  AdapterOperationalState,
  ExtensionMediaType,
} from '$lib/shared/extension-adapter-types';

import type {
  ExtensionIntegrationType,
  AdapterOperationalState,
  ExtensionMediaType,
} from '$lib/shared/extension-adapter-types';

/**
 * Bounded, type-specific raw manifest metadata (Nuvio formats,
 * contentLanguage, limited, self-reported enabled, raw supportedTypes, raw
 * filename, manifestUrl — extensible for future manifest variants).
 * Inert metadata only; never executed.
 */
export type ExtensionProviderMetadata = {
  formats?: string[];
  contentLanguage?: string[];
  limited?: boolean;
  /** Provider self-reported enabled state (manifest field — NOT the admin switch). */
  manifestEnabled?: boolean;
  /** Raw provider types as written in the manifest (pre-canonicalization). */
  types?: string[];
  /** Raw module path as written in the manifest (pre-resolution). */
  filename?: string;
  /** The manifest document URL this provider was discovered from. */
  manifestUrl?: string;
};

/** Administrator-facing safe view of one CloudStream repository. */
export type CloudStreamRepositoryView = {
  id: string;
  name: string;
  url: string;
  description: string | null;
  iconUrl: string | null;
  enabled: boolean;
  status: CloudStreamRepositoryStatus;
  /** Phase 2: which manifest schema this repository row syncs (cloudstream | nuvio). */
  integrationType: ExtensionIntegrationType;
  extensionCount: number;
  lastSyncedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Administrator-facing safe view of one discovered extension. */
export type CloudStreamExtensionView = {
  id: string;
  repositoryId: string;
  repositoryName: string;
  internalName: string;
  name: string | null;
  version: number | null;
  apiVersion: number | null;
  description: string | null;
  authors: string[];
  language: string | null;
  /** CloudStream TvType enum NAMES ('Movie', 'TvSeries', …). */
  tvTypes: string[];
  pluginUrl: string | null;
  pluginStatus: number | null;
  iconUrl: string | null;
  fileHash: string | null;
  fileSizeBytes: number | null;
  sourceUrl: string | null;
  enabled: boolean;
  adapterStatus: CloudStreamAdapterStatus;
  maveroAdapterId: string | null;
  adapterVersion: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  // ---------------------------------------------------------------------
  // Phase 2 — unified Extension catalog / permanent adapter registry.
  // ---------------------------------------------------------------------
  /** Which integration this provider row belongs to (cloudstream | nuvio). */
  integrationType: ExtensionIntegrationType;
  /** Canonical media support ('movie' | 'tv'; empty = none known). */
  mediaTypes: ExtensionMediaType[];
  /** DERIVED operational state (active/disabled from enabled; see extension-adapter-types). */
  adapterState: AdapterOperationalState;
  /** Nuvio provider JS module URL — METADATA ONLY, never fetched/executed. */
  moduleUrl: string | null;
  /** String provider version (Nuvio '1.1.1'); null for integer-versioned CloudStream plugins. */
  versionText: string | null;
  /** Bounded type-specific manifest metadata (formats, contentLanguage, …). */
  providerMetadata: ExtensionProviderMetadata | null;
  /** Permanent-adapter validation facts (Phase 3+ Builder/Tester; null in Phase 2). */
  lastTestedAt: string | null;
  lastTestError: string | null;
  // ---------------------------------------------------------------------
  // Phase 3 — Builder bookkeeping (admin view projection).
  // ---------------------------------------------------------------------
  /** The ACTIVE generated artifact version (generated rows only). */
  generatedAdapterVersion: number | null;
  /** The builder that produced the active artifact (provenance). */
  builderVersion: string | null;
  /** Last create-adapter attempt time (any outcome). */
  lastBuildAt: string | null;
  /** Closed-vocabulary last build failure (code + bounded message). */
  lastBuildError: string | null;
};

// ---------------------------------------------------------------------------
// Phase 3 — Test Provider result views (plan §9/§15: normalized results)
// ---------------------------------------------------------------------------

/** One representative test case outcome (movie or episode). */
export type ProviderTestCaseView = {
  kind: 'movie' | 'episode';
  passed: boolean;
  note: string | null;
  linksFound: number;
  durationMs: number;
};

/** The Test Provider action result (admin view; NO redirect — inline UI). */
export type ProviderTestResultView = {
  passed: boolean;
  testedAt: string;
  /** Which executable binding served the test. */
  adapterKind: 'native' | 'generated';
  adapterId: string;
  adapterVersion: string;
  cases: ProviderTestCaseView[];
  /** Normalized sample links (bounded — the Downloader 2 link view shape). */
  links: CloudStreamDownloadLinkView[];
};

/** Preview of an extension inside the repository add flow (no ids yet). */
export type CloudStreamExtensionPreview = {
  internalName: string;
  name: string | null;
  version: number | null;
  /** Phase 2: string provider version (Nuvio '1.1.1'). */
  versionText: string | null;
  language: string | null;
  /** CloudStream TvType enum NAMES. */
  tvTypes: string[];
  adapterStatus: CloudStreamAdapterStatus;
  /** Phase 2: which integration this previewed provider belongs to. */
  integrationType: ExtensionIntegrationType;
  /** Phase 2: canonical media support preview ('movie' | 'tv'). */
  mediaTypes: ExtensionMediaType[];
};

// ---------------------------------------------------------------------------
// Mavero Downloader 2 API response views (CS-3 — plan §13/§40.3)
//
// Server services in `src/lib/server/cloudstream/downloader/` produce these
// views; the future CS-4 UI consumes them. They intentionally reuse the
// shared StreamKind vocabulary so action capabilities map EXACTLY onto
// `stream-actions.ts` (no second action model — plan §15).
// ---------------------------------------------------------------------------

/**
 * Closed machine-readable error vocabulary for the Downloader 2 API (plan
 * §40.3 error contract). Top-level envelope errors use the request-level
 * codes; per-group failures use the extension/provider-level codes.
 */
export type CloudStreamDownloaderErrorCode =
  | 'INVALID_REQUEST'      // malformed request shape (400)
  | 'EXTENSION_NOT_FOUND'  // requested extension is not in the catalog (404)
  | 'EXTENSION_DISABLED'   // extension or its repository is disabled (409)
  | 'ADAPTER_NOT_AVAILABLE'// no Mavero adapter is registered (409)
  | 'UNSUPPORTED_MEDIA'    // adapter does not support movie/series resolution
  | 'NO_RESULTS'           // provider answered but nothing matched
  | 'PROVIDER_TIMEOUT'     // extension resolution exceeded its deadline
  | 'EXTRACTOR_FAILED'     // every extractor attempt failed
  | 'NETWORK_ERROR'        // provider network/HTTP/SSRF-rejected failures
  | 'RATE_LIMITED'         // per-identity rate limit exceeded (429)
  | 'INTERNAL_ERROR';      // unexpected internal failure (503)

/**
 * One normalized download link in the Downloader 2 response. `kind` uses
 * the shared StreamKind vocabulary — Download/Play/Share capabilities are
 * derived by `streamCapabilities` in `stream-actions.ts`, never re-invented.
 *
 * NOTE (deliberate omissions, documented per plan §40.7):
 *   * No `headers` field — CS-2 extractors resolve DIRECT URLs that need no
 *     special headers, and the shared action model consumes none. Adding a
 *     speculative headers map would invite leaking provider credentials.
 *   * No separate `resolution` field — `quality` ('1080p') IS the resolution
 *     label; a second field would duplicate the same value.
 */
export type CloudStreamDownloadLinkView = {
  /** Direct resolved URL (never proxied, rewritten, or fetched by Mavero). */
  url: string;
  /** The shared stream kind — drives Download/Play/Share capabilities. */
  kind: 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet' | 'external';
  /** Resolution label ('1080p') derived server-side when detectable. */
  quality?: string;
  codec?: string;
  container?: string;
  filename?: string;
  sizeBytes?: number;
  audioLanguages?: string[];
  /** Lowercased display host derived server-side (leading www. stripped). */
  host?: string;
  /** Producing provider/extension id (the adapter id). */
  provider: string;
  /** Display label of the hosting server ('GDFlix [Direct]'). */
  sourceName: string;
  /** Extractor id that resolved this link, when applicable. */
  extractor?: string;
};

/** One redaction-safe diagnostic stage summary (no URLs/headers/bodies). */
export type CloudStreamDownloadStageSummary = {
  stage: string;
  success: boolean;
  durationMs: number;
  httpStatus?: number;
  resultCount?: number;
  extractorId?: string;
  retries?: number;
};

/** Redaction-safe per-extension diagnostics (bounded at 32 stages). */
export type CloudStreamDownloadGroupDiagnostics = {
  /** Wall-clock duration of this extension's resolution. */
  durationMs: number;
  stages: CloudStreamDownloadStageSummary[];
};

export type CloudStreamDownloadGroupStatus = 'loaded' | 'empty' | 'failed';

/**
 * One extension's resolution result. `errorCode`/`errorMessage` appear only
 * when status = 'failed' (closed vocabulary; safe curated messages).
 */
export type CloudStreamDownloadGroupView = {
  /** Canonical extension identity (the CloudStream internalName). */
  extensionId: string;
  extensionName: string;
  status: CloudStreamDownloadGroupStatus;
  links: CloudStreamDownloadLinkView[];
  /** Closed-vocabulary error code when status = 'failed'. */
  errorCode?: CloudStreamDownloaderErrorCode;
  /** Safe human-readable message when status = 'failed'. */
  errorMessage?: string;
  /** Provider-matched page title, when the adapter surfaced one. */
  matchedTitle?: string;
  diagnostics?: CloudStreamDownloadGroupDiagnostics;
};

/**
 * One eligible source tab. ONLY eligible sources are listed (repository
 * enabled + extension enabled + adapter registered + media-type support),
 * so `enabled`/`compatible` are always true for returned tabs — they exist
 * for contract stability with the CS-4 UI.
 */
export type CloudStreamDownloadTabView = {
  extensionId: string;
  extensionName: string;
  iconUrl: string | null;
  /** Media types the REGISTERED adapter supports (code registry authority). */
  supportedMediaTypes: Array<'movie' | 'series' | 'anime'>;
  enabled: boolean;
  compatible: boolean;
};

/** The request media context, echoed as resolved server-side. */
export type CloudStreamDownloadMediaView = {
  mediaType: 'movie' | 'series' | 'anime';
  tmdbId: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
};

/** Repository validate/preview result (validation only — NO persistence). */
export type CloudStreamRepositoryPreview = {
  /** The validated repository URL (echoed for the confirmation round-trip). */
  repositoryUrl: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  /** Phase 2: detected manifest schema ('cloudstream' | 'nuvio'). */
  integrationType: ExtensionIntegrationType;
  pluginListCount: number;
  extensionCount: number;
  extensions: CloudStreamExtensionPreview[];
  /** True when the extension list was truncated for the preview bound. */
  truncated: boolean;
};
