/**
 * MAVERO permanent adapter ARTIFACT contracts (Permanent Adapter Plan
 * Phase 3 — plan §9).
 *
 * The artifact is the PERSISTED form of a Builder-generated permanent
 * adapter: a constrained, versioned, hash-verified JSON document. It
 * contains NO executable code — only a bounded declarative DSL that the
 * Mavero-owned interpreter executes (dsl-interpreter.ts) inside the
 * existing CloudStream runtime security model. The Builder service
 * imports this SAME module (repo tsconfig path alias under tsx) so both
 * sides agree on one artifact vocabulary — test-what-you-ship.
 *
 * SECURITY MODEL (plan §9 + §14):
 *   * Constrained representation preferred over executable code: the DSL
 *     is a closed vocabulary with hard bounds on every string/array.
 *   * Integrity: sha256 over the CANONICAL JSON serialization of the
 *     spec (sorted keys, no whitespace) — recomputed by Mavero before
 *     ANY artifact is persisted or executed; a mismatched hash is
 *     rejected before interpretation.
 *   * Deterministic identity: `${integration_type}:${provider}@${version}`.
 *   * Immutability: one artifact row per (canonical_key, adapter_version);
 *     old versions are retained forever (rollback = pointer re-version).
 *
 * This module is PURE (zero node-only imports): usable from $lib/shared
 * on the client, from $lib/server, and from the standalone Builder. The
 * integrity DIGEST (node:crypto) deliberately lives in the server-side
 * builder domain (artifact-hash.ts) so this file stays browser-safe.
 */

// ---------------------------------------------------------------------------
// Schema identity
// ---------------------------------------------------------------------------

/** The only artifact schema this Mavero understands (bump on breaking change). */
export const ADAPTER_ARTIFACT_SCHEMA_VERSION = 1;

/** The only generation strategy in schema v1 (constrained DSL pipeline). */
export type AdapterArtifactStrategy = 'declarative';

// ---------------------------------------------------------------------------
// Bounds (plan §14 — everything an artifact can carry is bounded)
// ---------------------------------------------------------------------------

/** Whole-artifact serialized size cap (64 KiB). */
export const MAX_ADAPTER_ARTIFACT_BYTES = 65_536;
/** Max template/selector/regex string lengths inside the spec. */
export const MAX_SPEC_STRING = 512;
export const MAX_SPEC_SELECTOR = 256;
export const MAX_SPEC_REGEX = 256;
/** Max headers in the spec. */
export const MAX_SPEC_HEADERS = 12;
/** Bounded link-resolution rules. */
export const MAX_SPEC_RESOLUTION_RULES = 6;
/** Bounded include/exclude substring lists. */
export const MAX_SPEC_INCLUDES = 12;
/** Bounded fan-out limits (hard clamps validated on interpretation too). */
export const MAX_SPEC_LIMIT_VALUE = 64;

// ---------------------------------------------------------------------------
// The declarative DSL (schema v1 — search-page-scraper archetype)
// ---------------------------------------------------------------------------

/** Static or dynamic (urls.json-style) base URL resolution. */
export type DeclarativeBaseUrl =
  | { kind: 'static'; url: string }
  | {
      kind: 'dynamic';
      /** Baked-in fallback (used whenever the domains document fails). */
      fallbackUrl: string;
      /** The shared dynamic-domains document URL (http/https only). */
      domainsUrl: string;
      /** The key inside the domains document (e.g. 'moviesdrive'). */
      key: string;
    };

/** Candidate extraction from the search results document (HTML or JSON). */
export type DeclarativeCandidateExtraction =
  | {
      /** HTML search results: CSS selector for one candidate card. */
      kind: 'html';
      /** CSS selector for one candidate card (e.g. 'div.post-cards > article'). */
      container: string;
      /** Attribute on the card's anchor holding the title ('title' | null). */
      titleAttr: string | null;
      /** Optional inner selector scoping the anchor (null = any descendant a). */
      anchorSelector: string | null;
    }
  | {
      /** JSON search results: dotted-path extraction. */
      kind: 'json';
      /** Dotted path to the candidates array (e.g. 'hits'). */
      listPath: string;
      /** Dotted path (within one candidate) to the title (e.g. 'document.post_title'). */
      titlePath: string;
      /** Dotted path (within one candidate) to the link (e.g. 'document.permalink'). */
      hrefPath: string;
    };

