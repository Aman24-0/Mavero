/**
 * MAVERO — Create Adapter orchestration (Permanent Adapter Plan Phase 3 —
 * plan §7/§10/§11/§12/§13, D-P3-7).
 *
 * The ONLY caller of the external Adapter Builder (through builder-
 * client.ts). Invoked exclusively by the admin Create Adapter action —
 * NEVER by Downloader 2 (plan §3 hard rule).
 *
 * PIPELINE (test-before-ready, atomic version promotion):
 *   1. lifecycle guard (native → NATIVE_ADAPTER_EXISTS refusal, plan §16;
 *      runtime_required → not convertible; generated → already served;
 *      adapter_required/failed → eligible)
 *   2. CAS transition to 'building' (concurrent admin actions are isolated)
 *   3. next adapter version = previous max + 1 (immutable lineage)
 *   4. POST /build to the external Builder (bounded, authorized)
 *   5. MAVERO-SIDE artifact VALIDATION (schema + identity + version +
 *      integrity hash recompute — never trusts the Builder)
 *   6. CAS transition to 'testing' + MAVERO-SIDE INDEPENDENT representative
 *      test through the standard resolver (READY is NEVER granted on
 *      Builder HTTP 200 alone — plan §10/§11)
 *   7. pass → INSERT the immutable artifact row + ONE atomic promotion
 *      UPDATE (adapter_state='generated' + generated_adapter_version +
 *      builder_version + last_tested_at), guarded by the expected prior
 *      state. The OLD READY adapter keeps serving during the entire build;
 *      a failed build NEVER touches it (plan §12/§13).
 *   8. any failure → adapter_state='failed' + closed last_build_error
 *      (Builder unavailable → controlled BUILDER_UNAVAILABLE admin outcome,
 *      the row returns to its prior state; nothing was attempted).
 *
 * HONESTY RULES (D-P3-11): builder verdict REQUIRES_RUNTIME/UNSUPPORTED →
 * adapter_state='runtime_required' (the provider stays disabled — never a
 * fake 'generated'); no .cs3 execution; no Nuvio module JS execution in
 * Mavero EVER (the constrained DSL interpreter is the only artifact runtime).
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
  validateAdapterArtifact,
  canonicalArtifactId,
  type AdapterAnalysisVerdict,
  type AdapterBuildRequest,
  type AdapterBuildResponse,
  type AdapterTestCase,
  type AdapterTestCaseResult,
  type PermanentAdapterArtifact,
} from '$lib/shared/adapter-artifact';
import { artifactIntegrityHash } from './artifact-hash';
import { requestAdapterBuild, type BuilderClientDeps } from './builder-client';
import { generatedAdapterFromArtifactRow } from './generated-registry';
import { runRepresentativeResolution, parseProviderTestInputs, type ProviderTestInputs } from './test-service';
import { deriveAdapterState, canonicalAdapterKey } from '$lib/server/extensions/adapter-registry';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';

type CloudStreamClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Outcome contract (admin-facing, closed vocabulary)
// ---------------------------------------------------------------------------

export type CreateAdapterOutcome =
  | {
      ok: true;
      adapterVersion: number;
      verdict: AdapterAnalysisVerdict;
      notes: string;
      testCases: AdapterTestCaseResult[];
    }
  | { ok: false; code: string; message: string };

export type CreateAdapterDeps = BuilderClientDeps & {
  /** The provider-site fetcher for the INDEPENDENT test (tests; defaults to
   * the real network — the test must hit the actual provider). */
  testFetcher?: typeof fetch;
  /** Injectable DNS resolver for the independent test (tests). */
  testDnsResolver?: SafeDnsResolver;
  /** Per-case test timeout override (tests). */
  testAdapterTimeoutMs?: number;
  /** Injectable request-id generator (tests). */
  requestId?: () => string;
};

// ---------------------------------------------------------------------------
// Row loading
// ---------------------------------------------------------------------------

/** The extension row projection the orchestration reasons over. */
type BuildExtensionRow = {
  id: string;
  repository_id: string;
  internal_name: string;
  name: string | null;
  language: string | null;
  version_text: string | null;
  version: number | null;
  integration_type: string;
  plugin_status: number | null;
  plugin_url: string | null;
  module_url: string | null;
  media_types: string[];
  adapter_state: string;
  enabled: boolean;
};

async function loadExtensionRow(
  client: CloudStreamClient,
  extensionId: string,
): Promise<BuildExtensionRow | null> {
  if (typeof extensionId !== 'string' || extensionId.length === 0 || extensionId.length > 200) return null;
  const { data, error } = await client
    .from('cloudstream_extensions')
    .select('id, repository_id, internal_name, name, language, version_text, version, integration_type, plugin_status, plugin_url, module_url, media_types, adapter_state, enabled')
    .eq('id', extensionId)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return data as unknown as BuildExtensionRow;
}

