/**
 * MAVERO Adapter Builder — Nuvio trace-matching DSL compiler (plan §8).
 *
 * Compiles a permanent declarative adapter from the OBSERVED behavior of a
 * sandboxed Nuvio provider module (sandbox.ts trace). The compiler is
 * strictly EVIDENCE-BASED (anti-hallucination, D-P3-6):
 *
 *   * every URL template substring comes from a fetch the module ACTUALLY
 *     made ({base}/{query} derived from the observed search URL);
 *   * every extraction path/selector is verified against the observed
 *     documents (the JSON tree is walked for the observed detail URL; HTML
 *     selectors are TESTED to produce the observed navigation URLs);
 *   * resolution patterns are derived from the module's ACTUAL output URLs;
 *   * TMDB is dropped (Mavero supplies title/year/tmdbId in requests);
 *   * dynamic domains documents observed in the trace become the DSL's
 *     dynamic baseUrl (host-evidence key selection, never guessed).
 *
 * When ANY step cannot be evidenced, the compiler REFUSES (verdict
 * REQUIRES_RUNTIME / UNSUPPORTED) — a fake adapter is never emitted.
 *
 * The artifact the compiler produces is only PERSISTED after the shared
 * interpreter re-runs the representative cases against the live provider
 * and the anti-hallucination check passes (see server.ts verify step).
 */

import type {
  AdapterAnalysisVerdict,
  AdapterBuildRequest,
  DeclarativeAdapterSpec,
  DeclarativeLinkExtraction,
  DeclarativeResolutionRule,
} from '$lib/shared/adapter-artifact';
import type { SandboxFetchRecord, SandboxTrace } from './sandbox';

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Refetch surface for evidence verification (the builder runtime context). */
export type NuvioCompileDeps = {
  /** Refetch + parse a JSON document (SSRF-guarded, bounded). */
  refetchJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  /** Refetch an HTML document (SSRF-guarded, bounded). */
  refetchHtml(url: string, headers?: Record<string, string>): Promise<string>;
  /** Load HTML into a cheerio document (for selector evidence testing). */
  parseHtml(html: string): import('cheerio').CheerioAPI;
};

export type NuvioCompileEvidence = {
  /** The search fetch the module actually made. */
  searchUrl: string;
  /** The detail page the module actually visited (null = search page IS the detail page). */
  detailUrl: string | null;
  /** Inner (button) pages the module actually visited, bounded. */
  innerUrls: string[];
  /** Output URLs the module actually returned, bounded. */
  outputUrls: string[];
  /** Whether a dynamic domains document was observed. */
  domainsDocument: string | null;
};

export type NuvioCompileSuccess = {
  ok: true;
  spec: DeclarativeAdapterSpec;
  verdict: AdapterAnalysisVerdict;
  notes: string;
  evidence: NuvioCompileEvidence;
};

export type NuvioCompileFailure = {
  ok: false;
  verdict: 'REQUIRES_RUNTIME' | 'UNSUPPORTED';
  reason: string;
};

export type NuvioCompileResult = NuvioCompileSuccess | NuvioCompileFailure;

// ---------------------------------------------------------------------------
// Bounded helpers
// ---------------------------------------------------------------------------

const MAX_EVIDENCE_URLS = 16;
const MAX_QUERY_CHARS = 100;

function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Bounded escape of a string into a regex source. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Common path prefix (≥4 chars) across observed URLs of one host. */
function commonPathPrefix(urls: string[]): string | null {
  if (urls.length < 2) return null;
  let prefix: string | null = null;
  for (const url of urls) {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
    prefix = prefix === null ? path : commonPrefix(prefix, path);
    if (prefix === null || prefix.length < 4) return null;
  }
  return prefix !== null && prefix.length >= 4 ? prefix : null;
}

function commonPrefix(a: string, b: string): string | null {
  let end = 0;
  const limit = Math.min(a.length, b.length);
  while (end < limit && a[end] === b[end]) end += 1;
  // Do not split mid-segment; back up to the last '/'.
  const lastSlash = a.lastIndexOf('/', end - 1);
  return lastSlash >= 0 ? a.slice(0, lastSlash) : null;
}

