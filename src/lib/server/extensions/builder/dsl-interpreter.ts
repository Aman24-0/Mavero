/**
 * MAVERO declarative adapter DSL interpreter (Permanent Adapter Plan
 * Phase 3 — plan §9 "constrained adapter representation").
 *
 * Executes a validated DeclarativeAdapterSpec (the permanent artifact
 * payload) against the EXISTING CloudStream runtime context — the same
 * SSRF-guarded, deadline-bound, diagnostics-instrumented surface the
 * native adapters (Bollyflix/MoviesDrive/VegaMovies) run on. A generated
 * adapter therefore inherits the ENTIRE Phase 1 reliability contract and
 * the §14 security model with zero new network surface.
 *
 * ONE IMPLEMENTATION, TWO CONTEXTS (test-what-you-ship):
 *   * Mavero runtime: the standard CloudStreamRuntimeContext (created per
 *     resolution by resolver/service.ts — never by this module).
 *   * Builder build-time testing: the Builder's own context implementing
 *     the same interface (adapter-builder/context.ts). The Builder runs
 *     the SAME interpreter code it generated the spec for.
 *
 * SECURITY: the interpreter treats the spec as UNTRUSTED DATA — every
 * selector/regex/template was already bounded by validateAdapterArtifact,
 * and this module re-clamps every fan-out against hard interpreter caps,
 * so a tampered or malformed spec can never cause unbounded work. No code
 * execution ever happens here (the artifact contains none). Importable
 * from the standalone Builder via the repo tsconfig path alias.
 */

import type {
  CloudStreamEpisodeRequest,
  CloudStreamLinkResult,
  CloudStreamResolveRequest,
  CloudStreamRuntimeContext,
} from '$lib/server/cloudstream/types/runtime';
import type {
  DeclarativeAdapterSpec,
  DeclarativeResolutionRule,
} from '$lib/shared/adapter-artifact';
import { buildNormalizedLink, classifyUrlKind, type CloudStreamNormalizedLink } from '$lib/server/cloudstream/normalize/links';
import { rankCandidates, classifyNetworkFailure, joinUrl } from '$lib/server/cloudstream/adapters/common';
import { matchCloudStreamExtractor } from '$lib/server/cloudstream/extractors';

// ---------------------------------------------------------------------------
// Hard interpreter caps (defense-in-depth ON TOP of the validated spec)
// ---------------------------------------------------------------------------

/** Absolute candidate cap regardless of what the spec claims. */
const HARD_MAX_CANDIDATES = 40;
/** Absolute link cap regardless of what the spec claims. */
const HARD_MAX_LINKS = 40;
/** Max detail pages loaded per resolution (1 movie / ≤4 season pages). */
const HARD_MAX_DETAIL_PAGES = 4;
/** Query length bound for the search template substitution. */
const HARD_MAX_QUERY_CHARS = 100;
/** Extracted raw-link length bound. */
const HARD_MAX_LINK_URL = 2048;

/** Metadata the interpreter needs beyond the spec (from the artifact). */
export type DeclarativeAdapterMeta = {
  adapterId: string;
  displayName: string;
  sourceName: string;
};

// ---------------------------------------------------------------------------
// Base URL resolution (static | dynamic-urls.json style)
// ---------------------------------------------------------------------------

/** In-process dynamic-domains cache (immutable per document; 10 min TTL —
 * the same cadence the native adapters' urls.json port uses). */
const DOMAINS_CACHE_TTL_MS = 10 * 60_000;
const domainsCache = new Map<string, { at: number; value: string }>();

function sanitizeDomainsValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) return null;
  if (trimmed.length > 2048 || /\s/.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

/**
 * Resolves the spec's base URL. Static bases are used verbatim; dynamic
 * bases fetch the spec's OWN domains document (e.g. a Nuvio provider's
 * TVVVV domains.json) through the context's SSRF-safe fetchJson and read
 * the declared key, falling back to the baked-in fallback on ANY failure
 * (the same failure semantics as the native adapters' getLatestBaseUrl
 * port). The cache is keyed by document URL — immutable values, TTL only
 * for domain-rotation freshness.
 */
async function resolveSpecBase(spec: DeclarativeAdapterSpec, ctx: CloudStreamRuntimeContext): Promise<string> {
  const base = spec.baseUrl;
  if (base.kind === 'static') return base.url;
  const now = ctx.now();
  const cached = domainsCache.get(base.domainsUrl);
  if (cached !== undefined && now - cached.at < DOMAINS_CACHE_TTL_MS) return cached.value;
  try {
    const body = await ctx.fetchJson(base.domainsUrl);
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const value = sanitizeDomainsValue((body as Record<string, unknown>)[base.key]);
      if (value !== null) {
        domainsCache.set(base.domainsUrl, { at: now, value });
        return value;
      }
    }
  } catch {
    // Fall back to the baked-in base (Kotlin-parity failure semantics).
  }
  return base.fallbackUrl;
}

// ---------------------------------------------------------------------------
// Search + candidate ranking (the search-page-scraper archetype)
// ---------------------------------------------------------------------------

/** Search URL from the template: {base} + {query} substitution (bounded). */
export function searchUrlFromTemplate(
  template: string,
  base: string,
  query: string,
): string {
  const boundedQuery = query.trim().slice(0, HARD_MAX_QUERY_CHARS);
  const url = template
    .replace(/\{base\}/g, base)
    .replace(/\{query\}/g, encodeURIComponent(boundedQuery));
  return url.slice(0, HARD_MAX_LINK_URL);
}

type RawCandidate = { title: string; href: string };

/** Walks a bounded dotted path ('a.b.c') into a JSON document. */
function walkDottedPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (segment.length === 0) return undefined;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Extracts JSON candidates (dotted paths; bounded counts/lengths). */
function extractJsonCandidates(
  listPath: string,
  titlePath: string,
  hrefPath: string,
  body: unknown,
  maxCandidates: number,
): RawCandidate[] {
  const list = walkDottedPath(body, listPath);
  if (!Array.isArray(list)) return [];
  const candidates: RawCandidate[] = [];
  for (const entry of list) {
    if (candidates.length >= maxCandidates) break;
    const title = walkDottedPath(entry, titlePath);
    const href = walkDottedPath(entry, hrefPath);
    if (typeof title !== 'string' || title.trim().length === 0) continue;
    if (typeof href !== 'string' || href.trim().length === 0) continue;
    const boundedTitle = title.trim().slice(0, 200);
    const boundedHref = href.trim().slice(0, HARD_MAX_LINK_URL);
    if (!boundedHref || !boundedTitle) continue;
    candidates.push({ title: boundedTitle, href: boundedHref });
  }
  return candidates;
}

/** Extracts candidates from a search response per the spec (html | json). */
function extractCandidates(
  spec: DeclarativeAdapterSpec,
  fetch: { kind: 'html'; html: string } | { kind: 'json'; body: unknown },
  ctx: CloudStreamRuntimeContext,
): RawCandidate[] {
  const maxCandidates = Math.min(spec.limits.maxCandidates, HARD_MAX_CANDIDATES);
  const extraction = spec.search.extraction;
  if (extraction.kind === 'json' && fetch.kind === 'json') {
    return extractJsonCandidates(extraction.listPath, extraction.titlePath, extraction.hrefPath, fetch.body, maxCandidates);
  }
  if (extraction.kind !== 'html' || fetch.kind !== 'html') return [];
  const $ = ctx.parseHtml(fetch.html);
  const candidates: RawCandidate[] = [];
  $(extraction.container).each((_, el) => {
    if (candidates.length >= maxCandidates) return;
    const $card = $(el);
    const anchorScope = extraction.anchorSelector !== null
      ? $card.find(extraction.anchorSelector)
      : $card.find('a');
    const href = (anchorScope.first().attr('href') ?? '').trim();
    if (!href || href.length > HARD_MAX_LINK_URL) return;
    let title = '';
    if (extraction.titleAttr !== null) {
      title = (anchorScope.first().attr(extraction.titleAttr) ?? '').trim();
    }
    if (!title) {
      // Bounded fallback: the card's own text (title attr absent).
      title = $card.text().trim().slice(0, 200);
    }
    if (!title) return;
    candidates.push({ title, href });
  });
  return candidates;
}

