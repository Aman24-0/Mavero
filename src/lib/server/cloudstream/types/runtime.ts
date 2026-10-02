/**
 * MAVERO CloudStream runtime contracts (CS-2 — plan §40.3 finalized / §40.6).
 *
 * These are the ADAPTER-RUNTIME types: everything a Mavero-native
 * CloudStream provider port needs to resolve titles into normalized links.
 * Catalog/domain metadata types live in `types/index.ts` (CS-1).
 *
 * SECURITY MODEL (plan §2.4, §10.2/§10.3, §40.6):
 *   * Adapters are STATELESS code-owned modules; they receive EVERYTHING
 *     through the runtime context (the ONLY network surface they ever see).
 *   * The context exposes bounded, SSRF-guarded fetch helpers — never raw
 *     fetch, never unrestricted network execution.
 *   * `.cs3` artifacts are metadata only: no adapter code path can fetch or
 *     execute remote plugin code.
 *   * Diagnostics are redaction-safe (categories + counts + durations, never
 *     URLs carrying tokens, cookies, or response bodies).
 */

import type { CloudStreamExtractedLink, CloudStreamNormalizedLink } from '../normalize/links';
import type { CheerioAPI } from 'cheerio';

// ---------------------------------------------------------------------------
// Requests (plan §40.3)
// ---------------------------------------------------------------------------

/** A resolve request for a movie. */
export type CloudStreamResolveRequest = {
  /** TMDB id of the requested media (string form — matches the Stremio path). */
  tmdbId: string;
  /** Display title used for provider search matching. */
  title: string;
  /** Release year (best-effort matching hint). */
  year?: number;
  /** Bounded abort deadline — the adapter MUST respect it. */
  deadline: AbortSignal;
};

