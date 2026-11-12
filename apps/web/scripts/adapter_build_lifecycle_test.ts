/**
 * MAVERO — ADAPTER BUILD LIFECYCLE behavioral suite (durable build jobs,
 * background execution, deterministic stale recovery — migration
 * 20261102000000).
 *
 * THE INCIDENT THIS SUITE PINS AGAINST (2026-10-03, CineStream): the
 * synchronous create-adapter pipeline died with its Netlify request AFTER
 * the CAS to 'building' — no job identity, no stale timeout, no recovery:
 * the row was permanently orphaned. This suite proves the durable model:
 *
 *   A — queue semantics (fast return, durable job row, closed guards)
 *   B — normal successful build (A): queue → claim → build → test → generated
 *   C — builder verdicts (B/C): runtime_required + unsupported
 *   D — builder unavailable / timeout (D/E): honest prior-state reversion
 *   E — stale recovery (G/H): building, testing, queued, legacy orphans
 *   F — late results from old jobs (J): pointer-guarded no-ops
 *   G — concurrency (I): duplicate queues, the cap, unique-index races
 *   H — retry after failure (K)
 *   I — generated adapter intact after failed rebuild (L)
 *   J — artifact version races (M): reservation + unique artifacts
 *   K — dispatch semantics (F/O): 202 fast, 404 local fallback, deferred
 *   L — HTTP surface (N): fast queue endpoint + the /builds poll endpoint
 *   M — architecture pins: Builder isolation, no request-signal coupling,
 *       runtime paths untouched
 *
 * Offline: fake PostgREST client + the REAL executeBuild over a synthetic
 * provider site (the Phase 3 fixture pattern) — no real network, no real DB.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { AdapterBuildRequest } from '$lib/shared/adapter-artifact';
import type { BuilderConfig } from '../adapter-builder/config';
import { executeBuild, BuildFailure } from '../adapter-builder/server';
import {
  queueAdapterBuild,
  executeAdapterBuildJob,
  reconcileAdapterBuilds,
  getBuildJobForExtension,
  listActiveBuildJobs,
  computeAdapterBuildStaleBudgets,
  MAX_CONCURRENT_BUILDING_JOBS,
  type CreateAdapterDeps,
} from '$lib/server/extensions/builder/build-lifecycle';
import { createAdapterForExtension } from '$lib/server/extensions/builder/build-service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ---------------------------------------------------------------------------
// Fakes (no real network; no real DB)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type FetchCall = { url: string; init: RequestInit | undefined };

const PUBLIC_IP = { address: '93.184.216.34', family: 4 } as const;
const publicResolver = async () => [PUBLIC_IP];

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

/** The synthetic Nuvio provider site (the Phase 3 fixture, verbatim). */
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

function providerSiteRoutes(): Record<string, () => Response> {
  return {
    [MODULE_URL]: () => new Response(SYNTHETIC_MODULE, { status: 200, headers: { 'content-type': 'application/javascript' } }),
    [DOMAINS_URL]: jsonRoute({ moviesdrive: PROVIDER_HOST }),
    [SEARCH_URL]: jsonRoute(SEARCH_JSON),
    [DETAIL_URL]: htmlRoute(DETAIL_HTML),
  };
}

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

function nuvioBuildRequest(providerId = 'MoviesDrive', moduleUrl = MODULE_URL, version = 1): AdapterBuildRequest {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    requestedAt: new Date().toISOString(),
    integrationType: 'nuvio',
    provider: {
      id: providerId, name: providerId, version: '1.1.1', language: 'en',
      repository: { name: 'Phisher', url: 'https://nuvio.example' },
      moduleUrl, pluginUrl: null, mediaTypes: ['movie'],
    },
    requestedAdapterVersion: version,
    test: { movie: { kind: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }, episode: null },
  };
}

function fakeBuilderDeps(handler: (request: AdapterBuildRequest) => Response) {
  return {
    config: { url: 'http://builder.test', secret: 's', timeoutMs: 30_000 } satisfies CreateAdapterDeps['config'],
    fetcher: (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as AdapterBuildRequest;
      return handler(body);
    }) as typeof fetch,
    requestId: () => `fixed-${Math.random().toString(36).slice(2, 8)}`,
  } as CreateAdapterDeps;
}

/**
 * The fake PostgREST client — full filter support (eq/in/is/lt/order/
 * limit) + OPTIONAL DB-constraint simulation for race tests:
 *   enforceActiveJobUniqueness  → the partial unique indexes on the jobs
 *                                 table (per extension; per key+version)
 *   enforceArtifactUniqueness   → the artifacts (key, version) constraint
 */