/** Per-link resolution rules (ordered; first match wins). */
export type DeclarativeResolutionRule =
  /** Link is already direct media — pass through when it matches ANY include. */
  | { kind: 'passthrough'; includes: string[] }
  /** Extract a URL from the page text via a bounded regex. */
  | { kind: 'regex-extract'; pattern: string; group: number }
  /**
   * Two-level extraction (the moviesdrive-family structure): fetch the
   * raw link's page, regex-extract the NEXT-level URL (e.g. a
   * hubcloud.ist/drive link), then dispatch THAT through the Mavero-owned
   * extractor registry. The regex is evidence-derived; the extractor is
   * Mavero code — no untrusted execution.
   */
  | { kind: 'regex-extract-extractor'; pattern: string; group: number }
  /** Follow the bounded redirect chain to the final URL. */
  | { kind: 'redirects' }
  /** Dispatch through the Mavero extractor registry (gdflix/hubcloud/…). */
  | { kind: 'extractor' };

/** Link-element extraction from a detail page. */
export type DeclarativeLinkExtraction = {
  /** CSS selector for link elements (e.g. 'a.dl' / 'h5 a'). */
  container: string;
  /** Anchor attribute holding the URL (usually 'href'). */
  hrefAttr: string;
  /** Substrings a link must match to be considered (e.g. ['hubcloud','gdflix']). */
  includes: string[];
};

/** Season/episode walk on a series detail page (the h5-sibling pattern). */
export type DeclarativeEpisodeWalk = {
  /** Elements whose text is tested against seasonPattern (e.g. 'h5'). */
  container: string;
  /** Bounded regex with the literal {season} placeholder. */
  seasonPattern: string;
  /** Bounded regex with the literal {episode} placeholder. */
  episodePattern: string;
  /** The anchor within the walked siblings that holds the episode link. */
  linkAttr: string;
};

/** The complete constrained pipeline. */
export type DeclarativeAdapterSpec = {
  baseUrl: DeclarativeBaseUrl;
  /** Bounded request headers applied to every provider fetch. */
  headers: Record<string, string>;
  search: {
    /** URL template: '{base}/?s={query}' — {base} and {query} placeholders. */
    urlTemplate: string;
    extraction: DeclarativeCandidateExtraction;
  };
  match: {
    /** v1 has exactly one strategy (rank-title-year = rankCandidates). */
    strategy: 'rank-title-year';
    maxCandidates: number;
  };
  movie: {
    links: DeclarativeLinkExtraction;
    resolution: DeclarativeResolutionRule[];
  };
  episode?: DeclarativeEpisodeWalk & {
    links: DeclarativeLinkExtraction;
    resolution: DeclarativeResolutionRule[];
  };
  output: {
    /** Display prefix for produced source names (e.g. 'MoviesDrive'). */
    sourceName: string;
  };
  limits: {
    maxCandidates: number;
    maxLinks: number;
  };
};

// ---------------------------------------------------------------------------
// Analysis verdicts (plan §6 — the Builder's explicit analysis result)
// ---------------------------------------------------------------------------

export type AdapterAnalysisVerdict =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'UNSUPPORTED'
  | 'REQUIRES_RUNTIME'
  | 'REQUIRES_MANUAL_ADAPTER';

/** Bounded network-endpoint analysis record (host only — never URLs with tokens). */
export type AdapterAnalysisEndpoint = {
  host: string;
  purpose: 'tmdb' | 'domains-config' | 'search' | 'detail' | 'resolution' | 'other';
};

export type AdapterAnalysis = {
  verdict: AdapterAnalysisVerdict;
  /** Bounded human explanation (safe — never internals/stack traces). */
  notes: string;
  endpoints: AdapterAnalysisEndpoint[];
  /** sha256 hex of the analyzed source text ('' when not applicable). */
  sourceRevision: string;
  analyzedAt: string;
};

// ---------------------------------------------------------------------------
// Test report (Builder-side + Mavero-side; plan §10 representative cases)
// ---------------------------------------------------------------------------