/** Distinct output-host markers (e.g. 'hubcloud', 'gdflix', 'pixeldrain'). */
function outputHostMarkers(urls: string[]): string[] {
  const markers = new Set<string>();
  for (const url of urls) {
    const host = urlHost(url);
    if (host.length === 0) continue;
    // The distinguishing label: the registrable word before the TLD (e.g.
    // 'hubcloud.ist' → 'hubcloud'; 'new4.gdflix.io' → 'gdflix').
    const parts = host.split('.');
    const label = parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
    if (label.length >= 4 && label.length <= 32 && /^[a-z0-9-]+$/.test(label)) {
      markers.add(label);
    }
    if (markers.size >= 4) break;
  }
  return [...markers].sort();
}

// ---------------------------------------------------------------------------
// Step 1: trace segmentation (observed fetch roles)
// ---------------------------------------------------------------------------

type TraceSegments = {
  stubs: SandboxFetchRecord[];
  domainsCandidates: SandboxFetchRecord[];
  search: SandboxFetchRecord;
  detail: SandboxFetchRecord | null;
  inner: SandboxFetchRecord[];
  /** The complete post-detail follow chain (any host, bounded) — the raw
   * link wave PLUS the module's extraction fetches (selector evidence
   * separates them). */
  followChain: SandboxFetchRecord[];
  outputs: string[];
};

/**
 * Segments the observed fetch trace into roles. The search fetch is the
 * request that carried the query — the title, its encoded form, OR the imdb
 * id (the moviesdrive family searches by imdb id; the title alone would
 * misclassify their search). The detail fetch is the first same-provider-
 * host navigation after search; inner fetches are same-host navigations
 * after the detail page (the two-level walk). Non-provider hosts reached
 * AFTER the detail page are resolution fetches (excluded — the DSL's
 * resolution rules own those).
 */
