/**
 * MAVERO — Durable Adapter Build Lifecycle (fix for the 2026-10-03
 * CineStream stale-building incident).
 *
 * ROOT CAUSE THIS MODULE ELIMINATES: the create-adapter pipeline used to run
 * synchronously inside the admin HTTP request. Netlify synchronous
 * functions are hard-capped (10s default, 26s max) while a real build needs
 * a possible 32s+ Render cold start + up to 150s Builder budget + the
 * independent representative test. When the platform killed the request
 * AFTER the CAS to 'building', NOTHING ever transitioned the row again
 * (BUILD_IN_PROGRESS guard + no stale recovery) — a permanent orphan.
 *
 * THE DURABLE MODEL (one job table, no new queue technology):
 *
 *   ADMIN REQUEST (fast, ~1s)                     BACKGROUND EXECUTOR
 *   ┌──────────────────────────────┐              (Netlify background function,
 *   │ lifecycle guard (unchanged)  │               15-min budget; local dev: a
 *   │ reserve adapter version      │               detached promise)
 *   │ INSERT job row (queued)      │──── POST ───▶│ claim job (CAS queued→building)
 *   │ CAS ext → building + pointer │   202         │ run the full pipeline
 *   │ dispatch executor ───────────┼──────────────▶│ (job-guarded CAS transitions
 *   │ RETURN { jobId }             │               │  + heartbeats + terminal writes)
 *   └──────────────────────────────┘              └────────────────────────────┘
 *
 *   EVERY POLL / PAGE LOAD also runs the RECONCILER: re-dispatch stale
 *   queued jobs; deterministically recover stale building/testing jobs
 *   (budgets derived from the configured Builder/test timeouts, never
 *   arbitrary); recover legacy orphans (rows in building/testing with no
 *   job row — exactly the CineStream pattern).
 *
 *   LATE-WRITE GUARD: cloudstream_extensions.current_build_job_id. Every
 *   pipeline CAS write matches the pointer, so a late worker from an OLD
 *   job can never write a row a NEWER job owns (or a recovered row).
 *
 * SECURITY MODEL (unchanged): builder-client.ts stays the ONLY Builder
 * caller; the Builder stays stateless (no DB, no filesystem, BUILDER_SECRET
 * only); .cs3 is never executed; no Nuvio module JS runs in Mavero; native
 * adapters keep precedence; Downloader 2 NEVER reaches any of this. The
 * background executor is authorized with the SAME server-side
 * PRIVATE_ADAPTER_BUILDER_SECRET (documented; never exposed to clients).
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
import { requestAdapterBuild, readBuilderClientConfig, type BuilderClientConfig, type BuilderClientDeps } from './builder-client';
import { generatedAdapterFromArtifactRow } from './generated-registry';
import { runRepresentativeResolution, parseProviderTestInputs, type ProviderTestInputs } from './test-service';
import { deriveAdapterState, canonicalAdapterKey } from '$lib/server/extensions/adapter-registry';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';

type CloudStreamClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Outcome contract (admin-facing, closed vocabulary — IDENTICAL to the
// pre-lifecycle build-service contract; existing consumers unchanged)
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
// Closed job vocabulary + deterministic stale budgets
// ---------------------------------------------------------------------------

/** Job lifecycle (migration 20261102000000 CHECK constraint). */
export const ADAPTER_BUILD_JOB_STATES = [
  'queued',
  'building',
  'testing',
  'succeeded',
  'failed',
  'stale_recovered',
] as const;
export type AdapterBuildJobState = (typeof ADAPTER_BUILD_JOB_STATES)[number];

const ACTIVE_JOB_STATES: readonly AdapterBuildJobState[] = ['queued', 'building', 'testing'];
const TERMINAL_JOB_STATES: readonly AdapterBuildJobState[] = ['succeeded', 'failed', 'stale_recovered'];

/**
 * Deterministic stale budgets — DERIVED from the budgets that actually
 * bound each phase (never an arbitrary duration):
 *   building  ≤ Builder client timeout (PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS,
 *              default 150s) + artifact validation/write margin
 *   testing   ≤ representative resolution (2 cases × 30s adapter budget)
 *              + persistence margin
 *   queued    ≤ dispatch retries + the full build budget, then honest
 *              EXECUTOR_UNREACHABLE
 */
export type AdapterBuildStaleBudgets = {
  /** Re-dispatch a queued job (idempotent — the claim CAS deduplicates). */
  dispatchRetryAfterMs: number;
  /** A queued job nobody ever claimed after this → honest failure. */
  queuedHardStaleMs: number;
  /** building-phase staleness (no heartbeat/progress within this). */
  buildingStaleMs: number;
  /** testing-phase staleness. */
  testingStaleMs: number;
};

export const CLOUDSTREAM_ADAPTER_TEST_BUDGET_MS = 30_000;

export function computeAdapterBuildStaleBudgets(builderTimeoutMs: number): AdapterBuildStaleBudgets {
  const writeMarginMs = 90_000;
  return {
    dispatchRetryAfterMs: 30_000,
    queuedHardStaleMs: Math.max(10 * 60_000, builderTimeoutMs + 5 * 60_000),
    buildingStaleMs: builderTimeoutMs + writeMarginMs,
    testingStaleMs: 2 * CLOUDSTREAM_ADAPTER_TEST_BUDGET_MS + writeMarginMs,
  };
}