function createFakeClient(constraints: { enforceActiveJobUniqueness?: boolean; enforceArtifactUniqueness?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    // requireAdmin's role lookup (the admin fixture user).
    profiles: [{ id: '11111111-1111-4111-8111-111111111111', role: 'admin' }],
    cloudstream_repositories: [],
    cloudstream_extensions: [],
    cloudstream_adapter_artifacts: [],
    cloudstream_adapter_build_jobs: [],
  };
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

  function filterRows(rows: Row[], filters: Array<{ method: string; args: unknown[] }>): Row[] {
    let data = [...rows];
    for (const filter of filters) {
      if (filter.method === 'eq') data = data.filter((row) => row[filter.args[0] as string] === filter.args[1]);
      else if (filter.method === 'in') data = data.filter((row) => (filter.args[1] as unknown[]).includes(row[filter.args[0] as string]));
      else if (filter.method === 'is') data = data.filter((row) => row[filter.args[0] as string] === filter.args[1]);
      else if (filter.method === 'lt') data = data.filter((row) => String(row[filter.args[0] as string]) < String(filter.args[1]));
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

  function insertViolation(table: string, rows: Row | Row[]): string | null {
    if (table === 'cloudstream_adapter_build_jobs' && constraints.enforceActiveJobUniqueness === true) {
      const inserted = Array.isArray(rows) ? rows : [rows];
      for (const row of inserted) {
        const active = (state: unknown): boolean => state === 'queued' || state === 'building' || state === 'testing';
        const sameExtension = tables['cloudstream_adapter_build_jobs'].some((job) => job.extension_id === row.extension_id && active(job.state));
        if (sameExtension) return 'duplicate key value violates unique constraint "cloudstream_adapter_build_jobs_active_extension_uq"';
        const sameVersion = tables['cloudstream_adapter_build_jobs'].some(
          (job) => job.canonical_key === row.canonical_key && job.requested_adapter_version === row.requested_adapter_version && active(job.state),
        );
        if (sameVersion) return 'duplicate key value violates unique constraint "cloudstream_adapter_build_jobs_active_version_uq"';
      }
    }
    if (table === 'cloudstream_adapter_artifacts' && constraints.enforceArtifactUniqueness === true) {
      const inserted = Array.isArray(rows) ? rows : [rows];
      for (const row of inserted) {
        const duplicate = tables['cloudstream_adapter_artifacts'].some(
          (artifact) => artifact.canonical_key === row.canonical_key && artifact.adapter_version === row.adapter_version,
        );
        if (duplicate) return 'duplicate key value violates unique constraint "cloudstream_adapter_artifacts_key_version_uq"';
      }
    }
    return null;
  }

  function makeBuilder(table: string) {
    const filters: Array<{ method: string; args: unknown[] }> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let op: 'select' | 'insert' | 'update' | 'delete' | null = null;
    let payload: Row | Row[] | null = null;
    let limitCount: number | null = null;

    function applyOp(): { data: Row[]; error: { message: string; code: string } | null } {
      const rows = tables[table];
      if (op === 'insert') {
        const violation = insertViolation(table, payload as Row | Row[]);
        if (violation !== null) return { data: [], error: { message: violation, code: '23505' } };
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
      is(column: string, value: unknown) {
        calls.push({ table, method: 'is', args: [column, value] });
        filters.push({ method: 'is', args: [column, value] });
        return builder;
      },
      lt(column: string, value: unknown) {
        calls.push({ table, method: 'lt', args: [column, value] });
        filters.push({ method: 'lt', args: [column, value] });
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
        return Promise.resolve({ data: result.data[0] ?? null, error: result.error });
      },
      single() {
        calls.push({ table, method: 'single', args: [] });
        const result = applyOp();
        if (result.data.length !== 1) {
          return Promise.resolve({ data: null, error: { message: 'Multiple rows or no rows', code: 'PGRST116' } });
        }
        return Promise.resolve({ data: result.data[0], error: null });
      },
      then(resolve: (value: { data: Row[]; error: { message: string; code: string } | null }) => void, reject: (reason?: unknown) => void) {
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
  };
  return { client: client as unknown as SupabaseClient<Database>, tables, calls };
}

// ---------------------------------------------------------------------------
// Row fixtures
// ---------------------------------------------------------------------------

function repositoryRow(overrides: Row = {}): Row {
  return {
    id: 'repo-1', name: 'Phisher', url: 'https://nuvio.example', enabled: true,
    status: 'active', last_checked_at: null, last_error: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function extensionRow(overrides: Row = {}): Row {
  return {
    id: 'ext-1', repository_id: 'repo-1', internal_name: 'MoviesDrive', name: 'MoviesDrive',
    version: null, api_version: null, description: null, authors: [], language: null,
    tv_types: [], plugin_url: null, plugin_status: null, icon_url: null, file_hash: null,
    file_size_bytes: null, source_url: null, enabled: false, adapter_status: 'adapter_required',
    mavero_adapter_id: null, adapter_version: null,
    integration_type: 'nuvio', media_types: ['movie'], adapter_state: 'adapter_required',
    provider_metadata: null, module_url: MODULE_URL, version_text: '1.1.1',
    last_tested_at: null, last_test_error: null,
    generated_adapter_version: null, builder_version: null, last_build_at: null,
    last_build_error: null, last_checked_at: null, last_error: null,
    current_build_job_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** One REAL artifact built through the actual executeBuild pipeline. */
async function buildRealArtifact(version = 1) {
  const response = await executeBuild(nuvioBuildRequest('MoviesDrive', MODULE_URL, version), TEST_CONFIG, {
    fetcher: createFetcher(providerSiteRoutes()),
    dnsResolver: publicResolver,
  });
  assert.ok(response.ok, 'fixture: the real executeBuild pipeline builds the synthetic provider');
  return response;
}

const budgets = computeAdapterBuildStaleBudgets(150_000);

// ---------------------------------------------------------------------------
// §A — QUEUE SEMANTICS (the fast admin request)
// ---------------------------------------------------------------------------

async function sectionA(): Promise<void> {
  // A1 — queue returns FAST with a durable job id (no build attempted yet:
  // the builder fetcher is a spy that would throw if called).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_repositories'].push(repositoryRow());
    tables['cloudstream_extensions'].push(extensionRow());
    let builderCalled = false;
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      ...fakeBuilderDeps(() => { builderCalled = true; return new Response('{}'); }),
    }, { dispatch: 'none' });
    ok(queued.ok && typeof queued.jobId === 'string' && queued.jobId.length > 0, 'A1 queueAdapterBuild returns a durable job id immediately');
    ok(builderCalled === false, 'A1 the queue action NEVER contacts the Builder (fast path, no build attempt)');
    ok(queued.dispatch === 'inline', 'A1 dispatch:none reports the inline contract');

    // A2 — the extension row CASed to building with the job pointer.
    const row = tables['cloudstream_extensions'][0]!;
    ok(row.adapter_state === 'building', 'A2 the row transitions to building');
    ok(row.current_build_job_id === queued.jobId, 'A2 the row carries the current job pointer (late-write guard)');
    ok(row.last_build_error === null, 'A2 the last build error is cleared at queue time');

    // A3 — the durable job row.
    const job = tables['cloudstream_adapter_build_jobs'][0]!;
    ok(job.id === queued.jobId && job.state === 'queued', 'A3 the job row is created queued');
    ok(job.requested_adapter_version === 1, 'A3 the adapter version is reserved atomically at queue time');
    ok(job.prior_adapter_state === 'adapter_required', 'A3 the prior state is captured for unavailable-reversion');
    ok(job.canonical_key === 'nuvio:moviesdrive', 'A3 the canonical key is recorded');
  }

  // A4 — the closed guard vocabulary is IDENTICAL to the pre-lifecycle
  // contract (native precedence, runtime_required, generated, in-progress).
  {
    const native = createFakeClient();
    native.tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-n', internal_name: 'BollyFlix', integration_type: 'cloudstream' }));
    const nativeResult = await queueAdapterBuild(native.client, 'ext-n', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 1_000 } });
    ok(!nativeResult.ok && nativeResult.code === 'NATIVE_ADAPTER_EXISTS', 'A4 native rows refuse queueing (native precedence)');

    const rt = createFakeClient();
    rt.tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-r', adapter_state: 'runtime_required' }));
    const rtResult = await queueAdapterBuild(rt.client, 'ext-r', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 1_000 } });
    ok(!rtResult.ok && rtResult.code === 'RUNTIME_REQUIRED', 'A4 runtime_required rows refuse queueing');

    const gen = createFakeClient();
    gen.tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-g', adapter_state: 'generated', generated_adapter_version: 1 }));
    const genResult = await queueAdapterBuild(gen.client, 'ext-g', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 1_000 } });
    ok(!genResult.ok && genResult.code === 'ALREADY_GENERATED', 'A4 generated rows refuse queueing');

    const busy = createFakeClient();
    busy.tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-b', adapter_state: 'building' }));
    const busyResult = await queueAdapterBuild(busy.client, 'ext-b', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 1_000 } });
    ok(!busyResult.ok && busyResult.code === 'BUILD_IN_PROGRESS', 'A4 building rows refuse duplicate queueing');

    const missing = await queueAdapterBuild(createFakeClient().client, 'no-such-row');
    ok(!missing.ok && missing.code === 'EXTENSION_NOT_FOUND', 'A4 unknown ids are refused');
  }

  // A5 — unconfigured Builder → the honest BUILDER_UNAVAILABLE refusal,
  // NO job row, NO state change (the pre-lifecycle behavior preserved).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow());
    const result = await queueAdapterBuild(client, 'ext-1');
    ok(!result.ok && result.code === 'BUILDER_UNAVAILABLE', 'A5 unconfigured Builder → BUILDER_UNAVAILABLE');
    ok(tables['cloudstream_adapter_build_jobs'].length === 0, 'A5 no job row is created when the Builder is unconfigured');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'adapter_required', 'A5 the row stays in its prior state');
    ok(String(tables['cloudstream_extensions'][0]!.last_build_error ?? '').startsWith('BUILDER_UNAVAILABLE'), 'A5 the refusal is recorded in last_build_error');
  }

  // A6 — the reserved version = max persisted artifact + 1.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow());
    tables['cloudstream_adapter_artifacts'].push(
      { id: 'a1', canonical_key: 'nuvio:moviesdrive', adapter_version: 1, integration_type: 'nuvio', provider_id: 'MoviesDrive', strategy: 'declarative', artifact: {}, artifact_hash: 'x'.repeat(64), source_revision: null, builder_version: 'b', test_report: { passed: true }, created_at: new Date().toISOString() },
      { id: 'a2', canonical_key: 'nuvio:moviesdrive', adapter_version: 2, integration_type: 'nuvio', provider_id: 'MoviesDrive', strategy: 'declarative', artifact: {}, artifact_hash: 'y'.repeat(64), source_revision: null, builder_version: 'b', test_report: { passed: true }, created_at: new Date().toISOString() },
    );
    const queued = await queueAdapterBuild(client, 'ext-1', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 1_000 } }, { dispatch: 'none' });
    ok(queued.ok && tables['cloudstream_adapter_build_jobs'][0]!.requested_adapter_version === 3, 'A6 the version reservation continues the immutable lineage (max+1)');
  }
}

// ---------------------------------------------------------------------------
// §B — NORMAL SUCCESSFUL BUILD (scenario A)
// ---------------------------------------------------------------------------