function segmentTrace(
  trace: SandboxTrace,
  queryTitle: string,
  imdbId: string | null,
): { ok: true; segments: TraceSegments } | { ok: false; reason: string } {
  const fetches = trace.fetches.filter((record) => record.ok);
  if (fetches.length === 0) {
    return { ok: false, reason: 'The provider made no successful network requests during the analysis.' };
  }

  // The search fetch: the first non-stub fetch whose URL carries the query
  // (raw/encoded title or the imdb id). Falls back to the first non-stub
  // fetch that is NOT a plausible domains document (jsonUrlKeys present).
  const encoded = encodeURIComponent(queryTitle.trim().slice(0, MAX_QUERY_CHARS));
  const raw = queryTitle.trim().slice(0, MAX_QUERY_CHARS);
  const queryCandidates = [raw.toLowerCase(), encoded.toLowerCase()];
  if (imdbId !== null && imdbId.length > 0) {
    queryCandidates.push(imdbId.toLowerCase());
  }
  let search: SandboxFetchRecord | null = null;
  for (const record of fetches) {
    if (record.stubbed) continue;
    const url = record.url.toLowerCase();
    if (queryCandidates.some((candidate) => candidate.length > 0 && url.includes(candidate))) {
      search = record;
      break;
    }
  }
  if (search === null) {
    search = fetches.find((record) => !record.stubbed && record.jsonUrlKeys.length === 0) ?? null;
  }
  if (search === null) {
    return { ok: false, reason: 'The provider search request could not be identified in the trace.' };
  }

  const providerHost = urlHost(search.url);
  if (providerHost.length === 0) {
    return { ok: false, reason: 'The provider search request is not a valid URL.' };
  }

  // Dynamic domains document: a JSON fetch (different host) whose URL-key
  // values point at the provider host.
  const domainsCandidates = fetches.filter((record) => {
    if (record.stubbed || record.url === search!.url) return false;
    if (urlHost(record.url) === providerHost) return false;
    return record.jsonUrlKeys.some((entry) => entry.valueHost === providerHost);
  });

  const afterSearch = fetches.filter((record) => record.seq > search!.seq && !record.stubbed);
  // Detail: the first same-host navigation after search (or null when the
  // module's outputs live directly on the search page).
  const sameHostAfterSearch = afterSearch.filter((record) => urlHost(record.url) === providerHost);
  const detail = sameHostAfterSearch[0] ?? null;
  // Inner pages: same-host navigations after the detail page.
  const inner = detail !== null ? sameHostAfterSearch.filter((record) => record.seq > detail.seq) : [];
  // The complete post-detail follow chain: every fetch after the detail page
  // (any host) — the moviesdrive family jumps to mirror hosts (mdrive.lol)
  // immediately after the detail page.
  const followChain = detail !== null
    ? afterSearch.filter((record) => record.seq > detail.seq).slice(0, MAX_EVIDENCE_URLS)
    : [];
  // Outputs: the module's returned URLs (bounded, http(s)/magnet only).
  const outputs = trace.output
    .map((entry) => entry.url)
    .filter((url) => /^https?:\/\//i.test(url) || url.toLowerCase().startsWith('magnet:'))
    .slice(0, MAX_EVIDENCE_URLS);
  if (outputs.length === 0) {
    return { ok: false, reason: 'The provider returned no usable stream URLs during the analysis.' };
  }

  return {
    ok: true,
    segments: {
      stubs: fetches.filter((record) => record.stubbed),
      domainsCandidates,
      search,
      detail,
      inner: inner.slice(0, MAX_EVIDENCE_URLS),
      followChain,
      outputs,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 2: base URL + search template
// ---------------------------------------------------------------------------

type BaseResolution = {
  baseUrl: DeclarativeAdapterSpec['baseUrl'];
  baseValue: string;
  searchTemplate: string;
  searchHeaders: Record<string, string>;
};

function resolveBaseAndTemplate(
  segments: TraceSegments,
  queryTitle: string,
  imdbId: string | null,
): { ok: true; value: BaseResolution } | { ok: false; reason: string } {
  const searchUrl = segments.search.url;
  const searchHeaders = segments.search.requestHeadersSanitized;

  // Dynamic base: prefer a domains document whose recorded keys point at
  // the provider host; the key is evidence-selected (host match), and the
  // current host value becomes the fallback base.
  const domains = segments.domainsCandidates[0] ?? null;
  if (domains !== null) {
    const keyEntry = domains.jsonUrlKeys.find((entry) => entry.valueHost === urlHost(searchUrl));
    if (keyEntry !== undefined) {
      return {
        ok: true,
        value: {
          baseUrl: {
            kind: 'dynamic',
            fallbackUrl: `https://${urlHost(searchUrl)}`,
            domainsUrl: domains.url,
            key: keyEntry.key,
          },
          baseValue: `https://${urlHost(searchUrl)}`,
          searchTemplate: deriveSearchTemplate(searchUrl, `https://${urlHost(searchUrl)}`, queryTitle, imdbId),
          searchHeaders,
        },
      };
    }
  }

  // Static base: the search URL's origin.
  let origin: string;
  try {
    origin = new URL(searchUrl).origin;
  } catch {
    return { ok: false, reason: 'The provider search URL could not be parsed.' };
  }
  return {
    ok: true,
    value: {
      baseUrl: { kind: 'static', url: origin },
      baseValue: origin,
      searchTemplate: deriveSearchTemplate(searchUrl, origin, queryTitle, imdbId),
      searchHeaders,
    },
  };
}

/**
 * Derives the search URL template: replaces the base origin with {base} and
 * the query value — the title, its encoded form, OR the imdb id (providers
 * that search by imdb id) — with {query}. The result MUST still contain
 * {query}; otherwise no search value could be evidenced (honest refusal).
 */
function deriveSearchTemplate(searchUrl: string, base: string, queryTitle: string, imdbId: string | null): string {
  let template = searchUrl;
  if (template.startsWith(base)) {
    template = `{base}${template.slice(base.length)}`;
  }
  const candidates: string[] = [];
  const encoded = encodeURIComponent(queryTitle.trim().slice(0, MAX_QUERY_CHARS));
  const raw = queryTitle.trim().slice(0, MAX_QUERY_CHARS);
  if (encoded.length > 0) candidates.push(encoded);
  if (raw.length > 0) candidates.push(raw);
  if (imdbId !== null && imdbId.length > 0) {
    candidates.push(encodeURIComponent(imdbId));
    candidates.push(imdbId);
  }
  for (const candidate of candidates) {
    if (template.includes(candidate)) {
      template = template.split(candidate).join('{query}');
    }
  }
  return template;
}

// ---------------------------------------------------------------------------
// Step 3: search candidate extraction (JSON evidence walk)
// ---------------------------------------------------------------------------

type JsonExtractionEvidence = {
  listPath: string;
  titlePath: string;
  hrefPath: string;
};

/**
 * Walks the refetched JSON search document for the OBSERVED detail URL. When
 * found inside an array element, the dotted paths (list/title/href) are
 * derived from the actual tree positions — never guessed.
 */
function compileJsonExtraction(
  body: unknown,
  detailUrl: string,
  queryTitle: string,
): JsonExtractionEvidence | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const detailTarget = detailUrl.toLowerCase();
  // Relative permalink evidence: search documents often carry the detail
  // link as a SITE-RELATIVE path ('/inception-2010/') while the observed
  // fetch is absolute — both forms evidence the same extraction path.
  let detailPath: string | null = null;
  try {
    const pathname = new URL(detailUrl).pathname;
    if (pathname.length > 1) detailPath = pathname.toLowerCase();
  } catch {
    // not parseable — absolute-only matching
  }

  // Find an array of objects containing the detail URL at some dotted path.
  const findInContainer = (container: unknown, prefix: string): {
    listPath: string;
    hrefPath: string;
    element: Record<string, unknown>;
  } | null => {
    if (container === null || typeof container !== 'object' || Array.isArray(container)) return null;
    for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > 0 && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
        for (const item of value.slice(0, 40)) {
          const record = item as Record<string, unknown>;
          const hrefPath = findStringValue(record, '', detailTarget, detailPath);
          if (hrefPath !== null) {
            return { listPath: prefix.length > 0 ? `${prefix}.${key}` : key, hrefPath, element: record };
          }
        }
      }
    }
    // Recurse into nested objects (bounded depth 4).
    for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
      if (prefix.split('.').length >= 4) continue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const nested = findInContainer(value, prefix.length > 0 ? `${prefix}.${key}` : key);
        if (nested !== null) return nested;
      }
    }
    return null;
  };

  // Finds the dotted path (within one element) whose string value matches the
  // detail link — the absolute observed URL OR its site-relative path form.
  const findStringValue = (element: Record<string, unknown>, prefix: string, target: string, targetPath: string | null): string | null => {
    for (const [key, value] of Object.entries(element)) {
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === target || (targetPath !== null && lower === targetPath)) {
          return prefix.length > 0 ? `${prefix}.${key}` : key;
        }
        // Base-relative forms the module joined before fetching.
        if (targetPath !== null && (lower.endsWith(targetPath) || target.endsWith(lower) && lower.startsWith('/'))) {
          return prefix.length > 0 ? `${prefix}.${key}` : key;
        }
      }
      if (prefix.split('.').length < 4 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const nested = findStringValue(value as Record<string, unknown>, prefix.length > 0 ? `${prefix}.${key}` : key, target, targetPath);
        if (nested !== null) return nested;
      }
    }
    return null;
  };

  const found = findInContainer(body, '');
  if (found === null) return null;

  // Title path: a sibling string field that plausibly carries the title —
  // evidence: contains a word (≥4 chars) of the query title, else the
  // longest bounded string field in the element.
  const normalizedTitle = queryTitle.trim().toLowerCase();
  const titleWords = normalizedTitle.split(/\s+/).filter((word) => word.length >= 4);
  let bestTitlePath: string | null = null;
  let bestScore = -1;
  const scanFields = (element: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(element)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        const lower = value.toLowerCase();
        const score = titleWords.some((word) => lower.includes(word)) ? 1000 + Math.min(value.length, 200) : Math.min(value.length, 200);
        if (score > bestScore) {
          bestScore = score;
          bestTitlePath = prefix.length > 0 ? `${prefix}.${key}` : key;
        }
      } else if (prefix.split('.').length < 3 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        scanFields(value as Record<string, unknown>, prefix.length > 0 ? `${prefix}.${key}` : key);
      }
    }
  };
  scanFields(found.element, '');
  if (bestTitlePath === null) return null;

  return { listPath: found.listPath, titlePath: bestTitlePath, hrefPath: found.hrefPath };
}