/** The repository row projection (provider provenance in the build request). */
async function loadRepositoryRow(
  client: CloudStreamClient,
  repositoryId: string,
): Promise<{ name: string | null; url: string | null } | null> {
  const { data, error } = await client
    .from('cloudstream_repositories')
    .select('name, url')
    .eq('id', repositoryId)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return data as { name: string | null; url: string | null };
}

/** Highest persisted artifact version for a canonical key (0 when none). */
async function latestArtifactVersion(
  client: CloudStreamClient,
  canonicalKey: string,
): Promise<number> {
  const { data, error } = await client
    .from('cloudstream_adapter_artifacts')
    .select('adapter_version')
    .eq('canonical_key', canonicalKey)
    .order('adapter_version', { ascending: false })
    .limit(1);
  if (error !== null || data === null || data.length === 0) return 0;
  return (data[0] as { adapter_version: number }).adapter_version;
}

// ---------------------------------------------------------------------------
// State transitions (CAS — concurrent admin actions are isolated)
// ---------------------------------------------------------------------------

/** One guarded UPDATE; returns true when exactly one row transitioned. */
async function casTransition(
  client: CloudStreamClient,
  extensionId: string,
  from: readonly string[],
  patch: Partial<Database['public']['Tables']['cloudstream_extensions']['Update']>,
): Promise<boolean> {
  const { data, error } = await client
    .from('cloudstream_extensions')
    .update(patch)
    .eq('id', extensionId)
    .in('adapter_state', [...from])
    .select('id');
  if (error !== null) return false;
  return Array.isArray(data) && data.length === 1;
}

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

/**
 * Runs the full create-adapter pipeline for one extension row. Synchronous
 * (bounded by the builder timeout + test budgets) — the admin action awaits
 * the outcome; the row's persisted state is the durable progress record.
 */