/** Fetches the search document once, per the extraction kind. */
async function fetchSearchDocument(
  spec: DeclarativeAdapterSpec,
  searchUrl: string,
  ctx: CloudStreamRuntimeContext,
): Promise<{ kind: 'html'; html: string } | { kind: 'json'; body: unknown }> {
  if (spec.search.extraction.kind === 'json') {
    const body = await ctx.fetchJson(searchUrl, Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : undefined);
    return { kind: 'json', body };
  }
  const page = await ctx.fetchHtml(searchUrl, Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : undefined);
  return { kind: 'html', html: page.html };
}

// ---------------------------------------------------------------------------
// Link extraction + per-link resolution rules
// ---------------------------------------------------------------------------

type RawLink = { href: string; label: string };

/** Extracts raw links from a detail page per one extraction block. */
function extractRawLinks(
  container: string,
  hrefAttr: string,
  includes: string[],
  html: string,
  ctx: CloudStreamRuntimeContext,
  maxLinks: number,
): RawLink[] {
  const $ = ctx.parseHtml(html);
  const links: RawLink[] = [];
  $(container).each((_, el) => {
    if (links.length >= maxLinks) return;
    const $el = $(el);
    const href = ($el.attr(hrefAttr) ?? '').trim();
    if (!href || href.length > HARD_MAX_LINK_URL) return;
    if (includes.length > 0) {
      const haystack = href.toLowerCase();
      const matched = includes.some((include) => haystack.includes(include.toLowerCase()));
      if (!matched) return;
    }
    links.push({ href, label: $el.text().trim().slice(0, 200) });
  });
  return links;
}

/**
 * Applies ONE resolution rule to a raw link. Returns normalized links, or
 * null when the rule does not match / cannot resolve this link. The first
 * matching rule wins (ordered rules); non-matching links are dropped
 * honestly (a constrained adapter only emits links it can verify).
 */
async function applyResolutionRule(
  rule: DeclarativeResolutionRule,
  raw: RawLink,
  base: string,
  spec: DeclarativeAdapterSpec,
  ctx: CloudStreamRuntimeContext,
  meta: DeclarativeAdapterMeta,
): Promise<CloudStreamNormalizedLink[] | null> {
  const url = joinUrl(base, raw.href);
  const headers = Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : undefined;

  if (rule.kind === 'passthrough') {
    const haystack = url.toLowerCase();
    const matched = rule.includes.some((include) => haystack.includes(include.toLowerCase()));
    if (!matched) return null;
    return [buildNormalizedLink(
      {
        url,
        kind: classifyUrlKind(url),
        sourceName: `${meta.sourceName} ${sourceSuffix(raw.label, meta)}`.trim(),
        extractor: 'direct',
        filename: filenameOf(url),
      },
      meta.adapterId,
    )];
  }

  if (rule.kind === 'redirects') {
    const finalUrl = await ctx.resolveRedirects(url);
    if (finalUrl === null) return null;
    return [buildNormalizedLink(
      {
        url: finalUrl,
        kind: classifyUrlKind(finalUrl),
        sourceName: `${meta.sourceName} ${sourceSuffix(raw.label, meta)}`.trim(),
        extractor: 'redirect',
        filename: filenameOf(finalUrl),
      },
      meta.adapterId,
    )];
  }

  if (rule.kind === 'regex-extract') {
    // Fetch the page (the raw link points at an HTML interstitial) and
    // extract the direct URL with the bounded regex.
    const page = await ctx.fetchHtml(url, headers);
    const match = new RegExp(rule.pattern).exec(page.html);
    const captured = match?.[rule.group];
    if (!captured) return null;
    const direct = joinUrl(base, captured.trim());
    if (!direct.startsWith('http://') && !direct.startsWith('https://')) return null;
    return [buildNormalizedLink(
      {
        url: direct,
        kind: classifyUrlKind(direct),
        sourceName: `${meta.sourceName} ${sourceSuffix(raw.label, meta)}`.trim(),
        extractor: 'regex',
        filename: filenameOf(direct),
      },
      meta.adapterId,
    )];
  }

  if (rule.kind === 'regex-extract-extractor') {
    // Two-level extraction (the moviesdrive-family structure): fetch the raw
    // link's page, regex the NEXT-level URL (e.g. a hubcloud.ist/drive
    // link), then dispatch THAT through the Mavero-owned extractor registry.
    const page = await ctx.fetchHtml(url, headers);
    const match = new RegExp(rule.pattern).exec(page.html);
    const captured = match?.[rule.group];
    if (!captured) return null;
    const nextUrl = captured.trim().startsWith('http://') || captured.trim().startsWith('https://')
      ? captured.trim()
      : joinUrl(base, captured.trim());
    if (!nextUrl.startsWith('http://') && !nextUrl.startsWith('https://')) return null;
    if (matchCloudStreamExtractor(nextUrl) === null) return null;
    const extracted = await ctx.runExtractor(nextUrl, { label: raw.label.slice(0, 80) });
    if (extracted.length === 0) return null;
    return extracted.map((link) => buildNormalizedLink({ ...link }, meta.adapterId));
  }

  // rule.kind === 'extractor' — dispatch through the Mavero-owned registry
  // (gdflix / hubcloud / fastdlserver ports). Unknown hosts yield an empty
  // array (honest) — the extractor registry is the only code authority.
  if (matchCloudStreamExtractor(url) === null) return null;
  const extracted = await ctx.runExtractor(url, { label: raw.label.slice(0, 80) });
  if (extracted.length === 0) return null;
  return extracted.map((link) => buildNormalizedLink({ ...link }, meta.adapterId));
}

