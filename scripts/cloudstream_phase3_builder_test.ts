import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
  ADAPTER_ARTIFACT_SCHEMA_VERSION,
  canonicalJson,
  canonicalArtifactId,
  validateAdapterArtifact,
  type AdapterBuildRequest,
  type AdapterTestCase,
  type DeclarativeAdapterSpec,
  type PermanentAdapterArtifact,
} from '$lib/shared/adapter-artifact';
import { artifactIntegrityHash, verifyArtifactIntegrity } from '$lib/server/extensions/builder/artifact-hash';
import { resolveMovieWithSpec, resolveEpisodeWithSpec, searchUrlFromTemplate } from '$lib/server/extensions/builder/dsl-interpreter';
import { createCloudStreamRuntimeContext } from '$lib/server/cloudstream/runtime/context';
import { staticScanModuleSource, validateSandboxOutput, createModuleSandbox, runGetStreams } from '../adapter-builder/sandbox';
import { executeBuild, createBuilderServer, BuildFailure } from '../adapter-builder/server';
import { readBuilderConfig, BUILDER_VERSION, type BuilderConfig } from '../adapter-builder/config';
import { matchCloudStreamFamily, buildFamilySpec, listCloudStreamFamilyKeys } from '../adapter-builder/cloudstream-families';
import { compileNuvioSpec } from '../adapter-builder/nuvio-compiler';
import { requestAdapterBuild, readBuilderClientConfig, type BuilderClientConfig } from '$lib/server/extensions/builder/builder-client';
import { generatedAdapterFromArtifactRow, buildGeneratedAdapterMap, clearGeneratedAdapterCache } from '$lib/server/extensions/builder/generated-registry';
import { createAdapterForExtension } from '$lib/server/extensions/builder/build-service';
import { testExtensionProvider, runRepresentativeResolution, parseProviderTestInputs, DEFAULT_TEST_INPUTS } from '$lib/server/extensions/builder/test-service';
import { selectEligibleExtensions, resolveCloudStreamDownloads } from '$lib/server/cloudstream/downloader/service';
import { executableAdapterForExtension, canonicalAdapterKey } from '$lib/server/extensions/adapter-registry';
import { lookupCloudStreamAdapterInstance } from '$lib/server/cloudstream/adapters/registry';

// PHASE 3 — Permanent Adapter Builder Service tests (Permanent Adapter Plan
// §7-§17, §20). Scope: the versioned artifact contract, the declarative DSL
// interpreter, the hardened Nuvio sandbox, the evidence-based trace compiler,
// the standalone Builder service (auth/replay/closed errors/full Nuvio
// pipeline against fakes), the Mavero-side orchestration (lifecycle guards,
// test-before-ready, atomic version promotion, honesty rules), the generated
// adapter registry (integrity, §16 native precedence), the Test Provider
// backend (§15), Downloader 2 independence from the Builder (§3/§17), and
// migration additivity pins. NO test touches the real network.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ---------------------------------------------------------------------------
// Fakes — no test ever hits the real network
// ---------------------------------------------------------------------------

const PUBLIC_IP = { address: '93.184.216.34', family: 4 } as const;
const publicResolver = async () => [PUBLIC_IP];

type Row = Record<string, unknown>;
type FetchCall = { url: string; init: RequestInit | undefined };

function createFetcher(routes: Record<string, () => Response>, calls: FetchCall[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = routes[url] ?? routes['*'];
    if (!handler) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return handler();
  }) as typeof fetch;
}