export async function createAdapterForExtension(
  client: CloudStreamClient,
  extensionId: string,
  rawTestInputs: {
    testTmdbId?: string;
    testTitle?: string;
    testYear?: string;
    testImdbId?: string;
    testSeason?: string;
    testEpisode?: string;
  } = {},
  deps: CreateAdapterDeps = {},
): Promise<CreateAdapterOutcome> {
  const row = await loadExtensionRow(client, extensionId);
  if (row === null) {
    return { ok: false, code: 'EXTENSION_NOT_FOUND', message: 'The extension could not be found.' };
  }

  // -------------------------------------------------------------------
  // 1. Lifecycle guard (live derivation — a native binding always wins).
  // -------------------------------------------------------------------
  const liveState = deriveAdapterState(row, row.adapter_state);
  if (liveState === 'native') {
    return {
      ok: false,
      code: 'NATIVE_ADAPTER_EXISTS',
      message: 'A native Mavero adapter already serves this provider — generated adapters never override it.',
    };
  }
  if (liveState === 'runtime_required') {
    return {
      ok: false,
      code: 'RUNTIME_REQUIRED',
      message: 'This provider cannot be converted into a permanent Mavero adapter and remains disabled.',
    };
  }
  if (liveState === 'generated') {
    return {
      ok: false,
      code: 'ALREADY_GENERATED',
      message: 'A permanent adapter is already active for this provider. Test it or roll back its version instead.',
    };
  }
  if (liveState === 'building' || liveState === 'testing') {
    return {
      ok: false,
      code: 'BUILD_IN_PROGRESS',
      message: 'An adapter build is already in progress for this provider.',
    };
  }

  // -------------------------------------------------------------------
  // 2. CAS to 'building' (failed→building and adapter_required→building
  //    are the sanctioned transitions; concurrent actions are isolated).
  // -------------------------------------------------------------------
  const building = await casTransition(client, row.id, ['adapter_required', 'failed'], {
    adapter_state: 'building',
    last_build_at: new Date().toISOString(),
    last_build_error: null,
  });
  if (!building) {
    return { ok: false, code: 'BUILD_IN_PROGRESS', message: 'An adapter build is already in progress for this provider.' };
  }

  const inputs: ProviderTestInputs = parseProviderTestInputs(rawTestInputs);

  // -------------------------------------------------------------------
  // 3-4. Compose the build request; call the external Builder.
  // -------------------------------------------------------------------
  const repository = await loadRepositoryRow(client, row.repository_id);
  const canonicalKey = canonicalAdapterKey(
    row.integration_type === 'nuvio' ? 'nuvio' : 'cloudstream',
    row.internal_name,
  );
  const nextVersion = (await latestArtifactVersion(client, canonicalKey)) + 1;

  const mediaTypes: Array<'movie' | 'tv'> =
    row.media_types.includes('movie') || row.media_types.includes('tv')
      ? (['movie', 'tv'] as const).filter((type) => row.media_types.includes(type))
      : ['movie'];

  const movieCase: AdapterTestCase = {
    kind: 'movie',
    tmdbId: inputs.movie.tmdbId,
    title: inputs.movie.title,
    ...(inputs.movie.year !== undefined ? { year: inputs.movie.year } : {}),
    ...(inputs.movie.imdbId !== undefined ? { imdbId: inputs.movie.imdbId } : {}),
  };
  const episodeCase: AdapterTestCase | null = inputs.episode !== null
    ? {
        kind: 'episode',
        tmdbId: inputs.episode.tmdbId,
        title: inputs.episode.title,
        ...(inputs.episode.year !== undefined ? { year: inputs.episode.year } : {}),
        ...(inputs.episode.imdbId !== undefined ? { imdbId: inputs.episode.imdbId } : {}),
        season: inputs.episode.season,
        episode: inputs.episode.episode,
      }
    : null;

  const buildRequest: AdapterBuildRequest = {
    requestId: deps.requestId !== undefined ? deps.requestId() : randomUUID(),
    requestedAt: new Date().toISOString(),
    integrationType: row.integration_type === 'nuvio' ? 'nuvio' : 'cloudstream',
    provider: {
      id: row.internal_name,
      name: row.name,
      version: row.version_text ?? (row.version !== null ? String(row.version) : null),
      language: row.language,
      repository: repository !== null ? { name: repository.name, url: repository.url } : { name: null, url: null },
      moduleUrl: row.integration_type === 'nuvio' ? row.module_url : null,
      pluginUrl: row.integration_type === 'cloudstream' ? row.plugin_url : null,
      mediaTypes,
    },
    requestedAdapterVersion: nextVersion,
    test: { movie: movieCase, episode: episodeCase },
  };

  const buildOutcome = await requestAdapterBuild(buildRequest, deps);

  // Builder unavailable: NO build was attempted — the row returns to its
  // prior state, nothing is marked failed, Downloader 2 is unaffected.
  if (!buildOutcome.ok) {
    await casTransition(client, row.id, ['building'], {
      adapter_state: row.adapter_state === 'failed' ? 'failed' : 'adapter_required',
      last_build_error: `${buildOutcome.code}: ${buildOutcome.message}`.slice(0, 1000),
    });
    return { ok: false, code: buildOutcome.code, message: buildOutcome.message };
  }

  const response: AdapterBuildResponse = buildOutcome.response;

  // -------------------------------------------------------------------
  // Builder refused honestly (closed error + analysis verdict).
  // -------------------------------------------------------------------
  if (!response.ok) {
    const verdict = response.error.verdict;
    // Not-convertible verdicts move the row to runtime_required (stays
    // disabled — the honest terminal state, D-P3-11). Everything else is a
    // build failure: the row records it and stays 'failed'.
    const targetState = verdict === 'REQUIRES_RUNTIME' || verdict === 'UNSUPPORTED'
      ? 'runtime_required'
      : 'failed';
    const message = `${response.error.code}: ${response.error.message}`.slice(0, 1000);
    await casTransition(client, row.id, ['building'], {
      adapter_state: targetState,
      last_build_error: message,
    });
    return { ok: false, code: response.error.code, message: response.error.message };
  }

  // -------------------------------------------------------------------
  // 5. MAVERO-SIDE artifact validation (never trust the Builder's 200).
  // -------------------------------------------------------------------
  const artifact = response.result.artifact as PermanentAdapterArtifact;
  const validationCode = validateArtifactForPersistence(artifact, {
    integrationType: buildRequest.integrationType,
    providerId: row.internal_name,
    adapterVersion: nextVersion,
    canonicalKey,
  });
  if (validationCode !== null) {
    await casTransition(client, row.id, ['building'], {
      adapter_state: 'failed',
      last_build_error: `MAVERO_VALIDATION_REJECTED: ${validationCode}`.slice(0, 1000),
    });
    return { ok: false, code: 'ARTIFACT_VALIDATION_FAILED', message: 'The Builder returned an artifact that failed Mavero-side validation.' };
  }

  // -------------------------------------------------------------------
  // 6. CAS to 'testing' + the INDEPENDENT representative test (Mavero's
  //    own runtime — the same machinery Downloader 2 uses).
  // -------------------------------------------------------------------
  const testing = await casTransition(client, row.id, ['building'], {
    adapter_state: 'testing',
  });
  if (!testing) {
    // Concurrent state change — abandon before persistence (honest).
    return { ok: false, code: 'STATE_CONFLICT', message: 'The extension state changed during the build.' };
  }

  const integrityHash = artifactIntegrityHash(artifact);
  const artifactRow = {
    canonical_key: canonicalKey,
    integration_type: artifact.integrationType,
    provider_id: artifact.providerId,
    adapter_version: artifact.adapterVersion,
    strategy: artifact.strategy,
    artifact: artifact as unknown as Record<string, unknown>,
    artifact_hash: integrityHash,
    source_revision: artifact.analysis.sourceRevision,
    builder_version: artifact.builderVersion,
  };
  const testAdapter = generatedAdapterFromArtifactRow({ ...artifactRow, artifact, test_report: null } as never);
  if (testAdapter === null) {
    // The interpreter/binding refused the (schema-valid) artifact — honest.
    await casTransition(client, row.id, ['testing'], {
      adapter_state: 'failed',
      last_build_error: 'MAVERO_VALIDATION_REJECTED: the artifact could not be bound to an executable adapter.'.slice(0, 1000),
    });
    return { ok: false, code: 'ARTIFACT_VALIDATION_FAILED', message: 'The artifact could not be bound to an executable adapter.' };
  }

  const resolution = await runRepresentativeResolution(testAdapter, inputs, {
    ...(deps.testFetcher !== undefined ? { fetcher: deps.testFetcher } : {}),
    ...(deps.testDnsResolver !== undefined ? { dnsResolver: deps.testDnsResolver } : {}),
    ...(deps.testAdapterTimeoutMs !== undefined ? { adapterTimeoutMs: deps.testAdapterTimeoutMs } : {}),
  });
  if (!resolution.passed) {
    const reason = resolution.cases.find((testCase) => !testCase.passed)?.note ?? 'The independent test found no links.';
    await casTransition(client, row.id, ['testing'], {
      adapter_state: 'failed',
      last_build_error: `MAVERO_TEST_FAILED: ${reason}`.slice(0, 1000),
    });
    return { ok: false, code: 'MAVERO_TEST_FAILED', message: `The generated adapter failed Mavero's independent test: ${reason}` };
  }

  // -------------------------------------------------------------------
  // 7. Persist the immutable artifact row + the ATOMIC promotion.
  // -------------------------------------------------------------------
  const testReport = {
    cases: resolution.cases,
    passed: true,
    testedAt: new Date().toISOString(),
  };
  const { error: insertError } = await client
    .from('cloudstream_adapter_artifacts')
    .insert({ ...artifactRow, test_report: testReport });
  if (insertError !== null) {
    await casTransition(client, row.id, ['testing'], {
      adapter_state: 'failed',
      last_build_error: `ARTIFACT_PERSIST_FAILED: the artifact row could not be stored.`.slice(0, 1000),
    });
    return { ok: false, code: 'ARTIFACT_PERSIST_FAILED', message: 'The artifact could not be persisted.' };
  }

  const promoted = await casTransition(client, row.id, ['testing'], {
    adapter_state: 'generated',
    generated_adapter_version: artifact.adapterVersion,
    builder_version: artifact.builderVersion,
    last_tested_at: new Date().toISOString(),
    last_test_error: null,
    last_build_error: null,
  });
  if (!promoted) {
    // The immutable row is retained (rollback-able); the pointer was not
    // moved — the previous READY adapter (if any) keeps serving.
    return { ok: false, code: 'STATE_CONFLICT', message: 'The extension state changed before promotion.' };
  }

  return {
    ok: true,
    adapterVersion: artifact.adapterVersion,
    verdict: artifact.analysis.verdict,
    notes: artifact.analysis.notes,
    testCases: testReport.cases as unknown as AdapterTestCaseResult[],
  };
}