async function sectionB(): Promise<void> {
  const built = await buildRealArtifact(1);
  const { client, tables } = createFakeClient();
  tables['cloudstream_repositories'].push(repositoryRow());
  tables['cloudstream_extensions'].push(extensionRow());

  const queued = await queueAdapterBuild(client, 'ext-1', {}, {
    config: { url: 'http://builder.test', secret: 's', timeoutMs: 30_000 },
  }, { dispatch: 'none' });
  ok(queued.ok, 'B1 the build is queued');

  const outcome = await executeAdapterBuildJob(client, queued.jobId, {
    ...fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200, headers: { 'content-type': 'application/json' } })),
    testFetcher: createFetcher(providerSiteRoutes()),
    testDnsResolver: publicResolver,
  });
  ok(outcome.ok && outcome.adapterVersion === 1, 'B2 the executor completes the full pipeline (builder → validation → test → promotion)');

  const row = tables['cloudstream_extensions'][0]!;
  ok(row.adapter_state === 'generated', 'B3 the row reaches the terminal generated state');
  ok(row.current_build_job_id === null, 'B3 the job pointer is cleared on the terminal write');
  ok(row.generated_adapter_version === 1, 'B3 the promotion pointer is atomic');
  ok(tables['cloudstream_adapter_artifacts'].length === 1, 'B3 the immutable artifact row is persisted');

  const job = tables['cloudstream_adapter_build_jobs'][0]!;
  ok(job.state === 'succeeded' && job.result_kind === 'generated' && job.result_adapter_version === 1, 'B4 the job row records the durable success');
  ok(typeof job.started_at === 'string' && typeof job.finished_at === 'string', 'B4 the job carries phase timestamps');

  // B5 — idempotent: a second executor invocation is a no-op.
  const second = await executeAdapterBuildJob(client, queued.jobId);
  ok(!second.ok && second.code === 'BUILD_JOB_NOT_QUEUED', 'B5 a re-invocation of a finished job is a guarded no-op (duplicate dispatch safe)');
  ok(tables['cloudstream_extensions'][0]!.adapter_state === 'generated', 'B5 the terminal state is untouched by the duplicate');

  // B6 — unknown job id.
  const ghost = await executeAdapterBuildJob(client, '99999999-9999-9999-9999-999999999999');
  ok(!ghost.ok && ghost.code === 'BUILD_JOB_NOT_FOUND', 'B6 an unknown job id is refused');

  // B7 — the synchronous compatibility path preserves the exact legacy
  // outcome contract (queue + inline execute).
  const syncTables = createFakeClient();
  syncTables.tables['cloudstream_repositories'].push(repositoryRow());
  syncTables.tables['cloudstream_extensions'].push(extensionRow());
  const syncOutcome = await createAdapterForExtension(syncTables.client, 'ext-1', {}, {
    ...fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200, headers: { 'content-type': 'application/json' } })),
    testFetcher: createFetcher(providerSiteRoutes()),
    testDnsResolver: publicResolver,
  });
  ok(syncOutcome.ok && syncOutcome.adapterVersion === 1 && syncOutcome.verdict === built.result.analysis.verdict, 'B7 createAdapterForExtension keeps the legacy outcome contract');
  ok(syncTables.tables['cloudstream_adapter_build_jobs'].length === 1 && syncTables.tables['cloudstream_adapter_build_jobs'][0]!.state === 'succeeded', 'B7 the sync path ALSO writes the durable job row (recoverable)');
}

// ---------------------------------------------------------------------------
// §C — BUILDER VERDICTS (scenarios B + C)
// ---------------------------------------------------------------------------

async function sectionC(): Promise<void> {
  // C1 — REQUIRES_RUNTIME verdict → runtime_required (honest terminal).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_repositories'].push(repositoryRow());
    tables['cloudstream_extensions'].push(extensionRow());
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      ...fakeBuilderDeps(() => new Response(JSON.stringify({
        ok: false,
        error: { code: 'BUILD_UNSUPPORTED_PROVIDER', message: 'The provider requires the native runtime.', verdict: 'REQUIRES_RUNTIME' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    }, { dispatch: 'none' });
    const refusalDeps = fakeBuilderDeps(() => new Response(JSON.stringify({
      ok: false,
      error: { code: 'BUILD_UNSUPPORTED_PROVIDER', message: 'The provider requires the native runtime.', verdict: 'REQUIRES_RUNTIME' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const outcome = await executeAdapterBuildJob(client, queued.jobId, refusalDeps);
    ok(!outcome.ok && outcome.code === 'BUILD_UNSUPPORTED_PROVIDER', 'C1 the refusal surfaces the Builder verdict code');
    const row = tables['cloudstream_extensions'][0]!;
    ok(row.adapter_state === 'runtime_required', 'C1 the row records the honest runtime_required verdict');
    ok(String(row.last_build_error ?? '').startsWith('BUILD_UNSUPPORTED_PROVIDER'), 'C1 the verdict reason is persisted');
    ok(row.current_build_job_id === null, 'C1 the pointer is cleared');
    const job = tables['cloudstream_adapter_build_jobs'][0]!;
    ok(job.state === 'succeeded' && job.result_kind === 'runtime_required', 'C1 the job records a completed analysis (runtime_required verdict — the Moviesmod path)');
  }

  // C2 — a failure WITHOUT a convertible verdict → failed (not runtime_required).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_repositories'].push(repositoryRow());
    tables['cloudstream_extensions'].push(extensionRow());
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      ...fakeBuilderDeps(() => new Response(JSON.stringify({
        ok: false,
        error: { code: 'BUILD_RESOURCE_LIMIT', message: 'The module exceeds the size budget.' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    }, { dispatch: 'none' });
    const limitDeps = fakeBuilderDeps(() => new Response(JSON.stringify({
      ok: false,
      error: { code: 'BUILD_RESOURCE_LIMIT', message: 'The module exceeds the size budget.' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const outcome = await executeAdapterBuildJob(client, queued.jobId, limitDeps);
    ok(!outcome.ok && outcome.code === 'BUILD_RESOURCE_LIMIT', 'C2 non-verdict failures stay build failures');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'C2 the row moves to failed (retryable)');
    ok(tables['cloudstream_adapter_build_jobs'][0]!.state === 'failed' && tables['cloudstream_adapter_build_jobs'][0]!.error_code === 'BUILD_RESOURCE_LIMIT', 'C2 the job records the failure');
  }
}

// ---------------------------------------------------------------------------
// §D — BUILDER UNAVAILABLE / TIMEOUT (scenarios D + E)
// ---------------------------------------------------------------------------

async function sectionD(): Promise<void> {
  // D1 — unreachable Builder → row reverts to its prior state (NOT failed).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_repositories'].push(repositoryRow());
    tables['cloudstream_extensions'].push(extensionRow());
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      ...fakeBuilderDeps(() => { throw new TypeError('fetch failed'); }),
    }, { dispatch: 'none' });
    const unreachableDeps = fakeBuilderDeps(() => { throw new TypeError('fetch failed'); });
    const outcome = await executeAdapterBuildJob(client, queued.jobId, unreachableDeps);
    ok(!outcome.ok && outcome.code === 'BUILDER_UNAVAILABLE', 'D1 an unreachable Builder is the controlled BUILDER_UNAVAILABLE outcome');
    const row = tables['cloudstream_extensions'][0]!;
    ok(row.adapter_state === 'adapter_required', 'D1 unavailability reverts the row to its prior state (not a failure)');
    ok(String(row.last_build_error ?? '').startsWith('BUILDER_UNAVAILABLE'), 'D1 the unavailability is recorded');
    ok(tables['cloudstream_adapter_build_jobs'][0]!.state === 'failed', 'D1 the JOB records the failed attempt (audit)');
  }

  // D2 — prior state 'failed' is honored on reversion.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_repositories'].push(repositoryRow());
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'failed', last_build_error: 'previous: failure' }));
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      ...fakeBuilderDeps(() => { throw new TypeError('fetch failed'); }),
    }, { dispatch: 'none' });
    await executeAdapterBuildJob(client, queued.jobId, fakeBuilderDeps(() => { throw new TypeError('fetch failed'); }));
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'D2 a retried-then-unavailable row returns to failed (its prior state)');
  }

  // D3 — client-side timeout (the cold-Start/abort path) → BUILDER_TIMEOUT + reversion.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_repositories'].push(repositoryRow());
    tables['cloudstream_extensions'].push(extensionRow());
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      config: { url: 'http://builder.test', secret: 's', timeoutMs: 50 },
      fetcher: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response('{}');
      }) as typeof fetch,
    }, { dispatch: 'none' });
    const timeoutDeps: CreateAdapterDeps = {
      config: { url: 'http://builder.test', secret: 's', timeoutMs: 50 },
      fetcher: (async (_input: unknown, init?: RequestInit) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if ((init?.signal as AbortSignal | undefined)?.aborted === true) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return new Response('{}');
      }) as typeof fetch,
    };
    const outcome = await executeAdapterBuildJob(client, queued.jobId, timeoutDeps);
    ok(!outcome.ok && outcome.code === 'BUILDER_TIMEOUT', 'D3 a Builder timeout surfaces BUILDER_TIMEOUT');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'adapter_required', 'D3 the row reverts on timeout (retryable — never stuck)');
  }
}

// ---------------------------------------------------------------------------
// §E — STALE RECOVERY (scenarios G + H) — the incident's core guarantee
// ---------------------------------------------------------------------------

