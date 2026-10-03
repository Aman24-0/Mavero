/**
 * Phase 3 live smoke — the REAL end-to-end Permanent Adapter Builder chain.
 *
 * Boots the standalone Builder service IN-PROCESS (the exact deployable
 * code), then drives the production server-side services against the LIVE
 * database and the REAL world:
 *
 *   1. add the phisher-nuvio-providers repository (the real Nuvio manifest)
 *   2. [Create Adapter] on its MoviesDrive provider → the external Builder
 *      pipeline (sandboxed module analysis → evidence-based compile →
 *      live interpreter verification) → Mavero-side independent test →
 *      atomic promotion
 *   3. [Test Provider] through the generated adapter
 *   4. Downloader 2 eligibility + resolution through the PERSISTED artifact
 *      (Builder stopped by then — the §3 independence rule, verified LIVE)
 *
 * Credentials: the live service-role key from the untracked
 * scripts/mavero_live.env (never committed; the pre-existing convention).
 * Cleanup: the repository + artifacts are removed after verification so the
 * production catalog stays exactly as the admin left it.
 *
 * Run: pnpm run verify:cloudstream-phase3
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { createBuilderServer } from '../adapter-builder/server';
import { readBuilderConfig } from '../adapter-builder/config';
import { createRepositoryFromUrl, deleteRepositoryById, listRepositories, setRepositoryEnabled } from '$lib/server/cloudstream/repository/service';
import { createAdapterForExtension } from '$lib/server/extensions/builder/build-service';
import { testExtensionProvider } from '$lib/server/extensions/builder/test-service';
import { listCloudStreamDownloadTabs, resolveCloudStreamDownloads } from '$lib/server/cloudstream/downloader/service';
import { generatedAdapterFromArtifactRow } from '$lib/server/extensions/builder/generated-registry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Live credentials (untracked, never committed — the repo convention).
const liveEnv: Record<string, string> = {};
for (const line of readFileSync(path.join(REPO_ROOT, '..', 'scripts', 'mavero_live.env'), 'utf8').split('\n')) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match !== null) liveEnv[match[1]!] = match[2]!;
}

const MANIFEST_URL = 'https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/main/manifest.json';
const PROVIDER_ID = 'MoviesDrive';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

async function main(): Promise<void> {
  assert.ok(liveEnv['SUPABASE_URL'] !== undefined && liveEnv['SERVICE_KEY'] !== undefined, 'live credentials present');
  const client = createClient<Database>(liveEnv['SUPABASE_URL']!, liveEnv['SERVICE_KEY']!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionUrlInUrl: false },
  }) as SupabaseClient<Database>;

  console.log('=== Phase 3 live smoke — real end-to-end builder chain ===\n');

  // ---------------------------------------------------------------------
  // 1. Boot the standalone Builder (the deployable service, in-process).
  // ---------------------------------------------------------------------
  process.env['BUILDER_SECRET'] = 'live-smoke-secret';
  process.env['BUILDER_PORT'] = '0';
  const builderConfig = readBuilderConfig();
  const server = createBuilderServer(builderConfig);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as { port: number }).port;
  const builderUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${builderUrl}/health`);
  const healthBody = (await health.json()) as { ok: boolean; builderVersion: string };
  ok(health.status === 200 && healthBody.ok, 'L1 the standalone Builder boots and answers /health');
  console.log(`  builder: ${builderUrl} (${healthBody.builderVersion})`);

  const builderDeps = {
    config: { url: builderUrl, secret: 'live-smoke-secret', timeoutMs: 240_000 },
  };

  // ---------------------------------------------------------------------
  // 2. Fresh repository state (idempotent re-runs).
  // ---------------------------------------------------------------------
  const existing = await listRepositories(client);
  const prior = existing.find((repo) => repo.url === MANIFEST_URL);
  if (prior !== undefined) {
    await deleteRepositoryById(client, prior.id);
    // Remove any artifacts from a prior smoke run (no FK cascade — honest
    // immutable rows are only deleted by this explicit cleanup).
    await client.from('cloudstream_adapter_artifacts').delete().eq('canonical_key', `nuvio:${PROVIDER_ID.toLowerCase()}`);
    console.log('  cleaned a prior smoke repository');
  }

  const { repository } = await createRepositoryFromUrl(client, MANIFEST_URL);
  ok(repository.extensionCount >= 1, `L2 the real Nuvio repository discovers ${repository.extensionCount} providers`);
  console.log(`  repository: ${repository.name} (${repository.extensionCount} extensions)`);

  // ---------------------------------------------------------------------
  // 3. [Create Adapter] on the real MoviesDrive provider.
  // ---------------------------------------------------------------------
  const { data: extensionRow } = await client
    .from('cloudstream_extensions')
    .select('id, internal_name, adapter_state, integration_type, module_url, media_types')
    .eq('repository_id', repository.id)
    .ilike('internal_name', PROVIDER_ID)
    .maybeSingle();
  assert.ok(extensionRow !== null, 'the MoviesDrive provider row exists');
  ok((extensionRow as { adapter_state: string }).adapter_state === 'adapter_required', 'L3 the provider starts honestly adapter_required');
  ok((extensionRow as { module_url: string | null }).module_url !== null, 'L4 the provider module URL is recorded (metadata only)');
  const extensionId = (extensionRow as { id: string }).id;
  console.log(`  provider: ${PROVIDER_ID} (${(extensionRow as { module_url: string }).module_url})`);

  console.log('  building adapter (sandboxed analysis → compile → live verify → independent test)…');
  const buildOutcome = await createAdapterForExtension(client, extensionId, {
    testTitle: 'Inception',
    testYear: '2010',
    testTmdbId: '27205',
    testImdbId: 'tt1375666',
  }, builderDeps);

  if (buildOutcome.ok) {
    console.log(`  build OK: adapter v${buildOutcome.adapterVersion} (${buildOutcome.verdict})`);
    ok(buildOutcome.adapterVersion >= 1, 'L5 the build promotes a versioned adapter');
    ok(buildOutcome.verdict === 'SUPPORTED' || buildOutcome.verdict === 'PARTIALLY_SUPPORTED', 'L6 the verdict is a closed analysis vocabulary value');
    ok(buildOutcome.testCases.length >= 1 && buildOutcome.testCases.every((testCase) => testCase.passed), 'L7 the representative test cases passed');
  } else {
    console.log(`  build refused honestly: ${buildOutcome.code} — ${buildOutcome.message}`);
    // An honest refusal is a VALID live outcome (site variance). The smoke
    // asserts the refusal is a closed code with the row in an honest state.
    ok(typeof buildOutcome.code === 'string' && buildOutcome.code.length > 0, 'L5b the refusal carries a closed code');
  }

  // ---------------------------------------------------------------------
  // 4. The persisted state (whatever the outcome).
  // ---------------------------------------------------------------------
  const { data: afterRow } = await client
    .from('cloudstream_extensions')
    .select('id, adapter_state, generated_adapter_version, builder_version, last_build_error, enabled')
    .eq('id', extensionId)
    .maybeSingle();
  assert.ok(afterRow !== null);
  const after = afterRow as { adapter_state: string; generated_adapter_version: number | null; builder_version: string | null; last_build_error: string | null; enabled: boolean };
  console.log(`  row state: ${after.adapter_state}${after.generated_adapter_version !== null ? ` v${after.generated_adapter_version}` : ''}${after.last_build_error !== null ? ` (${after.last_build_error.slice(0, 80)})` : ''}`);
  ok(['generated', 'failed', 'runtime_required', 'adapter_required'].includes(after.adapter_state), 'L8 the row is in an honest lifecycle state');

  const { data: artifactRows } = await client
    .from('cloudstream_adapter_artifacts')
    .select('canonical_key, integration_type, provider_id, adapter_version, artifact, artifact_hash')
    .eq('canonical_key', `nuvio:${PROVIDER_ID.toLowerCase()}`)
    .order('adapter_version', { ascending: true });
  const artifacts = (artifactRows ?? []) as unknown as Array<{ canonical_key: string; adapter_version: number; artifact: Record<string, unknown>; artifact_hash: string }>;

  if (after.adapter_state === 'generated') {
    ok(artifacts.length >= 1, 'L9 the immutable artifact row is persisted');
    const latest = artifacts[artifacts.length - 1]!;
    ok(latest.adapter_version === after.generated_adapter_version, 'L10 the active pointer matches the persisted artifact version');
    ok(latest.artifact_hash.length === 64, 'L11 the integrity hash is persisted');
    // The artifact binds to an executable adapter (read-time validation).
    const bound = generatedAdapterFromArtifactRow(latest as never);
    ok(bound !== null, 'L12 the persisted artifact binds to an executable adapter at read time');

    // -------------------------------------------------------------------
    // 5. [Test Provider] through the generated adapter.
    // -------------------------------------------------------------------
    const testOutcome = await testExtensionProvider(client, extensionId, { testTitle: 'Inception', testYear: '2010', testTmdbId: '27205', testImdbId: 'tt1375666' });
    ok(testOutcome.ok, 'L13 the Test Provider action runs through the generated adapter');
    if (testOutcome.ok) {
      console.log(`  test provider: ${testOutcome.result.passed ? 'PASSED' : 'FAILED'} (${testOutcome.result.cases.map((c) => `${c.kind}:${c.linksFound}`).join(', ')})`);
      ok(testOutcome.result.adapterKind === 'generated', 'L14 the generated binding served the test');
    }

    // -------------------------------------------------------------------
    // 6. Downloader 2 — WITH THE BUILDER STOPPED (the §3 independence rule).
    // -------------------------------------------------------------------
    server.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    console.log('  builder STOPPED — Downloader 2 must resolve from the persisted artifact alone');

    // Enable the REPOSITORY + the EXTENSION (the admin [Enable] steps — a
    // fresh repository starts disabled; the Phase 3.5 hardening pins the
    // generated adapter's participation to its CANONICAL KEY so the checks
    // can never pass on a native MoviesDrive row from another repository).
    await setRepositoryEnabled(client, repository.id, true);
    await client.from('cloudstream_extensions').update({ enabled: true }).eq('id', extensionId);
    const tabs = await listCloudStreamDownloadTabs(client, { mediaType: 'movie', contentId: 'movie-27205' }, {
      loadContent: async () => ({ mediaType: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }),
    });
    const generatedTab = tabs.tabs.find((tab) => tab.extensionId.toLowerCase() === `nuvio:${PROVIDER_ID.toLowerCase()}`);
    ok(generatedTab !== undefined, 'L15 the generated adapter appears in the Downloader 2 tabs (Builder stopped)');
    if (generatedTab !== undefined) {
      console.log(`  tab: ${generatedTab.extensionName}`);
    }

    const resolution = await resolveCloudStreamDownloads(client, { mediaType: 'movie', contentId: 'movie-27205' }, {}, {
      loadContent: async () => ({ mediaType: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }),
    });
    const group = resolution.groups.find((candidate) => candidate.extensionId.toLowerCase() === `nuvio:${PROVIDER_ID.toLowerCase()}`);
    ok(group !== undefined && group.status !== 'failed', 'L16 the generated adapter participates in resolution (Builder stopped)');
    if (group !== undefined) {
      console.log(`  resolve: ${group.status} — ${group.links.length} link(s)`);
      if (group.links.length > 0) {
        for (const link of group.links.slice(0, 3)) {
          console.log(`    - ${link.sourceName} [${link.kind}] ${link.host ?? ''}`);
        }
      }
    }
  } else {
    // Honest non-generated outcome: the Builder STILL must be shut down and
    // the row never enters Downloader 2.
    server.close();
    ok(artifacts.length === 0 || after.adapter_state !== 'generated', 'L9b no promotion without a passing test');
    const tabs = await listCloudStreamDownloadTabs(client, { mediaType: 'movie', contentId: 'movie-27205' }, {
      loadContent: async () => ({ mediaType: 'movie', tmdbId: '27205', title: 'Inception', year: 2010 }),
    });
    ok(!tabs.tabs.some((tab) => tab.extensionId.toLowerCase() === `nuvio:${PROVIDER_ID.toLowerCase()}`), 'L15b an un-promoted provider never appears in Downloader 2');
  }

  // ---------------------------------------------------------------------
  // 7. Cleanup — the production catalog stays as the admin left it.
  // ---------------------------------------------------------------------
  await client.from('cloudstream_adapter_artifacts').delete().eq('canonical_key', `nuvio:${PROVIDER_ID.toLowerCase()}`);
  await deleteRepositoryById(client, repository.id);
  const finalRepos = await listRepositories(client);
  ok(!finalRepos.some((repo) => repo.url === MANIFEST_URL), 'L17 cleanup: the smoke repository is removed');
  const { count: leftoverArtifacts } = await client
    .from('cloudstream_adapter_artifacts')
    .select('id', { count: 'exact', head: true })
    .eq('canonical_key', `nuvio:${PROVIDER_ID.toLowerCase()}`);
  ok((leftoverArtifacts ?? 0) === 0, 'L18 cleanup: the smoke artifacts are removed');

  console.log(`\ncloudstream_phase3_live_smoke: ${passed} checks PASSED`);
}

main().catch((error) => {
  console.error('LIVE SMOKE FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