// ---------------------------------------------------------------------------
// Artifact validation (identity + schema + integrity — Mavero-side)
// ---------------------------------------------------------------------------

/**
 * Full Mavero-side validation of a Builder-returned artifact. Returns null
 * when valid, otherwise a closed reason code. Recomputes NOTHING external:
 * schema (validateAdapterArtifact), identity coherence (canonical key +
 * integration type + provider id + the requested NEXT version).
 */
function validateArtifactForPersistence(
  artifact: PermanentAdapterArtifact,
  expected: {
    integrationType: 'cloudstream' | 'nuvio';
    providerId: string;
    adapterVersion: number;
    canonicalKey: string;
  },
): string | null {
  const issues = validateAdapterArtifact(artifact);
  if (issues.length > 0) return 'schema';
  if (artifact.integrationType !== expected.integrationType) return 'integrationType';
  if (artifact.adapterId !== expected.canonicalKey) return 'adapterId';
  if (artifact.providerId !== expected.providerId) return 'providerId';
  if (artifact.adapterVersion !== expected.adapterVersion) return 'adapterVersion';
  if (artifact.adapterId !== canonicalArtifactId(artifact.integrationType, artifact.providerId)) return 'canonicalIdentity';
  if (artifact.testReport.passed !== true) return 'builderTestReport';
  return null;
}