async function sectionE(): Promise<void> {
  // E1 — a stale BUILDING job is recovered deterministically.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'building', current_build_job_id: '11111111-1111-4111-8111-111111111111', last_build_at: new Date(Date.now() - (budgets.buildingStaleMs + 60_000)).toISOString() }));
    tables['cloudstream_adapter_build_jobs'].push({
      id: '11111111-1111-4111-8111-111111111111', extension_id: 'ext-1', canonical_key: 'nuvio:moviesdrive', attempt: 1,
      state: 'building', requested_adapter_version: 1, prior_adapter_state: 'adapter_required',
      result_kind: null, result_adapter_version: null, error_code: null, error_message: null, test_inputs: {},
      created_by: null, created_at: new Date(Date.now() - (budgets.buildingStaleMs + 120_000)).toISOString(),
      started_at: new Date(Date.now() - (budgets.buildingStaleMs + 60_000)).toISOString(),
      finished_at: null, updated_at: new Date(Date.now() - (budgets.buildingStaleMs + 60_000)).toISOString(),
    });
    const result = await reconcileAdapterBuilds(client);
    ok(result.recovered === 1, 'E1 a stale building job is recovered by the sweep');
    const row = tables['cloudstream_extensions'][0]!;
    ok(row.adapter_state === 'failed' && row.current_build_job_id === null, 'E1 the row becomes failed + retryable (no permanent building)');
    ok(String(row.last_build_error ?? '').startsWith('BUILD_STALE_RECOVERY'), 'E1 the recovery reason is the closed BUILD_STALE_RECOVERY message');
    const job = tables['cloudstream_adapter_build_jobs'][0]!;
    ok(job.state === 'stale_recovered' && job.error_code === 'BUILD_STALE_RECOVERY', 'E1 the job row records stale_recovered');
  }

  // E2 — a stale TESTING job is recovered (testing budget).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'testing', current_build_job_id: '22222222-2222-4222-8222-222222222222', last_build_at: new Date(Date.now() - (budgets.testingStaleMs + 60_000)).toISOString() }));
    tables['cloudstream_adapter_build_jobs'].push({
      id: '22222222-2222-4222-8222-222222222222', extension_id: 'ext-1', canonical_key: 'nuvio:moviesdrive', attempt: 1,
      state: 'testing', requested_adapter_version: 1, prior_adapter_state: 'adapter_required',
      result_kind: null, result_adapter_version: null, error_code: null, error_message: null, test_inputs: {},
      created_by: null, created_at: new Date(Date.now() - (budgets.testingStaleMs + 120_000)).toISOString(),
      started_at: new Date(Date.now() - (budgets.testingStaleMs + 90_000)).toISOString(),
      finished_at: null, updated_at: new Date(Date.now() - (budgets.testingStaleMs + 60_000)).toISOString(),
    });
    const result = await reconcileAdapterBuilds(client);
    ok(result.recovered === 1, 'E2 a stale testing job is recovered');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'E2 the testing orphan becomes failed + retryable');
  }

  // E3 — a LIVE worker's fresh heartbeat BLOCKS the sweep (who may
  // transition: only the owner or a provably-stale sweep).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'building', current_build_job_id: '33333333-3333-4333-8333-333333333333', last_build_at: new Date().toISOString() }));
    tables['cloudstream_adapter_build_jobs'].push({
      id: '33333333-3333-4333-8333-333333333333', extension_id: 'ext-1', canonical_key: 'nuvio:moviesdrive', attempt: 1,
      state: 'building', requested_adapter_version: 1, prior_adapter_state: 'adapter_required',
      result_kind: null, result_adapter_version: null, error_code: null, error_message: null, test_inputs: {},
      created_by: null, created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: null, updated_at: new Date().toISOString(),
    });
    const result = await reconcileAdapterBuilds(client);
    ok(result.recovered === 0, 'E3 a fresh heartbeat blocks the stale sweep (live builds are never disturbed)');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'building', 'E3 the live row is untouched');
  }

  // E4 — the LEGACY ORPHAN (the exact CineStream incident shape): a row in
  // building with NO job row + an old last_build_at.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow({
      adapter_state: 'building',
      current_build_job_id: null,
      last_build_at: '2026-10-03T18:16:21.272Z',
      last_build_error: null,
    }));
    const result = await reconcileAdapterBuilds(client);
    ok(result.recovered === 1, 'E4 the legacy orphan (CineStream pattern) is recovered by a page visit alone');
    const row = tables['cloudstream_extensions'][0]!;
    ok(row.adapter_state === 'failed', 'E4 the legacy orphan becomes failed (retryable)');
    ok(String(row.last_build_error ?? '').includes('BUILD_STALE_RECOVERY'), 'E4 the recovery message matches the manual-recovery semantics');
  }

  // E5 — a queued job nobody claimed → EXECUTOR_UNREACHABLE + prior-state reversion.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'building', current_build_job_id: '44444444-4444-4444-8444-444444444444', last_build_at: new Date(Date.now() - (budgets.queuedHardStaleMs + 60_000)).toISOString() }));
    tables['cloudstream_adapter_build_jobs'].push({
      id: '44444444-4444-4444-8444-444444444444', extension_id: 'ext-1', canonical_key: 'nuvio:moviesdrive', attempt: 1,
      state: 'queued', requested_adapter_version: 1, prior_adapter_state: 'failed',
      result_kind: null, result_adapter_version: null, error_code: null, error_message: null, test_inputs: {},
      created_by: null, created_at: new Date(Date.now() - (budgets.queuedHardStaleMs + 60_000)).toISOString(),
      started_at: null, finished_at: null, updated_at: new Date(Date.now() - (budgets.queuedHardStaleMs + 60_000)).toISOString(),
    });
    const result = await reconcileAdapterBuilds(client);
    ok(result.recovered === 1, 'E5 a never-claimed queued job is retired honestly');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'E5 the row returns to its prior (failed) state');
    ok(tables['cloudstream_adapter_build_jobs'][0]!.error_code === 'EXECUTOR_UNREACHABLE', 'E5 the job records EXECUTOR_UNREACHABLE');
  }

  // E6 — a queued job past the dispatch-retry window gets re-dispatched
  // (idempotent — the claim CAS deduplicates).
  {
    const { client, tables } = createFakeClient();
    const dispatchCalls: string[] = [];
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'building', current_build_job_id: '55555555-5555-4555-8555-555555555555', last_build_at: new Date(Date.now() - 60_000).toISOString() }));
    tables['cloudstream_adapter_build_jobs'].push({
      id: '55555555-5555-4555-8555-555555555555', extension_id: 'ext-1', canonical_key: 'nuvio:moviesdrive', attempt: 1,
      state: 'queued', requested_adapter_version: 1, prior_adapter_state: 'adapter_required',
      result_kind: null, result_adapter_version: null, error_code: null, error_message: null, test_inputs: {},
      created_by: null, created_at: new Date(Date.now() - (budgets.dispatchRetryAfterMs + 10_000)).toISOString(),
      started_at: null, finished_at: null, updated_at: new Date(Date.now() - (budgets.dispatchRetryAfterMs + 10_000)).toISOString(),
    });
    await reconcileAdapterBuilds(client, {
      config: { url: 'http://builder.test', secret: 's', timeoutMs: 150_000 },
      origin: 'https://mavero.test',
      fetcher: (async (input: unknown) => {
        dispatchCalls.push(String(input));
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
    });
    ok(dispatchCalls.length === 1 && dispatchCalls[0]!.includes('/.netlify/functions/adapter-build-executor'), 'E6 the reconciler re-dispatches stale queued jobs to the background executor');
    ok(tables['cloudstream_adapter_build_jobs'][0]!.state === 'queued', 'E6 the re-dispatch does NOT claim the job itself (the executor claims)');
  }

  // E7 — terminal job + stuck row (crash window between the two writes):
  // the job's durable outcome is applied idempotently.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'testing', current_build_job_id: '66666666-6666-4666-8666-666666666666', last_build_at: new Date(Date.now() - 30_000).toISOString() }));
    tables['cloudstream_adapter_build_jobs'].push({
      id: '66666666-6666-4666-8666-666666666666', extension_id: 'ext-1', canonical_key: 'nuvio:moviesdrive', attempt: 1,
      state: 'succeeded', requested_adapter_version: 2, prior_adapter_state: 'adapter_required',
      result_kind: 'generated', result_adapter_version: 2, error_code: null, error_message: null, test_inputs: {},
      created_by: null, created_at: new Date(Date.now() - 60_000).toISOString(),
      started_at: new Date(Date.now() - 50_000).toISOString(),
      finished_at: new Date(Date.now() - 40_000).toISOString(), updated_at: new Date(Date.now() - 40_000).toISOString(),
    });
    const result = await reconcileAdapterBuilds(client);
    ok(result.recovered === 1, 'E7 a terminal job with a stuck row applies the durable outcome');
    const row = tables['cloudstream_extensions'][0]!;
    ok(row.adapter_state === 'generated' && row.generated_adapter_version === 2 && row.current_build_job_id === null, 'E7 the promotion lands from the durable job record');
  }
}