/** A resolve request for one series episode (never treated as a movie). */
export type CloudStreamEpisodeRequest = CloudStreamResolveRequest & {
  season: number;
  episode: number;
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * One result a provider adapter produced for a request. `links` may be an
 * honest empty array ("provider answered, nothing matched") — that is NOT a
 * failure. `failure` explains why resolution could not complete.
 */
export type CloudStreamLinkResult = {
  /** Normalized candidate links (empty = honest zero, not an error). */
  links: CloudStreamNormalizedLink[];
  /** Set only when resolution could not complete. */
  failure?: CloudStreamResolutionFailure;
  /** Provider-side metadata worth surfacing (matched page title, etc.). */
  matchedTitle?: string;
};

/** Closed failure vocabulary (plan §20 error categories, CS-2 subset). */
export type CloudStreamFailureCategory =
  | 'SEARCH_FAILED'      // provider search request failed (network/HTTP/shape)
  | 'NO_MATCH'           // search succeeded but no result matched title/year
  | 'LOAD_FAILED'        // matched page could not be loaded
  | 'NO_LINKS'           // page loaded but contained no download links
  | 'EXTRACTOR_FAILED'   // every extractor attempt failed
  | 'TIMEOUT'            // deadline exceeded
  | 'BLOCKED_URL'        // SSRF guard rejected a destination
  | 'UNSUPPORTED'        // adapter does not support this request shape
  | 'UNEXPECTED';        // anything else (defensive)

export type CloudStreamResolutionFailure = {
  category: CloudStreamFailureCategory;
  /** Safe, curated message — never internals/stack traces (plan §20). */
  message: string;
};

// ---------------------------------------------------------------------------
// Adapter contract (plan §40.3 FINALIZED — AC-003/D-010)
// ---------------------------------------------------------------------------

/** A Mavero-native port of one CloudStream provider. */
export type MaveroCloudStreamAdapter = {
  /** Matches cloudstream_extensions.internal_name (case-insensitive). */
  id: string;
  /** Mavero adapter version — separate from the plugin version (plan §18). */
  version: string;
  /** Human-readable provider name (matches the plugin `name`). */
  displayName: string;
  /** Primary content language of the provider ('hi' | 'en' | …). */
  language: string | null;
  supports: { movie: boolean; series: boolean; anime: boolean };
  resolveMovie(
    req: CloudStreamResolveRequest,
    ctx: CloudStreamRuntimeContext,
  ): Promise<CloudStreamLinkResult>;
  resolveEpisode?(
    req: CloudStreamEpisodeRequest,
    ctx: CloudStreamRuntimeContext,
  ): Promise<CloudStreamLinkResult>;
};

// ---------------------------------------------------------------------------
// Runtime context (the ONLY network surface adapters see — §40.6)
// ---------------------------------------------------------------------------

/** Bounded HTML fetch outcome. */
export type CloudStreamHtmlResult = {
  /** Final URL after re-validated redirects. */
  finalUrl: string;
  /** Response body text (already size-capped). */
  html: string;
  /** HTTP status of the final response (safe diagnostic value). */
  status: number;
};

/** No-redirect probe outcome (location header without following). */
export type CloudStreamRedirectResult = {
  status: number;
  /** Absolute location header when present (null otherwise). */
  location: string | null;
  /** Header value verbatim (used by BuzzServer hx-redirect semantics). */
  headerName: string;
  headerValue: string | null;
};

export type CloudStreamFetchOptions = {
  /** Override the per-request timeout (default 10s). */
  timeoutMs?: number;
  /** Extra request headers (bounded, controlled — e.g. referer). */
  headers?: Record<string, string>;
};

export type CloudStreamRuntimeContext = {
  /** SSRF-guarded HTML/text fetch (bounded redirects, size cap, timeout). */
  fetchHtml(url: string, opts?: CloudStreamFetchOptions): Promise<CloudStreamHtmlResult>;
  /** SSRF-guarded JSON fetch (same pipeline as CS-1 repository documents). */
  fetchJson(url: string, opts?: CloudStreamFetchOptions): Promise<unknown>;
  /** SSRF-guarded no-redirect GET: returns the location/hx-redirect header. */
  fetchRedirect(url: string, opts?: CloudStreamFetchOptions): Promise<CloudStreamRedirectResult>;
  /**
   * Bounded HEAD redirect-chain resolution (port of the providers'
   * `resolveFinalUrl`): follows ≤7 redirects, aborting on the deadline.
   * Returns null when the chain dead-ends.
   */
  resolveRedirects(url: string): Promise<string | null>;
  /**
   * Resolves the CURRENT provider domain from the shared urls.json document
   * (port of `getLatestBaseUrl`) through the SAME injectable fetcher —
   * tests never touch the real network.
   */
  resolveBaseUrl(base: string, source: string): Promise<string>;
  /** Load an HTML document into a cheerio query object (server-only). */
  parseHtml(html: string): CheerioAPI;
  /** Dispatch one URL through the extractor registry (SSRF-guarded inside). */
  runExtractor(
    url: string,
    opts?: { label?: string },
  ): Promise<CloudStreamExtractedLink[]>;
  /** Record a redaction-safe diagnostic event for this resolution. */
  diagnostics: CloudStreamDiagnosticSink;
  /** The deadline signal for the CURRENT resolution (adapters must honor it). */
  signal: AbortSignal;
  /** Monotonic clock for duration measurement. */
  now(): number;
};

// ---------------------------------------------------------------------------
// Diagnostics (plan §21 — redaction-safe)
// ---------------------------------------------------------------------------

export type CloudStreamDiagnosticStage =
  | 'search'
  | 'load'
  | 'episode-walk'
  | 'extractor'
  | 'bypass'
  | 'resolve';

export type CloudStreamDiagnosticEvent = {
  /** Adapter id (or 'runtime' for context-level events). */
  adapterId: string;
  /** Stage identifier. */
  stage: CloudStreamDiagnosticStage | 'runtime';
  /** Duration of the operation in milliseconds. */
  durationMs: number;
  success: boolean;
  failureCategory?: CloudStreamFailureCategory;
  /** Safe HTTP status (never headers/cookies/bodies). */
  httpStatus?: number;
  /** Extractor id when the event is extractor-scoped. */
  extractorId?: string;
  /** Number of links the stage produced (never the links themselves). */
  resultCount?: number;
  /** Retry attempts consumed (bounded). */
  retries?: number;
};

/**
 * Collects diagnostic events per resolution. Events are recorded in-memory
 * and returned with the resolution result — never logged with raw URLs,
 * tokens, cookies, or response bodies (plan §21 rules).
 */
export type CloudStreamDiagnosticSink = {
  record(event: CloudStreamDiagnosticEvent): void;
  /** Immutable snapshot of collected events (test/diagnostic surface). */
  events(): readonly CloudStreamDiagnosticEvent[];
};

// ---------------------------------------------------------------------------
// Extractor contract (plan §9/§40.6)
// ---------------------------------------------------------------------------

/** A Mavero-native port of one CloudStream extractor. */
export type MaveroCloudStreamExtractor = {
  /** Extractor identity ('gdflix' | 'hubcloud' | 'fastdlserver'). */
  id: string;
  /** Display name (matches the Kotlin extractor name). */
  displayName: string;
  /** Can this extractor handle this URL? (host/keyword matching) */
  matches(url: string): boolean;
  extract(
    url: string,
    ctx: CloudStreamRuntimeContext,
  ): Promise<CloudStreamExtractedLink[]>;
};

// ---------------------------------------------------------------------------
// Orchestrator (CS-2 bounded resolution — §40.6; CS-3 layers the API on it)
// ---------------------------------------------------------------------------

/** One request against a set of adapters (DB-free; CS-3 selects adapters). */
export type CloudStreamResolutionRequest = {
  media: {
    tmdbId: string;
    title: string;
    year?: number;
  };
  /** Movie resolution when season/episode are absent. */
  season?: number;
  episode?: number;
  /** Adapter ids to resolve with (already selected + enabled upstream). */
  adapterIds: string[];
};

export type CloudStreamResolutionGroupStatus = 'loaded' | 'empty' | 'failed';

export type CloudStreamResolutionGroup = {
  adapterId: string;
  adapterName: string;
  status: CloudStreamResolutionGroupStatus;
  links: CloudStreamNormalizedLink[];
  failure?: CloudStreamResolutionFailure;
  /**
   * The provider-side page title the adapter matched (CS-3: surfaced for the
   * Downloader 2 response so the future UI can show what the provider
   * actually resolved against — honest visibility, never invented).
   */
  matchedTitle?: string;
};

export type CloudStreamResolutionResult = {
  groups: CloudStreamResolutionGroup[];
  diagnostics: readonly CloudStreamDiagnosticEvent[];
  /** Total wall-clock duration of the resolution. */
  durationMs: number;
};