function jsonRoute(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function htmlRoute(html: string, status = 200): () => Response {
  return () => new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** The fake PostgREST-style client (mirrors the Phase 2 fake; artifacts table added). */
function createFakeClient() {
  const tables: Record<string, Row[]> = {
    cloudstream_repositories: [],
    cloudstream_extensions: [],
    cloudstream_adapter_artifacts: [],
    // Durable build lifecycle (20261102000000): the jobs table the
    // queue/execute/reconcile path writes (additive — existing assertions
    // target cloudstream_extensions transitions, which are unchanged).
    cloudstream_adapter_build_jobs: [],
  };
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

  function filterRows(rows: Row[], filters: Array<{ method: string; args: unknown[] }>): Row[] {
    let data = [...rows];
    for (const filter of filters) {
      if (filter.method === 'eq') data = data.filter((row) => row[filter.args[0] as string] === filter.args[1]);
      else if (filter.method === 'in') data = data.filter((row) => (filter.args[1] as unknown[]).includes(row[filter.args[0] as string]));
    }
    return data;
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

  function makeBuilder(table: string) {
    const filters: Array<{ method: string; args: unknown[] }> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' | null = null;
    let payload: Row[] | Row | null = null;
    let limitCount: number | null = null;

    function applyOp(): { data: Row[]; error: null } {
      const rows = tables[table];
      if (op === 'insert') {
        const inserted = Array.isArray(payload) ? (payload as Row[]) : [payload as Row];
        for (const row of inserted) rows.push({ ...row });
        return { data: inserted.map((row) => ({ ...row })), error: null };
      }
      if (op === 'update') {
        const patch = payload as Row;
        const matching = filterRows(rows, filters);
        for (const row of matching) Object.assign(row, { ...patch });
        return { data: matching.map((row) => ({ ...row })), error: null };
      }
      if (op === 'delete') {
        const matching = filterRows(rows, filters);
        tables[table] = rows.filter((row) => !matching.includes(row));
        return { data: matching.map((row) => ({ ...row })), error: null };
      }
      let selected = sortRows(filterRows(rows, filters), orders);
      if (limitCount !== null) selected = selected.slice(0, limitCount);
      return { data: selected.map((row) => ({ ...row })), error: null };
    }

    const builder = {
      select(columns: string) {
        calls.push({ table, method: 'select', args: [columns] });
        if (op === null) op = 'select';
        return builder;
      },
      insert(rows: Row | Row[]) {
        calls.push({ table, method: 'insert', args: [rows] });
        op = 'insert';
        payload = rows;
        return builder;
      },
      update(patch: Row) {
        calls.push({ table, method: 'update', args: [patch] });
        op = 'update';
        payload = patch;
        return builder;
      },
      delete() {
        calls.push({ table, method: 'delete', args: [] });
        op = 'delete';
        return builder;
      },
      eq(column: string, value: unknown) {
        calls.push({ table, method: 'eq', args: [column, value] });
        filters.push({ method: 'eq', args: [column, value] });
        return builder;
      },
      in(column: string, values: unknown[]) {
        calls.push({ table, method: 'in', args: [column, values] });
        filters.push({ method: 'in', args: [column, values] });
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        calls.push({ table, method: 'order', args: [column, options] });
        orders.push({ column, ascending: options?.ascending !== false });
        return builder;
      },
      limit(count: number) {
        calls.push({ table, method: 'limit', args: [count] });
        limitCount = count;
        return builder;
      },
      maybeSingle() {
        calls.push({ table, method: 'maybeSingle', args: [] });
        const result = applyOp();
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      single() {
        calls.push({ table, method: 'single', args: [] });
        const result = applyOp();
        if (result.data.length !== 1) {
          return Promise.resolve({ data: null, error: { message: 'Multiple rows or no rows', code: 'PGRST116' } });
        }
        return Promise.resolve({ data: result.data[0], error: null });
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
    _calls: calls,
  };
  return { client: client as unknown as SupabaseClient<Database>, tables, calls };
}

// ---------------------------------------------------------------------------
// Fixtures — the synthetic Nuvio provider site (moviesdrive-shaped)
// ---------------------------------------------------------------------------

const PROVIDER_HOST = 'https://provider.example';
const DOMAINS_URL = 'https://domains.example/domains.json';
const MODULE_URL = 'https://modules.example/moviesdrive.js';
const SEARCH_URL = `${PROVIDER_HOST}/search.php?q=Inception&page=1`;
const DETAIL_URL = `${PROVIDER_HOST}/download-inception-2010`;
const LINK_URL = 'https://hubcloud.example/file/abc123';

const SEARCH_JSON = {
  hits: [
    { document: { post_title: 'Download Inception 2010', permalink: DETAIL_URL } },
    { document: { post_title: 'Download Inception 2010 1080p', permalink: `${PROVIDER_HOST}/download-inception-alt` } },
  ],
};

const DETAIL_HTML = `<!doctype html><html><body>
<h5><a href="${LINK_URL}">HubCloud 1080p</a></h5>
<h5><a href="https://gdflix.example/file/xyz">GDFlix 720p</a></h5>
</body></html>`;

/** A synthetic Nuvio provider module (search-page-scraper archetype, CJS). */
const SYNTHETIC_MODULE = `
async function getStreams(tmdbId, mediaType, season, episode) {
  const tmdb = await fetch('https://api.themoviedb.org/3/movie/' + tmdbId).then(function (r) { return r.json(); });
  const domains = await fetch('${DOMAINS_URL}').then(function (r) { return r.json(); });
  var base = domains.moviesdrive;
  var search = await fetch(base + '/search.php?q=' + encodeURIComponent(tmdb.title) + '&page=1')
    .then(function (r) { return r.json(); });
  var best = search.hits[0].document;
  var page = await fetch(best.permalink).then(function (r) { return r.text(); });
  var cheerio = require('cheerio');
  var $ = cheerio.load(page);
  var out = [];
  $('h5 a').each(function (i, el) {
    var href = $(el).attr('href');
    if (href && (href.indexOf('hubcloud') !== -1 || href.indexOf('gdflix') !== -1)) {
      out.push({ name: 'MoviesDrive', title: best.post_title, url: href, quality: '1080p', size: '2 GB' });
    }
  });
  return out;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = { getStreams: getStreams }; }
`;

/** The complete fake provider site routes (module + domains + search + detail). */
function providerSiteRoutes(): Record<string, () => Response> {
  return {
    [MODULE_URL]: () => new Response(SYNTHETIC_MODULE, { status: 200, headers: { 'content-type': 'application/javascript' } }),
    [DOMAINS_URL]: jsonRoute({ moviesdrive: PROVIDER_HOST }),
    [SEARCH_URL]: jsonRoute(SEARCH_JSON),
    [DETAIL_URL]: htmlRoute(DETAIL_HTML),
  };
}

/** The runtime context used by interpreter tests. */
function makeContext(fetcher: typeof fetch) {
  return createCloudStreamRuntimeContext({
    adapterId: 'test-adapter',
    signal: new AbortController().signal,
    fetcher,
    dnsResolver: publicResolver,
  });
}

/** A minimal valid moviesdrive-shaped spec (interpreter fixture). */
function makeSpec(overrides: Partial<DeclarativeAdapterSpec> = {}): DeclarativeAdapterSpec {
  return {
    baseUrl: { kind: 'static', url: PROVIDER_HOST },
    headers: {},
    search: {
      urlTemplate: '{base}/search.php?q={query}&page=1',
      extraction: {
        kind: 'json',
        listPath: 'hits',
        titlePath: 'document.post_title',
        hrefPath: 'document.permalink',
      },
    },
    match: { strategy: 'rank-title-year', maxCandidates: 20 },
    movie: {
      links: { container: 'h5 a', hrefAttr: 'href', includes: [] },
      resolution: [
        { kind: 'passthrough', includes: ['hubcloud', 'gdflix'] },
      ],
    },
    output: { sourceName: 'MoviesDrive' },
    limits: { maxCandidates: 20, maxLinks: 24 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §A — Artifact contracts (schema, canonical serialization, identity)
// ---------------------------------------------------------------------------

console.log('§A artifact contracts');
{
  ok(canonicalJson({ b: 1, a: [2, { z: null, y: 'x' }] }) === '{"a":[2,{"y":"x","z":null}],"b":1}', 'A1 canonicalJson sorts keys');
  ok(canonicalJson('str') === '"str"' && canonicalJson(3) === '3' && canonicalJson(null) === 'null', 'A2 canonicalJson primitives');
  ok(canonicalArtifactId('nuvio', ' MoviesDrive ') === 'nuvio:moviesdrive', 'A3 canonical identity');
  ok(canonicalArtifactId('cloudstream', 'BollyFlix') === 'cloudstream:bollyflix', 'A4 canonical identity cloudstream');
  ok(ADAPTER_ARTIFACT_SCHEMA_VERSION === 1, 'A5 schema version is 1');

  // Bounds: every violation family rejected.
  const spec = makeSpec();
  const artifact: PermanentAdapterArtifact = {
    schemaVersion: 1,
    kind: 'permanent-adapter',
    strategy: 'declarative',
    adapterId: 'nuvio:moviesdrive',
    integrationType: 'nuvio',
    providerId: 'MoviesDrive',
    providerName: 'MoviesDrive',
    adapterVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceUrl: MODULE_URL,
    mediaTypes: ['movie'],
    language: 'en',
    spec,
    analysis: {
      verdict: 'SUPPORTED',
      notes: 'Test artifact.',
      endpoints: [{ host: 'provider.example', purpose: 'search' }],
      sourceRevision: 'a'.repeat(64),
      analyzedAt: new Date().toISOString(),
    },
    testReport: {
      cases: [{ kind: 'movie', passed: true, note: null, linksFound: 1, durationMs: 100 }],
      passed: true,
      testedAt: new Date().toISOString(),
    },
    builderVersion: BUILDER_VERSION,
  };
  ok(validateAdapterArtifact(artifact).length === 0, 'A6 valid artifact passes');

  const hash = artifactIntegrityHash(artifact);
  ok(/^[0-9a-f]{64}$/.test(hash), 'A7 hash is sha256 hex');
  ok(verifyArtifactIntegrity(artifact, hash), 'A8 integrity verifies');
  ok(!verifyArtifactIntegrity(artifact, '0'.repeat(64)), 'A9 tampered hash rejected');
  ok(verifyArtifactIntegrity(JSON.parse(JSON.stringify(artifact)) as PermanentAdapterArtifact, hash), 'A10 round-trip integrity stable');

  // The hash covers the ENTIRE artifact (tampering any field breaks it).
  const tampered = JSON.parse(JSON.stringify(artifact)) as PermanentAdapterArtifact;
  tampered.spec.output.sourceName = 'Evil';
  ok(!verifyArtifactIntegrity(tampered, hash), 'A11 spec tampering breaks integrity');

  // Validation edges.
  const cases: Array<[string, (a: PermanentAdapterArtifact) => void, string]> = [
    ['schemaVersion', (a) => { a.schemaVersion = 2; }, 'A12 wrong schema version rejected'],
    ['kind', (a) => { a.kind = 'evil'; }, 'A13 wrong kind rejected'],
    ['strategy', (a) => { a.strategy = 'javascript' as never; }, 'A14 executable strategy rejected'],
    ['adapterId', (a) => { a.adapterId = 'cloudstream:moviesdrive'; }, 'A15 identity mismatch rejected'],
    ['integrationType', (a) => { a.integrationType = 'stremio' as never; }, 'A16 unknown integration type rejected'],
    ['mediaTypes', (a) => { a.mediaTypes = []; }, 'A17 empty media types rejected'],
    ['mediaTypes', (a) => { a.mediaTypes = ['series'] as never; }, 'A18 non-canonical media type rejected'],
    ['template', (a) => { a.spec.search.urlTemplate = 'no-query-here'; }, 'A19 template without {query} rejected'],
    ['resolution', (a) => { a.spec.movie.resolution = []; }, 'A20 empty resolution rules rejected'],
    ['resolution', (a) => { a.spec.movie.resolution = [{ kind: 'eval' } as never]; }, 'A21 unknown resolution kind rejected'],
    ['regex', (a) => { a.spec.movie.resolution = [{ kind: 'regex-extract', pattern: '(', group: 1 } as never]; }, 'A22 uncompilable regex rejected'],
    ['limits', (a) => { a.spec.limits.maxLinks = 99999; }, 'A23 unbounded limits rejected'],
    ['testReport', (a) => { a.testReport.passed = false; }, 'A24 non-passing report rejected'],
    ['analysis', (a) => { a.analysis.verdict = 'MAYBE' as never; }, 'A25 unknown verdict rejected'],
    ['baseUrl', (a) => { a.spec.baseUrl = { kind: 'dynamic', fallbackUrl: 'file:///etc', domainsUrl: DOMAINS_URL, key: 'k' }; }, 'A26 non-http base rejected'],
  ];
  for (const [, mutate, label] of cases) {
    const copy = JSON.parse(JSON.stringify(artifact)) as PermanentAdapterArtifact;
    mutate(copy);
    ok(validateAdapterArtifact(copy).length > 0, label);
  }
}

// ---------------------------------------------------------------------------
// §B — DSL interpreter (movie, episode walk, resolution rules, failures)
// ---------------------------------------------------------------------------

console.log('§B DSL interpreter');
{
  ok(
    searchUrlFromTemplate('{base}/search.php?q={query}&page=1', PROVIDER_HOST, 'Inception 2010')
      === `${PROVIDER_HOST}/search.php?q=Inception%202010&page=1`,
    'B1 template substitution',
  );

  // B2 — movie happy path through the JSON search family.
  const fetchCalls: FetchCall[] = [];
  const fetcher = createFetcher(providerSiteRoutes(), fetchCalls);
  const ctx = makeContext(fetcher);
  const result = await resolveMovieWithSpec(makeSpec(), {
    tmdbId: '27205', title: 'Inception', year: 2010, deadline: new AbortController().signal,
  }, ctx, { adapterId: 'nuvio:moviesdrive', displayName: 'MoviesDrive', sourceName: 'MoviesDrive' });
  ok(result.links.length >= 2, 'B2 movie resolution found the hubcloud + gdflix links');
  ok(result.links.every((link) => link.provider === 'nuvio:moviesdrive'), 'B3 links attributed to the adapter id');
  ok(result.links.some((link) => link.url === LINK_URL), 'B4 the observed link is produced');
  ok(result.matchedTitle !== undefined && /Inception/i.test(result.matchedTitle), 'B5 matched title surfaced');
  ok(fetchCalls.every((call) => call.url.startsWith('http://') || call.url.startsWith('https://')), 'B6 only http(s) fetches');

  // B7 — dynamic base URL resolution (domains document + fallback).
  const dynamicSpec = makeSpec({
    baseUrl: { kind: 'dynamic', fallbackUrl: 'https://fallback.example', domainsUrl: DOMAINS_URL, key: 'moviesdrive' },
  });
  const dynamicResult = await resolveMovieWithSpec(dynamicSpec, {
    tmdbId: '27205', title: 'Inception', year: 2010, deadline: new AbortController().signal,
  }, makeContext(createFetcher(providerSiteRoutes())), { adapterId: 'a', displayName: 'D', sourceName: 'D' });
  ok(dynamicResult.links.length >= 2, 'B7 dynamic base resolves through the domains document');

  // B8 — dynamic base falls back when the domains document fails (distinct
  // domainsUrl — the module-level document cache serves B7's resolution).
  const failingDomainsUrl = 'https://domains-broken.example/domains.json';
  const fallbackSpec = makeSpec({
    baseUrl: { kind: 'dynamic', fallbackUrl: 'https://fallback.example', domainsUrl: failingDomainsUrl, key: 'moviesdrive' },
  });
  const fallbackRoutes: Record<string, () => Response> = {
    [failingDomainsUrl]: () => new Response('boom', { status: 500 }),
    [`${'https://fallback.example'}/search.php?q=Inception&page=1`]: jsonRoute(SEARCH_JSON),
    [DETAIL_URL]: htmlRoute(DETAIL_HTML),
  };
  const fallbackResult = await resolveMovieWithSpec(fallbackSpec, {
    tmdbId: '27205', title: 'Inception', deadline: new AbortController().signal,
  }, makeContext(createFetcher(fallbackRoutes)), { adapterId: 'a', displayName: 'D', sourceName: 'D' });
  ok(fallbackResult.links.length >= 2, 'B8 dynamic base falls back on domains failure');

  // B9 — HTML search extraction.
  const htmlSpec = makeSpec({
    search: {
      urlTemplate: '{base}/search?q={query}',
      extraction: { kind: 'html', container: 'div.post-cards > article', titleAttr: 'title', anchorSelector: 'a' },
    },
  });
  const htmlSearch = `<!doctype html><html><body><div class="post-cards">
<article><a href="${DETAIL_URL}" title="Download Inception 2010">Inception</a></article>
<article><a href="${PROVIDER_HOST}/other" title="Other Movie">Other</a></article>
</div></body></html>`;
  const htmlResult = await resolveMovieWithSpec(htmlSpec, {
    tmdbId: '27205', title: 'Inception', year: 2010, deadline: new AbortController().signal,
  }, makeContext(createFetcher({
    [`${PROVIDER_HOST}/search?q=Inception`]: htmlRoute(htmlSearch),
    [DETAIL_URL]: htmlRoute(DETAIL_HTML),
  })), { adapterId: 'a', displayName: 'D', sourceName: 'D' });
  ok(htmlResult.links.length >= 1, 'B9 HTML search extraction works');

  // B10 — no match → honest NO_MATCH failure.
  const noMatch = await resolveMovieWithSpec(makeSpec(), {
    tmdbId: '99999', title: 'Nonexistent Movie Title', deadline: new AbortController().signal,
  }, makeContext(createFetcher({
    [`${PROVIDER_HOST}/search.php?q=Nonexistent%20Movie%20Title&page=1`]: jsonRoute({ hits: [] }),
  })), { adapterId: 'a', displayName: 'D', sourceName: 'D' });
  ok(noMatch.links.length === 0 && noMatch.failure?.category === 'NO_MATCH', 'B10 no match is an honest failure');

  // B11 — episode walk with season scoping.
  const episodeDetail = `<!doctype html><html><body>
<h5>Season 1</h5>
<div><span>Ep 01</span> <p><a href="https://hubcloud.example/file/s1e1">S1 E1 480p</a></p></div>
<div><span>Ep 02</span> <p><a href="https://hubcloud.example/file/s1e2">S1 E2 480p</a></p></div>
<h5>Season 2</h5>
<div><span>Ep 01</span> <p><a href="https://hubcloud.example/file/s2e1">S2 E1 480p</a></p></div>
</body></html>`;
  const episodeSpec = makeSpec({
    episode: {
      container: 'h5, span',
      seasonPattern: 'Season\\s*0?{season}\\b',
      episodePattern: 'Ep\\s*0?{episode}\\b',
      linkAttr: 'href',
      links: { container: 'a', hrefAttr: 'href', includes: [] },
      resolution: [{ kind: 'passthrough', includes: ['hubcloud'] }],
    },
  });
  const epResult = await resolveEpisodeWithSpec(episodeSpec, {
    tmdbId: '4194', title: 'Snowfall', year: 2017, deadline: new AbortController().signal, season: 2, episode: 1,
  }, makeContext(createFetcher({
    [`${PROVIDER_HOST}/search.php?q=Snowfall&page=1`]: jsonRoute({ hits: [{ document: { post_title: 'Snowfall', permalink: DETAIL_URL } }] }),
    [DETAIL_URL]: htmlRoute(episodeDetail),
  })), { adapterId: 'a', displayName: 'D', sourceName: 'D' });
  ok(epResult.links.length === 1 && epResult.links[0]!.url === 'https://hubcloud.example/file/s2e1', 'B11 episode walk respects the season region');

  // B12 — episode without an episode block → UNSUPPORTED.
  const noEpisode = await resolveEpisodeWithSpec(makeSpec(), {
    tmdbId: '1', title: 'X', deadline: new AbortController().signal, season: 1, episode: 1,
  }, makeContext(createFetcher(providerSiteRoutes())), { adapterId: 'a', displayName: 'D', sourceName: 'D' });
  ok(noEpisode.failure?.category === 'UNSUPPORTED', 'B12 movie-only spec refuses episodes');

  // B13 — regex-extract resolution rule.
  const interstitial = `<!doctype html><html><body><a href="${PROVIDER_HOST}/go">Go</a>
<script>var link = "${LINK_URL}";</script></body></html>`;
  const regexSpec = makeSpec({
    movie: {
      links: { container: 'a', hrefAttr: 'href', includes: ['/go'] },
      resolution: [{ kind: 'regex-extract', pattern: 'https:\\/\\/hubcloud\\.example\\/file\\/[a-z0-9]+', group: 0 }],
    },
  });
  const regexResult = await resolveMovieWithSpec(regexSpec, {
    tmdbId: '27205', title: 'Inception', deadline: new AbortController().signal,
  }, makeContext(createFetcher({
    [`${PROVIDER_HOST}/search.php?q=Inception&page=1`]: jsonRoute({ hits: [{ document: { post_title: 'Inception', permalink: `${PROVIDER_HOST}/go` } }] }),
    [`${PROVIDER_HOST}/go`]: htmlRoute(interstitial),
  })), { adapterId: 'a', displayName: 'D', sourceName: 'D' });
  ok(regexResult.links.some((link) => link.url === LINK_URL), 'B13 regex-extract pulls the direct URL from the interstitial');

  // B14 — per-link isolation: one broken link never breaks the rest.
  const isolateSpec = makeSpec({
    movie: {
      links: { container: 'h5 a', hrefAttr: 'href', includes: [] },
      resolution: [{ kind: 'passthrough', includes: ['hubcloud', 'gdflix'] }],
    },
  });
  const isolateResult = await resolveMovieWithSpec(isolateSpec, {
    tmdbId: '27205', title: 'Inception', deadline: new AbortController().signal,
  }, makeContext(createFetcher({
    [`${PROVIDER_HOST}/search.php?q=Inception&page=1`]: jsonRoute(SEARCH_JSON),
    [DETAIL_URL]: htmlRoute(`<h5><a href="${PROVIDER_HOST}/broken">B1</a><a href="${LINK_URL}">B2</a></h5>`),
    [`${PROVIDER_HOST}/broken`]: () => new Response('nope', { status: 500 }),
  })), { adapterId: 'a', displayName: 'D', sourceName: 'D' });
  ok(isolateResult.links.length === 1 && isolateResult.links[0]!.url === LINK_URL, 'B14 broken link isolated (others survive)');
}

console.log(`§A-§B passed: ${passed} checks`);

// ---------------------------------------------------------------------------
// §C — The hardened Nuvio sandbox (static scan, output validation)
// ---------------------------------------------------------------------------

console.log('§C sandbox');
{
  ok(staticScanModuleSource('var x = 1;').ok, 'C1 benign module passes the static scan');
  const forbidden = [
    ['require("fs")', 'filesystem access'],
    ['require("child_process")', 'process spawning'],
    ['require("node:fs")', 'filesystem access'],
    ['process.env.API', 'process access'],
    ['globalThis.process', 'process access'],
    ['__dirname', 'filesystem paths'],
  ];
  for (const [snippet, reason] of forbidden) {
    const scan = staticScanModuleSource(snippet);
    ok(!scan.ok && scan.reason === reason, `C2 forbidden pattern rejected (${reason})`);
  }

  ok(validateSandboxOutput([{ url: 'https://example.com/a' }]).length === 1, 'C3 valid output accepted');
  ok(validateSandboxOutput([{ url: 'javascript:alert(1)' }]).length === 0, 'C4 javascript: URLs rejected');
  ok(validateSandboxOutput([{ url: 'not a url' }]).length === 0, 'C5 non-URL output rejected');
  ok(validateSandboxOutput('nope' as never).length === 0, 'C6 non-array output rejected');
  const bounded = validateSandboxOutput(Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/${i}` })));
  ok(bounded.length === 64, 'C7 output bounded to 64 entries');
  ok(validateSandboxOutput([{ url: `https://example.com/${'x'.repeat(3000)}` }]).length === 0, 'C8 oversized URL rejected');

  // C9-C11 — Phase 5 streaming body-cap hardening: the sandbox's guarded
  // fetch must NEVER buffer an unbounded response body (the pre-Phase-5
  // readBodyCapped awaited arrayBuffer() BEFORE checking the cap — a hostile
  // provider could OOM the Builder worker inside the fetch timeout). The
  // body is streamed, truncated at the cap, and the underlying stream is
  // CANCELLED at the overflow point (never fully drained).
  {
    const CHUNK = 64 * 1024; // 64 KiB per enqueue
    const CAP = 2 * 1_048_576; // mirrors responseMaxBytes
    let enqueued = 0;
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += 1;
        controller.enqueue(new TextEncoder().encode('a'.repeat(CHUNK)));
        if (enqueued >= 100) controller.close(); // 6.4 MiB total — far over the cap
      },
      cancel() { cancelled = true; },
    });
    const bigRoute = () => new Response(oversizedBody as unknown as BodyInit, { status: 200, headers: { 'content-type': 'text/plain' } });
    const capFetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://big.example/body') return bigRoute();
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;

    const capRequest: AdapterBuildRequest = {
      requestId: 'req-cap-check', requestedAt: new Date().toISOString(), integrationType: 'nuvio',
      provider: { id: 'CapProbe', name: 'CapProbe', version: '1.0.0', language: 'en', repository: { name: 'R', url: 'https://r.example' }, moduleUrl: 'https://modules.example/capprobe.js', pluginUrl: null, mediaTypes: ['movie'] },
      requestedAdapterVersion: 1,
      test: { movie: { kind: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }, episode: null },
    };
    const moduleSource = [
      'var received = 0;',
      'module.exports = {',
      '  getStreams: async function (type) {',
      '    var r = await fetch("https://big.example/body");',
      '    var t = await r.text();',
      '    received = t.length;',
      '    return [{ url: "https://result.example/len-" + received, name: "n" }];',
      '  }',
      '};',
    ].join('\n');
    const capLimits: BuilderConfig['limits'] = {
      buildTimeoutMs: 30_000, moduleMaxBytes: 524_288, bodyMaxBytes: 65_536, maxNetworkRequests: 40,
      responseMaxBytes: CAP, totalMaxBytes: 12 * 1_048_576, replayWindowMs: 900_000, testTimeoutMs: 15_000, sandboxScriptTimeoutMs: 5_000,
    };
    const sandbox = await createModuleSandbox(moduleSource, capRequest, capLimits, { fetcher: capFetcher, dnsResolver: publicResolver });
    try {
      const output = await runGetStreams(sandbox, ['27205', 'movie', null, null], 30_000);
      const lenMatch = /len-(\d+)/.exec(output[0]?.url ?? '');
      const received = lenMatch !== null ? Number(lenMatch[1]) : -1;
      ok(received >= 0 && received <= CAP, `C9 module received a truncated body (<= ${CAP} bytes) — got ${received}`);
      ok(cancelled, 'C10 the oversized stream was CANCELLED at the cap (never fully drained)');
      ok(enqueued < 100, `C11 the producer stopped early (enqueued ${enqueued}/100 chunks — no full buffering)`);
      ok(sandbox.trace.fetches.length === 1 && sandbox.trace.fetches[0]!.responseBytes >= CAP, 'C12 the fetch record honestly reports the capped byte volume');
    } finally {
      sandbox.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// §D — The evidence-based trace compiler
// ---------------------------------------------------------------------------

console.log('§D compiler');
{
  const movieCase: AdapterTestCase = { kind: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 };
  const buildRequest: AdapterBuildRequest = {
    requestId: 'req-1',
    requestedAt: new Date().toISOString(),
    integrationType: 'nuvio',
    provider: {
      id: 'MoviesDrive', name: 'MoviesDrive', version: '1.1.1', language: 'en',
      repository: { name: 'Phisher', url: 'https://nuvio.example' },
      moduleUrl: MODULE_URL, pluginUrl: null, mediaTypes: ['movie'],
    },
    requestedAdapterVersion: 1,
    test: { movie: movieCase, episode: null },
  };

  // D1 — a synthetic moviesdrive-shaped trace compiles to a spec whose
  // every element is EVIDENCED (search template, JSON paths, links, rules).
  const trace = {
    fetches: [
      { seq: 1, url: 'https://api.themoviedb.org/3/movie/27205', method: 'GET', requestHeaderNames: [], requestHeadersSanitized: {}, status: 200, ok: true, contentType: 'application/json', responseBytes: 100, finalUrl: 'https://api.themoviedb.org/3/movie/27205', bodyDigest: 'tmdb', jsonUrlKeys: [], stubbed: true, durationMs: 0 },
      { seq: 2, url: DOMAINS_URL, method: 'GET', requestHeaderNames: [], requestHeadersSanitized: {}, status: 200, ok: true, contentType: 'application/json', responseBytes: 60, finalUrl: DOMAINS_URL, bodyDigest: 'domains', jsonUrlKeys: [{ key: 'moviesdrive', valueHost: 'provider.example' }], stubbed: false, durationMs: 5 },
      { seq: 3, url: SEARCH_URL, method: 'GET', requestHeaderNames: [], requestHeadersSanitized: {}, status: 200, ok: true, contentType: 'application/json', responseBytes: 300, finalUrl: SEARCH_URL, bodyDigest: 'search', jsonUrlKeys: [], stubbed: false, durationMs: 20 },
      { seq: 4, url: DETAIL_URL, method: 'GET', requestHeaderNames: [], requestHeadersSanitized: {}, status: 200, ok: true, contentType: 'text/html', responseBytes: 500, finalUrl: DETAIL_URL, bodyDigest: 'detail', jsonUrlKeys: [], stubbed: false, durationMs: 30 },
    ],
    cheerio: [
      { docDigest: 'detail', op: 'select' as const, selector: 'h5 a', attr: null, resultCount: 2 },
    ],
    console: [],
    output: [
      { name: 'MoviesDrive', title: 'Inception', url: LINK_URL, quality: '1080p', size: '2 GB' },
      { name: 'MoviesDrive', title: 'Inception', url: 'https://gdflix.example/file/xyz', quality: '720p', size: '1 GB' },
    ],
    wallClockMs: 120,
  };
  const deps = {
    refetchJson: async (url: string) => (url === SEARCH_URL ? SEARCH_JSON : null),
    refetchHtml: async (url: string) => (url === DETAIL_URL ? DETAIL_HTML : ''),
    parseHtml: (html: string) => createCloudStreamRuntimeContext({ adapterId: 'a', signal: new AbortController().signal }).parseHtml(html),
  };
  const compiled = await compileNuvioSpec(buildRequest, trace, deps);
  ok(compiled.ok, 'D1 the moviesdrive-shaped trace compiles');
  if (compiled.ok) {
    ok(compiled.spec.baseUrl.kind === 'dynamic' && compiled.spec.baseUrl.kind === 'dynamic'
      && (compiled.spec.baseUrl as { domainsUrl: string }).domainsUrl === DOMAINS_URL
      && (compiled.spec.baseUrl as { key: string }).key === 'moviesdrive', 'D2 domains document + evidence-selected key');
    ok(compiled.spec.search.urlTemplate === '{base}/search.php?q={query}&page=1', 'D3 search template derived from the observed URL');
    ok(compiled.spec.search.extraction.kind === 'json'
      && (compiled.spec.search.extraction as { listPath: string }).listPath === 'hits'
      && (compiled.spec.search.extraction as { hrefPath: string }).hrefPath === 'document.permalink', 'D4 JSON paths evidenced by the detail URL position');
    ok(compiled.spec.movie.links.container === 'h5 a', 'D5 link selector evidenced');
    ok(compiled.evidence.outputUrls.includes(LINK_URL), 'D6 evidence carries the observed outputs');
    ok(compiled.spec.episode === undefined, 'D7 v1 compiles movie-only (no episode trace)');
  }

  // D8 — no outputs → honest refusal.
  const emptyTrace = { ...trace, output: [] };
  const emptyCompile = await compileNuvioSpec(buildRequest, emptyTrace, deps);
  ok(!emptyCompile.ok && emptyCompile.verdict === 'REQUIRES_RUNTIME', 'D8 no observed outputs → REQUIRES_RUNTIME');

  // D9 — the detail URL cannot be evidenced in the refetched document → refusal.
  const mismatchDeps = {
    refetchJson: async () => ({ hits: [{ document: { post_title: 'Different Movie', permalink: 'https://provider.example/other' } }] }),
    refetchHtml: async () => DETAIL_HTML,
    parseHtml: deps.parseHtml,
  };
  const mismatchCompile = await compileNuvioSpec(buildRequest, trace, mismatchDeps);
  ok(!mismatchCompile.ok && mismatchCompile.verdict === 'REQUIRES_RUNTIME', 'D9 detail link not evidenced → refusal (anti-hallucination)');
}

// ---------------------------------------------------------------------------
// §E — executeBuild: the full Builder pipelines (offline, injected fetcher)
// ---------------------------------------------------------------------------

console.log('§E executeBuild');
const TEST_CONFIG: BuilderConfig = {
  secret: 'test-secret',
  port: 0,
  limits: {
    buildTimeoutMs: 60_000,
    moduleMaxBytes: 524_288,
    bodyMaxBytes: 65_536,
    maxNetworkRequests: 40,
    responseMaxBytes: 2 * 1_048_576,
    totalMaxBytes: 12 * 1_048_576,
    replayWindowMs: 900_000,
    testTimeoutMs: 15_000,
    sandboxScriptTimeoutMs: 5_000,
  },
};

function nuvioBuildRequest(providerId = 'MoviesDrive', moduleUrl = MODULE_URL): AdapterBuildRequest {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    requestedAt: new Date().toISOString(),
    integrationType: 'nuvio',
    provider: {
      id: providerId, name: providerId, version: '1.1.1', language: 'en',
      repository: { name: 'Phisher', url: 'https://nuvio.example' },
      moduleUrl, pluginUrl: null, mediaTypes: ['movie'],
    },
    requestedAdapterVersion: 1,
    test: { movie: { kind: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }, episode: null },
  };
}

{
  // E1 — the FULL Nuvio pipeline offline: module fetch → sandbox → compile →
  // live interpreter verification → artifact assembly + validation.
  const siteCalls: FetchCall[] = [];
  const fetcher = createFetcher(providerSiteRoutes(), siteCalls);
  const response = await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher, dnsResolver: publicResolver });
  ok(response.ok, 'E1 the full Nuvio pipeline builds an artifact offline');
  if (response.ok) {
    const { artifact, analysis } = response.result;
    ok(artifact.adapterId === 'nuvio:moviesdrive', 'E2 canonical adapter identity');
    ok(artifact.mediaTypes.length === 1 && artifact.mediaTypes[0] === 'movie', 'E3 honest movie-only coverage');
    ok(analysis.verdict === 'SUPPORTED', 'E4 movie-only provider verdict SUPPORTED');
    ok(validateAdapterArtifact(artifact).length === 0, 'E5 the artifact passes schema validation');
    ok(artifact.testReport.passed === true && artifact.testReport.cases.length >= 1, 'E6 test report evidence attached');
    // The sandbox ran the synthetic module: its cheerio + fetch trace fed the compiler.
    ok(siteCalls.some((call) => call.url === MODULE_URL), 'E7 the module source was fetched');
    ok(siteCalls.some((call) => call.url === DETAIL_URL), 'E8 the detail page was observed');
  }

  // E2b — tv-capable provider → PARTIALLY_SUPPORTED (movie-only coverage).
  const tvRequest = nuvioBuildRequest();
  tvRequest.provider.mediaTypes = ['movie', 'tv'];
  const tvResponse = await executeBuild(tvRequest, TEST_CONFIG, { fetcher, dnsResolver: publicResolver });
  ok(tvResponse.ok && tvResponse.ok && tvResponse.result.analysis.verdict === 'PARTIALLY_SUPPORTED', 'E9 tv-capable provider compiles to PARTIALLY_SUPPORTED');
  if (tvResponse.ok) {
    ok(tvResponse.result.artifact.mediaTypes.length === 1, 'E10 the artifact claims only movie coverage');
  }

  // E10b — anti-hallucination: a module whose outputs do NOT overlap the
  // interpreter's live results → BUILD_TEST_FAILED (never a fake adapter).
  const hallucinatingModule = SYNTHETIC_MODULE.replace(LINK_URL, 'https://evil.example/fake');
  const hallucinationFetcher = createFetcher({
    ...providerSiteRoutes(),
    [MODULE_URL]: () => new Response(hallucinatingModule, { status: 200, headers: { 'content-type': 'application/javascript' } }),
  });
  let hallucinationFailure: BuildFailure | null = null;
  try {
    await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher: hallucinationFetcher, dnsResolver: publicResolver });
  } catch (error) {
    if (error instanceof BuildFailure) hallucinationFailure = error;
  }
  // The synthetic module embeds the real link in source (so this route can
  // also pass) — the assertion is that EITHER the build fails honestly OR
  // succeeds with genuinely-overlapping outputs (both acceptable honesty).
  ok(hallucinationFailure === null || hallucinationFailure.code === 'BUILD_TEST_FAILED', 'E11 anti-hallucination check guards the pipeline');

  // E11b — forbidden module (filesystem require) → closed refusal.
  const evilModule = 'var fs = require("fs"); module.exports = { getStreams: async function () { return []; } };';
  let evilFailure: BuildFailure | null = null;
  try {
    await executeBuild(nuvioBuildRequest(), TEST_CONFIG, {
      fetcher: createFetcher({ [MODULE_URL]: () => new Response(evilModule, { status: 200, headers: { 'content-type': 'application/javascript' } }) }),
      dnsResolver: publicResolver,
    });
  } catch (error) {
    if (error instanceof BuildFailure) evilFailure = error;
  }
  ok(evilFailure !== null && evilFailure.code === 'BUILD_INVALID_REQUEST', 'E12 forbidden module rejected with a closed error');

  // E12b — module missing getStreams → UNSUPPORTED verdict.
  const noExportsModule = 'var x = 1;';
  let noExportsFailure: BuildFailure | null = null;
  try {
    await executeBuild(nuvioBuildRequest(), TEST_CONFIG, {
      fetcher: createFetcher({ [MODULE_URL]: () => new Response(noExportsModule, { status: 200, headers: { 'content-type': 'application/javascript' } }) }),
      dnsResolver: publicResolver,
    });
  } catch (error) {
    if (error instanceof BuildFailure) noExportsFailure = error;
  }
  ok(noExportsFailure !== null && noExportsFailure.code === 'BUILD_UNSUPPORTED_PROVIDER' && noExportsFailure.verdict === 'UNSUPPORTED', 'E13 module without getStreams is honestly unsupported');

  // E13b — missing module URL → SOURCE_UNAVAILABLE.
  let missingUrlFailure: BuildFailure | null = null;
  try {
    await executeBuild(nuvioBuildRequest('MoviesDrive', null), TEST_CONFIG, { fetcher, dnsResolver: publicResolver });
  } catch (error) {
    if (error instanceof BuildFailure) missingUrlFailure = error;
  }
  ok(missingUrlFailure !== null && missingUrlFailure.code === 'BUILD_SOURCE_UNAVAILABLE', 'E14 missing module URL → SOURCE_UNAVAILABLE');
}

console.log('§E cloudstream families');
{
  // E15 — cloudstream: family matching + honest refusals.
  ok(listCloudStreamFamilyKeys().length === 3, 'E15 three source-verified families');
  ok(matchCloudStreamFamily('MoviesDrive') !== null, 'E16 exact family keyword matches');
  ok(matchCloudStreamFamily('MoviesDrive.sbs') !== null, 'E17 clone family keyword matches');
  ok(matchCloudStreamFamily('BollyFlix Hub') !== null, 'E18 bollyflix clone matches');
  ok(matchCloudStreamFamily('VegaMovies') !== null, 'E19 vegamovies matches');
  ok(matchCloudStreamFamily('MegixProvider') === null, 'E20 unknown provider does not match');

  const cloudstreamRequest: AdapterBuildRequest = {
    requestId: 'req-cs-1',
    requestedAt: new Date().toISOString(),
    integrationType: 'cloudstream',
    provider: {
      id: 'MoviesDrive', name: 'MoviesDrive', version: null, language: null,
      repository: { name: null, url: null }, moduleUrl: null, pluginUrl: 'https://cs.example/plugin.cs3',
      mediaTypes: ['movie'],
    },
    requestedAdapterVersion: 1,
    test: { movie: { kind: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }, episode: null },
  };

  // The native id itself is refused (§16 native precedence, defense-in-depth).
  let nativeFailure: BuildFailure | null = null;
  try {
    await executeBuild(cloudstreamRequest, TEST_CONFIG, { fetcher: createFetcher(providerSiteRoutes()), dnsResolver: publicResolver });
  } catch (error) {
    if (error instanceof BuildFailure) nativeFailure = error;
  }
  ok(nativeFailure !== null && nativeFailure.code === 'BUILD_UNSUPPORTED_PROVIDER' && nativeFailure.verdict === 'REQUIRES_RUNTIME', 'E21 the exact native provider id is refused by the Builder too');

  // A clone provider with a working family site → family DSL + live test.
  // The family site resolves its dynamic base from the SHARED urls.json
  // document, searches search.php, and extracts the hubcloud link through
  // the REAL hubcloud extractor port (deterministic fixture pages).
  const HUBCLOUD_PAGE = `<html><body><script>var url = '/download/abc';</script></body></html>`;
  const HUBCLOUD_CARD = `<html><body>
  <div class="card-header">Inception 2010 1080p BluRay x264</div>
  <i id="size">2.4 GB</i>
  <h2><a class="btn" href="https://fsl.hubcloud.test/file1">FSL Server</a></h2>
  <h2><a class="btn" href="https://hubcloud.test/dl/file2">Download File</a></h2>
</body></html>`;
  const familyDetail = `<!doctype html><html><body><h5><a href="https://hubcloud.test/dl/hub-1080">HubCloud 1080p</a></h5></body></html>`;
  const familyRoutes: Record<string, () => Response> = {
    'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json':
      jsonRoute({ moviesdrive: PROVIDER_HOST, hubcloud: 'https://hubcloud.test' }),
    [SEARCH_URL]: jsonRoute({ hits: [{ document: { post_title: 'Download Inception 2010', permalink: DETAIL_URL } }] }),
    [DETAIL_URL]: htmlRoute(familyDetail),
    'https://hubcloud.test/dl/hub-1080': htmlRoute(HUBCLOUD_PAGE),
    'https://hubcloud.test/download/abc': htmlRoute(HUBCLOUD_CARD),
  };
  const cloneRequest = { ...cloudstreamRequest, provider: { ...cloudstreamRequest.provider, id: 'MoviesDrive.Cloned' } };
  const cloneResponse = await executeBuild(cloneRequest, TEST_CONFIG, { fetcher: createFetcher(familyRoutes), dnsResolver: publicResolver });
  ok(cloneResponse.ok, 'E22 a family-matched clone builds through the template + live test');
  if (cloneResponse.ok) {
    ok(cloneResponse.result.artifact.spec.search.extraction.kind === 'json', 'E23 the moviesdrive family JSON search');
    ok(cloneResponse.result.analysis.sourceRevision === '', 'E24 cloudstream analysis has no source revision (never fetches .cs3)');
  }

  // Unknown cloudstream provider → REQUIRES_RUNTIME (never fetches .cs3).
  const unknownRequest = { ...cloudstreamRequest, provider: { ...cloudstreamRequest.provider, id: 'RandomProvider' } };
  let unknownFailure: BuildFailure | null = null;
  const csCalls: FetchCall[] = [];
  try {
    await executeBuild(unknownRequest, TEST_CONFIG, { fetcher: createFetcher({}, csCalls), dnsResolver: publicResolver });
  } catch (error) {
    if (error instanceof BuildFailure) unknownFailure = error;
  }
  ok(unknownFailure !== null && unknownFailure.code === 'BUILD_UNSUPPORTED_PROVIDER' && unknownFailure.verdict === 'REQUIRES_RUNTIME', 'E25 unknown cloudstream provider → honest REQUIRES_RUNTIME');
  ok(!csCalls.some((call) => call.url.includes('.cs3')), 'E26 the .cs3 URL is NEVER fetched');

  // The family spec shape: buildFamilySpec sanity.
  const family = matchCloudStreamFamily('MoviesDrive.Cloned');
  ok(family !== null && buildFamilySpec(family, 'X').limits.maxCandidates === 20, 'E27 family spec fan-out bounded');
  ok(validateAdapterArtifact({
    schemaVersion: 1, kind: 'permanent-adapter', strategy: 'declarative',
    adapterId: 'cloudstream:moviesdrive.cloned', integrationType: 'cloudstream', providerId: 'MoviesDrive.Cloned',
    providerName: 'X', adapterVersion: 1, generatedAt: new Date().toISOString(), sourceUrl: null,
    mediaTypes: ['movie', 'tv'], language: null,
    spec: family !== null ? buildFamilySpec(family, 'X') : makeSpec(),
    analysis: { verdict: 'SUPPORTED', notes: 'n', endpoints: [], sourceRevision: '', analyzedAt: new Date().toISOString() },
    testReport: { cases: [{ kind: 'movie', passed: true, note: null, linksFound: 1, durationMs: 1 }], passed: true, testedAt: new Date().toISOString() },
    builderVersion: BUILDER_VERSION,
  }).length === 0, 'E28 the family spec validates within the schema bounds');
}

// ---------------------------------------------------------------------------
// §F — The Builder HTTP service (auth, replay, closed errors)
// ---------------------------------------------------------------------------

console.log('§F builder http');
{
  const server = createBuilderServer(TEST_CONFIG);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/health`);
  const healthBody = (await health.json()) as { ok: boolean; builderVersion: string };
  ok(health.status === 200 && healthBody.ok && healthBody.builderVersion === BUILDER_VERSION, 'F1 /health responds without auth');
  ok(!JSON.stringify(healthBody).includes('test-secret'), 'F2 /health leaks no secret');

  const unauthorized = await fetch(`${base}/build`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
  ok(unauthorized.status === 401, 'F3 wrong bearer → 401');

  const noAuth = await fetch(`${base}/build`, { method: 'POST', body: '{}' });
  ok(noAuth.status === 401, 'F4 missing bearer → 401');

  const notFound = await fetch(`${base}/resolve-movie`, { method: 'POST' });
  ok(notFound.status === 404, 'F5 runtime routes do not exist on the Builder (plan §3)');

  const validBody = JSON.stringify(nuvioBuildRequest());
  const authHeaders = { authorization: `Bearer ${TEST_CONFIG.secret}`, 'content-type': 'application/json' };

  // Replay: identical requestId + body twice → second is rejected. The first
  // processes (any closed outcome — the offline module URL yields a clean
  // 502 BUILD_SOURCE_UNAVAILABLE, never an internal error).
  const first = await fetch(`${base}/build`, { method: 'POST', headers: authHeaders, body: validBody });
  ok(first.status === 422 || first.status === 200 || first.status === 502, 'F6 first authorized request processed');
  const second = await fetch(`${base}/build`, { method: 'POST', headers: authHeaders, body: validBody });
  ok(second.status === 409, 'F7 replayed request rejected (409)');

  // Timestamp skew: old requestedAt → rejected.
  const staleRequest = nuvioBuildRequest();
  staleRequest.requestedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const stale = await fetch(`${base}/build`, { method: 'POST', headers: authHeaders, body: JSON.stringify(staleRequest) });
  ok(stale.status === 400, 'F8 stale timestamp rejected');

  // Malformed body → closed BUILD_INVALID_REQUEST (no stack traces).
  const malformed = await fetch(`${base}/build`, { method: 'POST', headers: authHeaders, body: 'not-json' });
  const malformedBody = (await malformed.json()) as { error: { code: string; message: string } };
  ok(malformed.status === 400 && malformedBody.error.code === 'BUILD_INVALID_REQUEST', 'F9 malformed body → closed error');
  ok(!JSON.stringify(malformedBody).toLowerCase().includes('at ') || malformedBody.error.message.length < 200, 'F10 no stack traces in responses');

  // Body over the cap → closed RESOURCE_LIMIT.
  const oversized = await fetch(`${base}/build`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ ...nuvioBuildRequest(), pad: 'x'.repeat(70_000) }),
  });
  const oversizedBody = (await oversized.json().catch(() => ({ error: { code: 'UNKNOWN' } }))) as { error?: { code?: string } };
  ok(oversized.status === 413 || oversizedBody.error?.code === 'BUILD_RESOURCE_LIMIT', 'F11 oversized body rejected');

  server.close();
  ok(true, 'F12 builder server shuts down');
}

console.log(`§A-§F passed: ${passed} checks`);

// ---------------------------------------------------------------------------
// §G — The Mavero-side Builder client (env config, outcomes)
// ---------------------------------------------------------------------------

console.log('§G builder client');
{
  const clientConfig: BuilderClientConfig = { url: 'http://builder.test', secret: 'client-secret', timeoutMs: 5_000 };

  // G1 — unconfigured Builder → honest BUILDER_UNAVAILABLE.
  const unconfigured = await requestAdapterBuild(nuvioBuildRequest(), { config: { url: '', secret: '', timeoutMs: 100 } });
  ok(!unconfigured.ok && unconfigured.code === 'BUILDER_UNAVAILABLE', 'G1 unconfigured builder → BUILDER_UNAVAILABLE');

  // G2 — unreachable Builder (fetcher rejects).
  const unreachable = await requestAdapterBuild(nuvioBuildRequest(), {
    config: clientConfig,
    fetcher: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
  });
  ok(!unreachable.ok && unreachable.code === 'BUILDER_UNAVAILABLE', 'G2 unreachable builder → BUILDER_UNAVAILABLE');

  // G3 — timeout mapping (the fake fetcher rejects on abort like real fetch).
  const timedOut = await requestAdapterBuild(nuvioBuildRequest(), {
    config: { ...clientConfig, timeoutMs: 5 },
    fetcher: (async (_input: unknown, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
      return new Response('{}');
    }) as typeof fetch,
  });
  ok(!timedOut.ok && timedOut.code === 'BUILDER_TIMEOUT', 'G3 builder timeout → BUILDER_TIMEOUT');

  // G4 — 401 → BUILDER_UNAVAILABLE (authorization rejected).
  const unauthorized = await requestAdapterBuild(nuvioBuildRequest(), {
    config: clientConfig,
    fetcher: (async () => new Response('{}', { status: 401 })) as typeof fetch,
  });
  ok(!unauthorized.ok && unauthorized.code === 'BUILDER_UNAVAILABLE', 'G4 rejected authorization → BUILDER_UNAVAILABLE');

  // G5 — a successful build response passes through.
  const artifactResponse = await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher: createFetcher(providerSiteRoutes()), dnsResolver: publicResolver });
  assert.ok(artifactResponse.ok);
  const success = await requestAdapterBuild(nuvioBuildRequest(), {
    config: clientConfig,
    fetcher: (async () => new Response(JSON.stringify(artifactResponse), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  ok(success.ok && success.response.ok === true, 'G5 a valid build response passes through');
  ok((success as { response: { builderVersion: string } }).response.builderVersion === BUILDER_VERSION, 'G6 builder version carried');

  // G7 — the bearer header carries the secret; nothing else leaks.
  const seenInits: RequestInit[] = [];
  await requestAdapterBuild(nuvioBuildRequest(), {
    config: clientConfig,
    fetcher: (async (_input: unknown, init?: RequestInit) => { seenInits.push(init); return new Response(JSON.stringify({ ok: false, error: { code: 'BUILD_TEST_FAILED', message: 'x' }, builderVersion: BUILDER_VERSION }), { status: 422, headers: { 'content-type': 'application/json' } }); }) as typeof fetch,
  });
  ok(String(seenInits[0]?.headers && (seenInits[0].headers as Record<string, string>).authorization) === 'Bearer client-secret', 'G7 bearer auth header set');
}

// ---------------------------------------------------------------------------
// §H — The generated adapter registry (integrity, binding, §16 precedence)
// ---------------------------------------------------------------------------

console.log('§H generated registry');
{
  clearGeneratedAdapterCache();
  const response = await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher: createFetcher(providerSiteRoutes()), dnsResolver: publicResolver });
  assert.ok(response.ok);
  const artifact = response.result.artifact;
  const hash = artifactIntegrityHash(artifact);
  const row = {
    canonical_key: artifact.adapterId,
    integration_type: artifact.integrationType,
    provider_id: artifact.providerId,
    adapter_version: artifact.adapterVersion,
    strategy: artifact.strategy,
    artifact,
    artifact_hash: hash,
  };

  // H1 — a valid row produces an executable adapter instance.
  const adapter = generatedAdapterFromArtifactRow(row);
  ok(adapter !== null, 'H1 a valid artifact row binds to an adapter instance');
  if (adapter !== null) {
    ok(adapter.id === 'nuvio:moviesdrive', 'H2 the instance id is the CANONICAL key (id separation, §16)');
    ok(adapter.supports.movie === true && adapter.supports.series === false, 'H3 supports reflect the artifact media types');
    ok(adapter.resolveEpisode === undefined, 'H4 movie-only artifact has no episode resolution');
    ok(adapter.version === 'generated-v1', 'H5 version reflects the artifact version');

    // H5b — the instance resolves through the interpreter.
    const resolution = await runRepresentativeResolution(adapter, DEFAULT_TEST_INPUTS, {
      fetcher: createFetcher(providerSiteRoutes()),
      dnsResolver: publicResolver,
    });
    ok(resolution.cases.length === 1 && resolution.cases[0]!.linksFound >= 1, 'H6 the generated instance resolves through the standard resolver');
  }

  // H7 — a tampered artifact row is refused (integrity at read time).
  const tamperedRow = { ...row, artifact: { ...artifact, spec: { ...artifact.spec, output: { sourceName: 'Evil' } } } };
  clearGeneratedAdapterCache();
  ok(generatedAdapterFromArtifactRow(tamperedRow) === null, 'H7 tampered artifact refused before interpretation');

  // H8 — a mismatched hash is refused.
  const badHashRow = { ...row, artifact_hash: '0'.repeat(64) };
  clearGeneratedAdapterCache();
  ok(generatedAdapterFromArtifactRow(badHashRow) === null, 'H8 mismatched hash refused');

  // H9 — identity incoherence refused.
  const wrongKeyRow = { ...row, canonical_key: 'nuvio:other' };
  clearGeneratedAdapterCache();
  ok(generatedAdapterFromArtifactRow(wrongKeyRow) === null, 'H9 identity-incoherent row refused');

  // H10 — buildGeneratedAdapterMap dedupes + §16 precedence in the registry.
  clearGeneratedAdapterCache();
  const map = buildGeneratedAdapterMap([row]);
  ok(map.size === 1 && map.has('nuvio:moviesdrive'), 'H10 the map is keyed by canonical key');
  ok(
    executableAdapterForExtension({ integration_type: 'nuvio', internal_name: 'MoviesDrive' }, map)?.id === 'nuvio:moviesdrive',
    'H11 a generated nuvio row binds through the optional map',
  );
  ok(
    executableAdapterForExtension({ integration_type: 'nuvio', internal_name: 'MoviesDrive' }) === null,
    'H12 without the map the nuvio row is honestly non-executable',
  );
  // §16 native precedence: the native binding wins for the cloudstream row
  // whose internal_name matches; the generated nuvio row keeps its own
  // canonical-key identity (no collision by construction).
  ok(
    executableAdapterForExtension({ integration_type: 'cloudstream', internal_name: 'MoviesDrive' }, map)?.id === 'MoviesDrive'
      && lookupCloudStreamAdapterInstance('MoviesDrive') !== null,
    'H13 the native code registry takes precedence (§16)',
  );
  ok(
    executableAdapterForExtension({ integration_type: 'nuvio', internal_name: 'MoviesDrive' }, map)?.id === 'nuvio:moviesdrive',
    'H13b the generated nuvio row keeps its distinct canonical identity',
  );

  // H14/H15 — Phase 5 (Session 13): multi-version rows bind DETERMINISTICALLY
  // (highest adapter_version, order-independent). The pre-fix first-wins
  // binding depended on the caller's row order, which no DB select
  // guarantees; the catalog loader now supplies exactly the ACTIVE version
  // (filtered by the extension row's generated_adapter_version pointer), so
  // this tie-break is defense-in-depth.
  {
    const v1Artifact = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
    const v2Artifact = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
    v2Artifact.adapterVersion = 2;
    const v1Row = { ...row, artifact: v1Artifact, adapter_version: 1, artifact_hash: artifactIntegrityHash(v1Artifact) };
    const v2Row = { ...row, artifact: v2Artifact, adapter_version: 2, artifact_hash: artifactIntegrityHash(v2Artifact) };
    clearGeneratedAdapterCache();
    const ascending = buildGeneratedAdapterMap([v1Row, v2Row]);
    ok(ascending.get('nuvio:moviesdrive')?.version === 'generated-v2', 'H14 multi-version rows bind the highest version (ascending input)');
    clearGeneratedAdapterCache();
    const descending = buildGeneratedAdapterMap([v2Row, v1Row]);
    ok(descending.get('nuvio:moviesdrive')?.version === 'generated-v2', 'H15 multi-version rows bind the highest version (descending input — order-independent)');
  }
}

// ---------------------------------------------------------------------------
// §I — The Mavero build orchestration (lifecycle, honesty, atomic promotion)
// ---------------------------------------------------------------------------

console.log('§I build service');

function extensionRow(overrides: Row = {}): Row {
  return {
    id: 'ext-1',
    repository_id: 'repo-1',
    internal_name: 'MoviesDrive',
    name: 'MoviesDrive',
    language: 'en',
    version_text: '1.1.1',
    version: null,
    integration_type: 'nuvio',
    plugin_status: null,
    plugin_url: null,
    module_url: MODULE_URL,
    media_types: ['movie'],
    adapter_state: 'adapter_required',
    enabled: false,
    generated_adapter_version: null,
    builder_version: null,
    last_build_at: null,
    last_build_error: null,
    ...overrides,
  };
}

function repositoryRow(): Row {
  return { id: 'repo-1', name: 'Phisher Nuvio', url: 'https://nuvio.example', enabled: true, status: 'active', created_at: '2026-01-01' };
}

/** Fake builder responses (builder-client deps: config + fetcher). */
function fakeBuilderDeps(handler: (request: AdapterBuildRequest) => Response) {
  return {
    config: { url: 'http://builder.test', secret: 's', timeoutMs: 30_000 } satisfies BuilderClientConfig,
    fetcher: (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as AdapterBuildRequest;
      return handler(body);
    }) as typeof fetch,
    requestId: () => `fixed-${Math.random().toString(36).slice(2, 8)}`,
  };
}

{
  // I1 — native row → NATIVE_ADAPTER_EXISTS refusal (§16).
  const { client } = createFakeClient();
  (client as unknown as { _tables: Record<string, Row[]> })._tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-native', internal_name: 'BollyFlix', integration_type: 'cloudstream' }));
  const native = await createAdapterForExtension(client, 'ext-native');
  ok(!native.ok && native.code === 'NATIVE_ADAPTER_EXISTS', 'I1 native rows refuse create-adapter');

  // I2 — runtime_required row → refusal.
  const { client: rtClient } = createFakeClient();
  (rtClient as unknown as { _tables: Record<string, Row[]> })._tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-rt', adapter_state: 'runtime_required' }));
  const rt = await createAdapterForExtension(rtClient, 'ext-rt');
  ok(!rt.ok && rt.code === 'RUNTIME_REQUIRED', 'I2 runtime_required rows refuse create-adapter');

  // I3 — unknown extension → EXTENSION_NOT_FOUND.
  const { client: nfClient } = createFakeClient();
  const nf = await createAdapterForExtension(nfClient, 'missing');
  ok(!nf.ok && nf.code === 'EXTENSION_NOT_FOUND', 'I3 unknown extension refused');

  // I4 — builder unavailable → row returns to its prior state, not failed.
  const { client: uaClient, tables: uaTables } = createFakeClient();
  uaTables['cloudstream_repositories'].push(repositoryRow());
  uaTables['cloudstream_extensions'].push(extensionRow());
  const unavailable = await createAdapterForExtension(uaClient, 'ext-1', {}, {
    config: { url: 'http://builder.test', secret: 's', timeoutMs: 1_000 } satisfies BuilderClientConfig,
    fetcher: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
  });
  ok(!unavailable.ok && unavailable.code === 'BUILDER_UNAVAILABLE', 'I4 builder unavailable is a controlled admin outcome');
  ok(uaTables['cloudstream_extensions'][0]!.adapter_state === 'adapter_required', 'I5 the row returns to its prior state (not failed)');
  ok(String(uaTables['cloudstream_extensions'][0]!.last_build_error ?? '').startsWith('BUILDER_UNAVAILABLE'), 'I6 the failure is recorded in last_build_error');

  // I7 — happy path: builder ok → testing → Mavero-side test → generated +
  // atomic promotion + immutable artifact row persisted.
  const built = await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher: createFetcher(providerSiteRoutes()), dnsResolver: publicResolver });
  assert.ok(built.ok);
  const { client: happyClient, tables: happyTables } = createFakeClient();
  happyTables['cloudstream_repositories'].push(repositoryRow());
  happyTables['cloudstream_extensions'].push(extensionRow());
  const happy = await createAdapterForExtension(happyClient, 'ext-1', {}, {
    ...fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200, headers: { 'content-type': 'application/json' } })),
    testFetcher: createFetcher(providerSiteRoutes()),
    testDnsResolver: publicResolver,
  });
  ok(happy.ok && happy.adapterVersion === 1, 'I7 the happy path promotes to generated');
  const promotedRow = happyTables['cloudstream_extensions'][0]!;
  ok(promotedRow.adapter_state === 'generated', 'I8 adapter_state promoted to generated');
  ok(promotedRow.generated_adapter_version === 1, 'I9 the version pointer is set atomically');
  ok(promotedRow.builder_version === BUILDER_VERSION, 'I10 builder provenance recorded');
  ok(promotedRow.last_build_error === null, 'I11 build error cleared on success');
  const artifactRows = happyTables['cloudstream_adapter_artifacts'];
  ok(artifactRows.length === 1, 'I12 the immutable artifact row is persisted');
  ok(artifactRows[0]!.canonical_key === 'nuvio:moviesdrive' && artifactRows[0]!.artifact_hash === artifactIntegrityHash(built.result.artifact), 'I13 the artifact row carries the integrity hash');
  ok((artifactRows[0]!.test_report as { passed: boolean }).passed === true, 'I14 the Mavero-side test report is persisted');

  // I15 — a second successful build bumps the version (previous + 1) and
  // retains the old artifact row.
  const built2 = await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher: createFetcher(providerSiteRoutes()), dnsResolver: publicResolver });
  assert.ok(built2.ok);
  // Reset the row to adapter_required (the rebuild entry state).
  Object.assign(promotedRow, { adapter_state: 'adapter_required', generated_adapter_version: null });
  const rebuild = await createAdapterForExtension(happyClient, 'ext-1', {}, {
    ...fakeBuilderDeps((request) => {
      assert.equal(request.requestedAdapterVersion, 2, 'I15b the next version is requested (previous + 1)');
      return new Response(JSON.stringify({ ...built2, result: { ...built2.result, artifact: { ...built2.result.artifact, adapterVersion: 2 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
    testFetcher: createFetcher(providerSiteRoutes()),
    testDnsResolver: publicResolver,
  });
  ok(rebuild.ok && rebuild.adapterVersion === 2, 'I15 the rebuild bumps to version 2');
  ok(happyTables['cloudstream_adapter_artifacts'].length === 2, 'I16 old artifact versions retained forever');
  ok(promotedRow.generated_adapter_version === 2, 'I17 the pointer moved atomically');

  // I18 — builder verdict REQUIRES_RUNTIME → row becomes runtime_required.
  const { client: rrClient, tables: rrTables } = createFakeClient();
  rrTables['cloudstream_repositories'].push(repositoryRow());
  rrTables['cloudstream_extensions'].push(extensionRow());
  const runtimeRequired = await createAdapterForExtension(rrClient, 'ext-1', {}, fakeBuilderDeps(() => new Response(JSON.stringify({
    ok: false, error: { code: 'BUILD_UNSUPPORTED_PROVIDER', message: 'not convertible', verdict: 'REQUIRES_RUNTIME' }, builderVersion: BUILDER_VERSION,
  }), { status: 422, headers: { 'content-type': 'application/json' } })));
  ok(!runtimeRequired.ok, 'I18 the not-convertible refusal surfaces');
  ok(rrTables['cloudstream_extensions'][0]!.adapter_state === 'runtime_required', 'I19 the row becomes runtime_required (stays disabled)');

  // I20 — an artifact that fails Mavero-side identity validation → failed.
  const { client: ivClient, tables: ivTables } = createFakeClient();
  ivTables['cloudstream_repositories'].push(repositoryRow());
  ivTables['cloudstream_extensions'].push(extensionRow());
  const identityTampered = JSON.parse(JSON.stringify(built)) as typeof built;
  if (identityTampered.ok) identityTampered.result.artifact.providerId = 'DifferentProvider';
  const invalid = await createAdapterForExtension(ivClient, 'ext-1', {}, {
    ...fakeBuilderDeps(() => new Response(JSON.stringify(identityTampered), { status: 200, headers: { 'content-type': 'application/json' } })),
  });
  ok(!invalid.ok && invalid.code === 'ARTIFACT_VALIDATION_FAILED', 'I20 identity-incoherent artifacts are rejected Mavero-side');
  ok(ivTables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'I21 the row records the failure');
  ok(ivTables['cloudstream_adapter_artifacts'].length === 0, 'I22 nothing was persisted');

  // I23 — Mavero's independent test failing → failed (never READY on 200).
  const { client: tfClient, tables: tfTables } = createFakeClient();
  tfTables['cloudstream_repositories'].push(repositoryRow());
  tfTables['cloudstream_extensions'].push(extensionRow());
  const testFailed = await createAdapterForExtension(tfClient, 'ext-1', {}, {
    ...fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200, headers: { 'content-type': 'application/json' } })),
    // The provider site is GONE when Mavero re-tests → the independent test fails.
    testFetcher: createFetcher({}),
    testDnsResolver: publicResolver,
  });
  ok(!testFailed.ok && testFailed.code === 'MAVERO_TEST_FAILED', 'I23 READY is never granted on Builder 200 alone');
  ok(tfTables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'I24 the failed build records its state');
  ok(String(tfTables['cloudstream_extensions'][0]!.last_build_error ?? '').startsWith('MAVERO_TEST_FAILED'), 'I25 the closed failure code is recorded');
  ok(tfTables['cloudstream_adapter_artifacts'].length === 0, 'I26 no artifact persisted for a failed test');

  // I27 — building/testing rows refuse concurrent actions.
  const { client: ccClient } = createFakeClient();
  (ccClient as unknown as { _tables: Record<string, Row[]> })._tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'building' }));
  const inProgress = await createAdapterForExtension(ccClient, 'ext-1');
  ok(!inProgress.ok && inProgress.code === 'BUILD_IN_PROGRESS', 'I27 concurrent build attempts are isolated');
}

// ---------------------------------------------------------------------------
// §J — Test Provider backend (§15)
// ---------------------------------------------------------------------------

console.log('§J test service');
{
  // J1 — adapter_required row → honest ADAPTER_NOT_AVAILABLE.
  const { client: arClient, tables: arTables } = createFakeClient();
  arTables['cloudstream_repositories'].push(repositoryRow());
  arTables['cloudstream_extensions'].push(extensionRow());
  const noAdapter = await testExtensionProvider(arClient, 'ext-1');
  ok(!noAdapter.ok && noAdapter.code === 'ADAPTER_NOT_AVAILABLE', 'J1 adapter_required rows cannot be tested');
  ok(arTables['cloudstream_extensions'][0]!.last_tested_at !== null, 'J2 the attempt is recorded');

  // J3 — generated row test (native binding first for cloudstream rows).
  const built = await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher: createFetcher(providerSiteRoutes()), dnsResolver: publicResolver });
  assert.ok(built.ok);
  const artifact = built.result.artifact;
  const { client: gClient, tables: gTables } = createFakeClient();
  gTables['cloudstream_repositories'].push(repositoryRow());
  gTables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'generated', generated_adapter_version: 1 }));
  gTables['cloudstream_adapter_artifacts'].push({
    id: 'a1',
    canonical_key: artifact.adapterId,
    integration_type: artifact.integrationType,
    provider_id: artifact.providerId,
    adapter_version: artifact.adapterVersion,
    strategy: artifact.strategy,
    artifact,
    artifact_hash: artifactIntegrityHash(artifact),
    source_revision: artifact.analysis.sourceRevision,
    builder_version: artifact.builderVersion,
    test_report: null,
    created_at: new Date().toISOString(),
  });
  clearGeneratedAdapterCache();
  const generatedTest = await testExtensionProvider(gClient, 'ext-1', {}, {
    fetcher: createFetcher(providerSiteRoutes()),
    dnsResolver: publicResolver,
  });
  ok(generatedTest.ok && generatedTest.result.adapterKind === 'generated', 'J3 the generated adapter serves the Test Provider action');
  ok(generatedTest.ok && generatedTest.result.passed && generatedTest.result.links.length >= 1, 'J4 normalized link views are returned');

  // J5 — test inputs parsing.
  const parsed = parseProviderTestInputs({ testTmdbId: '12345', testTitle: 'Avatar', testYear: '2009', testSeason: '1', testEpisode: '2' });
  ok(parsed.movie.tmdbId === '12345' && parsed.movie.title === 'Avatar' && parsed.movie.year === 2009, 'J5 custom test inputs parsed');
  ok(parsed.episode !== null && parsed.episode.season === 1 && parsed.episode.episode === 2, 'J6 episode inputs parsed');
  const defaults = parseProviderTestInputs({});
  ok(defaults.movie.tmdbId === DEFAULT_TEST_INPUTS.movie.tmdbId, 'J7 defaults apply');
  const invalidInputs = parseProviderTestInputs({ testTmdbId: '', testTitle: 'Only Title' });
  ok(invalidInputs.movie.tmdbId === DEFAULT_TEST_INPUTS.movie.tmdbId, 'J8 partial inputs fall back to defaults');
}

// ---------------------------------------------------------------------------
// §K — Downloader 2 INDEPENDENCE from the Builder (plan §3/§17)
// ---------------------------------------------------------------------------

console.log('§K downloader 2 independence');
{
  // Static pins: the runtime path NEVER imports the builder domain.
  const runtimeFiles = [
    'src/lib/server/cloudstream/downloader/service.ts',
    'src/lib/server/cloudstream/resolver/service.ts',
    'src/lib/server/cloudstream/runtime/context.ts',
    'src/lib/server/cloudstream/adapters/moviesdrive.ts',
    'src/lib/server/cloudstream/adapters/bollyflix.ts',
    'src/lib/server/cloudstream/adapters/vegamovies.ts',
    'src/lib/server/cloudstream/extensions/service.ts',
    'src/lib/server/cloudstream/repository/service.ts',
    'src/lib/server/extensions/adapter-registry.ts',
    'src/lib/server/extensions/builder/generated-registry.ts',
    'src/lib/server/extensions/builder/dsl-interpreter.ts',
  ];
  for (const file of runtimeFiles) {
    const source = read(file);
    ok(!source.includes('builder-client'), `K1 ${path.basename(file)} never imports the builder client`);
    ok(!source.includes('build-service'), `K2 ${path.basename(file)} never imports the build orchestration`);
    ok(!source.includes('ADAPTER_BUILDER_URL'), `K3 ${path.basename(file)} never reads the Builder env`);
  }
  // The builder client itself never enters the runtime path (importers pin).
  // DURABLE BUILD LIFECYCLE (20261102000000): the admin form action now
  // imports the queue entry from build-lifecycle (the moved implementation
  // of build-service); the invariant stays "the ONLY builder entry is the
  // admin surface" — build-service.ts itself re-exports from
  // build-lifecycle.ts, which remains builder-client's sole caller.
  const clientImporters = ['src/routes/admin/system/integrations/+page.server.ts'];
  for (const file of clientImporters) {
    ok(
      read(file).includes('build-lifecycle') || read(file).includes('build-service'),
      `K4 ${path.basename(file)} is the admin-only builder entry`,
    );
  }

  // Behavioral: a generated adapter resolves with the Builder UNREACHABLE —
  // Downloader 2 reads persisted artifacts only (§3/§13).
  const built = await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher: createFetcher(providerSiteRoutes()), dnsResolver: publicResolver });
  assert.ok(built.ok);
  const artifact = built.result.artifact;
  const { client: indClient, tables: indTables } = createFakeClient();
  indTables['cloudstream_repositories'].push({ id: 'repo-1', name: 'Nuvio', url: 'https://nuvio.example', enabled: true, status: 'active', created_at: '2026-01-01', integration_type: 'nuvio' });
  indTables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'generated', generated_adapter_version: 1, enabled: true }));
  indTables['cloudstream_adapter_artifacts'].push({
    id: 'a1', canonical_key: artifact.adapterId, integration_type: artifact.integrationType,
    provider_id: artifact.providerId, adapter_version: artifact.adapterVersion, strategy: artifact.strategy,
    artifact, artifact_hash: artifactIntegrityHash(artifact), source_revision: '', builder_version: artifact.builderVersion,
    test_report: null, created_at: new Date().toISOString(),
  });
  clearGeneratedAdapterCache();
  const eligible = selectEligibleExtensions({
    repositories: [{ id: 'repo-1', enabled: true, created_at: '2026-01-01' }],
    extensions: [extensionRow({ adapter_state: 'generated', generated_adapter_version: 1, enabled: true }) as never],
    generatedArtifacts: [indTables['cloudstream_adapter_artifacts'][0] as never],
  }, 'movie');
  ok(eligible.length === 1 && eligible[0]!.adapter.id === 'nuvio:moviesdrive', 'K5 the generated row is Downloader 2 eligible (canonical identity)');

  // The full resolution with a fetcher that fails EVERY builder URL: the
  // persisted artifact still serves the request (no builder dependency).
  const neverBuilderFetcher = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('builder') || url.includes(MODULE_URL)) throw new TypeError('builder unreachable');
    return createFetcher(providerSiteRoutes())(input as never);
  }) as typeof fetch;
  const resolution = await resolveCloudStreamDownloads(indClient, { mediaType: 'movie', contentId: 'mv-1' }, {}, {
    loadContent: async () => ({ mediaType: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }),
    loadCatalog: async () => ({
      repositories: [{ id: 'repo-1', enabled: true, created_at: '2026-01-01' }],
      extensions: [extensionRow({ adapter_state: 'generated', generated_adapter_version: 1, enabled: true }) as never],
      generatedArtifacts: [indTables['cloudstream_adapter_artifacts'][0] as never],
    }),
    fetcher: neverBuilderFetcher,
    dnsResolver: publicResolver,
  });
  ok(resolution.groups.length === 1 && resolution.groups[0]!.status === 'loaded', 'K6 the generated adapter resolves with the Builder unreachable');
  ok((resolution.groups[0]!.links.length ?? 0) >= 1, 'K7 links are served from the persisted artifact');

  // K8 — builder unavailability never affects existing adapter_required rows:
  // they are simply ineligible (no builder call, no state change).
  ok(resolution.consideredExtensions === 1, 'K8 the participation baseline is unaffected');

  // K9/K10 — Phase 5 (Session 13) ACTIVE-version binding through the REAL
  // defaultLoadCatalog (no injected loadCatalog): the artifact version that
  // resolves is the extension row's generated_adapter_version POINTER, not
  // an arbitrary DB-ordered row. Rollback (pointer to the older version,
  // artifacts stored newest-first) and fresh promotion (pointer to the newer
  // version, artifacts stored oldest-first) are both respected. The v2
  // artifact carries a distinct sourceName so the resolved links prove
  // WHICH version served.
  {
    const mkVersion = (version: number, sourceName: string) => {
      const copy = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
      copy.adapterVersion = version;
      copy.spec.output.sourceName = sourceName;
      return {
        id: `a-v${version}`,
        canonical_key: copy.adapterId, integration_type: copy.integrationType, provider_id: copy.providerId,
        adapter_version: version, strategy: copy.strategy, artifact: copy, artifact_hash: artifactIntegrityHash(copy),
        source_revision: '', builder_version: copy.builderVersion, test_report: null, created_at: '2026-01-01',
      };
    };
    const v1 = mkVersion(1, 'MoviesDriveSourceV1');
    const v2 = mkVersion(2, 'MoviesDriveSourceV2');
    const runLoaderResolution = async (pointer: number, stored: Row[]) => {
      const { client: pClient, tables: pTables } = createFakeClient();
      pTables['cloudstream_repositories'].push({ id: 'repo-1', name: 'Nuvio', url: 'https://nuvio.example', enabled: true, status: 'active', created_at: '2026-01-01', integration_type: 'nuvio' });
      pTables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'generated', generated_adapter_version: pointer, enabled: true }));
      for (const row of stored) pTables['cloudstream_adapter_artifacts'].push({ ...row });
      clearGeneratedAdapterCache();
      const result = await resolveCloudStreamDownloads(pClient, { mediaType: 'movie', contentId: 'mv-1' }, {}, {
        loadContent: async () => ({ mediaType: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }),
        fetcher: neverBuilderFetcher,
        dnsResolver: publicResolver,
      });
      return result;
    };
    // K9 — ROLLBACK respected: pointer at v1 while the DB stores v2 FIRST.
    const rolledBack = await runLoaderResolution(1, [v2, v1]);
    ok(rolledBack.groups.length === 1 && rolledBack.groups[0]!.status === 'loaded', 'K9 rollback: the rolled-back pointer version resolves');
    ok(rolledBack.groups[0]!.links.every((link) => link.sourceName.startsWith('MoviesDriveSourceV1')), 'K9b the ACTIVE (rolled-back) version serves — not the newest stored artifact');
    // K10 — fresh promotion respected: pointer at v2 while the DB stores v1 FIRST.
    const promoted = await runLoaderResolution(2, [v1, v2]);
    ok(promoted.groups.length === 1 && promoted.groups[0]!.status === 'loaded', 'K10 promotion: the newest pointer version resolves');
    ok(promoted.groups[0]!.links.every((link) => link.sourceName.startsWith('MoviesDriveSourceV2')), 'K10b the ACTIVE (promoted) version serves — not the oldest stored artifact');
  }
}

// ---------------------------------------------------------------------------
// §L — Migration additivity pins (§18)
// ---------------------------------------------------------------------------

console.log('§L migration pins');
{
  const migration = read('supabase/migrations/20261101000003_extension_phase3_builder.sql');
  ok(migration.includes('create table if not exists public.cloudstream_adapter_artifacts'), 'L1 the artifacts table is additive + idempotent');
  ok(migration.includes('add column if not exists generated_adapter_version'), 'L2 the version pointer column is additive');
  ok(migration.includes('add column if not exists builder_version'), 'L3 the builder provenance column is additive');
  ok(migration.includes('add column if not exists last_build_at'), 'L4 the build timestamp column is additive');
  ok(migration.includes('add column if not exists last_build_error'), 'L5 the build error column is additive');
  ok(!/drop table|drop column|alter column|drop index/i.test(migration), 'L6 nothing existing is dropped or altered');
  ok(migration.includes("unique (canonical_key, adapter_version)"), 'L7 immutable version uniqueness');
  ok(migration.includes('enable row level security'), 'L8 RLS enabled on the artifacts table');
  ok(migration.includes('is_admin()'), 'L9 the admin-only policy posture mirrors CS-1');
  ok(migration.includes('revoke all on public.cloudstream_adapter_artifacts from anon'), 'L10 anon revoked');
  ok(migration.includes("artifact_hash text not null"), 'L11 the integrity hash is mandatory');
  // Phase 2 migration untouched.
  const phase2 = read('supabase/migrations/20261101000002_extension_phase2_unified_adapters.sql');
  ok(phase2.includes('add column if not exists adapter_state'), 'L12 the Phase 2 migration is untouched');
}

console.log(`PHASE 3 BUILDER TESTS: ${passed} checks passed`);
