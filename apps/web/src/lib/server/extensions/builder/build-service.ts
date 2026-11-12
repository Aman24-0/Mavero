/**
 * MAVERO — Create Adapter orchestration (Permanent Adapter Plan Phase 3 —
 * plan §7/§10/§11/§12/§13, D-P3-7; DURABLE LIFECYCLE since
 * 20261102000000_adapter_build_lifecycle.sql — see build-lifecycle.ts).
 *
 * The implementation moved to build-lifecycle.ts (one pipeline, one job
 * model). THIS module preserves the historical import surface
 * ($lib/server/extensions/builder/build-service) used by the admin form
 * actions, the JSON mutation endpoint, and the test suites:
 *
 *   createAdapterForExtension — the SYNCHRONOUS compatibility path:
 *   queue the durable job + execute it inline (used by tests, live smoke
 *   harnesses, and any caller that genuinely wants to await the outcome
 *   on a long-lived server). Even THIS path is durable: if the caller dies
 *   mid-execute, the reconciler recovers the row — the CineStream
 *   permanent-'building' orphan is structurally impossible now.
 *
 * The PRODUCTION admin path (Netlify) uses queueAdapterBuild +
 * executeAdapterBuildJob from build-lifecycle.ts (fast queue return +
 * background execution + polling), because a synchronous pipeline cannot
 * survive the Netlify 10s/26s synchronous function ceiling.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
  queueAdapterBuild,
  executeAdapterBuildJob,
  type CreateAdapterOutcome,
  type CreateAdapterDeps,
} from './build-lifecycle';

type CloudStreamClient = SupabaseClient<Database>;

export type { CreateAdapterOutcome, CreateAdapterDeps };

/**
 * Runs the full create-adapter pipeline for one extension row
 * SYNCHRONOUSLY (queue + inline execute; bounded by the builder timeout +
 * test budgets). The row's persisted state — including the durable job row
 * — is the progress record; if the caller dies mid-flight the reconciler
 * recovers the row deterministically (no permanent 'building').
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
  const queued = await queueAdapterBuild(client, extensionId, rawTestInputs, deps, { dispatch: 'none' });
  if (!queued.ok) {
    return { ok: false, code: queued.code, message: queued.message };
  }
  return executeAdapterBuildJob(client, queued.jobId, deps);
}
