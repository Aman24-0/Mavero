/**
 * Admin CloudStream/Nuvio adapter BUILD STATUS endpoint (durable build
 * lifecycle — migration 20261102000000).
 *
 * GET /api/admin/integrations/cloudstream/builds?extensionId=<uuid>
 *   200: { ok: true, extension, job }  — the fresh extension view + the
 *        extension's latest build job (phase, timestamps, outcome).
 * GET /api/admin/integrations/cloudstream/builds
 *   200: { ok: true, jobs: BuildJobView[] } — all ACTIVE jobs (bounded).
 *
 * Every poll ALSO runs the deterministic reconciler sweep:
 *   * re-dispatches stale queued jobs (idempotent — the claim CAS dedups)
 *   * recovers stale building/testing jobs (BUILD_STALE_RECOVERY → failed,
 *     retryable — budgets derived from the configured phase timeouts)
 *   * recovers legacy orphans (rows in building/testing with no job row —
 *     the pre-lifecycle CineStream pattern)
 *
 * This is what makes the lifecycle self-healing: even with the admin page
 * closed, the next page load / poll / queue action sweeps orphans — no
 * build can remain in building/testing forever.
 *
 * Security: admin-only (requireAdmin BEFORE any state logic), no-store
 * (live status), UUID-validated ids, safe curated job fields only (never
 * test inputs, never internal state). NEVER contacts the Builder — the
 * endpoint observes DURABLE DB state only ("do not claim a build completed
 * until the durable DB state confirms it").
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { getExtensionViewForAdmin } from '$lib/server/cloudstream/extensions/service';
import {
  reconcileAdapterBuilds,
  getBuildJobForExtension,
  listActiveBuildJobs,
} from '$lib/server/extensions/builder/build-lifecycle';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ url, request, locals }) => {
  // Admin-only — called BEFORE any state logic.
  await requireAdmin(locals, { redirectTo: '/admin/system/integrations?tab=extension' });

  const extensionId = url.searchParams.get('extensionId');

  // The deterministic stale sweep runs on EVERY poll (cheap: one indexed
  // query + guarded writes only for stale rows).
  const reconcile = await reconcileAdapterBuilds(locals.supabase, {
    origin: new URL(request.url).origin,
  }).catch(() => ({ recovered: 0, redispatched: 0, details: [] as string[] }));

  if (extensionId !== null && extensionId.length > 0) {
    if (!UUID_PATTERN.test(extensionId)) {
      return json(
        { ok: false, error: { code: 'VALIDATION', message: 'The extension id is invalid.' } },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const extension = await getExtensionViewForAdmin(locals.supabase, extensionId).catch(() => null);
    if (extension === null) {
      return json(
        { ok: false, error: { code: 'EXTENSION_NOT_FOUND', message: 'The extension could not be found.' } },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    const job = await getBuildJobForExtension(locals.supabase, extensionId);
    return json(
      { ok: true, extension, job, reconcile },
      { headers: NO_STORE_HEADERS },
    );
  }

  const jobs = await listActiveBuildJobs(locals.supabase);
  return json({ ok: true, jobs, reconcile }, { headers: NO_STORE_HEADERS });
};