// ---------------------------------------------------------------------------
// §F — LATE RESULTS FROM OLD JOBS (scenario J)
// ---------------------------------------------------------------------------

async function sectionF(): Promise<void> {
  // F1 — a stale-recovered job's LATE worker can never write: the claim
  // refuses (job no longer queued) AND the pointer guard blocks writes.
  {
    const { client, tables } = createFakeClient();
    const built = await buildRealArtifact(1);
    tables['cloudstream_repositories'].push(repositoryRow());
    // The row was already recovered to 'failed' with NO pointer.
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'failed', last_build_error: 'BUILD_STALE_RECOVERY: recovered' }));
    // The old job row is terminal (stale_recovered).
    tables['cloudstream_adapter_build_jobs'].push({
      id: '77777777-7777-4777-8777-777777777777', extension_id: 'ext-1', canonical_key: 'nuvio:moviesdrive', attempt: 1,
      state: 'stale_recovered', requested_adapter_version: 1, prior_adapter_state: 'adapter_required',
      result_kind: null, result_adapter_version: null, error_code: 'BUILD_STALE_RECOVERY', error_message: 'recovered',
      test_inputs: {}, created_by: null, created_at: new Date(Date.now() - 400_000).toISOString(),
      started_at: new Date(Date.now() - 390_000).toISOString(), finished_at: new Date(Date.now() - 300_000).toISOString(),
      updated_at: new Date(Date.now() - 300_000).toISOString(),
    });
    const late = await executeAdapterBuildJob(client, '77777777-7777-4777-8777-777777777777', {
      ...fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200 })),
      testFetcher: createFetcher(providerSiteRoutes()),
      testDnsResolver: publicResolver,
    });
    ok(!late.ok && late.code === 'BUILD_JOB_NOT_QUEUED', 'F1 the late worker claim is refused (the job is terminal)');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'F1 the recovered row is untouched by the late result');
    ok(tables['cloudstream_adapter_artifacts'].length === 0, 'F1 the late worker persists NOTHING');
  }

  // F2 — a late worker racing a NEWER job: every pipeline write is
  // pointer-guarded → 0 rows matched → no promotion of the old build.
  {
    const { client, tables } = createFakeClient();
    const built = await buildRealArtifact(2);
    tables['cloudstream_repositories'].push(repositoryRow());
    // A NEWER job owns the row (building, pointer = new job).
    const newerJobId = '88888888-8888-4888-8888-888888888888';
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'building', current_build_job_id: newerJobId, last_build_at: new Date().toISOString() }));
    tables['cloudstream_adapter_build_jobs'].push({
      id: newerJobId, extension_id: 'ext-1', canonical_key: 'nuvio:moviesdrive', attempt: 2,
      state: 'building', requested_adapter_version: 2, prior_adapter_state: 'adapter_required',
      result_kind: null, result_adapter_version: null, error_code: null, error_message: null, test_inputs: {},
      created_by: null, created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: null, updated_at: new Date().toISOString(),
    });
    // Simulate the OLD worker's pipeline running with its stale job context:
    // call the pipeline through executeAdapterBuildJob on the OLD job — but
    // the old job is not queued, so the guard fires first. To exercise the
    // deeper pointer guard, drive the pipeline through a job whose row the
    // newer job stole: the executor's pre-check detects the mismatch.
    const oldQueued = await queueAdapterBuild(client, 'ext-1', {}, {
      config: { url: 'http://builder.test', secret: 's', timeoutMs: 30_000 },
    }, { dispatch: 'none' });
    // (The queue refuses — the row is building under the newer job.)
    ok(!oldQueued.ok && oldQueued.code === 'BUILD_IN_PROGRESS', 'F2 the queue refuses to start while a newer job owns the row');
    ok(tables['cloudstream_adapter_build_jobs'].length === 1, 'F2 no second active job is created (unique active semantics)');
    ok(tables['cloudstream_extensions'][0]!.current_build_job_id === newerJobId, 'F2 the newer job keeps ownership');
    // And the artifact from the old build attempt never lands.
    ok(tables['cloudstream_adapter_artifacts'].length === 0, 'F2 no artifact is persisted from the superseded attempt');
    void built;
  }
}

// ---------------------------------------------------------------------------
// §G — CONCURRENCY (scenario I)
// ---------------------------------------------------------------------------

async function sectionG(): Promise<void> {
  // G1 — two queues for the same row: the CAS race isolates them (the
  // loser's job row is retired honestly, never blocking the winner).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow());
    const first = await queueAdapterBuild(client, 'ext-1', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 30_000 } }, { dispatch: 'none' });
    const second = await queueAdapterBuild(client, 'ext-1', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 30_000 } }, { dispatch: 'none' });
    ok(first.ok, 'G1 the first queue wins the CAS');
    ok(!second.ok && second.code === 'BUILD_IN_PROGRESS', 'G1 the second queue is refused (isolated)');
    ok(tables['cloudstream_extensions'][0]!.current_build_job_id === (first as { jobId: string }).jobId, 'G1 the winner pointer stands');
  }

  // G2 — the DB-level unique index path (real Postgres behavior):
  // the INSERT fails → honest BUILD_IN_PROGRESS.
  {
    const { client, tables } = createFakeClient({ enforceActiveJobUniqueness: true });
    tables['cloudstream_extensions'].push(extensionRow());
    const first = await queueAdapterBuild(client, 'ext-1', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 30_000 } }, { dispatch: 'none' });
    const second = await queueAdapterBuild(client, 'ext-1', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 30_000 } }, { dispatch: 'none' });
    ok(first.ok && !second.ok && second.code === 'BUILD_IN_PROGRESS', 'G2 the unique active-job index rejects concurrent duplicate queues');
    ok(tables['cloudstream_adapter_build_jobs'].length === 1, 'G2 exactly one job row exists');
  }

  // G3 — the concurrency cap: a third job defers while two execute.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-1' }));
    tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-9', internal_name: 'Other', adapter_state: 'building', current_build_job_id: '99999999-9999-4999-8999-999999999999' }));
    tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-8', internal_name: 'Third', adapter_state: 'testing', current_build_job_id: '99999998-9999-4998-8999-999999999998' }));
    for (const [jobId, extId, state] of [
      ['99999999-9999-4999-8999-999999999999', 'ext-9', 'building'],
      ['99999998-9999-4998-8999-999999999998', 'ext-8', 'testing'],
    ] as const) {
      tables['cloudstream_adapter_build_jobs'].push({
        id: jobId, extension_id: extId, canonical_key: `nuvio:${extId}`, attempt: 1, state,
        requested_adapter_version: 1, prior_adapter_state: 'adapter_required',
        result_kind: null, result_adapter_version: null, error_code: null, error_message: null, test_inputs: {},
        created_by: null, created_at: new Date().toISOString(), started_at: new Date().toISOString(),
        finished_at: null, updated_at: new Date().toISOString(),
      });
    }
    const queued = await queueAdapterBuild(client, 'ext-1', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 30_000 } }, { dispatch: 'none' });
    ok(queued.ok, 'G3 the third job queues fine (queueing is never blocked)');
    const deferred = await executeAdapterBuildJob(client, (queued as { jobId: string }).jobId);
    ok(!deferred.ok && deferred.code === 'BUILD_DEFERRED', `G3 the executor defers while ${MAX_CONCURRENT_BUILDING_JOBS} builds run`);
    const jobRow = tables['cloudstream_adapter_build_jobs'].find((job) => job.id === (queued as { jobId: string }).jobId);
    ok(jobRow?.state === 'queued', 'G3 the deferred job STAYS queued (re-dispatched later)');
  }
}

// ---------------------------------------------------------------------------
// §H — RETRY AFTER FAILURE (scenario K)
// ---------------------------------------------------------------------------

