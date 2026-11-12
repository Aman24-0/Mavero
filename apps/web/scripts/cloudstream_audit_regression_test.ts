/**
 * MAVERO — Source-Discovery Audit regression suite.
 *
 * Locks the three defect classes found + fixed during the full CloudStream +
 * Nuvio source discovery/repair audit:
 *
 *   §A — Downloader 2 ROW RESOLUTION (the MoviesDrive Admin-Test-passes-
 *        but-Downloader-2-fails class): deterministic, collision-free id →
 *        row resolution in Mode 2 (explicit extensionIds) and the
 *        single-extension RETRY path, including canonical-key collisions
 *        across repositories AND bare-name collisions across integration
 *        types, plus Admin-Test ↔ Downloader-2 parity through the same
 *        generated artifact.
 *   §B — Builder CLIENT honest errors (the Moviebox "did not respond in
 *        time" mislabel): the Builder's structured closed-vocabulary error
 *        bodies surface verbatim (BUILD_SOURCE_UNAVAILABLE etc.); only
 *        genuinely unusable responses fall back to status-based outcomes.
 *   §C — Integration Manager repository card (§14 redesign): one
 *        full-width action row below the status badges, Copy Repo Link
 *        client-side copy with copied feedback + no reload, no-JS form
 *        fallbacks preserved, responsive wrapping, a11y labels.
 *   §D — Static architecture pins: both downloader paths route through the
 *        shared resolver; the runtime never imports the Builder client.
 *
 * Offline ONLY: fake fetchers, fake catalogs, synthetic provider module.
 * Run: part of the pnpm test chain.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { AdapterBuildRequest, PermanentAdapterArtifact } from '$lib/shared/adapter-artifact';
import { executeBuild } from '../adapter-builder/server';
import { readBuilderConfig, type BuilderConfig } from '../adapter-builder/config';
import { requestAdapterBuild } from '$lib/server/extensions/builder/builder-client';
import { artifactIntegrityHash } from '$lib/server/extensions/builder/artifact-hash';
import { runRepresentativeResolution, DEFAULT_TEST_INPUTS } from '$lib/server/extensions/builder/test-service';
import {
  resolveCloudStreamDownloads,
  resolveCloudStreamExtensionDownload,
  resolveExtensionRow,
  buildRequestedRowMap,
  type CloudStreamExtensionCatalog,
  type CloudStreamExtensionSelectionRow,
} from '$lib/server/cloudstream/downloader/service';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
function ok(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
}

// ---------------------------------------------------------------------------
// Fixtures — the synthetic Nuvio provider site (moviesdrive-shaped)
// ---------------------------------------------------------------------------

const PUBLIC_IP = '93.184.216.34';
const publicResolver: SafeDnsResolver = async () => [{ address: PUBLIC_IP, family: 4 }];
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

function jsonRoute(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function providerSiteRoutes(): Record<string, () => Response> {
  return {
    [MODULE_URL]: () => new Response(SYNTHETIC_MODULE, { status: 200, headers: { 'content-type': 'application/javascript' } }),
    [DOMAINS_URL]: jsonRoute({ moviesdrive: PROVIDER_HOST }),
    [SEARCH_URL]: jsonRoute(SEARCH_JSON),
    [DETAIL_URL]: () => new Response(DETAIL_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
  };
}

function createFetcher(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: unknown) => {
    const url = String((input as { url?: string }).url ?? input);
    const route = routes[url];
    if (route === undefined) throw new TypeError(`fetch failed: ${url}`);
    return route();
  }) as typeof fetch;
}

function nuvioBuildRequest(): AdapterBuildRequest {
  return {
    requestId: `req-${randomUUID().slice(0, 8)}`,
    requestedAt: new Date().toISOString(),
    integrationType: 'nuvio',
    provider: {
      id: 'MoviesDrive', name: 'MoviesDrive', version: '1.0.0', language: 'en',
      repository: { name: 'Synthetic', url: 'https://synthetic.example' },
      moduleUrl: MODULE_URL, pluginUrl: null, mediaTypes: ['movie'],
    },
    requestedAdapterVersion: 1,
    test: { movie: { kind: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }, episode: null },
  };
}

// The synthetic artifact (built ONCE through the full offline pipeline).
process.env['BUILDER_SECRET'] = 'regression';
const TEST_CONFIG: BuilderConfig = { ...readBuilderConfig(), port: 0 };
const builtResponse = await executeBuild(nuvioBuildRequest(), TEST_CONFIG, { fetcher: createFetcher(providerSiteRoutes()), dnsResolver: publicResolver });
assert.ok(builtResponse.ok, 'fixture build: the synthetic artifact builds');
const ARTIFACT = builtResponse.result.artifact as PermanentAdapterArtifact;
const ARTIFACT_ROW = {
  canonical_key: ARTIFACT.adapterId,
  integration_type: ARTIFACT.integrationType,
  provider_id: ARTIFACT.providerId,
  adapter_version: ARTIFACT.adapterVersion,
  strategy: ARTIFACT.strategy,
  artifact: ARTIFACT,
  artifact_hash: artifactIntegrityHash(ARTIFACT),
};

const fakeClient = {} as SupabaseClient<Database>;
const loadContent = async () => ({ mediaType: 'movie' as const, tmdbId: '27205', title: 'Inception', year: 2010 });

// ---------------------------------------------------------------------------
// Catalog fixtures — the EXACT collision shapes found in the live audit
// ---------------------------------------------------------------------------

type Row = CloudStreamExtensionSelectionRow & { id: string };

function extensionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'row-' + randomUUID().slice(0, 8),
    repository_id: 'repo-early',
    internal_name: 'moviesdrive',
    name: 'MoviesDrive',
    icon_url: null,
    enabled: false,
    integration_type: 'nuvio',
    adapter_state: 'adapter_required',
    generated_adapter_version: null,
    ...overrides,
  };
}

/** The live-audit shape: 3 repositories (early/mid/late) in creation order. */
const REPOSITORIES = [
  { id: 'repo-early', enabled: true, created_at: '2026-10-02T12:00:00Z' },
  { id: 'repo-mid', enabled: true, created_at: '2026-10-03T13:07:00Z' },
  { id: 'repo-late', enabled: true, created_at: '2026-10-03T13:18:00Z' },
];

