/**
 * Admin CloudStream/Nuvio extension MUTATION endpoint (Permanent Adapter
 * Plan Phase 4 — plan §11/§12).
 *
 * POST /api/admin/integrations/cloudstream/extensions
 *   Body: { action: 'setEnabled', id: string, enabled: boolean }
 *       | { action: 'setEnabledBulk', ids: string[], enabled: boolean }
 *       | { action: 'createAdapter', id: string, testTmdbId?, … }
 *       | { action: 'testProvider', id: string, testTmdbId?, … }
 *   200: { ok: true, extension | extensions | providerTest, … }
 *   4xx/5xx: { ok: false, error: { code, message }, extension? }
 *
 * WHY THIS ENDPOINT EXISTS (plan §12): the Extension manager's toggles must
 * run as async actions with TARGETED state updates — no full page reload, no
 * scroll jump. The page's SvelteKit form actions remain as the no-JS
 * fallback (unchanged, regression-pinned); the JS-enabled UI calls THIS JSON
 * endpoint and patches its local row state from the returned views
 * ("invalidate only affected data"). It is also the bulk-operation surface
 * (§11: enable/disable selected, create adapters for selected — the client
 * drives one request per bounded chunk and shows progress).
 *
 * createAdapter (DURABLE LIFECYCLE, 20261102000000): the action now QUEUES
 * the build job and returns IMMEDIATELY ({ queued: true, jobId }) — the
 * build runs in the background executor (Netlify background function /
 * local detached execution), and the UI polls
 * /api/admin/integrations/cloudstream/builds for the durable state. The
 * synchronous pipeline could not survive the Netlify 10s/26s function
 * ceiling (the CineStream stale-'building' root cause). The lifecycle
 * guards (native precedence, runtime_required, BUILD_IN_PROGRESS,
 * EXTENSION_NOT_FOUND, BUILDER_UNAVAILABLE) are IDENTICAL to the
 * pre-lifecycle contract.
 *
 * Security (mirrors the preview endpoint contract):
 *   - Admin-only (`requireAdmin` — called BEFORE any catalog/Builder logic
 *     so anon/normal users never reach mutation code paths).
 *   - Bounded JSON body (`readJsonBody`, 256 KiB), bounded bulk id count
 *     (MAX_BULK_IDS, single shared constant with the UI chunking).
 *   - Every id UUID-validated before it reaches a query.
 *   - createAdapter is the ONLY action that may contact the external
 *     Adapter Builder — through the SAME durable build lifecycle
 *     orchestration (queue job → background executor → pipeline with
 *     lifecycle guards, CAS, artifact hash verification, atomic
 *     promotion; never a raw Builder call).
 *     testProvider NEVER contacts the Builder (test-what-you-ship).
 *   - Surfaces ONLY safe, curated messages from the closed error
 *     taxonomies — never internals/stack traces.
 *   - `no-store` cache headers (admin mutation surface).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';
import {
  setExtensionEnabled,
  setExtensionsEnabledBulk,
  getExtensionViewForAdmin,
} from '$lib/server/cloudstream/extensions/service';
import { setExtensionPosition } from '$lib/server/downloader/source-order';
import { queueAdapterBuild, reconcileAdapterBuilds } from '$lib/server/extensions/builder/build-lifecycle';
import { testExtensionProvider } from '$lib/server/extensions/builder/test-service';
import type { CloudStreamExtensionView } from '$lib/server/cloudstream/types';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const VALID_ACTIONS = new Set(['setEnabled', 'setEnabledBulk', 'createAdapter', 'testProvider', 'setPosition']);

/** The optional representative test-input override fields (form-action parity). */
const TEST_INPUT_FIELDS = ['testTmdbId', 'testTitle', 'testYear', 'testImdbId', 'testSeason', 'testEpisode'] as const;

type TestInputField = (typeof TEST_INPUT_FIELDS)[number];

type MutateBody = {
  action?: unknown;
  id?: unknown;
  ids?: unknown;
  enabled?: unknown;
  position?: unknown;
} & Partial<Record<TestInputField, unknown>>;

function invalid(status: 400 | 404 | 413 | 503, code: string, message: string, extension: CloudStreamExtensionView | null = null) {
  return json({ ok: false, error: { code, message }, ...(extension !== null ? { extension } : {}) }, { status, headers: NO_STORE_HEADERS });
}

function unexpected(error: unknown, fallback: string) {
  const result = classifyAdminMutationError(error, fallback);
  return json(
    {
      ok: false,
      error: { code: result.status === 'unknown' ? 'UNEXPECTED' : result.status.toUpperCase(), message: result.message },
    },
    { status: result.status === 'unknown' ? 503 : 400, headers: NO_STORE_HEADERS },
  );
}