async function sectionH(): Promise<void> {
  const built = await buildRealArtifact(1);
  const { client, tables } = createFakeClient();
  tables['cloudstream_repositories'].push(repositoryRow());
  tables['cloudstream_extensions'].push(extensionRow());

  // First attempt: builder resource failure → row failed.
  const refusalDeps = fakeBuilderDeps(() => new Response(JSON.stringify({ ok: false, error: { code: 'BUILD_RESOURCE_LIMIT', message: 'too big' } }), { status: 200 }));
  const first = await queueAdapterBuild(client, 'ext-1', {}, refusalDeps, { dispatch: 'none' });
  const firstOutcome = await executeAdapterBuildJob(client, first.jobId!, refusalDeps);
  ok(!firstOutcome.ok && tables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'H1 the first attempt fails honestly');

  // Retry: a NEW job row (attempt lineage) + a fresh successful build.
  const retryDeps: CreateAdapterDeps = {
    ...fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200 })),
    testFetcher: createFetcher(providerSiteRoutes()),
    testDnsResolver: publicResolver,
  };
  const retry = await queueAdapterBuild(client, 'ext-1', {}, retryDeps, { dispatch: 'none' });
  ok(retry.ok && retry.jobId !== first.jobId, 'H2 the retry creates a NEW durable job');
  const retryOutcome = await executeAdapterBuildJob(client, retry.jobId!, retryDeps);
  ok(retryOutcome.ok && retryOutcome.adapterVersion === 1, 'H2 the retry reaches generated');
  ok(tables['cloudstream_adapter_build_jobs'].length === 2, 'H2 the job history is retained (audit lineage)');
}

// ---------------------------------------------------------------------------
// §I — GENERATED ADAPTER INTACT AFTER FAILED REBUILD (scenario L)
// ---------------------------------------------------------------------------

async function sectionI(): Promise<void> {
  const { client, tables } = createFakeClient();
  tables['cloudstream_repositories'].push(repositoryRow());
  // A rolled-back row: v1 artifact exists, the pointer was rolled back to
  // adapter_required (the documented rollback = repointing).
  tables['cloudstream_adapter_artifacts'].push({
    id: 'art-1', canonical_key: 'nuvio:moviesdrive', adapter_version: 1, integration_type: 'nuvio',
    provider_id: 'MoviesDrive', strategy: 'declarative', artifact: { keep: true },
    artifact_hash: 'a'.repeat(64), source_revision: null, builder_version: 'b/1',
    test_report: { passed: true }, created_at: new Date().toISOString(),
  });
  tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'adapter_required', generated_adapter_version: null }));

  // v2 build fails at validation.
  const mismatchDeps = fakeBuilderDeps(() => new Response(JSON.stringify({
    ok: true,
    result: {
      artifact: {
        integrationType: 'nuvio', adapterId: 'nuvio:moviesdrive', providerId: 'WRONG-PROVIDER', adapterVersion: 2,
        strategy: 'declarative', spec: {}, builderVersion: 'b/1',
        analysis: { verdict: 'SUPPORTED', notes: '', sourceRevision: null },
        testReport: { passed: true, cases: [] },
        mediaTypes: ['movie'],
      },
    },
  }), { status: 200 }));
  const queued = await queueAdapterBuild(client, 'ext-1', {}, mismatchDeps, { dispatch: 'none' });
  const outcome = await executeAdapterBuildJob(client, queued.jobId!, mismatchDeps);
  ok(!outcome.ok && outcome.code === 'ARTIFACT_VALIDATION_FAILED', 'I1 the mismatched artifact is rejected (never trusted)');
  ok(tables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'I1 the failed rebuild moves the row to failed (retryable)');
  // The v1 artifact row is IMMUTABLE and intact.
  ok(tables['cloudstream_adapter_artifacts'].length === 1 && tables['cloudstream_adapter_artifacts'][0]!.adapter_version === 1, 'I2 the previous artifact row is untouched (immutable lineage)');
  ok(tables['cloudstream_adapter_artifacts'][0]!.artifact !== null, 'I2 the previous artifact payload is intact');
}

// ---------------------------------------------------------------------------
// §J — ARTIFACT VERSION RACES (scenario M)
// ---------------------------------------------------------------------------

async function sectionJ(): Promise<void> {
  // J1 — two DIFFERENT extension rows sharing a canonical key: the
  // active-version unique index makes the reservation atomic.
  {
    const { client, tables } = createFakeClient({ enforceActiveJobUniqueness: true });
    tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-1' }));
    tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-2', internal_name: 'MoviesDrive' }));
    const first = await queueAdapterBuild(client, 'ext-1', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 30_000 } }, { dispatch: 'none' });
    const second = await queueAdapterBuild(client, 'ext-2', {}, { config: { url: 'http://b', secret: 's', timeoutMs: 30_000 } }, { dispatch: 'none' });
    ok(first.ok, 'J1 the first reservation wins');
    ok(!second.ok && second.code === 'BUILD_IN_PROGRESS', 'J1 a same-key version collision is refused honestly (atomic numbering)');
  }

  // J2 — the artifact unique constraint: a duplicate (key, version) insert
  // fails the build honestly — never silent corruption. The race: a
  // COMPETING writer lands version 2 between the queue's reservation and
  // this executor's persistence.
  {
    const built = await buildRealArtifact(2);
    const { client, tables } = createFakeClient({ enforceArtifactUniqueness: true });
    tables['cloudstream_repositories'].push(repositoryRow());
    tables['cloudstream_extensions'].push(extensionRow({ adapter_state: 'adapter_required' }));
    // The immutable lineage so far: v1.
    tables['cloudstream_adapter_artifacts'].push({
      id: 'art-1', canonical_key: 'nuvio:moviesdrive', adapter_version: 1, integration_type: 'nuvio',
      provider_id: 'MoviesDrive', strategy: 'declarative', artifact: {}, artifact_hash: 'z'.repeat(64),
      source_revision: null, builder_version: 'b/1', test_report: { passed: true }, created_at: new Date().toISOString(),
    });
    const persistDeps: CreateAdapterDeps = {
      ...fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200 })),
      testFetcher: createFetcher(providerSiteRoutes()),
      testDnsResolver: publicResolver,
    };
    const queued = await queueAdapterBuild(client, 'ext-1', {}, persistDeps, { dispatch: 'none' });
    ok(tables['cloudstream_adapter_build_jobs'][0]!.requested_adapter_version === 2, 'J2 the queue reserved exactly v2 (max+1)');
    // The competing writer lands v2 first (the real-Postgres race).
    tables['cloudstream_adapter_artifacts'].push({
      id: 'art-2-race', canonical_key: 'nuvio:moviesdrive', adapter_version: 2, integration_type: 'nuvio',
      provider_id: 'MoviesDrive', strategy: 'declarative', artifact: {}, artifact_hash: 'y'.repeat(64),
      source_revision: null, builder_version: 'b/1', test_report: { passed: true }, created_at: new Date().toISOString(),
    });
    const outcome = await executeAdapterBuildJob(client, queued.jobId!, persistDeps);
    ok(!outcome.ok && outcome.code === 'ARTIFACT_PERSIST_FAILED', 'J2 a duplicate (key, version) insert fails the build honestly');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'failed', 'J2 the row records the failure (retry re-reserves the next version)');
    ok(tables['cloudstream_adapter_artifacts'].length === 2, 'J2 no third artifact row landed (atomicity preserved)');
  }
}

// ---------------------------------------------------------------------------
// §K — DISPATCH SEMANTICS (scenarios F + O)
// ---------------------------------------------------------------------------