/** The netlify background-function invoke budget (202 returns immediately). */
export const EXECUTOR_DISPATCH_TIMEOUT_MS = 8_000;

/** At most this many jobs run building/testing concurrently (Render 0.5-CPU). */
export const MAX_CONCURRENT_BUILDING_JOBS = 2;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Row loading
// ---------------------------------------------------------------------------

/** The extension row projection the lifecycle reasons over. */
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
  current_build_job_id: string | null;
};

const EXTENSION_COLUMNS =
  'id, repository_id, internal_name, name, language, version_text, version, integration_type, plugin_status, plugin_url, module_url, media_types, adapter_state, enabled, current_build_job_id';

async function loadExtensionRow(client: CloudStreamClient, extensionId: string): Promise<BuildExtensionRow | null> {
  if (typeof extensionId !== 'string' || extensionId.length === 0 || extensionId.length > 200) return null;
  const { data, error } = await client
    .from('cloudstream_extensions')
    .select(EXTENSION_COLUMNS)
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
async function latestArtifactVersion(client: CloudStreamClient, canonicalKey: string): Promise<number> {
  const { data, error } = await client
    .from('cloudstream_adapter_artifacts')
    .select('adapter_version')
    .eq('canonical_key', canonicalKey)
    .order('adapter_version', { ascending: false })
    .limit(1);
  if (error !== null || data === null || data.length === 0) return 0;
  return (data[0] as { adapter_version: number }).adapter_version;
}

/** The job row projection. */
type BuildJobRow = {
  id: string;
  extension_id: string;
  canonical_key: string;
  attempt: number;
  state: string;
  requested_adapter_version: number;
  prior_adapter_state: string;
  result_kind: string | null;
  result_adapter_version: number | null;
  error_code: string | null;
  error_message: string | null;
  test_inputs: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

const JOB_COLUMNS =
  'id, extension_id, canonical_key, attempt, state, requested_adapter_version, prior_adapter_state, result_kind, result_adapter_version, error_code, error_message, test_inputs, created_by, created_at, started_at, finished_at, updated_at';

async function loadJobRow(client: CloudStreamClient, jobId: string): Promise<BuildJobRow | null> {
  if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) return null;
  const { data, error } = await client
    .from('cloudstream_adapter_build_jobs')
    .select(JOB_COLUMNS)
    .eq('id', jobId)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return data as unknown as BuildJobRow;
}

// ---------------------------------------------------------------------------
// State transitions (CAS — job-guarded; concurrent actions isolated)
// ---------------------------------------------------------------------------

/**
 * One guarded UPDATE; returns true when exactly one row transitioned.
 * LATE-WRITE GUARD: transitions FROM building/testing additionally match
 * the current job pointer — an old worker's write matches 0 rows the
 * moment a newer job owns the row (or the row was stale-recovered). The
 * INITIAL adapter_required/failed → building transition SETS the pointer
 * (the state CAS itself is the concurrency boundary — exactly one queue
 * wins, and a terminal row's pointer is always null).
 */
async function casTransition(
  client: CloudStreamClient,
  extensionId: string,
  jobId: string | undefined,
  from: readonly string[],
  patch: Partial<Database['public']['Tables']['cloudstream_extensions']['Update']>,
): Promise<boolean> {
  let query = client
    .from('cloudstream_extensions')
    .update(patch)
    .eq('id', extensionId)
    .in('adapter_state', [...from]);
  const needsPointerGuard = from.includes('building') || from.includes('testing');
  if (jobId !== undefined && needsPointerGuard) {
    query = query.eq('current_build_job_id', jobId);
  }
  const { data, error } = await query.select('id');
  if (error !== null) return false;
  return Array.isArray(data) && data.length === 1;
}

/** One guarded job-row UPDATE (claim / phase change / terminal). */
async function casJob(
  client: CloudStreamClient,
  jobId: string,
  from: readonly string[],
  patch: Partial<Database['public']['Tables']['cloudstream_adapter_build_jobs']['Update']>,
): Promise<boolean> {
  const { data, error } = await client
    .from('cloudstream_adapter_build_jobs')
    .update(patch)
    .eq('id', jobId)
    .in('state', [...from])
    .select('id');
  if (error !== null) return false;
  return Array.isArray(data) && data.length === 1;
}

// ---------------------------------------------------------------------------
// QUEUE — the fast admin request (durable state, immediate return)
// ---------------------------------------------------------------------------

export type QueueAdapterDeps = CreateAdapterDeps & {
  /** Site origin for the background-executor dispatch (production). */
  origin?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
};

export type QueueAdapterOutcome =
  | { ok: true; jobId: string; dispatch: 'dispatched' | 'local' | 'deferred' | 'unconfigured' | 'inline' }
  | { ok: false; code: string; message: string };

export type QueueAdapterOptions = {
  /** 'auto' dispatch (default); 'none' — queue only (the caller executes). */
  dispatch?: 'auto' | 'none';
  /** Admin actor id for the job audit trail (uuid-validated). */
  createdBy?: string;
};

/**
 * Queues ONE durable adapter build for an extension row and returns
 * IMMEDIATELY (sub-second): the extension row CASes to 'building' with the
 * job pointer, and execution happens in the background executor (or inline
 * for the synchronous compatibility path / local dev).
 *
 * The SAME lifecycle guards as the original synchronous pipeline: native →
 * NATIVE_ADAPTER_EXISTS; runtime_required → RUNTIME_REQUIRED; generated →
 * ALREADY_GENERATED; building/testing → BUILD_IN_PROGRESS (with the
 * reconciler sweeping stale rows first, a stuck row is never permanent).
 */
export async function queueAdapterBuild(
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
  deps: QueueAdapterDeps = {},
  options: QueueAdapterOptions = {},
): Promise<QueueAdapterOutcome> {
  const row = await loadExtensionRow(client, extensionId);
  if (row === null) {
    return { ok: false, code: 'EXTENSION_NOT_FOUND', message: 'The extension could not be found.' };
  }

  // 1. Lifecycle guard (live derivation — a native binding always wins).
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

  const priorState: 'adapter_required' | 'failed' = row.adapter_state === 'failed' ? 'failed' : 'adapter_required';

  // 2. Unconfigured Builder → the honest BUILDER_UNAVAILABLE refusal with
  //    NO build attempted (the row stays in its prior state; recorded in
  //    last_build_error — the pre-lifecycle behavior, preserved).
  const builderConfig = deps.config ?? (await readBuilderClientConfig());
  if (builderConfig === null) {
    await client
      .from('cloudstream_extensions')
      .update({
        last_build_error: 'BUILDER_UNAVAILABLE: The Adapter Builder is not configured on this deployment.'.slice(0, 1000),
      })
      .eq('id', row.id)
      .in('adapter_state', ['adapter_required', 'failed'])
      .select('id');
    return {
      ok: false,
      code: 'BUILDER_UNAVAILABLE',
      message: 'The Adapter Builder is not configured on this deployment.',
    };
  }

  // 3. Reserve the next adapter version + insert the durable job row.
  const canonicalKey = canonicalAdapterKey(
    row.integration_type === 'nuvio' ? 'nuvio' : 'cloudstream',
    row.internal_name,
  );
  const requestedVersion = (await latestArtifactVersion(client, canonicalKey)) + 1;
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const jobId = randomUUID();

  const { error: insertError } = await client.from('cloudstream_adapter_build_jobs').insert({
    id: jobId,
    extension_id: row.id,
    canonical_key: canonicalKey,
    attempt: 1,
    state: 'queued',
    requested_adapter_version: requestedVersion,
    prior_adapter_state: priorState,
    test_inputs: sanitizeJobTestInputs(rawTestInputs),
    ...(options.createdBy !== undefined && UUID_PATTERN.test(options.createdBy) ? { created_by: options.createdBy } : {}),
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (insertError !== null) {
    // The active-job unique indexes (per extension / per canonical-key
    // version) reject concurrent duplicates — an honest, race-free refusal.
    return {
      ok: false,
      code: 'BUILD_IN_PROGRESS',
      message: 'An adapter build is already in progress for this provider.',
    };
  }

  // 4. CAS the extension row to 'building' WITH the job pointer.
  const building = await casTransition(client, row.id, jobId, ['adapter_required', 'failed'], {
    adapter_state: 'building',
    last_build_at: nowIso,
    last_build_error: null,
    current_build_job_id: jobId,
  });
  if (!building) {
    // Lost the CAS race — retire the job row honestly (auditable) so the
    // unique active index does not block the winner's retry.
    await casJob(client, jobId, ['queued'], {
      state: 'failed',
      error_code: 'BUILD_IN_PROGRESS',
      error_message: 'The extension state changed before the build could start.',
      finished_at: nowIso,
      updated_at: nowIso,
    });
    return { ok: false, code: 'BUILD_IN_PROGRESS', message: 'An adapter build is already in progress for this provider.' };
  }

  // 5. Dispatch (auto: background function / local detached; none: caller).
  if (options.dispatch === 'none') {
    return { ok: true, jobId, dispatch: 'inline' };
  }
  const dispatch = await dispatchBuildExecutor(client, jobId, deps);
  return { ok: true, jobId, dispatch };
}

/** Bounded, shape-safe test-input capture for the job row. */
function sanitizeJobTestInputs(raw: Record<string, string | undefined>): Record<string, string> {
  const fields = ['testTmdbId', 'testTitle', 'testYear', 'testImdbId', 'testSeason', 'testEpisode'] as const;
  const clean: Record<string, string> = {};
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === 'string' && value.length > 0 && value.length <= 200) clean[field] = value;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// DISPATCH — the Netlify background function invoke (or local detached run)
// ---------------------------------------------------------------------------

export type BuilderDispatchDeps = CreateAdapterDeps & {
  /** Site origin for the background-executor invoke. */
  origin?: string;
};

export type BuilderDispatchResult = 'dispatched' | 'local' | 'deferred' | 'unconfigured';

/**
 * Fires the background executor for one job. The invoke returns 202
 * IMMEDIATELY (Netlify detaches the execution — up to 15 minutes); this
 * never waits for the build itself. Failure modes are all safe:
 *   * unreachable/timeout → the job stays queued (the reconciler retries)
 *   * 404 (no function — vite dev/preview) → local detached execution
 *   * a stalled local promise on a real lambda is inert (stale recovery
 *     catches it) — the fallback can never corrupt state.
 */
async function dispatchBuildExecutor(
  client: CloudStreamClient,
  jobId: string,
  deps: BuilderDispatchDeps,
): Promise<BuilderDispatchResult> {
  const config = deps.config ?? (await readBuilderClientConfig());
  if (config === null) return 'unconfigured';

  // Local dev (vite): no /.netlify/functions route exists — run detached.
  if (isDevRuntime()) {
    runDetached(client, jobId, deps);
    return 'local';
  }

  if (deps.origin === undefined || deps.origin.length === 0) return 'deferred';
  const fetcher = deps.fetcher ?? fetch;
  const url = `${deps.origin.replace(/\/+$/, '')}/.netlify/functions/adapter-build-executor`;
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(EXECUTOR_DISPATCH_TIMEOUT_MS),
    });
    if (response.ok) return 'dispatched';
    if (response.status === 404) {
      // The function is not deployed on this origin (preview/dev server):
      // execute locally, detached. On a real lambda the promise simply
      // stalls (harmless — staleness recovers the job).
      runDetached(client, jobId, deps);
      return 'local';
    }
    return 'deferred';
  } catch {
    return 'deferred';
  }
}