/** Extracts the string-valued test-input overrides (never trusts shapes). */
function readTestInputs(body: MutateBody): { testTmdbId?: string; testTitle?: string; testYear?: string; testImdbId?: string; testSeason?: string; testEpisode?: string } {
  const inputs: Partial<Record<TestInputField, string>> = {};
  for (const field of TEST_INPUT_FIELDS) {
    const value = body[field];
    if (typeof value === 'string' && value.length > 0) inputs[field] = value;
  }
  return inputs;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  // Admin-only — called BEFORE any catalog/Builder logic.
  await requireAdmin(locals, { redirectTo: '/admin/system/integrations?tab=extension' });

  const parsed = await readJsonBody<MutateBody>(request);
  if (!parsed.ok) {
    return invalid(parsed.status, parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', parsed.message);
  }
  const body = parsed.value;

  const action = body.action;
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    return invalid(400, 'INVALID_REQUEST', 'The action is invalid.');
  }

  // ---------------------------------------------------------------------
  // Toggles (plan §12): single + bulk enable/disable with fresh views.
  // ---------------------------------------------------------------------
  if (action === 'setEnabled' || action === 'setEnabledBulk') {
    if (typeof body.enabled !== 'boolean') {
      return invalid(400, 'VALIDATION', 'The enabled flag must be a boolean.');
    }
    if (action === 'setEnabled') {
      if (typeof body.id !== 'string' || body.id.length === 0) {
        return invalid(400, 'VALIDATION', 'An extension id is required.');
      }
      try {
        await setExtensionEnabled(locals.supabase, body.id, body.enabled);
        const extension = await getExtensionViewForAdmin(locals.supabase, body.id);
        return json({ ok: true, extension }, { headers: NO_STORE_HEADERS });
      } catch (error) {
        if (error instanceof CloudStreamRepositoryError) {
          return invalid(error.code === 'NOT_FOUND' ? 404 : 400, 'VALIDATION', error.message);
        }
        return unexpected(error, 'Unable to update the extension.');
      }
    }
    if (!Array.isArray(body.ids)) {
      return invalid(400, 'VALIDATION', 'A list of extension ids is required.');
    }
    try {
      const extensions = await setExtensionsEnabledBulk(locals.supabase, body.ids, body.enabled);
      return json({ ok: true, extensions }, { headers: NO_STORE_HEADERS });
    } catch (error) {
      if (error instanceof CloudStreamRepositoryError) {
        return invalid(error.code === 'NOT_FOUND' ? 404 : 400, 'VALIDATION', error.message);
      }
      return unexpected(error, 'Unable to update the extensions.');
    }
  }

  // ---------------------------------------------------------------------
  // setPosition (FINAL TASK, PART G): moves ONE CloudStream/Nuvio
  // extension to a 1-based GLOBAL position (the unified add-on + plugin
  // ordering namespace). Never contacts the Builder; the response carries
  // the moved row's fresh view + the fresh global position map so the
  // client patches EVERY displayed position (not just the moved row).
  // ---------------------------------------------------------------------
  if (action === 'setPosition') {
    if (typeof body.id !== 'string' || body.id.length === 0) {
      return invalid(400, 'VALIDATION', 'An extension id is required.');
    }
    const rawPosition = body.position;
    const position = typeof rawPosition === 'number' ? rawPosition : Number(rawPosition);
    if (!Number.isSafeInteger(position) || position < 1) {
      return invalid(400, 'VALIDATION', 'Position must be a whole number starting at 1.');
    }
    try {
      const { result, positions } = await setExtensionPosition(locals.supabase, body.id, position);
      if (!result.ok) {
        const status = result.code === 'TABLE_MISSING' ? 503 : result.code === 'NOT_FOUND' ? 404 : 400;
        return invalid(status, result.code, result.message);
      }
      const extension = await getExtensionViewForAdmin(locals.supabase, body.id);
      const positionEntries: Record<string, number> = {};
      for (const [key, value] of positions) positionEntries[key] = value;
      return json(
        { ok: true, extension, position: result.position, positions: positionEntries },
        { headers: NO_STORE_HEADERS },
      );
    } catch (error) {
      return unexpected(error, 'Unable to update the extension position.');
    }
  }

  // ---------------------------------------------------------------------
  // createAdapter (plan §11 bulk "create adapters for selected where
  // valid" — one extension per request; the client drives the queue).
  // DURABLE LIFECYCLE: queue + immediate return; the UI polls the
  // /builds endpoint for the terminal state.
  // ---------------------------------------------------------------------
  if (action === 'createAdapter') {
    if (typeof body.id !== 'string' || body.id.length === 0) {
      return invalid(400, 'VALIDATION', 'An extension id is required.');
    }
    // Pre-flight sweep: a stale building/testing row becomes retryable
    // BEFORE the guard runs (no permanent orphan can block the action).
    await reconcileAdapterBuilds(locals.supabase, {
      origin: new URL(request.url).origin,
    }).catch(() => undefined);
    const queued = await queueAdapterBuild(locals.supabase, body.id, readTestInputs(body), {
      origin: new URL(request.url).origin,
    }, {
      createdBy: typeof locals.user?.id === 'string' ? locals.user.id : undefined,
    });
    // The row view is reloaded BEST-EFFORT even on failure (a refusal or
    // queued transition must be visible without a page reload).
    const extension = await getExtensionViewForAdmin(locals.supabase, body.id).catch(() => null);
    if (!queued.ok) {
      const status = queued.code === 'BUILDER_UNAVAILABLE' || queued.code === 'BUILDER_TIMEOUT' ? 503 : 400;
      return invalid(status, queued.code, queued.message, extension);
    }
    return json(
      {
        ok: true,
        queued: true,
        jobId: queued.jobId,
        dispatch: queued.dispatch,
        extension,
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  // ---------------------------------------------------------------------
  // testProvider (plan §9/§15 — NEVER contacts the Builder).
  // ---------------------------------------------------------------------
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return invalid(400, 'VALIDATION', 'An extension id is required.');
  }
  const outcome = await testExtensionProvider(locals.supabase, body.id, readTestInputs(body));
  const extension = await getExtensionViewForAdmin(locals.supabase, body.id).catch(() => null);
  if (!outcome.ok) {
    return invalid(400, outcome.code, outcome.message, extension);
  }
  return json({ ok: true, extension, providerTest: outcome.result }, { headers: NO_STORE_HEADERS });
};