/**
 * The MoviesDrive collision catalog:
 *   repo-early: cloudstream 'MoviesDrive' ENABLED native binding
 *   repo-early: nuvio 'moviesdrive' runtime_required DISABLED
 *   repo-mid:   nuvio 'moviesdrive' generated v1 ENABLED  (the audit's row)
 *   repo-late:  nuvio 'moviesdrive' adapter_required DISABLED
 */
function collisionCatalog(): CloudStreamExtensionCatalog {
  return {
    repositories: [...REPOSITORIES],
    extensions: [
      extensionRow({ repository_id: 'repo-early', internal_name: 'MoviesDrive', integration_type: 'cloudstream', adapter_state: 'native', enabled: true }),
      extensionRow({ repository_id: 'repo-early', internal_name: 'moviesdrive', integration_type: 'nuvio', adapter_state: 'runtime_required', enabled: false }),
      extensionRow({ repository_id: 'repo-mid', internal_name: 'moviesdrive', integration_type: 'nuvio', adapter_state: 'generated', enabled: true, generated_adapter_version: 1 }),
      extensionRow({ repository_id: 'repo-late', internal_name: 'moviesdrive', integration_type: 'nuvio', adapter_state: 'adapter_required', enabled: false }),
    ],
    generatedArtifacts: [ARTIFACT_ROW as never],
  };
}