// ---------------------------------------------------------------------------
// Step 4: HTML link-extraction evidence (selector testing)
// ---------------------------------------------------------------------------

/**
 * Tests candidate selectors (recorded cheerio ops + standard families)
 * against the refetched detail HTML: a selector is EVIDENCE-SELECTED when
 * its extracted hrefs include the OBSERVED navigation URLs.
 */
async function compileHtmlLinkExtraction(
  html: string,
  observedUrls: string[],
  recordedSelectors: string[],
  deps: NuvioCompileDeps,
): Promise<DeclarativeLinkExtraction | null> {
  const $ = deps.parseHtml(html);
  const targets = new Set(observedUrls.map((url) => url.toLowerCase()));
  const candidates = dedupeStrings([
    ...recordedSelectors.filter((selector) => selector.includes('a') || selector.includes('h5') || selector.includes('button')),
    'h5 a',
    'a',
    'a:has(button)',
  ]);
  // Evidence selection: the candidate covering the MOST observed navigation
  // URLs wins (ties broken by the SMALLEST fan-out — the most specific
  // selector). Raw links may be a MINORITY of the full follow chain (the
  // module's own extraction fetches follow), so a majority threshold would
  // misclassify; coverage + specificity is the honest criterion.
  let best: { selector: string; matched: number; total: number } | null = null;
  for (const selector of candidates) {
    if (selector.length === 0 || selector.length > 256) continue;
    let matched = 0;
    let total = 0;
    try {
      $(selector).each((_, el) => {
        total += 1;
        const href = ($(el).attr('href') ?? '').trim().toLowerCase();
        if (href.length > 0 && targets.has(href)) matched += 1;
        else if (href.length > 0 && [...targets].some((target) => target.endsWith(href) || href.endsWith(target))) matched += 1;
      });
    } catch {
      continue; // invalid selector — skip
    }
    if (matched < 1 || total <= 0 || total > 64) continue;
    if (
      best === null
      || matched > best.matched
      || (matched === best.matched && total < best.total)
    ) {
      best = { selector, matched, total };
    }
  }
  if (best === null) return null;
  return { container: best.selector, hrefAttr: 'href', includes: [] };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** The observed navigation URLs an evidenced selector actually carries. */
function extractSelectorMatchedUrls(
  selector: string,
  detailHtml: string,
  observedUrls: string[],
  deps: NuvioCompileDeps,
): string[] {
  try {
    const $ = deps.parseHtml(detailHtml);
    const hrefs = new Set<string>();
    $(selector).each((_, el) => {
      const href = ($(el).attr('href') ?? '').trim().toLowerCase();
      if (href.length > 0) hrefs.add(href);
    });
    return observedUrls.filter((url) => {
      const lower = url.toLowerCase();
      if (hrefs.has(lower)) return true;
      try {
        return hrefs.has(new URL(url).pathname) || [...hrefs].some((href) => href.startsWith('/') && lower.endsWith(href));
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 5: resolution rules from observed outputs
// ---------------------------------------------------------------------------

/**
 * Builds the ordered resolution rules from the observed output URLs and the
 * observed navigation structure:
 *   * module visited inner pages  → regex-extract (host-derived pattern)
 *     + extractor (known hosts) + passthrough (direct media);
 *   * no inner pages (detail-page links ARE the outputs) → extractor +
 *     passthrough with host markers.
 */
function compileResolutionRules(
  segments: TraceSegments,
  secondLevelUrl: string | null,
): DeclarativeResolutionRule[] {
  const markers = outputHostMarkers(segments.outputs);
  const includes = markers.slice(0, 4);
  const hasFollowChain = segments.inner.length > 0 || segments.followChain.length > 0;
  if (!hasFollowChain) {
    const rules: DeclarativeResolutionRule[] = [{ kind: 'extractor' }];
    if (includes.length > 0) {
      rules.push({ kind: 'passthrough', includes: [...includes, '.mp4', '.mkv', '.m3u8'].slice(0, 12) });
    }
    return rules;
  }
  // Two-level walk (the moviesdrive-family structure): the raw links' pages
  // carry the NEXT-level URLs (e.g. hubcloud.ist/drive/...), which the
  // Mavero-owned extractor registry then resolves. The pattern derives from
  // the OBSERVED second-level fetch — never guessed.
  const rules: DeclarativeResolutionRule[] = [];
  const patternSource = secondLevelUrl ?? segments.outputs[0] ?? null;
  if (patternSource !== null) {
    const hostParts = urlHost(patternSource).split('.');
    const domain = hostParts.length >= 2 ? hostParts.slice(-2).join('.') : urlHost(patternSource);
    if (domain.length > 0) {
      const pattern = `(https?:\\/\\/[^"'\\s<>]*${escapeRegex(domain)}[^"'\\s<>]*)`;
      if (pattern.length <= 256) {
        rules.push({ kind: 'regex-extract-extractor', pattern, group: 1 });
      }
    }
  }
  rules.push({ kind: 'extractor' });
  if (includes.length > 0) {
    rules.push({ kind: 'passthrough', includes: [...includes, '.mp4', '.mkv', '.m3u8'].slice(0, 12) });
  }
  return rules.slice(0, 6);
}

// ---------------------------------------------------------------------------
// The compiler entry point
// ---------------------------------------------------------------------------

/**
 * Compiles one declarative spec from the observed movie-case trace. The
 * episode block is deliberately NOT compiled in v1 (the walk pattern cannot
 * be evidenced from the movie trace alone) — a provider whose manifest
 * declares tv support compiles to PARTIALLY_SUPPORTED with movie-only
 * coverage, which is honest and immediately useful. Episode compilation
 * lands with the dedicated episode trace work in a later builder version.
 */
export async function compileNuvioSpec(
  request: AdapterBuildRequest,
  trace: SandboxTrace,
  deps: NuvioCompileDeps,
): Promise<NuvioCompileResult> {
  const queryTitle = request.test.movie.title.trim() || request.provider.name || request.provider.id;
  const imdbId = request.test.movie.imdbId ?? null;

  // Step 1 — segment the observed trace.
  const segmented = segmentTrace(trace, queryTitle, imdbId);
  if (!segmented.ok) {
    return { ok: false, verdict: 'REQUIRES_RUNTIME', reason: segmented.reason };
  }
  const segments = segmented.segments;

  // Step 2 — base URL + search template.
  const baseResult = resolveBaseAndTemplate(segments, queryTitle, imdbId);
  if (!baseResult.ok) {
    return { ok: false, verdict: 'REQUIRES_RUNTIME', reason: baseResult.reason };
  }
  const base = baseResult.value;
  if (!base.searchTemplate.includes('{query}')) {
    return {
      ok: false,
      verdict: 'REQUIRES_RUNTIME',
      reason: 'The provider did not search using the supplied title, so no search template can be derived.',
    };
  }

  // Step 3 — candidate extraction.
  const isJsonSearch = (segments.search.contentType ?? '').includes('json');
  const detailUrl = segments.detail?.url ?? segments.search.url;
  const detailHeaders = segments.detail?.requestHeadersSanitized ?? base.searchHeaders;

  let extraction: DeclarativeAdapterSpec['search']['extraction'];
  if (isJsonSearch) {
    let body: unknown;
    try {
      body = await deps.refetchJson(segments.search.url, base.searchHeaders);
    } catch {
      return { ok: false, verdict: 'REQUIRES_RUNTIME', reason: 'The provider search document could not be re-verified.' };
    }
    const evidence = compileJsonExtraction(body, detailUrl, queryTitle);
    if (evidence === null) {
      return {
        ok: false,
        verdict: 'REQUIRES_RUNTIME',
        reason: 'The observed detail link was not found in the provider search document, so its extraction path cannot be evidenced.',
      };
    }
    extraction = { kind: 'json', ...evidence };
  } else {
    let html: string;
    try {
      html = await deps.refetchHtml(segments.search.url, base.searchHeaders);
    } catch {
      return { ok: false, verdict: 'REQUIRES_RUNTIME', reason: 'The provider search page could not be re-verified.' };
    }
    const selectors = trace.cheerio
      .filter((record) => record.docDigest === segments.search.bodyDigest && record.selector !== null)
      .map((record) => record.selector as string);
    const linkExtraction = await compileHtmlLinkExtraction(html, [detailUrl], selectors, deps);
    if (linkExtraction === null) {
      return {
        ok: false,
        verdict: 'REQUIRES_RUNTIME',
        reason: 'No search-page selector could be evidenced against the observed detail link.',
      };
    }
    // Search cards: same selector (each card's first anchor); title attr
    // when the module read it, else the card text.
    const titleAttr = trace.cheerio.some((record) => record.docDigest === segments.search.bodyDigest && record.attr === 'title')
      ? 'title'
      : null;
    extraction = {
      kind: 'html',
      container: linkExtraction.container,
      titleAttr,
      anchorSelector: null,
    };
  }

  // Step 4 — detail-page link extraction (evidence-selected selector).
  let detailHtml: string;
  try {
    detailHtml = await deps.refetchHtml(detailUrl, detailHeaders);
  } catch {
    return { ok: false, verdict: 'REQUIRES_RUNTIME', reason: 'The provider detail page could not be re-verified.' };
  }
  const detailDigest = segments.detail?.bodyDigest ?? segments.search.bodyDigest;
  const detailSelectors = trace.cheerio
    .filter((record) => record.docDigest === detailDigest && record.selector !== null)
    .map((record) => record.selector as string);
  // Selector-evidence targets: the COMPLETE post-detail follow chain first
  // (the moviesdrive family jumps to mirror hosts immediately — the raw-link
  // wave is whichever observed URLs the detail page's anchors actually
  // carry), then the same-host inner pages, then the outputs.
  const observedNavUrls = segments.followChain.length > 0
    ? segments.followChain.map((record) => record.url)
    : segments.inner.length > 0
      ? segments.inner.map((record) => record.url)
      : segments.outputs;
  let movieLinks = await compileHtmlLinkExtraction(detailHtml, observedNavUrls, detailSelectors, deps);
  if (movieLinks === null) {
    // Honest fallback: link extraction could not be evidenced.
    return {
      ok: false,
      verdict: 'REQUIRES_RUNTIME',
      reason: 'No detail-page link selector could be evidenced against the observed provider navigation.',
    };
  }
  // Which observed URLs did the evidenced selector actually carry? Those are
  // the RAW LINKS (the first extraction wave); everything else in the follow
  // chain is the module's own extraction (second-level+ fetches).
  const rawLinkUrls = extractSelectorMatchedUrls(movieLinks.container, detailHtml, observedNavUrls, deps);
  const secondLevelUrls = segments.followChain
    .map((record) => record.url)
    .filter((url) => !rawLinkUrls.includes(url) && !segments.outputs.includes(url));
  // The observed SECOND-LEVEL fetch (e.g. the first hubcloud.ist/drive URL)
  // sources the regex-extract-extractor pattern.
  const secondLevelUrl = secondLevelUrls[0] ?? null;

  // When the detail anchors ARE the outputs, the includes narrow extraction
  // to the observed host markers (keeps fan-out bounded).
  if (segments.followChain.length === 0 && segments.inner.length === 0) {
    const markers = outputHostMarkers(segments.outputs);
    if (markers.length > 0) {
      movieLinks = { ...movieLinks, includes: markers.slice(0, 6) };
    }
  } else {
    // Two-level walk: the common path prefix of the RAW LINK URLs (if any)
    // narrows the selector fan-out honestly.
    const prefix = commonPathPrefix(rawLinkUrls.length > 0 ? rawLinkUrls : segments.inner.map((record) => record.url));
    if (prefix !== null && prefix.length >= 4 && prefix.length <= 128) {
      movieLinks = { ...movieLinks, includes: [prefix.slice(0, 128)] };
    }
  }

  // Step 5 — resolution rules from observed outputs.
  const resolution = compileResolutionRules(segments, secondLevelUrl);

  const providerName = (request.provider.name ?? request.provider.id).slice(0, 120);
  const mediaTypes: Array<'movie' | 'tv'> = request.provider.mediaTypes.includes('tv')
    ? ['movie', 'tv']
    : ['movie'];

  const spec: DeclarativeAdapterSpec = {
    baseUrl: base.baseUrl,
    headers: Object.keys(base.searchHeaders).length > 0 ? base.searchHeaders : {},
    search: {
      urlTemplate: base.searchTemplate.slice(0, 512),
      extraction,
    },
    match: { strategy: 'rank-title-year', maxCandidates: 20 },
    movie: { links: movieLinks, resolution },
    output: { sourceName: providerName },
    limits: { maxCandidates: 20, maxLinks: 24 },
  };

  const verdict: AdapterAnalysisVerdict = request.provider.mediaTypes.includes('tv')
    ? 'PARTIALLY_SUPPORTED'
    : 'SUPPORTED';
  const notes = request.provider.mediaTypes.includes('tv')
    ? `Compiled movie resolution from the observed provider behavior; episode resolution requires a later builder version (honest partial coverage). Evidence: ${segments.outputs.length} observed output URLs${segments.domainsCandidates.length > 0 ? '; dynamic domains document observed' : ''}.`
    : `Compiled from the observed provider behavior. Evidence: ${segments.outputs.length} observed output URLs${segments.domainsCandidates.length > 0 ? '; dynamic domains document observed' : ''}.`;

  return {
    ok: true,
    spec,
    verdict,
    notes,
    evidence: {
      searchUrl: segments.search.url,
      detailUrl: segments.detail?.url ?? null,
      innerUrls: segments.inner.map((record) => record.url),
      outputUrls: segments.outputs,
      domainsDocument: segments.domainsCandidates[0]?.url ?? null,
    },
  };
}