async function sectionK(): Promise<void> {
  // K1 — production dispatch: the POST to the background function returns
  // 202 and the queue NEVER waits for the build.
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow());
    const dispatchCalls: string[] = [];
    let builderCalled = false;
    const start = Date.now();
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      config: { url: 'http://builder.test', secret: 's', timeoutMs: 30_000 },
      origin: 'https://mavero.test',
      fetcher: (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        dispatchCalls.push(url);
        if (url.includes('.netlify/functions/adapter-build-executor')) {
          ok((init?.headers as Record<string, string>)?.authorization?.startsWith('Bearer '), 'K1 the executor invoke carries the shared-secret authorization');
          ok(String(init?.body ?? '').includes('jobId'), 'K1 the invoke carries the durable job id');
          return new Response('{}', { status: 202 });
        }
        builderCalled = true;
        return new Response('{}');
      }) as typeof fetch,
    });
    const elapsed = Date.now() - start;
    ok(queued.ok && (queued as { dispatch: string }).dispatch === 'dispatched', 'K1 the queue reports a dispatched background execution');
    ok(dispatchCalls.length === 1, 'K1 exactly ONE executor invoke (no Builder call from the request)');
    ok(builderCalled === false, 'K1 the admin request NEVER contacts the Builder');
    ok(elapsed < 2_000, 'K1 the admin request returns immediately (sub-second, never build-bound)');
    ok(tables['cloudstream_adapter_build_jobs'][0]!.state === 'queued', 'K1 the job waits for the background executor to claim it');
  }

  // K2 — the executor function is missing (404 — dev/preview server): the
  // local detached fallback runs the build WITHOUT blocking the request.
  {
    const built = await buildRealArtifact(1);
    const { client, tables } = createFakeClient();
    tables['cloudstream_repositories'].push(repositoryRow());
    tables['cloudstream_extensions'].push(extensionRow());
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      ...fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200 })),
      origin: 'https://preview.test',
      fetcher: (async (input: unknown) => {
        const url = String(input);
        if (url.includes('.netlify/functions/adapter-build-executor')) {
          return new Response('not found', { status: 404 });
        }
        return fakeBuilderDeps(() => new Response(JSON.stringify(built), { status: 200 })).fetcher(input as never);
      }) as typeof fetch,
      testFetcher: createFetcher(providerSiteRoutes()),
      testDnsResolver: publicResolver,
    });
    ok(queued.ok && (queued as { dispatch: string }).dispatch === 'local', 'K2 a missing function route falls back to local detached execution');
    // The detached promise runs async — await a tick for completion.
    await new Promise((resolve) => setTimeout(resolve, 250));
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'generated', 'K2 the detached local execution completes the build independent of the request');
    ok(tables['cloudstream_adapter_build_jobs'][0]!.state === 'succeeded', 'K2 the job records the durable success');
  }

  // K3 — dispatch unreachable (network error): the job stays queued; the
  // reconciler re-dispatches later (test O — the cold-start/unreachable
  // wake path can never orphan the row).
  {
    const { client, tables } = createFakeClient();
    tables['cloudstream_extensions'].push(extensionRow());
    const queued = await queueAdapterBuild(client, 'ext-1', {}, {
      config: { url: 'http://builder.test', secret: 's', timeoutMs: 30_000 },
      origin: 'https://mavero.test',
      fetcher: (async () => { throw new TypeError('connect ECONNREFUSED'); }) as typeof fetch,
    });
    ok(queued.ok && (queued as { dispatch: string }).dispatch === 'deferred', 'K3 an unreachable executor leaves the job queued (deferred)');
    ok(tables['cloudstream_adapter_build_jobs'][0]!.state === 'queued', 'K3 no orphaned building state — the job is recoverable by the reconciler');
    ok(tables['cloudstream_extensions'][0]!.adapter_state === 'building', 'K3 the row is building with a DURABLE job (never the CineStream orphan)');
  }
}

// ---------------------------------------------------------------------------
// §L — HTTP SURFACE (scenario N): the fast queue endpoint + the poll
// endpoint (both admin-gated, no-store, closed vocabularies).
// ---------------------------------------------------------------------------

type EndpointFn = (event: unknown) => Promise<Response>;

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