export type AdapterTestCaseKind = 'movie' | 'episode';

export type AdapterTestCase = {
  kind: AdapterTestCaseKind;
  tmdbId: string;
  title: string;
  year?: number;
  /** IMDB id when known (providers that search by imdb id — e.g. the
   * moviesdrive family — need it for a realistic analysis). */
  imdbId?: string;
  season?: number;
  episode?: number;
};

export type AdapterTestCaseResult = {
  kind: AdapterTestCaseKind;
  passed: boolean;
  /** Closed failure note (bounded, safe). */
  note: string | null;
  linksFound: number;
  durationMs: number;
};

export type AdapterTestReport = {
  cases: AdapterTestCaseResult[];
  /** Every case must pass for an artifact to become READY. */
  passed: boolean;
  testedAt: string;
};

// ---------------------------------------------------------------------------
// The artifact (everything Mavero persists + verifies)
// ---------------------------------------------------------------------------

export type PermanentAdapterArtifact = {
  schemaVersion: number;
  kind: 'permanent-adapter';
  strategy: AdapterArtifactStrategy;
  /** `${integration_type}:${provider key}` (the registry canonical key). */
  adapterId: string;
  integrationType: 'cloudstream' | 'nuvio';
  providerId: string;
  providerName: string | null;
  /** Monotonic per-provider adapter version (1, 2, 3 …). */
  adapterVersion: number;
  generatedAt: string;
  sourceUrl: string | null;
  mediaTypes: Array<'movie' | 'tv'>;
  language: string | null;
  /** The constrained pipeline (validated + hash-covered). */
  spec: DeclarativeAdapterSpec;
  analysis: AdapterAnalysis;
  /** Builder-side test evidence (Mavero ALWAYS re-tests independently). */
  testReport: AdapterTestReport;
  builderVersion: string;
};

// ---------------------------------------------------------------------------
// Builder API contracts (plan §4 — closed error structure)
// ---------------------------------------------------------------------------

export const ADAPTER_BUILDER_ERROR_CODES = [
  'BUILD_INVALID_REQUEST',
  'BUILD_UNSUPPORTED_PROVIDER',
  'BUILD_SOURCE_UNAVAILABLE',
  'BUILD_GENERATION_FAILED',
  'BUILD_VALIDATION_FAILED',
  'BUILD_TEST_FAILED',
  'BUILD_TIMEOUT',
  'BUILD_RESOURCE_LIMIT',
  'BUILD_INTERNAL_ERROR',
] as const;

export type AdapterBuilderErrorCode = (typeof ADAPTER_BUILDER_ERROR_CODES)[number];

/** The build request (derived from the Phase 2 schema — plan §4). */
export type AdapterBuildRequest = {
  requestId: string;
  requestedAt: string;
  integrationType: 'cloudstream' | 'nuvio';
  provider: {
    id: string;
    name: string | null;
    version: string | null;
    language: string | null;
    repository: { name: string | null; url: string | null };
    /** Nuvio JS module URL (null for cloudstream). */
    moduleUrl: string | null;
    /** CloudStream .cs3 URL (METADATA ONLY — never fetched by the Builder). */
    pluginUrl: string | null;
    mediaTypes: Array<'movie' | 'tv'>;
  };
  /** Next adapter version Mavero expects to persist (previous + 1). */
  requestedAdapterVersion: number;
  /** Representative test inputs Mavero will re-run independently. */
  test: {
    movie: AdapterTestCase;
    episode: AdapterTestCase | null;
  };
};

export type AdapterBuildSuccess = {
  ok: true;
  result: {
    analysis: AdapterAnalysis;
    artifact: PermanentAdapterArtifact;
  };
  builderVersion: string;
};

export type AdapterBuildFailure = {
  ok: false;
  error: {
    code: AdapterBuilderErrorCode;
    message: string;
    /** Verdict the extension row should record (analysis vocabulary). */
    verdict?: AdapterAnalysisVerdict;
  };
  builderVersion: string;
};

export type AdapterBuildResponse = AdapterBuildSuccess | AdapterBuildFailure;