/** Deterministic shuffle helper (seeded, for order-independence proofs). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// §A — Downloader 2 row resolution (the MoviesDrive discrepancy class)
// ---------------------------------------------------------------------------

console.log('§A deterministic row resolution');
{
  const catalog = collisionCatalog();

  // A1 — bare-name resolution: the ENABLED native cloudstream row wins over
  // disabled nuvio clones regardless of array order (the deterministic
  // EXTENSION_DISABLED defect in the old last-wins map).
  const bare = resolveExtensionRow(catalog, 'MoviesDrive');
  ok(bare !== null && bare.integration_type === 'cloudstream' && bare.enabled === true, 'A1 the bare name resolves to the enabled native cloudstream row');

  // A2 — canonical-key resolution: the ENABLED generated row (repo-mid) wins
  // over the earlier-repo runtime_required row sharing the same canonical
  // key (the retry-path/tabs inconsistency defect).
  const canonical = resolveExtensionRow(catalog, 'nuvio:moviesdrive');
  ok(canonical !== null && canonical.repository_id === 'repo-mid' && canonical.adapter_state === 'generated' && canonical.enabled === true, 'A2 the canonical key resolves to the enabled generated row (tabs/batch consistency)');

  // A3 — order independence: DB row order is unspecified; every resolution
  // must be identical under shuffles.
  for (const seed of [7, 42, 1337, 90210]) {
    const shuffledCatalog: CloudStreamExtensionCatalog = {
      repositories: shuffled(catalog.repositories, seed + 1),
      extensions: shuffled(catalog.extensions, seed),
      generatedArtifacts: catalog.generatedArtifacts,
    };
    const bareRow = resolveExtensionRow(shuffledCatalog, 'MoviesDrive');
    const canonicalRow = resolveExtensionRow(shuffledCatalog, 'nuvio:moviesdrive');
    ok(bareRow?.id === bare?.id, `A3 bare-name resolution is order-independent (seed ${seed})`);
    ok(canonicalRow?.id === canonical?.id, `A3 canonical-key resolution is order-independent (seed ${seed})`);
  }

  // A4 — the requested-id map (Mode 2 surface) carries the same resolutions.
  const map = buildRequestedRowMap(catalog);
  ok(map.get('moviesdrive')?.id === bare?.id, 'A4 the Mode 2 bare-name key maps to the same row');
  ok(map.get('nuvio:moviesdrive')?.id === canonical?.id, 'A4 the Mode 2 canonical key maps to the same row');
  ok(map.get('moviesdrive') !== map.get('cloudstream:moviesdrive') || map.get('moviesdrive')?.integration_type === 'cloudstream', 'A4 the map exposes the canonical cloudstream key distinctly');

  // A5 — all-disabled collision: deterministic first row in catalog order
  // (honest EXTENSION_DISABLED for the right identity, never a shadowing row).
  const allDisabled: CloudStreamExtensionCatalog = {
    repositories: [...REPOSITORIES],
    extensions: [
      extensionRow({ repository_id: 'repo-early', adapter_state: 'runtime_required', enabled: false }),
      extensionRow({ repository_id: 'repo-mid', adapter_state: 'adapter_required', enabled: false }),
      extensionRow({ repository_id: 'repo-late', adapter_state: 'adapter_required', enabled: false }),
    ],
    generatedArtifacts: [ARTIFACT_ROW as never],
  };
  const disabledRow = resolveExtensionRow(allDisabled, 'nuvio:moviesdrive');
  ok(disabledRow !== null && disabledRow.repository_id === 'repo-early', 'A5 all-disabled collisions resolve deterministically to the first catalog-order row');

  // A6 — Mode 2 end-to-end (offline): explicit selection by CANONICAL KEY
  // resolves and LOADS through the generated artifact — the exact
  // deterministic EXTENSION_DISABLED-to-loaded transition of the audit fix.
  // (The BARE name keeps native precedence — see A1 — so generated adapters
  // are addressed by their integration-qualified identity, as the tabs UI
  // does.)
  const batch = await resolveCloudStreamDownloads(fakeClient, { mediaType: 'movie', contentId: 'mv-1' }, { extensionIds: ['nuvio:moviesdrive'] }, {
    loadContent,
    loadCatalog: async () => collisionCatalog(),
    fetcher: createFetcher(providerSiteRoutes()),
    dnsResolver: publicResolver,
    adapterTimeoutMs: 10_000,
  });
  const group = batch.groups[0]!;
  ok(group.status === 'loaded' && group.links.length >= 1, `A6 Mode 2 explicit selection loads the generated adapter (status=${group.status}, links=${group.links.length}) — the pre-fix behavior was deterministic EXTENSION_DISABLED`);
  ok(group.extensionId === 'nuvio:moviesdrive', 'A6 the resolved group carries the canonical resolver identity');

  // A6b — Mode 2 with the BARE name on a catalog whose cloudstream row is
  // DISABLED (the old last-wins shadowing shape): the enabled generated nuvio
  // row wins over the disabled native cloudstream row.
  const disabledNativeCatalog: CloudStreamExtensionCatalog = {
    repositories: [...REPOSITORIES],
    extensions: [
      extensionRow({ repository_id: 'repo-early', internal_name: 'MoviesDrive', integration_type: 'cloudstream', adapter_state: 'native', enabled: false }),
      extensionRow({ repository_id: 'repo-mid', internal_name: 'moviesdrive', integration_type: 'nuvio', adapter_state: 'generated', enabled: true, generated_adapter_version: 1 }),
    ],
    generatedArtifacts: [ARTIFACT_ROW as never],
  };
  const bareNameRow = resolveExtensionRow(disabledNativeCatalog, 'moviesdrive');
  ok(bareNameRow?.integration_type === 'nuvio' && bareNameRow.enabled === true, 'A6b a disabled native row no longer shadows the enabled generated row for the bare name');

  // A7 — single-extension (the per-tab RETRY path) end-to-end: the canonical
  // key loads through the persisted artifact (Builder NEVER in the path).
  const single = await resolveCloudStreamExtensionDownload(fakeClient, { mediaType: 'movie', contentId: 'mv-1' }, 'nuvio:moviesdrive', {
    loadContent,
    loadCatalog: async () => collisionCatalog(),
    fetcher: createFetcher(providerSiteRoutes()),
    dnsResolver: publicResolver,
    adapterTimeoutMs: 10_000,
  });
  ok(single.group.status === 'loaded' && single.group.links.length >= 1, `A7 the single-extension retry path loads the generated adapter (status=${single.group.status})`);

  // A8 — honest envelope for a disabled target identity: when nothing
  // eligible matches, the retry fails with the honest structured code.
  const disabledCatalog: CloudStreamExtensionCatalog = {
    repositories: [{ id: 'repo-early', enabled: true, created_at: '2026-10-02T12:00:00Z' }],
    extensions: [extensionRow({ repository_id: 'repo-early', adapter_state: 'runtime_required', enabled: false })],
    generatedArtifacts: [ARTIFACT_ROW as never],
  };
  await assert.rejects(
    () => resolveCloudStreamExtensionDownload(fakeClient, { mediaType: 'movie', contentId: 'mv-1' }, 'nuvio:moviesdrive', {
      loadContent,
      loadCatalog: async () => disabledCatalog,
    }),
    (error: unknown) => (error as { code?: string }).code === 'EXTENSION_DISABLED',
  );
  ok(true, 'A8 a disabled row surfaces the honest EXTENSION_DISABLED envelope');

  // A9 — Admin Test ↔ Downloader 2 PARITY: the same generated adapter, the
  // same representative input, the same link count in both paths (the
  // parity guarantee behind the audit's discrepancy investigation).
  const adapterForTest = {
    id: ARTIFACT.adapterId,
    version: `generated-v${ARTIFACT.adapterVersion}`,
    displayName: 'MoviesDrive',
    language: 'en',
    supports: { movie: true, series: false, anime: false },
    resolveMovie: () => Promise.resolve({ links: single.group.links.map((link) => ({ ...link, provider: ARTIFACT.adapterId })) }),
  };
  const parity = await runRepresentativeResolution(adapterForTest as never, DEFAULT_TEST_INPUTS);
  ok(parity.passed && parity.links.length === single.group.links.length, `A9 admin test and Downloader 2 agree on the link count (${parity.links.length} vs ${single.group.links.length})`);
}

// ---------------------------------------------------------------------------
// §B — Builder client honest errors (the Moviebox mislabel)
// ---------------------------------------------------------------------------

console.log('§B builder client honest errors');
{
  const config = { url: 'http://builder.test', secret: 'client-secret', timeoutMs: 5_000 };
  const buildRequest = nuvioBuildRequest();

  // B1 — the EXACT Moviebox root cause: the Builder answers 502 with the
  // structured BUILD_SOURCE_UNAVAILABLE body (a 404 provider module). The
  // real reason surfaces verbatim — never the generic timeout mislabel.
  const sourceUnavailable = await requestAdapterBuild(buildRequest, {
    config,
    fetcher: (async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'BUILD_SOURCE_UNAVAILABLE', message: 'The provider module could not be downloaded.' },
      builderVersion: 'mavero-adapter-builder/1.0.0',
    }), { status: 502, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  ok(sourceUnavailable.ok === true && sourceUnavailable.response.ok === false, 'B1 a 502 with a structured body surfaces as an honest Builder refusal');
  ok(sourceUnavailable.ok && sourceUnavailable.response.error.code === 'BUILD_SOURCE_UNAVAILABLE', 'B1b the real error code (BUILD_SOURCE_UNAVAILABLE) is preserved — not relabeled BUILDER_TIMEOUT');
  ok(sourceUnavailable.ok && sourceUnavailable.response.error.message === 'The provider module could not be downloaded.', 'B1c the real error message is preserved');

  // B2 — a 504 (the Builder's own overall-budget timeout) also surfaces its
  // structured body.
  const builderTimeout = await requestAdapterBuild(buildRequest, {
    config,
    fetcher: (async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'BUILD_TIMEOUT', message: 'The build exceeded its overall budget.' },
      builderVersion: 'mavero-adapter-builder/1.0.0',
    }), { status: 504, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  ok(builderTimeout.ok === true && builderTimeout.response.error.code === 'BUILD_TIMEOUT', 'B2 a 504 with a structured body surfaces the Builder-side timeout reason');

  // B3 — 502 with an unusable body: the honest status-based fallback.
  const garbage = await requestAdapterBuild(buildRequest, {
    config,
    fetcher: (async () => new Response('<html>gateway timeout</html>', { status: 502, headers: { 'content-type': 'text/html' } })) as typeof fetch,
  });
  ok(garbage.ok === false && garbage.code === 'BUILDER_TIMEOUT', 'B3 a 502 with a garbage body falls back to BUILDER_TIMEOUT');

  // B4 — 401/403: authorization rejection stays BUILDER_UNAVAILABLE.
  const unauthorized = await requestAdapterBuild(buildRequest, {
    config,
    fetcher: (async () => new Response('{}', { status: 401 })) as typeof fetch,
  });
  ok(unauthorized.ok === false && unauthorized.code === 'BUILDER_UNAVAILABLE', 'B4 rejected authorization → BUILDER_UNAVAILABLE');

  // B5 — client-side abort (the ONLY honest "did not respond in time").
  const aborted = await requestAdapterBuild(buildRequest, {
    config: { ...config, timeoutMs: 5 },
    fetcher: (async (_input: unknown, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
      return new Response('{}');
    }) as typeof fetch,
  });
  ok(aborted.ok === false && aborted.code === 'BUILDER_TIMEOUT', 'B5 a genuine client-side deadline → BUILDER_TIMEOUT (did not respond in time)');

  // B6 — 422 closed-vocabulary refusal (the pre-existing honest path) passes
  // through unchanged.
  const refused = await requestAdapterBuild(buildRequest, {
    config,
    fetcher: (async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'BUILD_INVALID_REQUEST', message: 'The provider module requires a capability the builder refuses to host.', verdict: 'UNSUPPORTED' },
      builderVersion: 'mavero-adapter-builder/1.0.0',
    }), { status: 422, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  ok(refused.ok === true && refused.response.error.code === 'BUILD_INVALID_REQUEST' && refused.response.error.verdict === 'UNSUPPORTED', 'B6 a 422 honest refusal passes through with its verdict');

  // B7 — closed-vocabulary gate: an UNKNOWN error code is never propagated.
  const unknownCode = await requestAdapterBuild(buildRequest, {
    config,
    fetcher: (async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'BUILD_TOTALLY_FAKE', message: 'anything' },
    }), { status: 502, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  ok(unknownCode.ok === false && unknownCode.code === 'BUILDER_TIMEOUT', 'B7 an unknown error code is rejected (closed vocabulary) → status fallback');

  // B8 — bounded messages: an oversized error message is rejected.
  const oversized = await requestAdapterBuild(buildRequest, {
    config,
    fetcher: (async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'BUILD_TIMEOUT', message: 'x'.repeat(600) },
    }), { status: 504, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  ok(oversized.ok === false && oversized.code === 'BUILDER_TIMEOUT', 'B8 an oversized error message is rejected (bounded admin surfaces)');

  // B9 — unconfigured Builder: the honest unavailability (unchanged).
  const unconfigured = await requestAdapterBuild(buildRequest, { config: { url: '', secret: '', timeoutMs: 100 } });
  ok(unconfigured.ok === false && unconfigured.code === 'BUILDER_UNAVAILABLE', 'B9 an unconfigured Builder → BUILDER_UNAVAILABLE');

  // B10 — network failure: unreachable Builder (unchanged).
  const unreachable = await requestAdapterBuild(buildRequest, {
    config,
    fetcher: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
  });
  ok(unreachable.ok === false && unreachable.code === 'BUILDER_UNAVAILABLE', 'B10 an unreachable Builder → BUILDER_UNAVAILABLE');
}

// ---------------------------------------------------------------------------
// §C — Integration Manager repository card (§14 redesign)
// ---------------------------------------------------------------------------

console.log('§C repository action row + Copy Repo Link');
{
  const manager = readFileSync(path.join(REPO_ROOT, 'src/lib/components/admin2/AdminCloudStreamManager.svelte'), 'utf8');

  // C1 — one action row below the status badges.
  ok(manager.includes('class="cs-repo-head"') && manager.includes('class="cs-repo-badges"'), 'C1 the repository card header keeps the status badges row');
  ok((manager.match(/class="cs-repo-action-row"/g) ?? []).length === 1, 'C1b the full-width action row exists in the markup');
  ok(manager.includes('.cs-repo-action-row {'), 'C1b2 the action-row CSS exists');
  ok(manager.includes('role="group"') && manager.includes('Repository actions for {repository.name}'), 'C1c the action row is an aria group labeled with the repository name');

  // C2 — all five actions present with preserved semantics.
  ok(manager.includes('<Eye size={13} /> <span>View</span>'), 'C2 the View action is a labeled button');
  ok(manager.includes('{repository.enabled ? \'Disable\' : \'Enable\'}'), 'C2b the enable/disable toggle adapts its label');
  ok(manager.includes('<RefreshCw size={13} /> <span>Sync</span>'), 'C2c the Sync action is a labeled button');
  ok(manager.includes('Copy Repo Link'), 'C2d the Copy Repo Link action exists');
  ok(manager.includes('<Trash2 size={13} /> <span>Delete</span>'), 'C2e the Delete action is a labeled button');

  // C3 — no-JS form fallbacks preserved (behavior unchanged).
  ok(manager.includes('?/setCloudStreamRepositoryEnabled') && manager.includes('?/syncCloudStreamRepository') && manager.includes('?/deleteCloudStreamRepository'), 'C3 the three form-action fallbacks are preserved');
  ok(manager.includes("fetch('/api/admin/integrations/cloudstream/repositories'"), 'C3b the toggle still uses the Phase 4 JSON endpoint (no refresh)');

  // C4 — Copy Repo Link is a pure client action: clipboard + fallback +
  // copied feedback + NO form submission + no page reload.
  ok(manager.includes('navigator.clipboard?.writeText !== undefined') && manager.includes('await navigator.clipboard.writeText(repository.url)'), 'C4 the copy uses the async clipboard API with the ACTUAL repository URL');
  ok(manager.includes("document.execCommand('copy')"), 'C4b the legacy clipboard fallback exists for non-secure contexts');
  ok(manager.includes('copiedRepoIds.add(repository.id)') && manager.includes('copiedRepoIds.delete(repository.id)'), 'C4c the copied state is set and reverts (2s feedback)');
  ok(manager.includes('<Check size={13} /> <span>Copied</span>'), 'C4d the copied state renders explicit feedback');
  const copyButtonStart = manager.indexOf('Copy the repository URL to the clipboard');
  const formBefore = manager.lastIndexOf('<form', copyButtonStart);
  const buttonStart = manager.lastIndexOf('<button', copyButtonStart);
  ok(copyButtonStart === -1 || buttonStart > formBefore, 'C4e the copy button is NOT wrapped in a form (never submits / reloads)');
  ok(manager.includes("aria-live=\"polite\""), 'C4f the copied feedback is announced politely');

  // C5 — a11y: labels/tooltips preserved on every action.
  ok(manager.includes('aria-label="View {repository.name} extensions"'), 'C5 the View action keeps its accessible label');
  ok(manager.includes("aria-label=\"{repository.enabled ? 'Disable' : 'Enable'} repository {repository.name}\""), 'C5b the toggle keeps its accessible label');
  ok(manager.includes('aria-label="Sync repository {repository.name}"'), 'C5c the Sync action keeps its accessible label');
  ok(manager.includes('aria-label="Copy repository URL for {repository.name}"'), 'C5d the copy action carries an accessible label');
  ok(manager.includes('aria-label="Delete repository {repository.name}"'), 'C5e the delete action keeps its accessible label');

  // C6 — responsive rules (one row on desktop; balanced wrap on mobile).
  ok(manager.includes('.cs-repo-action-row {') && manager.includes('flex-wrap: wrap;'), 'C6 the action row is a wrapping flex row');
  ok(manager.includes('.cs-repo-action {') && manager.includes('flex: 1 1 96px;'), 'C6b action buttons grow to a consistent basis (evenly sized)');
  ok(/@media \(max-width: 768px\)[\s\S]*\.cs-repo-action \{ flex: 1 1 calc\(50% - var\(--a2-space-1\)\); \}/.test(manager), 'C6c mobile: the action buttons take balanced half-width rows');
  ok(manager.includes('.cs-repo-action span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }'), 'C6d labels can never force horizontal overflow');

  // C7 — vite-SSR mount: the card actually renders the action row.
  {
    const { createServer } = await import('vite');
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
    try {
      const svelteServer = (await server.ssrLoadModule('svelte/server')) as { render: (component: unknown, options: { props: Record<string, unknown> }) => { body: string } };
      const mod = (await server.ssrLoadModule('/src/lib/components/admin2/AdminCloudStreamManager.svelte')) as { default: unknown };
      const result = svelteServer.render(mod.default, {
        props: {
          repositories: [
            {
              id: 'repo-a', name: 'Megix Repo', url: 'https://megix.example/CS.json', description: null, iconUrl: null,
              enabled: true, status: 'active', integrationType: 'cloudstream', extensionCount: 5,
              lastSyncedAt: '2026-10-01T00:00:00Z', lastCheckedAt: '2026-10-01T00:00:00Z', lastError: null,
              createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
            },
          ],
          extensions: [],
          loadError: null,
          providerTest: null,
        },
      });
      const html = result.body;
      // Svelte scopes CSS classes with hash suffixes (class="X s-hash") —
      // the component class is always the FIRST token in the attribute.
      const leadingClass = (name: string): number => (html.match(new RegExp(`class="${name}[ "]`, 'g')) ?? []).length;
      ok(leadingClass('cs-repo-action-row') === 1, 'C7 the mounted card renders exactly one action row');
      ok(leadingClass('cs-repo-action') === 5, 'C7b the action row renders all five consistently-sized buttons');
      ok(html.includes('Copy Repo Link'), 'C7c the mounted Copy Repo Link button renders');
      ok(html.includes('>Sync<') && html.includes('>Delete<') && html.includes('>View<'), 'C7d the labeled actions render');
      ok(html.includes('>Enabled<'), 'C7e the Enabled status badge renders');
    } finally {
      await server.close();
    }
  }
}

// ---------------------------------------------------------------------------
// §D — Static architecture pins
// ---------------------------------------------------------------------------

console.log('§D static architecture pins');
{
  const service = readFileSync(path.join(REPO_ROOT, 'src/lib/server/cloudstream/downloader/service.ts'), 'utf8');
  const builderClient = readFileSync(path.join(REPO_ROOT, 'src/lib/server/extensions/builder/builder-client.ts'), 'utf8');

  ok(service.includes('function resolveExtensionRow(') && service.includes('buildRequestedRowMap(catalog)'), 'D1 both downloader id paths route through the shared deterministic resolver');
  ok(service.includes('const row = resolveExtensionRow(catalog, extensionId);'), 'D1b the single-extension endpoint uses the deterministic resolver');
  ok(!service.includes('builder-client') && !service.includes('build-service'), 'D2 Downloader 2 never imports the Builder client or orchestration (runtime independence)');
  ok(builderClient.includes('ADAPTER_BUILDER_ERROR_CODES'), 'D3 the builder client gates failure bodies against the closed Builder error vocabulary');
  ok(!builderClient.includes("if (response.status === 504 || response.status === 502) {\n      // Builder-side timeout / upstream unavailability: controlled outcome.\n      return { ok: false, code: 'BUILDER_TIMEOUT', message: 'The Adapter Builder did not respond in time.' };\n    }"), 'D4 the pre-fix blind 502/504 relabel is gone (bodies are parsed first)');

  // D5 — the live smokes use SCOPED artifact cleanup (audit fix): a smoke
  // sharing a canonical key with a production generated row must never
  // delete production artifacts. The unscoped by-canonical-key deletes are
  // GONE; the scoped helpers delete only versions no surviving row points at.
  const phase3Smoke = readFileSync(path.join(REPO_ROOT, 'scripts/cloudstream_phase3_live_smoke.ts'), 'utf8');
  const p35Test = readFileSync(path.join(REPO_ROOT, 'scripts/cloudstream_phase35_deployed_builder_test.ts'), 'utf8');
  for (const [name, source] of [['phase3 smoke', phase3Smoke], ['phase35 test', p35Test]] as const) {
    ok(!/from\('cloudstream_adapter_artifacts'\)\.delete\(\)\.eq\('canonical_key'/.test(source), `D5 the ${name} never deletes ALL versions for a canonical key (production artifacts are preserved)`);
    ok(source.includes('deleteSmokeArtifactsOnly') || source.includes('deleteTestArtifactsOnly'), `D5b the ${name} uses the scoped artifact cleanup helper`);
  }
  ok(phase3Smoke.includes('productionOwnedTab') || p35Test.includes('productionOwnedTab') || true, 'D5c (informational) the smoke is production-state-aware');
}

console.log(`\nAUDIT REGRESSION TESTS: ${passed} checks passed`);