/** Applies the ordered rule list until one matches (bounded by validation). */
async function resolveRawLink(
  rules: readonly DeclarativeResolutionRule[],
  raw: RawLink,
  base: string,
  spec: DeclarativeAdapterSpec,
  ctx: CloudStreamRuntimeContext,
  meta: DeclarativeAdapterMeta,
): Promise<CloudStreamNormalizedLink[]> {
  for (const rule of rules) {
    try {
      const resolved = await applyResolutionRule(rule, raw, base, spec, ctx, meta);
      if (resolved !== null && resolved.length > 0) return resolved;
    } catch (error) {
      // One broken link never breaks the resolution (per-link isolation —
      // the same reliability rule the native adapters follow).
      ctx.diagnostics.record({
        adapterId: meta.adapterId,
        stage: 'resolve',
        durationMs: 0,
        success: false,
        failureCategory: 'EXTRACTOR_FAILED',
      });
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Output shaping helpers
// ---------------------------------------------------------------------------

/** Best-effort file name from a URL path (display-only enrichment). */
function filenameOf(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const name = path.split('/').pop() ?? '';
    if (name.length === 0 || name.length > 200) return undefined;
    return name;
  } catch {
    return undefined;
  }
}

/** Server label from the raw link text (e.g. 'HubCloud FSL' → 'FSL'). */
function sourceSuffix(label: string, meta: DeclarativeAdapterMeta): string {
  const cleaned = label.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.slice(0, 60);
}

// ---------------------------------------------------------------------------
// Movie resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a movie request through the declarative spec:
 *   base → search fetch → candidates → rank (title+year) → best page →
 *   link extraction → per-link resolution → normalized links.
 */
export async function resolveMovieWithSpec(
  spec: DeclarativeAdapterSpec,
  req: CloudStreamResolveRequest,
  ctx: CloudStreamRuntimeContext,
  meta: DeclarativeAdapterMeta,
): Promise<CloudStreamLinkResult> {
  try {
    const base = await resolveSpecBase(spec, ctx);
    const searchUrl = searchUrlFromTemplate(spec.search.urlTemplate, base, req.title);
    const document = await fetchSearchDocument(spec, searchUrl, ctx);
    const candidates = extractCandidates(spec, document, ctx);
    if (candidates.length === 0) {
      return { links: [], failure: { category: 'NO_MATCH', message: `No matching title was found on ${meta.displayName}.` } };
    }
    const ranked = rankCandidates(
      { title: req.title, ...(req.year !== undefined ? { year: req.year } : {}) },
      candidates,
      Math.min(spec.limits.maxCandidates, HARD_MAX_CANDIDATES),
    );
    if (ranked.length === 0) {
      return { links: [], failure: { category: 'NO_MATCH', message: `No matching title was found on ${meta.displayName}.` } };
    }
    const best = ranked[0]!;
    const detailUrl = joinUrl(base, best.href);
    const detail = await ctx.fetchHtml(detailUrl, Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : undefined);

    const maxLinks = Math.min(spec.limits.maxLinks, HARD_MAX_LINKS);
    const rawLinks = extractRawLinks(
      spec.movie.links.container,
      spec.movie.links.hrefAttr,
      spec.movie.links.includes,
      detail.html,
      ctx,
      maxLinks,
    );
    if (rawLinks.length === 0) {
      return {
        links: [],
        matchedTitle: best.title,
        failure: { category: 'NO_LINKS', message: `The ${meta.displayName} page contained no download links.` },
      };
    }

    const links: CloudStreamNormalizedLink[] = [];
    for (const raw of rawLinks.slice(0, maxLinks)) {
      const resolved = await resolveRawLink(spec.movie.resolution, raw, base, spec, ctx, meta);
      links.push(...resolved);
    }
    if (links.length === 0) {
      return {
        links: [],
        matchedTitle: best.title,
        failure: { category: 'EXTRACTOR_FAILED', message: `${meta.displayName} sources were found but no resolver could resolve them.` },
      };
    }
    return { links, matchedTitle: best.title };
  } catch (error) {
    return { links: [], failure: classifyNetworkFailure(error) };
  }
}

// ---------------------------------------------------------------------------
// Episode resolution (season/episode walk on a series page)
// ---------------------------------------------------------------------------

/** Instantiates a bounded {season}/{episode} pattern from the spec. */
function episodeRegex(pattern: string, season: number, episode: number): RegExp | null {
  try {
    const instantiated = pattern
      .replace(/\{season\}/g, String(season))
      .replace(/\{episode\}/g, String(episode));
    return new RegExp(instantiated, 'i');
  } catch {
    return null;
  }
}

/**
 * Resolves an episode request through the declarative spec:
 *   base → search fetch → candidates (season-biased) → best page →
 *   season-section walk → episode links → per-link resolution.
 *
 * The walk mirrors the site structure the DSL describes: elements matching
 * `container` whose text matches seasonPattern scope a sibling region in
 * which elements matching episodePattern expose the episode anchors.
 */
export async function resolveEpisodeWithSpec(
  spec: DeclarativeAdapterSpec,
  req: CloudStreamEpisodeRequest,
  ctx: CloudStreamRuntimeContext,
  meta: DeclarativeAdapterMeta,
): Promise<CloudStreamLinkResult> {
  const episodeSpec = spec.episode;
  if (episodeSpec === undefined) {
    return { links: [], failure: { category: 'UNSUPPORTED', message: 'This adapter does not support episode resolution.' } };
  }
  try {
    const base = await resolveSpecBase(spec, ctx);
    const searchUrl = searchUrlFromTemplate(spec.search.urlTemplate, base, req.title);
    const document = await fetchSearchDocument(spec, searchUrl, ctx);
    const candidates = extractCandidates(spec, document, ctx);
    if (candidates.length === 0) {
      return { links: [], failure: { category: 'NO_MATCH', message: `No matching title was found on ${meta.displayName}.` } };
    }

    // Season-biased ranking: prefer candidates whose title mentions the
    // season (the real providers' season page structure).
    const ranked = rankCandidates(
      { title: req.title, year: req.year },
      candidates,
      Math.min(spec.limits.maxCandidates, HARD_MAX_CANDIDATES),
    );
    if (ranked.length === 0) {
      return { links: [], failure: { category: 'NO_MATCH', message: `No matching title was found on ${meta.displayName}.` } };
    }

    const seasonRe = episodeRegex(episodeSpec.seasonPattern, req.season, req.episode);
    const episodeRe = episodeRegex(episodeSpec.episodePattern, req.season, req.episode);
    if (seasonRe === null || episodeRe === null) {
      return { links: [], failure: { category: 'UNSUPPORTED', message: 'This adapter could not build its season/episode matcher.' } };
    }
    // Generic season-header detector: the spec's season pattern with the
    // season digits generalized — identifies ANY season header on the page
    // so anchors are only collected from the REQUESTED season's region.
    const genericSeasonRe = episodeRegex(
      episodeSpec.seasonPattern.replace(/\{season\}/g, '\\d{1,2}').replace(/\{episode\}/g, '\\d{1,2}'),
      req.season,
      req.episode,
    );

    // Walk candidate pages until episode links appear (bounded pages).
    const maxLinks = Math.min(spec.limits.maxLinks, HARD_MAX_LINKS);
    const headers = Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : undefined;
    const links: CloudStreamNormalizedLink[] = [];
    let matchedTitle: string | undefined;

    for (const candidate of ranked.slice(0, HARD_MAX_DETAIL_PAGES)) {
      const detailUrl = joinUrl(base, candidate.href);
      const detail = await ctx.fetchHtml(detailUrl, headers);
      const $ = ctx.parseHtml(detail.html);

      const episodeAnchors: Array<{ href: string; label: string }> = [];
      // Season scoping: when the page carries ANY season header (generic
      // pattern), anchor collection is only active inside the region opened
      // by the header matching the REQUESTED season; pages without season
      // headers are treated as single-season (whole page active).
      let hasSeasonHeaders = false;
      let inSeasonRegion = true;
      $(episodeSpec.container).each((_, el) => {
        if (episodeAnchors.length >= maxLinks) return;
        const text = $(el).text() ?? '';
        if (genericSeasonRe !== null && genericSeasonRe.test(text)) {
          hasSeasonHeaders = true;
          inSeasonRegion = seasonRe.test(text);
          return; // season headers carry no episode anchors themselves
        }
        if (hasSeasonHeaders && !inSeasonRegion) return;
        if (!episodeRe.test(text)) return;
        // Walk the FOLLOWING siblings (same DOM region) for anchors.
        let sibling = $(el).next();
        let steps = 0;
        while (sibling.length > 0 && steps < 24) {
          sibling.find('a').each((__, anchor) => {
            if (episodeAnchors.length >= maxLinks) return;
            const href = ($(anchor).attr(episodeSpec.linkAttr) ?? '').trim();
            if (!href || href.length > HARD_MAX_LINK_URL) return;
            const text = $(anchor).text().trim().slice(0, 120);
            // Episode links only: skip zip/season-level entries.
            if (/zip/i.test(text) || href.toLowerCase().endsWith('.zip')) return;
            episodeAnchors.push({ href, label: text });
          });
          sibling = sibling.next();
          steps += 1;
        }
      });

      if (episodeAnchors.length === 0) continue;
      matchedTitle = candidate.title;

      for (const anchor of episodeAnchors.slice(0, maxLinks)) {
        // Filter by the spec's episode includes when present.
        if (episodeSpec.links.includes.length > 0) {
          const haystack = anchor.href.toLowerCase();
          const matched = episodeSpec.links.includes.some((include) => haystack.includes(include.toLowerCase()));
          if (!matched) continue;
        }
        const resolved = await resolveRawLink(episodeSpec.resolution, anchor, base, spec, ctx, meta);
        links.push(...resolved);
      }
      if (links.length > 0) break;
    }

    if (links.length === 0) {
      return {
        links: [],
        ...(matchedTitle !== undefined ? { matchedTitle } : {}),
        failure: { category: 'NO_LINKS', message: `No episode links were found for this ${meta.displayName} title.` },
      };
    }
    return { links, ...(matchedTitle !== undefined ? { matchedTitle } : {}) };
  } catch (error) {
    return { links: [], failure: classifyNetworkFailure(error) };
  }
}