// ---------------------------------------------------------------------------
// Canonical serialization + integrity
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: sorted object keys, no insignificant whitespace,
 * stable array order — two artifacts with identical semantics serialize
 * identically. Primitives only (the spec is plain JSON data).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256 hex over the canonical serialization lives in the server-side
 * builder domain (artifact-hash.ts) — kept out of $lib/shared so this
 * module stays browser-safe. */

// ---------------------------------------------------------------------------
// Validation (pure — used by Mavero before persistence AND before
// interpretation; by the Builder before returning; never trusts input)
// ---------------------------------------------------------------------------

export type ArtifactValidationIssue = { field: string; problem: string };

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isBoundedStringArray(value: unknown, maxCount: number, maxItem: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxCount) return false;
  return value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxItem);
}

function isSafeRegexSource(pattern: string): boolean {
  // Bounded, non-backtracking-catastrophic by length; no flags; compiles.
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value: unknown, max = MAX_SPEC_STRING): value is string {
  if (!isBoundedString(value, max)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates the FULL artifact contract: schema version, identity, size,
 * spec bounds, closed vocabularies, test report shape. Returns the issues
 * (empty array = valid). PURE — no I/O, safe to run on any side.
 */
export function validateAdapterArtifact(artifact: unknown): ArtifactValidationIssue[] {
  const issues: ArtifactValidationIssue[] = [];
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return [{ field: 'artifact', problem: 'The artifact must be a JSON object.' }];
  }
  const a = artifact as Record<string, unknown>;

  if (a['schemaVersion'] !== ADAPTER_ARTIFACT_SCHEMA_VERSION) {
    issues.push({ field: 'schemaVersion', problem: `Expected ${ADAPTER_ARTIFACT_SCHEMA_VERSION}.` });
  }
  if (a['kind'] !== 'permanent-adapter') {
    issues.push({ field: 'kind', problem: "Expected 'permanent-adapter'." });
  }
  if (a['strategy'] !== 'declarative') {
    issues.push({ field: 'strategy', problem: "Expected 'declarative'." });
  }
  if (typeof a['adapterVersion'] !== 'number' || !Number.isInteger(a['adapterVersion']) || (a['adapterVersion'] as number) < 1 || (a['adapterVersion'] as number) > 1_000_000) {
    issues.push({ field: 'adapterVersion', problem: 'Expected an integer >= 1.' });
  }
  if (a['integrationType'] !== 'cloudstream' && a['integrationType'] !== 'nuvio') {
    issues.push({ field: 'integrationType', problem: "Expected 'cloudstream' | 'nuvio'." });
  }
  if (!isBoundedString(a['adapterId'], MAX_SPEC_STRING)) {
    issues.push({ field: 'adapterId', problem: 'Expected a bounded canonical adapter id.' });
  } else {
    const expectedPrefix = `${a['integrationType']}:`;
    if (!a['adapterId'].startsWith(expectedPrefix)) {
      issues.push({ field: 'adapterId', problem: `The adapter id must start with '${expectedPrefix}'.` });
    }
  }
  if (!isBoundedString(a['providerId'], 200)) {
    issues.push({ field: 'providerId', problem: 'Expected a bounded provider id.' });
  }
  if (a['providerName'] !== null && !isBoundedString(a['providerName'], 200)) {
    issues.push({ field: 'providerName', problem: 'Expected null or a bounded string.' });
  }
  if (!isBoundedString(a['generatedAt'], 64)) {
    issues.push({ field: 'generatedAt', problem: 'Expected a bounded timestamp string.' });
  }
  if (a['sourceUrl'] !== null && !isHttpUrl(a['sourceUrl'])) {
    issues.push({ field: 'sourceUrl', problem: 'Expected null or an http(s) URL.' });
  }
  const mediaTypes = a['mediaTypes'];
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0 || mediaTypes.length > 2 || !mediaTypes.every((t) => t === 'movie' || t === 'tv')) {
    issues.push({ field: 'mediaTypes', problem: "Expected a non-empty subset of ['movie','tv']." });
  }
  if (a['language'] !== null && !isBoundedString(a['language'], 40)) {
    issues.push({ field: 'language', problem: 'Expected null or a bounded language code.' });
  }
  if (!isBoundedString(a['builderVersion'], 120)) {
    issues.push({ field: 'builderVersion', problem: 'Expected a bounded builder version string.' });
  }

  // Analysis block.
  const analysis = a['analysis'];
  if (analysis === null || typeof analysis !== 'object' || Array.isArray(analysis)) {
    issues.push({ field: 'analysis', problem: 'Expected an analysis object.' });
  } else {
    const an = analysis as Record<string, unknown>;
    const verdicts: unknown[] = ['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'REQUIRES_RUNTIME', 'REQUIRES_MANUAL_ADAPTER'];
    if (!verdicts.includes(an['verdict'])) {
      issues.push({ field: 'analysis.verdict', problem: 'Expected a closed analysis verdict.' });
    }
    if (!isBoundedString(an['notes'], 2000)) {
      issues.push({ field: 'analysis.notes', problem: 'Expected bounded analysis notes.' });
    }
    if (an['sourceRevision'] !== undefined && (typeof an['sourceRevision'] !== 'string' || an['sourceRevision'].length > 64)) {
      issues.push({ field: 'analysis.sourceRevision', problem: 'Expected a bounded sha256 hex or empty string.' });
    }
    if (!isBoundedString(an['analyzedAt'], 64)) {
      issues.push({ field: 'analysis.analyzedAt', problem: 'Expected a bounded timestamp string.' });
    }
    const endpoints = an['endpoints'];
    if (!Array.isArray(endpoints) || endpoints.length > 32) {
      issues.push({ field: 'analysis.endpoints', problem: 'Expected a bounded endpoint list.' });
    }
  }

  // Test report block.
  const testReport = a['testReport'];
  if (testReport === null || typeof testReport !== 'object' || Array.isArray(testReport)) {
    issues.push({ field: 'testReport', problem: 'Expected a test report object.' });
  } else {
    const tr = testReport as Record<string, unknown>;
    if (typeof tr['passed'] !== 'boolean' || tr['passed'] !== true) {
      issues.push({ field: 'testReport.passed', problem: 'A READY artifact must carry a passing builder-side report.' });
    }
    if (!isBoundedString(tr['testedAt'], 64)) {
      issues.push({ field: 'testReport.testedAt', problem: 'Expected a bounded timestamp string.' });
    }
    if (!Array.isArray(tr['cases']) || tr['cases'].length === 0 || tr['cases'].length > 4) {
      issues.push({ field: 'testReport.cases', problem: 'Expected 1..4 bounded test cases.' });
    }
  }

  // Spec block.
  const spec = a['spec'];
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    issues.push({ field: 'spec', problem: 'Expected a declarative spec object.' });
    return issues;
  }
  const s = spec as Record<string, unknown>;

  // baseUrl.
  const baseUrl = s['baseUrl'];
  if (baseUrl === null || typeof baseUrl !== 'object' || Array.isArray(baseUrl)) {
    issues.push({ field: 'spec.baseUrl', problem: 'Expected a baseUrl object.' });
  } else if ((baseUrl as Record<string, unknown>)['kind'] === 'static') {
    if (!isHttpUrl((baseUrl as Record<string, unknown>)['url'])) {
      issues.push({ field: 'spec.baseUrl.url', problem: 'Expected an http(s) URL.' });
    }
  } else if ((baseUrl as Record<string, unknown>)['kind'] === 'dynamic') {
    const b = baseUrl as Record<string, unknown>;
    if (!isHttpUrl(b['fallbackUrl'])) issues.push({ field: 'spec.baseUrl.fallbackUrl', problem: 'Expected an http(s) URL.' });
    if (!isHttpUrl(b['domainsUrl'])) issues.push({ field: 'spec.baseUrl.domainsUrl', problem: 'Expected an http(s) URL.' });
    if (!isBoundedString(b['key'], 120)) issues.push({ field: 'spec.baseUrl.key', problem: 'Expected a bounded domains key.' });
  } else {
    issues.push({ field: 'spec.baseUrl.kind', problem: "Expected 'static' | 'dynamic'." });
  }

  // headers.
  const headers = s['headers'];
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    issues.push({ field: 'spec.headers', problem: 'Expected a headers object.' });
  } else {
    const entries = Object.entries(headers as Record<string, unknown>);
    if (entries.length > MAX_SPEC_HEADERS) {
      issues.push({ field: 'spec.headers', problem: `At most ${MAX_SPEC_HEADERS} headers.` });
    }
    for (const [key, value] of entries) {
      if (!isBoundedString(key, 128) || !isBoundedString(value, MAX_SPEC_STRING)) {
        issues.push({ field: 'spec.headers', problem: 'Headers must be bounded strings.' });
        break;
      }
    }
  }

  // search.
  const search = s['search'];
  if (search === null || typeof search !== 'object' || Array.isArray(search)) {
    issues.push({ field: 'spec.search', problem: 'Expected a search object.' });
  } else {
    const se = search as Record<string, unknown>;
    if (!isBoundedString(se['urlTemplate'], MAX_SPEC_STRING) || !String(se['urlTemplate']).includes('{query}')) {
      issues.push({ field: 'spec.search.urlTemplate', problem: 'Expected a bounded template containing {query}.' });
    }
    const extraction = se['extraction'];
    if (extraction === null || typeof extraction !== 'object' || Array.isArray(extraction)) {
      issues.push({ field: 'spec.search.extraction', problem: 'Expected an extraction object.' });
    } else if ((extraction as Record<string, unknown>)['kind'] === 'json') {
      const ex = extraction as Record<string, unknown>;
      for (const pathField of ['listPath', 'titlePath', 'hrefPath'] as const) {
        const pathValue = ex[pathField];
        if (!isBoundedString(pathValue, 128) || String(pathValue).split('.').length > 6 || /[^a-zA-Z0-9_.\[\]@-]/.test(String(pathValue))) {
          issues.push({ field: `spec.search.extraction.${pathField}`, problem: 'Expected a bounded simple dotted path.' });
        }
      }
    } else if ((extraction as Record<string, unknown>)['kind'] === 'html') {
      const ex = extraction as Record<string, unknown>;
      if (!isBoundedString(ex['container'], MAX_SPEC_SELECTOR)) {
        issues.push({ field: 'spec.search.extraction.container', problem: 'Expected a bounded CSS selector.' });
      }
      if (ex['titleAttr'] !== null && !isBoundedString(ex['titleAttr'], 64)) {
        issues.push({ field: 'spec.search.extraction.titleAttr', problem: 'Expected null or a bounded attribute name.' });
      }
      if (ex['anchorSelector'] !== null && !isBoundedString(ex['anchorSelector'], MAX_SPEC_SELECTOR)) {
        issues.push({ field: 'spec.search.extraction.anchorSelector', problem: 'Expected null or a bounded selector.' });
      }
    } else {
      issues.push({ field: 'spec.search.extraction.kind', problem: "Expected 'html' | 'json'." });
    }
  }

  // match.
  const match = s['match'];
  if (match === null || typeof match !== 'object' || Array.isArray(match) || (match as Record<string, unknown>)['strategy'] !== 'rank-title-year') {
    issues.push({ field: 'spec.match.strategy', problem: "Expected 'rank-title-year'." });
  }

  // movie + episode link extraction + resolution rules.
  const validateLinks = (block: unknown, field: string) => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      issues.push({ field: `spec.${field}`, problem: 'Expected a link extraction object.' });
      return;
    }
    const l = block as Record<string, unknown>;
    if (!isBoundedString(l['container'], MAX_SPEC_SELECTOR)) {
      issues.push({ field: `spec.${field}.container`, problem: 'Expected a bounded CSS selector.' });
    }
    if (!isBoundedString(l['hrefAttr'], 64)) {
      issues.push({ field: `spec.${field}.hrefAttr`, problem: 'Expected a bounded attribute name.' });
    }
    if (!isBoundedStringArray(l['includes'], MAX_SPEC_INCLUDES, 128)) {
      issues.push({ field: `spec.${field}.includes`, problem: 'Expected a bounded include list.' });
    }
  };
  const validateResolution = (rules: unknown, field: string) => {
    if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_SPEC_RESOLUTION_RULES) {
      issues.push({ field: `spec.${field}.resolution`, problem: 'Expected 1..6 resolution rules.' });
      return;
    }
    for (const rule of rules) {
      if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
        issues.push({ field: `spec.${field}.resolution`, problem: 'Each rule must be an object.' });
        continue;
      }
      const r = rule as Record<string, unknown>;
      if (r['kind'] === 'passthrough') {
        if (!isBoundedStringArray(r['includes'], MAX_SPEC_INCLUDES, 128)) {
          issues.push({ field: `spec.${field}.resolution`, problem: 'Passthrough includes must be bounded.' });
        }
      } else if (r['kind'] === 'regex-extract' || r['kind'] === 'regex-extract-extractor') {
        if (!isBoundedString(r['pattern'], MAX_SPEC_REGEX) || !isSafeRegexSource(String(r['pattern']))) {
          issues.push({ field: `spec.${field}.resolution`, problem: 'Expected a bounded, compilable regex.' });
        }
        if (typeof r['group'] !== 'number' || !Number.isInteger(r['group']) || (r['group'] as number) < 1 || (r['group'] as number) > 9) {
          issues.push({ field: `spec.${field}.resolution`, problem: 'Expected a capture group 1..9.' });
        }
      } else if (r['kind'] !== 'redirects' && r['kind'] !== 'extractor') {
        issues.push({ field: `spec.${field}.resolution`, problem: 'Unknown resolution rule kind.' });
      }
    }
  };
  const movie = s['movie'];
  if (movie === null || typeof movie !== 'object' || Array.isArray(movie)) {
    issues.push({ field: 'spec.movie', problem: 'Expected a movie block.' });
  } else {
    validateLinks((movie as Record<string, unknown>)['links'], 'movie.links');
    validateResolution((movie as Record<string, unknown>)['resolution'], 'movie');
  }
  const episode = s['episode'];
  if (episode !== undefined) {
    if (episode === null || typeof episode !== 'object' || Array.isArray(episode)) {
      issues.push({ field: 'spec.episode', problem: 'Expected an episode block.' });
    } else {
      const e = episode as Record<string, unknown>;
      if (!isBoundedString(e['container'], MAX_SPEC_SELECTOR)) {
        issues.push({ field: 'spec.episode.container', problem: 'Expected a bounded CSS selector.' });
      }
      for (const patternField of ['seasonPattern', 'episodePattern'] as const) {
        const pattern = e[patternField];
        if (!isBoundedString(pattern, MAX_SPEC_REGEX) || !isSafeRegexSource(String(pattern))) {
          issues.push({ field: `spec.episode.${patternField}`, problem: 'Expected a bounded, compilable regex.' });
        }
      }
      if (!isBoundedString(e['linkAttr'], 64)) {
        issues.push({ field: 'spec.episode.linkAttr', problem: 'Expected a bounded attribute name.' });
      }
      validateLinks(e['links'], 'episode.links');
      validateResolution(e['resolution'], 'episode');
    }
  }

  // output + limits.
  const output = s['output'];
  if (output === null || typeof output !== 'object' || Array.isArray(output) || !isBoundedString((output as Record<string, unknown>)['sourceName'], 120)) {
    issues.push({ field: 'spec.output.sourceName', problem: 'Expected a bounded source name.' });
  }
  const limits = s['limits'];
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    issues.push({ field: 'spec.limits', problem: 'Expected a limits object.' });
  } else {
    for (const key of ['maxCandidates', 'maxLinks'] as const) {
      const value = (limits as Record<string, unknown>)[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_SPEC_LIMIT_VALUE) {
        issues.push({ field: `spec.limits.${key}`, problem: `Expected an integer 1..${MAX_SPEC_LIMIT_VALUE}.` });
      }
    }
  }

  // Whole-artifact size bound (canonical serialization).
  const serialized = canonicalJson(a);
  if (serialized.length > MAX_ADAPTER_ARTIFACT_BYTES) {
    issues.push({ field: 'artifact', problem: `The artifact exceeds ${MAX_ADAPTER_ARTIFACT_BYTES} bytes.` });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Identity helpers (mirror the Phase 2 registry canonical key)
// ---------------------------------------------------------------------------

/** Canonical artifact/adapter identity: `${type}:${lowercased provider key}`. */
export function canonicalArtifactId(
  integrationType: 'cloudstream' | 'nuvio',
  providerId: string,
): string {
  return `${integrationType}:${providerId.trim().toLowerCase()}`;
}