/** import.meta.env.DEV (static access — vite's module runner rejects dynamic
 * env access; plain-node/tsx runs see undefined → false). */
function isDevRuntime(): boolean {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

/** Fire-and-forget local execution (dev/preview; never blocks a request). */
function runDetached(client: CloudStreamClient, jobId: string, deps: BuilderDispatchDeps): void {
  void executeAdapterBuildJob(client, jobId, pipelineDeps(deps)).catch(() => undefined);
}

function pipelineDeps(deps: BuilderDispatchDeps): CreateAdapterDeps {
  return {
    ...(deps.config !== undefined ? { config: deps.config } : {}),
    ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
    ...(deps.testFetcher !== undefined ? { testFetcher: deps.testFetcher } : {}),
    ...(deps.testDnsResolver !== undefined ? { testDnsResolver: deps.testDnsResolver } : {}),
    ...(deps.testAdapterTimeoutMs !== undefined ? { testAdapterTimeoutMs: deps.testAdapterTimeoutMs } : {}),
    ...(deps.requestId !== undefined ? { requestId: deps.requestId } : {}),
  };
}

/** Re-dispatches the OLDEST queued job (the executor self-chain drain). */
export async function dispatchNextQueuedJob(client: CloudStreamClient, deps: BuilderDispatchDeps = {}): Promise<boolean> {
  const { data, error } = await client
    .from('cloudstream_adapter_build_jobs')
    .select('id')
    .eq('state', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error !== null || data === null || data.length === 0) return false;
  const jobId = (data[0] as { id: string }).id;
  await dispatchBuildExecutor(client, jobId, deps);
  return true;
}

// ---------------------------------------------------------------------------
// EXECUTE — the worker core (claimed exactly once per job)
// ---------------------------------------------------------------------------

/**
 * Claims and executes ONE durable build job: the full original pipeline
 * (Builder request → Mavero-side artifact validation → independent
 * representative test → atomic artifact persistence + promotion) with
 * job-guarded CAS transitions and phase heartbeats.
 *
 * Idempotent + race-safe: the claim CAS (queued→building) means exactly one
 * executor wins; a late duplicate exits with BUILD_JOB_NOT_QUEUED.
 */
export async function executeAdapterBuildJob(
  client: CloudStreamClient,
  jobId: string,
  deps: CreateAdapterDeps = {},
): Promise<CreateAdapterOutcome> {
  const job = await loadJobRow(client, jobId);
  if (job === null) {
    return { ok: false, code: 'BUILD_JOB_NOT_FOUND', message: 'The build job could not be found.' };
  }
  if (job.state !== 'queued') {
    return { ok: false, code: 'BUILD_JOB_NOT_QUEUED', message: 'The build job was already claimed or finished.' };
  }

  // Concurrency cap: leave the job queued when builds are already running
  // (the reconciler re-dispatches; the Builder is single-small-CPU).
  const busy = await countActiveExecutionJobs(client);
  if (busy >= MAX_CONCURRENT_BUILDING_JOBS) {
    return { ok: false, code: 'BUILD_DEFERRED', message: 'The maximum number of concurrent adapter builds is already running.' };
  }

  const nowIso = new Date().toISOString();
  const claimed = await casJob(client, jobId, ['queued'], {
    state: 'building',
    started_at: nowIso,
    updated_at: nowIso,
  });
  if (!claimed) {
    return { ok: false, code: 'BUILD_JOB_NOT_QUEUED', message: 'The build job was already claimed or finished.' };
  }

  // The extension row must still be 'building' AND owned by this job.
  const row = await loadExtensionRow(client, job.extension_id);
  if (row === null || row.current_build_job_id !== jobId || row.adapter_state !== 'building') {
    await finishJob(client, jobId, ['building'], 'failed', {
      error_code: 'STATE_CONFLICT',
      error_message: 'The extension row no longer points at this build job.',
    });
    return { ok: false, code: 'STATE_CONFLICT', message: 'The extension state changed during the build.' };
  }

  const jobContext: BuildJobContext = {
    jobId,
    requestedVersion: job.requested_adapter_version,
    priorState: job.prior_adapter_state === 'failed' ? 'failed' : 'adapter_required',
    canonicalKey: job.canonical_key,
  };
  const inputs = parseProviderTestInputs(job.test_inputs ?? {});

  // HARDENING (the live incident lesson): ANY unexpected pipeline exception
  // (network stack, transient DB error, module loading) still writes an
  // honest terminal state — the row NEVER waits for the stale sweep when
  // the worker is alive to report. (If the worker truly dies, the
  // reconciler's stale sweep is the safety net.)
  let outcome: CreateAdapterOutcome;
  try {
    outcome = await runAdapterBuildPipeline(client, row, jobContext, inputs, deps);
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : String(error);
    await casTransition(client, row.id, jobId, ['building', 'testing'], {
      adapter_state: 'failed',
      current_build_job_id: null,
      last_build_error: `BUILD_INCOMPLETE: the build worker stopped unexpectedly (${safeMessage.slice(0, 400)}). Retry is available.`.slice(0, 1000),
    });
    outcome = {
      ok: false,
      code: 'BUILD_INCOMPLETE',
      message: 'The build worker stopped unexpectedly; retry is available.',
    };
  }

  // Centralized terminal job write, derived from the DURABLE extension row
  // (never the promise's word alone).
  const finalRow = await loadExtensionRow(client, job.extension_id);
  await writeJobTerminalFromExtensionState(client, job, outcome, finalRow);

  // Self-chain: drain the next queued job (bounded concurrency).
  await dispatchNextQueuedJob(client, deps).catch(() => undefined);

  return outcome;
}

/** Jobs currently executing (building/testing) — the concurrency signal. */
async function countActiveExecutionJobs(client: CloudStreamClient): Promise<number> {
  const { data, error } = await client
    .from('cloudstream_adapter_build_jobs')
    .select('id')
    .in('state', ['building', 'testing'])
    .limit(MAX_CONCURRENT_BUILDING_JOBS + 1);
  if (error !== null || data === null) return 0;
  return data.length;
}

type BuildJobContext = {
  jobId: string;
  requestedVersion: number;
  priorState: 'adapter_required' | 'failed';
  canonicalKey: string;
};

/** Terminal job-row write (guarded — never resurrects a finished job). */
async function finishJob(
  client: CloudStreamClient,
  jobId: string,
  from: readonly string[],
  state: 'succeeded' | 'failed' | 'stale_recovered',
  fields: {
    result_kind?: 'generated' | 'runtime_required';
    result_adapter_version?: number;
    error_code?: string;
    error_message?: string;
  } = {},
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  return casJob(client, jobId, from, {
    state,
    ...(fields.result_kind !== undefined ? { result_kind: fields.result_kind } : {}),
    ...(fields.result_adapter_version !== undefined ? { result_adapter_version: fields.result_adapter_version } : {}),
    ...(fields.error_code !== undefined ? { error_code: fields.error_code.slice(0, 120) } : {}),
    ...(fields.error_message !== undefined ? { error_message: fields.error_message.slice(0, 1000) } : {}),
    finished_at: nowIso,
    updated_at: nowIso,
  });
}

async function writeJobTerminalFromExtensionState(
  client: CloudStreamClient,
  job: BuildJobRow,
  outcome: CreateAdapterOutcome,
  finalRow: BuildExtensionRow | null,
): Promise<void> {
  // The durable extension row decides the job terminal (never the promise).
  // The pipeline's own terminal writes CLEAR the pointer, so a null pointer
  // still reflects OUR outcome; a pointer to a DIFFERENT job means this job
  // was superseded — never write over it.
  let extensionState: string | null;
  if (finalRow === null) {
    extensionState = null; // row deleted mid-build (the FK cascade deletes this job row too)
  } else if (finalRow.current_build_job_id === null || finalRow.current_build_job_id === job.id) {
    extensionState = finalRow.adapter_state;
  } else {
    extensionState = null; /* a different job owns the row */
  }
  if (extensionState === 'generated') {
    await finishJob(client, job.id, ['building', 'testing'], 'succeeded', {
      result_kind: 'generated',
      result_adapter_version: outcome.ok ? outcome.adapterVersion : job.requested_adapter_version,
    });
    return;
  }
  if (extensionState === 'runtime_required') {
    await finishJob(client, job.id, ['building', 'testing'], 'succeeded', {
      result_kind: 'runtime_required',
    });
    return;
  }
  if (extensionState === null) {
    // The row no longer points at this job (recovered/retired elsewhere).
    return;
  }
  if (extensionState === 'adapter_required' || extensionState === 'failed') {
    // Row reverted (Builder unavailable) or failed — the job records it.
    await finishJob(client, job.id, ['building', 'testing'], 'failed', {
      error_code: outcome.ok ? 'BUILD_INCOMPLETE' : outcome.code,
      error_message: outcome.ok ? 'The build did not reach a terminal extension state.' : outcome.message,
    });
    return;
  }
  // Still building/testing (mid-flight crash window): honest incomplete.
  await finishJob(client, job.id, ['building', 'testing'], 'failed', {
    error_code: 'BUILD_INCOMPLETE',
    error_message: 'The build stopped before reaching a terminal state; the reconciler will recover the row.',
  });
}

// ---------------------------------------------------------------------------
// THE PIPELINE (the original build-service steps 3–8, job-guarded)
// ---------------------------------------------------------------------------

/**
 * Runs the full build pipeline for one CLAIMED job. Synchronous within the
 * executor (bounded by the builder timeout + test budgets). Every state
 * write is CAS-guarded by BOTH the expected prior state AND the job
 * pointer; the OLD READY adapter keeps serving during the entire build and
 * a failed build NEVER touches it.
 */
async function runAdapterBuildPipeline(
  client: CloudStreamClient,
  row: BuildExtensionRow,
  job: BuildJobContext,
  inputs: ProviderTestInputs,
  deps: CreateAdapterDeps,
): Promise<CreateAdapterOutcome> {
  const { jobId } = job;
  const nextVersion = job.requestedVersion;

  // Compose the build request (provider provenance + test cases).
  const repository = await loadRepositoryRow(client, row.repository_id);
  const canonicalKey = job.canonicalKey;

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
    await casTransition(client, row.id, jobId, ['building'], {
      adapter_state: job.priorState,
      current_build_job_id: null,
      last_build_error: `${buildOutcome.code}: ${buildOutcome.message}`.slice(0, 1000),
    });
    return { ok: false, code: buildOutcome.code, message: buildOutcome.message };
  }

  const response: AdapterBuildResponse = buildOutcome.response;

  // Builder refused honestly (closed error + analysis verdict).
  if (!response.ok) {
    const verdict = response.error.verdict;
    const targetState = verdict === 'REQUIRES_RUNTIME' || verdict === 'UNSUPPORTED'
      ? 'runtime_required'
      : 'failed';
    const message = `${response.error.code}: ${response.error.message}`.slice(0, 1000);
    await casTransition(client, row.id, jobId, ['building'], {
      adapter_state: targetState,
      current_build_job_id: null,
      last_build_error: message,
    });
    return { ok: false, code: response.error.code, message: response.error.message };
  }

  // Mavero-side artifact validation (never trust the Builder's 200).
  const artifact = response.result.artifact as PermanentAdapterArtifact;
  const validationCode = validateArtifactForPersistence(artifact, {
    integrationType: buildRequest.integrationType,
    providerId: row.internal_name,
    adapterVersion: nextVersion,
    canonicalKey,
  });
  if (validationCode !== null) {
    await casTransition(client, row.id, jobId, ['building'], {
      adapter_state: 'failed',
      current_build_job_id: null,
      last_build_error: `MAVERO_VALIDATION_REJECTED: ${validationCode}`.slice(0, 1000),
    });
    return { ok: false, code: 'ARTIFACT_VALIDATION_FAILED', message: 'The Builder returned an artifact that failed Mavero-side validation.' };
  }

  // CAS to 'testing' + the INDEPENDENT representative test (Mavero's own
  // runtime — the same machinery Downloader 2 uses).
  const testing = await casTransition(client, row.id, jobId, ['building'], {
    adapter_state: 'testing',
  });
  if (!testing) {
    // Concurrent state change — abandon before persistence (honest).
    return { ok: false, code: 'STATE_CONFLICT', message: 'The extension state changed during the build.' };
  }
  // Phase heartbeat (the job row advances queued/building→testing).
  await casJob(client, jobId, ['building', 'queued'], {
    state: 'testing',
    updated_at: new Date().toISOString(),
  });

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
    await casTransition(client, row.id, jobId, ['testing'], {
      adapter_state: 'failed',
      current_build_job_id: null,
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
    await casTransition(client, row.id, jobId, ['testing'], {
      adapter_state: 'failed',
      current_build_job_id: null,
      last_build_error: `MAVERO_TEST_FAILED: ${reason}`.slice(0, 1000),
    });
    return { ok: false, code: 'MAVERO_TEST_FAILED', message: `The generated adapter failed Mavero's independent test: ${reason}` };
  }

  // Persist the immutable artifact row + the ATOMIC promotion.
  const testReport = {
    cases: resolution.cases,
    passed: true,
    testedAt: new Date().toISOString(),
  };
  const { error: insertError } = await client
    .from('cloudstream_adapter_artifacts')
    .insert({ ...artifactRow, test_report: testReport });
  if (insertError !== null) {
    await casTransition(client, row.id, jobId, ['testing'], {
      adapter_state: 'failed',
      current_build_job_id: null,
      last_build_error: 'ARTIFACT_PERSIST_FAILED: the artifact row could not be stored.'.slice(0, 1000),
    });
    return { ok: false, code: 'ARTIFACT_PERSIST_FAILED', message: 'The artifact could not be persisted.' };
  }

  const promoted = await casTransition(client, row.id, jobId, ['testing'], {
    adapter_state: 'generated',
    current_build_job_id: null,
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
// Full Mavero-side artifact validation (unchanged from build-service)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RECONCILE — the deterministic stale sweep (no build orphans, ever)
// ---------------------------------------------------------------------------

export type ReconcileDeps = BuilderDispatchDeps & {
  /** Injectable clock (tests). */
  now?: () => Date;
};

export type ReconcileResult = {
  recovered: number;
  redispatched: number;
  details: string[];
};

/**
 * The deterministic stale-recovery sweep. Runs on every build-status poll,
 * the integrations page load, and the queue pre-flight. Rules (all derived
 * from the configured phase budgets — never arbitrary):
 *
 *   1. LEGACY ORPHAN — an extension in building/testing with NO job row
 *      (the pre-lifecycle CineStream pattern): stale by last_build_at →
 *      'failed' + BUILD_STALE_RECOVERY (retryable).
 *   2. TERMINAL JOB, STUCK ROW — the job finished but the extension write
 *      was lost (crash window): apply the job's durable outcome now.
 *   3. QUEUED — older than dispatchRetryAfterMs → re-dispatch (idempotent
 *      claim CAS); older than queuedHardStaleMs → honest
 *      EXECUTOR_UNREACHABLE failure, row returns to prior state.
 *   4. BUILDING/TESTING — no heartbeat within the phase budget → job
 *      'stale_recovered' + row 'failed' + BUILD_STALE_RECOVERY. A live
 *      worker's fresh heartbeat blocks the sweep (updated_at guard).
 *
 * Every transition is a single guarded UPDATE — exactly one writer wins;
 * a late worker's subsequent writes match 0 rows (job-pointer guard).
 */
export async function reconcileAdapterBuilds(
  client: CloudStreamClient,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const budgets = computeAdapterBuildStaleBudgets(
    deps.config?.timeoutMs ?? (await readBuilderClientConfig())?.timeoutMs ?? 150_000,
  );
  const result: ReconcileResult = { recovered: 0, redispatched: 0, details: [] };

  const { data: inFlight, error } = await client
    .from('cloudstream_extensions')
    .select('id, adapter_state, current_build_job_id, last_build_at, updated_at')
    .in('adapter_state', ['building', 'testing']);
  if (error !== null || inFlight === null) return result;

  for (const raw of inFlight as Array<{
    id: string;
    adapter_state: string;
    current_build_job_id: string | null;
    last_build_at: string | null;
    updated_at: string;
  }>) {
    // ------------------------------------------------------------------
    // 1. Legacy orphan (no job row — pre-lifecycle rows, manual edits).
    // ------------------------------------------------------------------
    if (raw.current_build_job_id === null || !UUID_PATTERN.test(raw.current_build_job_id)) {
      const staleAfter = raw.adapter_state === 'testing' ? budgets.testingStaleMs : budgets.buildingStaleMs;
      const startedAt = Date.parse(raw.last_build_at ?? raw.updated_at);
      if (Number.isFinite(startedAt) && nowMs - startedAt > staleAfter) {
        const message =
          `BUILD_STALE_RECOVERY: the build entered ${raw.adapter_state} at ${raw.last_build_at ?? 'unknown time'} ` +
          'but no build job or Builder completion was observed. The build was not verified; retry is required.'.slice(0, 1000);
        const { data: swept } = await client
          .from('cloudstream_extensions')
          .update({
            adapter_state: 'failed',
            last_build_error: message,
          })
          .eq('id', raw.id)
          .in('adapter_state', [raw.adapter_state])
          .is('current_build_job_id', null)
          .select('id');
        if (Array.isArray(swept) && swept.length === 1) {
          result.recovered += 1;
          result.details.push(`legacy-orphan:${raw.id}`);
        }
      }
      continue;
    }

    // ------------------------------------------------------------------
    // Load the owning job row.
    // ------------------------------------------------------------------
    const job = await loadJobRow(client, raw.current_build_job_id);
    if (job === null) {
      // Pointer to a missing job — recover like the legacy orphan but
      // guarded by the pointer value.
      const staleAfter = raw.adapter_state === 'testing' ? budgets.testingStaleMs : budgets.buildingStaleMs;
      const startedAt = Date.parse(raw.last_build_at ?? raw.updated_at);
      if (Number.isFinite(startedAt) && nowMs - startedAt > staleAfter) {
        const message =
          `BUILD_STALE_RECOVERY: the build entered ${raw.adapter_state} at ${raw.last_build_at ?? 'unknown time'} ` +
          'but its build job no longer exists. The build was not verified; retry is required.'.slice(0, 1000);
        const { data: swept } = await client
          .from('cloudstream_extensions')
          .update({
            adapter_state: 'failed',
            current_build_job_id: null,
            last_build_error: message,
          })
          .eq('id', raw.id)
          .in('adapter_state', [raw.adapter_state])
          .eq('current_build_job_id', raw.current_build_job_id)
          .select('id');
        if (Array.isArray(swept) && swept.length === 1) {
          result.recovered += 1;
          result.details.push(`missing-job:${raw.id}`);
        }
      }
      continue;
    }

    // ------------------------------------------------------------------
    // 2. Terminal job, stuck row — apply the job's outcome (idempotent).
    // ------------------------------------------------------------------
    if (TERMINAL_JOB_STATES.includes(job.state as AdapterBuildJobState)) {
      const patch = extensionPatchFromTerminalJob(job, now);
      const { data: applied } = await client
        .from('cloudstream_extensions')
        .update(patch)
        .eq('id', raw.id)
        .eq('current_build_job_id', job.id)
        .in('adapter_state', ['building', 'testing'])
        .select('id');
      if (Array.isArray(applied) && applied.length === 1) {
        result.recovered += 1;
        result.details.push(`terminal-job-apply:${job.id}`);
      }
      continue;
    }

    // ------------------------------------------------------------------
    // 3. Queued job — re-dispatch / hard-stale.
    // ------------------------------------------------------------------
    if (job.state === 'queued') {
      const age = nowMs - Date.parse(job.created_at);
      if (age > budgets.queuedHardStaleMs) {
        const retired = await finishJob(client, job.id, ['queued'], 'failed', {
          error_code: 'EXECUTOR_UNREACHABLE',
          error_message: 'The build executor could not be reached; the build was never started. Retry is available.',
        });
        if (retired) {
          await client
            .from('cloudstream_extensions')
            .update({
              adapter_state: job.prior_adapter_state,
              current_build_job_id: null,
              last_build_error: 'EXECUTOR_UNREACHABLE: the background build executor was unreachable; no build ran. Retry is available.'.slice(0, 1000),
            })
            .eq('id', raw.id)
            .eq('current_build_job_id', job.id)
            .in('adapter_state', ['building', 'testing'])
            .select('id');
          result.recovered += 1;
          result.details.push(`executor-unreachable:${job.id}`);
        }
      } else if (age > budgets.dispatchRetryAfterMs) {
        await dispatchBuildExecutor(client, job.id, deps);
        result.redispatched += 1;
        result.details.push(`redispatch:${job.id}`);
      }
      continue;
    }

    // ------------------------------------------------------------------
    // 4. Active building/testing job — phase staleness.
    // ------------------------------------------------------------------
    const staleAfter = job.state === 'testing' ? budgets.testingStaleMs : budgets.buildingStaleMs;
    const lastHeartbeat = Date.parse(job.updated_at);
    if (Number.isFinite(lastHeartbeat) && nowMs - lastHeartbeat > staleAfter) {
      const cutoffIso = new Date(nowMs - staleAfter).toISOString();
      const message =
        `BUILD_STALE_RECOVERY: the build entered ${job.state} at ${job.started_at ?? job.updated_at} ` +
        'but no completion was observed within the build budget. The build was not verified; retry is required.'.slice(0, 1000);
      const { data: jobSwept } = await client
        .from('cloudstream_adapter_build_jobs')
        .update({
          state: 'stale_recovered',
          error_code: 'BUILD_STALE_RECOVERY',
          error_message: message,
          finished_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('id', job.id)
        .in('state', [job.state])
        .lt('updated_at', cutoffIso)
        .select('id');
      if (Array.isArray(jobSwept) && jobSwept.length === 1) {
        await client
          .from('cloudstream_extensions')
          .update({
            adapter_state: 'failed',
            current_build_job_id: null,
            last_build_error: message,
          })
          .eq('id', raw.id)
          .eq('current_build_job_id', job.id)
          .in('adapter_state', ['building', 'testing'])
          .select('id');
        result.recovered += 1;
        result.details.push(`stale-${job.state}:${job.id}`);
      }
    }
  }

  return result;
}

/** The extension-row patch that applies a terminal job's durable outcome. */
function extensionPatchFromTerminalJob(
  job: BuildJobRow,
  now: Date,
): Partial<Database['public']['Tables']['cloudstream_extensions']['Update']> {
  if (job.state === 'succeeded' && job.result_kind === 'generated') {
    return {
      adapter_state: 'generated',
      current_build_job_id: null,
      generated_adapter_version: job.result_adapter_version,
      last_tested_at: job.finished_at ?? now.toISOString(),
      last_build_error: null,
    };
  }
  if (job.state === 'succeeded' && job.result_kind === 'runtime_required') {
    return {
      adapter_state: 'runtime_required',
      current_build_job_id: null,
      last_build_error: job.error_message ?? 'The Builder determined this provider requires the native runtime.',
    };
  }
  if (job.state === 'failed' && job.error_code === 'EXECUTOR_UNREACHABLE') {
    return {
      adapter_state: job.prior_adapter_state,
      current_build_job_id: null,
      last_build_error: job.error_message ?? 'EXECUTOR_UNREACHABLE: no build ran; retry is available.',
    };
  }
  const message = job.error_message ?? 'The adapter build failed; retry is available.';
  return {
    adapter_state: 'failed',
    current_build_job_id: null,
    last_build_error: message.slice(0, 1000),
  };
}

// ---------------------------------------------------------------------------
// STATUS — the admin poll view
// ---------------------------------------------------------------------------

/** The admin-safe job view (polling contract). */
export type BuildJobView = {
  id: string;
  extensionId: string;
  canonicalKey: string;
  attempt: number;
  state: AdapterBuildJobState;
  requestedAdapterVersion: number;
  priorAdapterState: 'adapter_required' | 'failed';
  resultKind: 'generated' | 'runtime_required' | null;
  resultAdapterVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
};

function toJobView(job: BuildJobRow): BuildJobView {
  return {
    id: job.id,
    extensionId: job.extension_id,
    canonicalKey: job.canonical_key,
    attempt: job.attempt,
    state: job.state as AdapterBuildJobState,
    requestedAdapterVersion: job.requested_adapter_version,
    priorAdapterState: job.prior_adapter_state === 'failed' ? 'failed' : 'adapter_required',
    resultKind: job.result_kind === 'generated' || job.result_kind === 'runtime_required' ? job.result_kind : null,
    resultAdapterVersion: job.result_adapter_version,
    errorCode: job.error_code,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    finishedAt: job.finished_at,
  };
}

/** The latest job (any state) for ONE extension. */
export async function getBuildJobForExtension(client: CloudStreamClient, extensionId: string): Promise<BuildJobView | null> {
  if (typeof extensionId !== 'string' || !UUID_PATTERN.test(extensionId)) return null;
  const { data, error } = await client
    .from('cloudstream_adapter_build_jobs')
    .select(JOB_COLUMNS)
    .eq('extension_id', extensionId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error !== null || data === null || data.length === 0) return null;
  return toJobView((data[0] as unknown as BuildJobRow));
}

/** All ACTIVE jobs (bounded — the poll endpoint's no-id mode). */
export async function listActiveBuildJobs(client: CloudStreamClient, limit = 50): Promise<BuildJobView[]> {
  const { data, error } = await client
    .from('cloudstream_adapter_build_jobs')
    .select(JOB_COLUMNS)
    .in('state', [...ACTIVE_JOB_STATES])
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error !== null || data === null) return [];
  return (data as unknown as BuildJobRow[]).map(toJobView);
}