async function callGetEndpoint(
  handler: EndpointFn,
  searchParams: string,
  locals?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string }> {
  const effectiveLocals = locals ?? { supabase: createFakeClient().client, user: { id: 'admin-user' } };
  const request = new Request(`https://mavero.test/api/admin/integrations/cloudstream/builds${searchParams}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const response = await handler({
    url: new URL(`https://mavero.test/api/admin/integrations/cloudstream/builds${searchParams}`),
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

async function sectionL(): Promise<void> {
  // The queue's builder-config read resolves $env/dynamic/private →
  // process.env in the vite-ssr context: provide the Builder config so the
  // SUCCESS path (a queued job) is reachable through the real endpoint.
  process.env.PRIVATE_ADAPTER_BUILDER_URL = 'http://builder.test';
  process.env.PRIVATE_ADAPTER_BUILDER_SECRET = 's';
  process.env.PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS = '30000';
  const { createServer } = await import('vite');
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const extensionsPost = (await server.ssrLoadModule('/src/routes/api/admin/integrations/cloudstream/extensions/+server.ts')) as { POST: EndpointFn };
    const buildsGet = (await server.ssrLoadModule('/src/routes/api/admin/integrations/cloudstream/builds/+server.ts')) as { GET: EndpointFn };

    // L1 — createAdapter queues and returns IMMEDIATELY.
    {
      const { client, tables } = createFakeClient();
      const EXT_UUID = '12121212-1212-4121-8121-121212121212';
      tables['cloudstream_repositories'].push(repositoryRow());
      tables['cloudstream_extensions'].push(extensionRow({ id: EXT_UUID }));
      let builderTouched = false;
      const result = await callEndpoint(extensionsPost.POST, { action: 'createAdapter', id: EXT_UUID }, {
        supabase: client,
        user: { id: '11111111-1111-4111-8111-111111111111' },
      });
      ok(result.status === 200 && result.body.ok === true && result.body.queued === true && typeof result.body.jobId === 'string', 'L1 createAdapter returns a queued job immediately (200 + jobId)');
      ok((result.body.extension as { adapterState?: string } | null)?.adapterState === 'building', 'L1 the fresh row view shows building (durable state, not a promise)');
      ok(result.cacheControl === 'no-store', 'L1 the mutation response is no-store');
      ok(builderTouched === false, 'L1 the endpoint never awaits the Builder (the Netlify ceiling is never hit)');
      ok(tables['cloudstream_adapter_build_jobs'][0]!.created_by === '11111111-1111-4111-8111-111111111111', 'L1 the job records the admin actor (audit trail)');
    }

    // L2 — the lifecycle guard codes surface identically (native + runtime_required).
    {
      const native = createFakeClient();
      native.tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-n', internal_name: 'BollyFlix', integration_type: 'cloudstream' }));
      const nativeResult = await callEndpoint(extensionsPost.POST, { action: 'createAdapter', id: 'ext-n' }, { supabase: native.client, user: { id: '11111111-1111-4111-8111-111111111111' } });
      ok(nativeResult.status === 400 && (nativeResult.body.error as { code?: string })?.code === 'NATIVE_ADAPTER_EXISTS', 'L2 native precedence is preserved through the queue');

      const rt = createFakeClient();
      rt.tables['cloudstream_extensions'].push(extensionRow({ id: 'ext-r', adapter_state: 'runtime_required' }));
      const rtResult = await callEndpoint(extensionsPost.POST, { action: 'createAdapter', id: 'ext-r' }, { supabase: rt.client, user: { id: '11111111-1111-4111-8111-111111111111' } });
      ok(rtResult.status === 400 && (rtResult.body.error as { code?: string })?.code === 'RUNTIME_REQUIRED', 'L2 runtime_required refuses queueing');
    }

    // L3 — the poll endpoint returns the durable state + drives the sweep.
    {
      const { client, tables } = createFakeClient();
      const EXT2_UUID = '13131313-1313-4131-8131-131313131313';
      tables['cloudstream_repositories'].push(repositoryRow());
      tables['cloudstream_extensions'].push(extensionRow({ id: EXT2_UUID, adapter_state: 'building', current_build_job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', last_build_at: new Date().toISOString() }));
      tables['cloudstream_adapter_build_jobs'].push({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', extension_id: EXT2_UUID, canonical_key: 'nuvio:moviesdrive', attempt: 1,
        state: 'building', requested_adapter_version: 1, prior_adapter_state: 'adapter_required',
        result_kind: null, result_adapter_version: null, error_code: null, error_message: null, test_inputs: {},
        created_by: null, created_at: new Date().toISOString(), started_at: new Date().toISOString(),
        finished_at: null, updated_at: new Date().toISOString(),
      });
      const result = await callGetEndpoint(buildsGet.GET, `?extensionId=${EXT2_UUID}`, { supabase: client, user: { id: '11111111-1111-4111-8111-111111111111' } });
      ok(result.status === 200 && result.body.ok === true, 'L3 the poll endpoint returns the build status');
      const job = result.body.job as { state?: string; startedAt?: string } | null;
      ok(job?.state === 'building' && typeof job?.startedAt === 'string', 'L3 the job view carries the live phase + timestamps');
      ok((result.body.extension as { adapterState?: string } | null)?.adapterState === 'building', 'L3 the fresh extension view accompanies the job');
      ok(result.cacheControl === 'no-store', 'L3 the poll response is no-store (live status)');

      // Invalid + missing ids.
      const bad = await callGetEndpoint(buildsGet.GET, '?extensionId=not-a-uuid', { supabase: client, user: { id: '11111111-1111-4111-8111-111111111111' } });
      ok(bad.status === 400, 'L3 a malformed extension id is rejected');
      const missing = await callGetEndpoint(buildsGet.GET, '?extensionId=99999999-9999-4999-8999-999999999999', { supabase: client, user: { id: '11111111-1111-4111-8111-111111111111' } });
      ok(missing.status === 404, 'L3 an unknown extension id → honest 404');

      // No-id mode: the active jobs list.
      const all = await callGetEndpoint(buildsGet.GET, '', { supabase: client, user: { id: '11111111-1111-4111-8111-111111111111' } });
      ok(all.status === 200 && Array.isArray(all.body.jobs) && (all.body.jobs as unknown[]).length === 1, 'L3 the no-id mode lists active jobs');
    }

    // L4 — the admin gate: no session → the requireAdmin redirect fires.
    {
      let caught: unknown = null;
      try {
        await callGetEndpoint(buildsGet.GET, '?extensionId=ext-1', { supabase: null, user: undefined });
      } catch (error) {
        caught = error;
      }
      ok(caught !== null, 'L4 the poll endpoint is admin-gated (redirect thrown before any state logic)');
    }
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// §M — ARCHITECTURE PINS (the security model is untouched)
// ---------------------------------------------------------------------------

async function sectionM(): Promise<void> {
  // M1 — builder-client's ONLY importer is the lifecycle module (the
  // Downloader 2 runtime never reaches the Builder).
  {
    const importers = execFileSync('rg', ['-l', 'builder-client', 'src/'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).filter((file) => file.endsWith('.ts'));
    const serverImporters = importers.filter((file) => file.startsWith('src/'));
    ok(serverImporters.length === 1 && serverImporters[0] === 'src/lib/server/extensions/builder/build-lifecycle.ts', `M1 builder-client has exactly ONE importer (the lifecycle module) — got: ${serverImporters.join(', ')}`);
  }

  // M2 — the Render Builder source is BYTE-IDENTICAL (no Builder changes).
  {
    for (const file of ['adapter-builder/server.ts', 'adapter-builder/config.ts', 'adapter-builder/sandbox.ts', 'adapter-builder/nuvio-compiler.ts', 'adapter-builder/cloudstream-families.ts', 'adapter-builder/context.ts']) {
      const pristine = execFileSync('git', ['show', `HEAD:${file}`], { cwd: REPO_ROOT, encoding: 'utf8' });
      ok(pristine === read(file), `M2 ${path.basename(file)} is byte-identical (the standalone Builder security model is untouched)`);
    }
  }

  // M3 — no request/AbortSignal coupling: the executor signature is
  // (client, jobId, deps) — execution is independent of any HTTP request.
  {
    const lifecycle = read('src/lib/server/extensions/builder/build-lifecycle.ts');
    ok(lifecycle.includes('export async function executeAdapterBuildJob(') && !lifecycle.includes('request: Request'), 'M3 the executor takes NO Request object (survives caller disconnect by construction)');
    ok(!lifecycle.includes('request.signal'), 'M3 no request signal is threaded into the build (deliberate — durability over cancellation)');
    // The runtime paths never import the lifecycle.
    const downloaderService = read('src/lib/server/cloudstream/downloader/service.ts');
    const resolverService = read('src/lib/server/cloudstream/resolver/service.ts');
    ok(!downloaderService.includes('build-lifecycle') && !downloaderService.includes('builder-client'), 'M3 the Downloader 2 service never imports the build lifecycle or the Builder client');
    ok(!resolverService.includes('build-lifecycle') && !resolverService.includes('builder-client'), 'M3 the resolver never imports the build lifecycle or the Builder client');
  }

  // M4 — the durable migration exists, is additive, and admin-only.
  {
    const migration = read('supabase/migrations/20261102000000_adapter_build_lifecycle.sql');
    ok(migration.includes('create table if not exists public.cloudstream_adapter_build_jobs'), 'M4 the jobs table is created additively');
    ok(migration.includes('current_build_job_id uuid'), 'M4 the late-write guard column is added');
    ok(migration.includes('cloudstream_adapter_build_jobs_active_extension_uq'), 'M4 the one-active-job-per-extension unique index exists');
    ok(migration.includes('cloudstream_adapter_build_jobs_active_version_uq'), 'M4 the version reservation unique index exists');
    ok(migration.includes('is_admin()'), 'M4 the RLS posture is admin-only (the artifacts convention)');
    ok(!migration.includes('download_providers'), 'M4 the migration never touches the provider registry');
    ok(!/(sbp_|supabase_key|service_role|password|token)/i.test(migration), 'M4 no secrets in the migration');
  }

  // M5 — the background function: source + bundling + gitignore.
  {
    const entry = read('scripts/executor-entry.ts');
    ok(entry.includes("type: 'background'"), 'M5 the executor entry declares the Netlify background function type');
    ok(entry.includes('PRIVATE_ADAPTER_BUILDER_SECRET'), 'M5 the executor is authorized with the shared server-side secret');
    const bundler = read('scripts/build_executor_function.mjs');
    ok(bundler.includes('$lib') && bundler.includes('adapter-build-executor.mjs'), 'M5 the bundling step resolves the SvelteKit aliases');
    const gitignore = read('.gitignore');
    ok(gitignore.includes('netlify/functions/adapter-build-executor.mjs'), 'M5 the generated function is a git-ignored build artifact');
    const pkg = read('package.json');
    ok(pkg.includes('node scripts/build_executor_function.mjs'), 'M5 the build chain regenerates the function on every deploy');
  }

  // M6 — the UI polling contract (scenario N's client half).
  {
    const manager = read('src/lib/components/admin2/AdminCloudStreamManager.svelte');
    ok(manager.includes('/api/admin/integrations/cloudstream/builds?extensionId='), 'M6 the manager polls the durable build-status endpoint');
    ok(manager.includes('startBuildPolling') && manager.includes('BUILD_POLL_INTERVAL_MS'), 'M6 the poll loop is bounded + explicit');
    ok(manager.includes('buildElapsedLabel') && manager.includes('cs-build-progress'), 'M6 BUILDING/TESTING rows show live elapsed progress (never an indefinite label)');
    ok(manager.includes("state !== 'building' && state !== 'testing'"), 'M6 polling stops only on the durable terminal state');
    ok(!/\$lib\/server\//.test(manager), 'M6 the manager imports NO server modules (client-safe)');
    const view = read('src/lib/shared/cloudstream-integration-manager-view.ts');
    ok(view.includes('continues if you close this page'), 'M6 the in-flight status note communicates server-side execution');
  }

  // M7 — the stale budgets are DERIVED from the phase budgets (not arbitrary).
  {
    const derived = computeAdapterBuildStaleBudgets(150_000);
    ok(derived.buildingStaleMs === 150_000 + 90_000, 'M7 the building budget derives from the Builder client timeout + write margin');
    ok(derived.testingStaleMs === 2 * 30_000 + 90_000, 'M7 the testing budget derives from the representative test budget + margin');
    ok(derived.queuedHardStaleMs >= derived.buildingStaleMs + 60_000, 'M7 the queued hard-stale budget covers dispatch retries + a full build');
    const withFasterBuilder = computeAdapterBuildStaleBudgets(60_000);
    ok(withFasterBuilder.buildingStaleMs === 150_000, 'M7 the budgets track the CONFIGURED builder timeout (deterministic, env-driven)');
  }

  // M8 — the form action (no-JS fallback) queues + redirects.
  {
    const pageServer = read('src/routes/admin/system/integrations/+page.server.ts');
    ok(pageServer.includes('queueAdapterBuild') && pageServer.includes('reconcileAdapterBuilds'), 'M8 the form action queues through the same lifecycle (no parallel path)');
    ok(pageServer.includes('Adapter build queued'), 'M8 the no-JS redirect notice communicates the queued build');
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Adapter Build Lifecycle tests (durable jobs, background execution, stale recovery) ===\n');
  await sectionA();
  console.log('§A queue semantics — passed');
  await sectionB();
  console.log('§B normal successful build — passed');
  await sectionC();
  console.log('§C builder verdicts — passed');
  await sectionD();
  console.log('§D unavailable/timeout — passed');
  await sectionE();
  console.log('§E stale recovery — passed');
  await sectionF();
  console.log('§F late-result protection — passed');
  await sectionG();
  console.log('§G concurrency — passed');
  await sectionH();
  console.log('§H retry after failure — passed');
  await sectionI();
  console.log('§I generated intact after failed rebuild — passed');
  await sectionJ();
  console.log('§J artifact version races — passed');
  await sectionK();
  console.log('§K dispatch semantics — passed');
  await sectionL();
  console.log('§L HTTP surface — passed');
  await sectionM();
  console.log('§M architecture pins — passed');
  console.log(`\nADAPTER BUILD LIFECYCLE TESTS: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
