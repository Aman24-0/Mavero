/**
 * Phase 3.5 — DEPLOYED Adapter Builder integration test.
 *
 * Verifies the production integration against an EXTERNAL, DEPLOYED Builder
 * service instance (a real standalone process running the committed Phase 3
 * code — the exact service definition that runs on Render):
 *
 *   security      §8/§14 endpoint matrix against the deployed URL
 *   e2e           §10 the real Create Adapter chain over real HTTP →
 *                 production Supabase persistence (§11)
 *   independence  §12 Downloader 2 resolves from the persisted artifact with
 *                 the Builder UNAVAILABLE (run this stage with the Builder
 *                 process STOPPED)
 *   rollback      §13 rebuild failure never destroys the old READY artifact
 *                 (run with the Builder process STOPPED)
 *   cleanup       removes the test repository + artifacts (the catalog ends
 *                 exactly as the admin left it)
 *
 * Credentials/URLs come from the untracked live env file (the pre-existing
 * convention — scripts/mavero_live.env one level above the repo root):
 *   SUPABASE_URL, SERVICE_KEY, P35_BUILDER_URL, P35_BUILDER_SECRET
 *
 * Run (one stage at a time; the driver sequences process lifecycle):
 *   pnpm exec tsx --tsconfig ./jsconfig.json \
 *     scripts/cloudstream_phase35_deployed_builder_test.ts <stage>
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { requestAdapterBuild } from '$lib/server/extensions/builder/builder-client';
import { createRepositoryFromUrl, deleteRepositoryById, listRepositories, setRepositoryEnabled } from '$lib/server/cloudstream/repository/service';
import { createAdapterForExtension } from '$lib/server/extensions/builder/build-service';
import { testExtensionProvider } from '$lib/server/extensions/builder/test-service';
import { listCloudStreamDownloadTabs, resolveCloudStreamDownloads } from '$lib/server/cloudstream/downloader/service';
import { generatedAdapterFromArtifactRow } from '$lib/server/extensions/builder/generated-registry';
import { artifactIntegrityHash } from '$lib/server/extensions/builder/artifact-hash';
import type { AdapterBuildRequest, AdapterBuildResponse } from '$lib/shared/adapter-artifact';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Live configuration (untracked, never committed — the repo convention).
const liveEnv: Record<string, string> = {};
for (const line of readFileSync(path.join(REPO_ROOT, '..', 'scripts', 'mavero_live.env'), 'utf8').split('\n')) {
  const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (match !== null) liveEnv[match[1]!] = match[2]!;
}

const MANIFEST_URL = 'https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/main/manifest.json';
const PROVIDER_ID = 'MoviesDrive';
const CANONICAL_KEY = `nuvio:${PROVIDER_ID.toLowerCase()}`;
const STATE_FILE = '/tmp/p35_state.json';
const TEST_INPUTS = { testTitle: 'Inception', testYear: '2010', testTmdbId: '27205', testImdbId: 'tt1375666' };
const LOAD_CONTENT = async () => ({ mediaType: 'movie' as const, tmdbId: '27205', title: 'Inception', year: 2010 });

const BUILDER_URL = (liveEnv['P35_BUILDER_URL'] ?? '').replace(/\/+$/, '');
const BUILDER_SECRET = liveEnv['P35_BUILDER_SECRET'] ?? '';

let passed = 0;
function ok(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${label}`);
}

function makeClient(): SupabaseClient<Database> {
  assert.ok(liveEnv['SUPABASE_URL'] !== undefined && liveEnv['SERVICE_KEY'] !== undefined, 'live credentials present');
  assert.ok(BUILDER_URL.length > 0 && BUILDER_SECRET.length > 0, 'deployed builder URL + secret present');
  return createClient<Database>(liveEnv['SUPABASE_URL']!, liveEnv['SERVICE_KEY']!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionUrlInUrl: false },
  }) as SupabaseClient<Database>;
}

async function writeState(state: Record<string, unknown>): Promise<void> {
  await import('node:fs/promises').then((fs) => fs.writeFile(STATE_FILE, JSON.stringify(state)));
}

async function readState(): Promise<{ extensionId: string } | null> {
  try {
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(STATE_FILE, 'utf8'));
    return JSON.parse(raw) as { extensionId: string };
  } catch {
    return null;
  }
}

/** The row for the test provider — the e2e-recorded extension id (unique). */
async function findTestExtensionRow(client: SupabaseClient<Database>): Promise<{ id: string; adapter_state: string; generated_adapter_version: number | null; builder_version: string | null } | null> {
  const state = await readState();
  if (state !== null && typeof state.extensionId === 'string') {
    const { data } = await client
      .from('cloudstream_extensions')
      .select('id, adapter_state, generated_adapter_version, builder_version')
      .eq('id', state.extensionId)
      .maybeSingle();
    return (data ?? null) as { id: string; adapter_state: string; generated_adapter_version: number | null; builder_version: string | null } | null;
  }
  return null;
}

function builderDeps(): { config: { url: string; secret: string; timeoutMs: number } } {
  return { config: { url: BUILDER_URL, secret: BUILDER_SECRET, timeoutMs: 300_000 } };
}

function validRequestShape(overrides: Record<string, unknown> = {}): AdapterBuildRequest {
  return {
    requestId: `p35-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedAt: new Date().toISOString(),
    integrationType: 'cloudstream',
    provider: { id: 'SecurityProbeProvider', mediaTypes: ['movie'] },
    test: { movie: { tmdbId: '27205', title: 'Inception', year: 2010 } },
    requestedAdapterVersion: 1,
    ...overrides,
  } as AdapterBuildRequest;
}

async function postBuild(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(`${BUILDER_URL}/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function probeBuilderReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BUILDER_URL}/health`, { signal: AbortSignal.timeout(4_000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stage: security (§8 / §14) — the deployed endpoint must reject everything
// it should, leak nothing, and accept only the authorized shape.
// ---------------------------------------------------------------------------

async function stageSecurity(): Promise<void> {
  console.log('=== Stage: security (deployed endpoint matrix) ===\n');
  assert.ok(await probeBuilderReachable(), 'PRECONDITION the deployed Builder is reachable');

  // 1. Health.
  const health = await fetch(`${BUILDER_URL}/health`);
  const healthBody = (await health.json()) as { ok: boolean; builderVersion: string };
  ok(health.status === 200 && healthBody.ok === true, 'S1 /health answers 200 ok');
  ok(healthBody.builderVersion === 'mavero-adapter-builder/1.0.0', 'S2 the deployed builder identifies its version');

  // 2. No / wrong bearer.
  const noAuth = await postBuild(validRequestShape());
  ok(noAuth.status === 401, 'S3 missing builder secret is rejected (401)');
  const badAuth = await postBuild(validRequestShape(), { authorization: 'Bearer definitely-not-the-secret' });
  ok(badAuth.status === 401, 'S4 incorrect builder secret is rejected (401)');

  // 3. Malformed payloads WITH the valid secret.
  const malformed = await postBuild('{not json', { authorization: `Bearer ${BUILDER_SECRET}` });
  ok(malformed.status === 400 && malformed.json?.['ok'] === false, 'S5 malformed JSON body is rejected');
  const badShape = await postBuild({ requestId: 'x' }, { authorization: `Bearer ${BUILDER_SECRET}` });
  ok(badShape.status === 400, 'S6 a wrong-shaped build payload is rejected');

  // 4. Oversized body (over the 64 KiB cap) → 413 drain-and-respond.
  const bigBody = JSON.stringify(validRequestShape({ padding: 'x'.repeat(80 * 1024) }));
  const oversized = await postBuild(bigBody, { authorization: `Bearer ${BUILDER_SECRET}` });
  ok(oversized.status === 413, 'S7 oversized payloads are rejected (413)');

  // 5. Unknown route / wrong method (no runtime routes exist AT ALL).
  const unknownRoute = await fetch(`${BUILDER_URL}/resolve`, { method: 'GET' });
  ok(unknownRoute.status === 404, 'S8 runtime routes do not exist (404)');
  const getBuild = await fetch(`${BUILDER_URL}/build`, { method: 'GET' });
  ok(getBuild.status === 404, 'S9 GET /build is not a route (404)');

  // 6. Timestamp skew bound.
  const skewed = validRequestShape({ requestedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
  const skewResponse = await postBuild(skewed, { authorization: `Bearer ${BUILDER_SECRET}` });
  ok(skewResponse.status === 400, 'S10 stale timestamps outside the skew window are rejected');

  // 7. Replay protection (same requestId + same body twice).
  const replayRequest = validRequestShape({ integrationType: 'cloudstream', provider: { id: 'UnknownFamilyProvider', mediaTypes: ['movie'] } });
  const first = await postBuild(replayRequest, { authorization: `Bearer ${BUILDER_SECRET}` });
  ok(first.status === 422, 'S11 an unmatched CloudStream provider is honestly refused (422)');
  const firstBody = first.json as { error?: { code?: string; verdict?: string } } | null;
  ok(firstBody?.error?.code === 'BUILD_UNSUPPORTED_PROVIDER', 'S12 the refusal carries the closed provider code');
  ok(firstBody?.error?.verdict === 'REQUIRES_RUNTIME', 'S13 the refusal verdict is REQUIRES_RUNTIME (honest)');
  const replayed = await postBuild(replayRequest, { authorization: `Bearer ${BUILDER_SECRET}` });
  ok(replayed.status === 409, 'S14 replayed requests are rejected (409)');

  // 8. SSRF: a nuvio provider whose module URL points at loopback must be
  //    refused without any fetch (assertSafeManifestUrl blocks private IPs).
  const ssrfRequest = validRequestShape({
    integrationType: 'nuvio',
    provider: { id: 'SsrfProbe', mediaTypes: ['movie'], moduleUrl: 'http://127.0.0.1:9/module.js' },
  });
  const ssrfResponse = await postBuild(ssrfRequest, { authorization: `Bearer ${BUILDER_SECRET}` });
  const ssrfBody = ssrfResponse.json as { error?: { code?: string } } | null;
  ok(ssrfResponse.status === 502 && ssrfBody?.error?.code === 'BUILD_SOURCE_UNAVAILABLE', 'S15 loopback module URLs are refused (SSRF guard)');

  // 9. Error hygiene: no stack traces, no filesystem paths, no secrets.
  const bodies = [noAuth.json, badAuth.json, malformed.json, badShape.json, oversized.json, first.json, replayed.json, ssrfResponse.json];
  const serialized = JSON.stringify(bodies);
  ok(!serialized.includes('at ') && !serialized.includes('/home/') && !serialized.includes('/tmp/'), 'S16 error bodies carry no stack traces or paths');
  ok(!serialized.includes(BUILDER_SECRET), 'S17 the builder never echoes the shared secret');
  ok(!serialized.toLowerCase().includes('password') && !serialized.toLowerCase().includes('token'), 'S18 error bodies carry no credential material');

  // 10. The deployed builder is NOT an open URL fetch service: an
  //     authenticated but unsupported nuvio source must fail honestly
  //     (both the omitted key and the explicit null — never a 500).
  const noModule = validRequestShape({ integrationType: 'nuvio', provider: { id: 'NoModuleProvider', mediaTypes: ['movie'] } });
  const noModuleResponse = await postBuild(noModule, { authorization: `Bearer ${BUILDER_SECRET}` });
  const noModuleBody = noModuleResponse.json as { error?: { code?: string } } | null;
  ok(noModuleResponse.status === 502 && noModuleBody?.error?.code === 'BUILD_SOURCE_UNAVAILABLE', 'S19 a missing module URL is an honest source failure (never a fetch-all, never a 500)');
  const nullModule = validRequestShape({ integrationType: 'nuvio', provider: { id: 'NullModuleProvider', mediaTypes: ['movie'], moduleUrl: null } });
  const nullModuleResponse = await postBuild(nullModule, { authorization: `Bearer ${BUILDER_SECRET}` });
  const nullModuleBody = nullModuleResponse.json as { error?: { code?: string } } | null;
  ok(nullModuleResponse.status === 502 && nullModuleBody?.error?.code === 'BUILD_SOURCE_UNAVAILABLE', 'S19b an explicit null module URL is the same honest source failure');

  console.log(`\nsecurity stage: ${passed} checks PASSED\n`);
}

// ---------------------------------------------------------------------------
// Stage: e2e (§10/§11) — the real Create Adapter chain over real HTTP.
// ---------------------------------------------------------------------------

async function stageE2E(): Promise<void> {
  console.log('=== Stage: e2e (deployed builder → production persistence) ===\n');
  const client = makeClient();
  assert.ok(await probeBuilderReachable(), 'PRECONDITION the deployed Builder is reachable');

  // Fresh state (idempotent re-runs).
  const existing = await listRepositories(client);
  const prior = existing.find((repo) => repo.url === MANIFEST_URL);
  if (prior !== undefined) {
    await client.from('cloudstream_adapter_artifacts').delete().eq('canonical_key', CANONICAL_KEY);
    await deleteRepositoryById(client, prior.id);
    console.log('  cleaned a prior run');
  }

  const { repository } = await createRepositoryFromUrl(client, MANIFEST_URL);
  ok(repository.extensionCount >= 1, `E1 the real Nuvio repository discovers ${repository.extensionCount} providers`);

  const { data: extensionRow } = await client
    .from('cloudstream_extensions')
    .select('id, internal_name, adapter_state, module_url, media_types')
    .eq('repository_id', repository.id)
    .ilike('internal_name', PROVIDER_ID)
    .maybeSingle();
  assert.ok(extensionRow !== null, 'the MoviesDrive provider row exists');
  const extensionId = (extensionRow as { id: string }).id;
  ok((extensionRow as { adapter_state: string }).adapter_state === 'adapter_required', 'E2 the provider starts honestly adapter_required');

  // The real build — over real HTTP to the DEPLOYED builder process.
  console.log('  [Create Adapter] → deployed Builder (sandbox → trace → compile → live verify)…');
  const startedAt = Date.now();
  const buildOutcome = await createAdapterForExtension(client, extensionId, TEST_INPUTS, builderDeps());
  const durationMs = Date.now() - startedAt;
  console.log(`  build finished in ${(durationMs / 1000).toFixed(1)}s`);
  ok(buildOutcome.ok === true, `E3 the deployed Builder build succeeds (code=${buildOutcome.ok ? '' : buildOutcome.code})`);
  assert.ok(buildOutcome.ok, 'the deployed build must succeed for the rest of the chain');
  ok(buildOutcome.adapterVersion >= 1, 'E4 the build promotes a versioned adapter');
  ok(['SUPPORTED', 'PARTIALLY_SUPPORTED'].includes(buildOutcome.verdict), 'E5 the verdict is a closed vocabulary value');
  ok(buildOutcome.testCases.length >= 1 && buildOutcome.testCases.every((c) => c.passed), 'E6 the representative test cases passed');

  // §11 persistence — the exact DB state after the real chain.
  const { data: afterRow } = await client
    .from('cloudstream_extensions')
    .select('adapter_state, generated_adapter_version, builder_version, last_tested_at, last_build_error, integration_type, internal_name, module_url, enabled')
    .eq('id', extensionId)
    .maybeSingle();
  assert.ok(afterRow !== null);
  const after = afterRow as { adapter_state: string; generated_adapter_version: number | null; builder_version: string | null; last_tested_at: string | null; last_build_error: string | null; integration_type: string; internal_name: string; module_url: string | null; enabled: boolean };
  ok(after.adapter_state === 'generated', 'E7 the row is promoted to generated (READY)');
  ok(after.generated_adapter_version === buildOutcome.adapterVersion, 'E8 the active pointer matches the built version');
  ok(after.builder_version === 'mavero-adapter-builder/1.0.0', 'E9 the builder metadata is recorded');
  ok(after.last_tested_at !== null, 'E10 the test timestamp is recorded');
  ok(after.integration_type === 'nuvio' && after.internal_name.toLowerCase() === 'moviesdrive', 'E11 provider identity is intact');
  ok(after.last_build_error === null, 'E12 no build error remains');

  const { data: artifactRows } = await client
    .from('cloudstream_adapter_artifacts')
    .select('canonical_key, integration_type, provider_id, adapter_version, strategy, artifact, artifact_hash, source_revision, builder_version, test_report, created_at')
    .eq('canonical_key', CANONICAL_KEY)
    .order('adapter_version', { ascending: true });
  const artifacts = (artifactRows ?? []) as unknown as Array<{
    canonical_key: string; integration_type: string; provider_id: string; adapter_version: number;
    strategy: string; artifact: Record<string, unknown>; artifact_hash: string;
    source_revision: string | null; builder_version: string; test_report: Record<string, unknown> | null; created_at: string;
  }>;
  ok(artifacts.length === 1, 'E13 exactly one immutable artifact row is persisted');
  const artifact = artifacts[0]!;
  ok(artifact.integration_type === 'nuvio' && artifact.provider_id.toLowerCase() === 'moviesdrive', 'E14 the artifact identity matches the provider');
  ok(artifact.adapter_version === after.generated_adapter_version, 'E15 the artifact version matches the active pointer');
  ok(artifact.strategy === 'declarative', 'E16 the artifact is a declarative (non-executable) artifact');
  ok(artifact.artifact_hash.length === 64 && /^[a-f0-9]+$/.test(artifact.artifact_hash), 'E17 the 64-hex integrity hash is persisted');
  ok(artifactIntegrityHash(artifact.artifact as never) === artifact.artifact_hash, 'E18 the hash verifies against the canonical serialization');
  ok(artifact.builder_version === 'mavero-adapter-builder/1.0.0', 'E19 the artifact records the builder version');
  ok((artifact.test_report as { passed?: boolean } | null)?.passed === true, 'E20 the artifact carries its passing test report');
  ok(artifact.created_at !== null, 'E21 the artifact row is timestamped');

  // The persisted artifact binds independently of the Builder.
  const bound = generatedAdapterFromArtifactRow(artifact as never);
  ok(bound !== null, 'E22 the persisted artifact binds to an executable adapter at read time (no Builder)');

  // [Test Provider] through the generated adapter.
  const testOutcome = await testExtensionProvider(client, extensionId, TEST_INPUTS);
  ok(testOutcome.ok === true, 'E23 the Test Provider action runs through the generated adapter');
  if (testOutcome.ok) {
    console.log(`  [Test Provider]: ${testOutcome.result.passed ? 'PASSED' : 'FAILED'} (${testOutcome.result.cases.map((c) => `${c.kind}:${c.linksFound}`).join(', ')})`);
    ok(testOutcome.result.passed === true, 'E24 the generated adapter test passes');
    ok(testOutcome.result.adapterKind === 'generated', 'E25 the generated binding served the test');
  }

  // Record the row for the later stages (separate processes).
  await writeState({ extensionId, repositoryId: repository.id, canonicalKey: CANONICAL_KEY });

  // Enable the REPOSITORY + the EXTENSION (the admin [Enable] steps — a
  // repository starts disabled by design; without enabling it the generated
  // adapter can never participate in Downloader 2).
  await setRepositoryEnabled(client, repository.id, true);
  await client.from('cloudstream_extensions').update({ enabled: true }).eq('id', extensionId);
  const tabs = await listCloudStreamDownloadTabs(client, { mediaType: 'movie', contentId: 'movie-27205' }, { loadContent: LOAD_CONTENT });
  const generatedTab = tabs.tabs.find((tab) => tab.extensionId.toLowerCase() === CANONICAL_KEY);
  ok(generatedTab !== undefined, 'E26 the generated adapter appears in Downloader 2 tabs (canonical key identity)');
  if (generatedTab !== undefined) console.log(`  tab id: ${generatedTab.extensionId}`);

  console.log(`\ne2e stage: ${passed} checks PASSED\n`);
}

// ---------------------------------------------------------------------------
// Stage: independence (§12) — Builder UNAVAILABLE; Downloader 2 still serves.
// Run this stage with the deployed Builder process STOPPED.
// ---------------------------------------------------------------------------

async function stageIndependence(): Promise<void> {
  console.log('=== Stage: independence (Builder STOPPED) ===\n');
  const client = makeClient();

  // Positive control: the Builder MUST be genuinely unreachable right now —
  // otherwise "resolution works" would prove nothing about independence.
  const probe = await requestAdapterBuild(validRequestShape(), { config: { url: BUILDER_URL, secret: BUILDER_SECRET, timeoutMs: 10_000 } });
  ok(probe.ok === false && probe.code === 'BUILDER_UNAVAILABLE', 'I1 positive control: the Builder is genuinely unavailable');

  const row = await findTestExtensionRow(client);
  assert.ok(row !== null, 'the provider row exists (run e2e first)');
  const ext = row;
  ok(ext.adapter_state === 'generated' && ext.generated_adapter_version !== null, 'I2 the READY artifact pointer survives (not removed)');

  const { data: artifactRows } = await client
    .from('cloudstream_adapter_artifacts')
    .select('canonical_key, integration_type, provider_id, adapter_version, strategy, artifact, artifact_hash, source_revision, builder_version, test_report')
    .eq('canonical_key', CANONICAL_KEY);
  const artifacts = (artifactRows ?? []) as unknown as Array<{ canonical_key: string; integration_type: string; provider_id: string; adapter_version: number; strategy: string; artifact: Record<string, unknown>; artifact_hash: string; source_revision: string | null; builder_version: string; test_report: Record<string, unknown> | null }>;
  ok(artifacts.length >= 1, 'I3 the persisted artifact rows remain');
  ok(generatedAdapterFromArtifactRow(artifacts[0]! as never) !== null, 'I4 the artifact still binds at read time (Builder absent)');

  // Downloader 2 — the tabs and the resolution, with the Builder DEAD. The
  // generated adapter's resolver identity is the CANONICAL KEY (nuvio:
  // moviesdrive) — distinct from any native cloudstream MoviesDrive rows.
  const tabs = await listCloudStreamDownloadTabs(client, { mediaType: 'movie', contentId: 'movie-27205' }, { loadContent: LOAD_CONTENT });
  ok(tabs.tabs.some((tab) => tab.extensionId.toLowerCase() === CANONICAL_KEY), 'I5 the generated adapter appears in Downloader 2 tabs (Builder stopped)');

  console.log('  resolving Downloader 2 with the Builder unavailable…');
  const resolution = await resolveCloudStreamDownloads(client, { mediaType: 'movie', contentId: 'movie-27205' }, {}, { loadContent: LOAD_CONTENT });
  const group = resolution.groups.find((candidate) => candidate.extensionId.toLowerCase() === CANONICAL_KEY);
  ok(group !== undefined && group.status !== 'failed', 'I6 the generated adapter participates in resolution (Builder stopped)');
  if (group !== undefined) {
    console.log(`  resolve: ${group.status} — ${group.links.length} link(s)`);
    for (const link of group.links.slice(0, 3)) {
      console.log(`    - ${link.sourceName} [${link.kind}] ${link.host ?? ''}`);
    }
    ok(group.links.length > 0, 'I7 Downloader 2 still returns the persisted adapter\'s links with NO Builder');
  }

  console.log(`\nindependence stage: ${passed} checks PASSED\n`);
}

// ---------------------------------------------------------------------------
// Stage: rollback (§13) — a failing rebuild never destroys the old READY
// artifact. Run with the Builder process STOPPED.
// ---------------------------------------------------------------------------

async function stageRollback(): Promise<void> {
  console.log('=== Stage: rollback (rebuild failure safety) ===\n');
  const client = makeClient();

  const probe = await requestAdapterBuild(validRequestShape(), { config: { url: BUILDER_URL, secret: BUILDER_SECRET, timeoutMs: 10_000 } });
  ok(probe.ok === false && probe.code === 'BUILDER_UNAVAILABLE', 'R1 positive control: the Builder is unavailable for the rebuild');

  const row = await findTestExtensionRow(client);
  assert.ok(row !== null, 'the provider row exists (run e2e first)');
  const ext = row;
  assert.ok(ext.adapter_state === 'generated', 'precondition: the provider is READY');

  // 1. Rebuild attempt on a READY row → closed refusal, NO builder call.
  const refusal = await createAdapterForExtension(client, ext.id, TEST_INPUTS, builderDeps());
  ok(refusal.ok === false && refusal.code === 'ALREADY_GENERATED', 'R2 a rebuild on a READY row is refused safely (no builder call)');

  // 2. Snapshot the artifact rows.
  const snapshot = await client
    .from('cloudstream_adapter_artifacts')
    .select('adapter_version, artifact_hash')
    .eq('canonical_key', CANONICAL_KEY)
    .order('adapter_version', { ascending: true });
  const before = ((snapshot.data ?? []) as unknown as Array<{ adapter_version: number; artifact_hash: string }>).map((r) => `${r.adapter_version}:${r.artifact_hash}`);

  // 3. The documented rollback-for-rebuild state (pointer re-version): the
  //    row returns to adapter_required while the v1 artifact is retained.
  await client.from('cloudstream_extensions').update({ adapter_state: 'adapter_required' }).eq('id', ext.id);

  // 4. Rebuild with the Builder DOWN → honest unavailable, row reverts,
  //    failure recorded, previous artifact untouched.
  const failedRebuild = await createAdapterForExtension(client, ext.id, TEST_INPUTS, builderDeps());
  ok(failedRebuild.ok === false && failedRebuild.code === 'BUILDER_UNAVAILABLE', 'R3 the rebuild with a dead Builder reports BUILDER_UNAVAILABLE honestly');

  const { data: afterRow } = await client.from('cloudstream_extensions')
    .select('adapter_state, last_build_error, generated_adapter_version')
    .eq('id', ext.id)
    .maybeSingle();
  const after = afterRow as { adapter_state: string; last_build_error: string | null; generated_adapter_version: number | null } | null;
  ok(after !== null && after.adapter_state === 'adapter_required', 'R4 the row reverts to its prior state (not failed)');
  ok(after?.last_build_error !== null && (after?.last_build_error ?? '').startsWith('BUILDER_UNAVAILABLE'), 'R5 the failure state is recorded with a closed code');
  ok(after?.generated_adapter_version !== null, 'R6 the previous version pointer was NOT destroyed');

  const snapshotAfter = await client
    .from('cloudstream_adapter_artifacts')
    .select('adapter_version, artifact_hash')
    .eq('canonical_key', CANONICAL_KEY)
    .order('adapter_version', { ascending: true });
  const afterArtifacts = ((snapshotAfter.data ?? []) as unknown as Array<{ adapter_version: number; artifact_hash: string }>).map((r) => `${r.adapter_version}:${r.artifact_hash}`);
  ok(JSON.stringify(before) === JSON.stringify(afterArtifacts), 'R7 the previous artifact rows + hashes are byte-identical (nothing destroyed)');

  // 5. Restore the pointer (the admin rollback) — the provider becomes
  //    usable again from the SAME persisted artifact.
  await client.from('cloudstream_extensions').update({ adapter_state: 'generated' }).eq('id', ext.id);
  const resolution = await resolveCloudStreamDownloads(client, { mediaType: 'movie', contentId: 'movie-27205' }, {}, { loadContent: LOAD_CONTENT });
  const group = resolution.groups.find((candidate) => candidate.extensionId.toLowerCase() === CANONICAL_KEY);
  ok(group !== undefined && group.links.length > 0, 'R8 the provider is usable again from the unchanged artifact (rollback safety)');

  console.log(`\nrollback stage: ${passed} checks PASSED\n`);
}

// ---------------------------------------------------------------------------
// Stage: cleanup — the production catalog ends as the admin left it.
// ---------------------------------------------------------------------------

async function stageCleanup(): Promise<void> {
  console.log('=== Stage: cleanup ===\n');
  const client = makeClient();

  await client.from('cloudstream_adapter_artifacts').delete().eq('canonical_key', CANONICAL_KEY);
  const repos = await listRepositories(client);
  const repo = repos.find((candidate) => candidate.url === MANIFEST_URL);
  if (repo !== undefined) await deleteRepositoryById(client, repo.id);

  const finalRepos = await listRepositories(client);
  ok(!finalRepos.some((candidate) => candidate.url === MANIFEST_URL), 'C1 the test repository is removed');
  const { count } = await client.from('cloudstream_adapter_artifacts').select('id', { count: 'exact', head: true }).eq('canonical_key', CANONICAL_KEY);
  ok((count ?? 0) === 0, 'C2 the test artifacts are removed');
  await import('node:fs/promises').then((fs) => fs.rm(STATE_FILE, { force: true }));

  console.log(`\ncleanup stage: ${passed} checks PASSED\n`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const stage = process.argv[2] ?? '';
  switch (stage) {
    case 'security': await stageSecurity(); break;
    case 'e2e': await stageE2E(); break;
    case 'independence': await stageIndependence(); break;
    case 'rollback': await stageRollback(); break;
    case 'cleanup': await stageCleanup(); break;
    default:
      console.error('usage: cloudstream_phase35_deployed_builder_test.ts <security|e2e|independence|rollback|cleanup>');
      process.exit(2);
  }
  console.log(`PHASE 3.5 DEPLOYED BUILDER TEST [${stage}]: ${passed} checks PASSED`);
}

main().catch((error) => {
  console.error('PHASE 3.5 TEST FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
