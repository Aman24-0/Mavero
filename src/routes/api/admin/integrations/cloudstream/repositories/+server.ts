/**
 * Admin CloudStream repository MUTATION endpoint (Permanent Adapter Plan
 * Phase 4 — plan §12).
 *
 * POST /api/admin/integrations/cloudstream/repositories
 *   Body: { action: 'setEnabled', id: string, enabled: boolean }
 *   200: { ok: true, repository: CloudStreamRepositoryView }
 *   4xx/5xx: { ok: false, error: { code, message } }
 *
 * WHY THIS ENDPOINT EXISTS (plan §12): repository enable/disable is a
 * TOGGLE — the same no-full-reload/no-scroll-jump contract as extension
 * toggles. The page's form action (`?/setCloudStreamRepositoryEnabled`)
 * remains the no-JS fallback; the JS-enabled UI calls this JSON endpoint
 * and patches the ONE repository row in its local state (targeted update —
 * extension views are unaffected by repository toggling).
 *
 * Security (mirrors the preview/mutation endpoint contracts):
 *   - Admin-only (`requireAdmin` — before any repository logic).
 *   - Bounded JSON body; the id is UUID-validated inside the service
 *     (`setRepositoryEnabled`) before it reaches a query.
 *   - Surfaces ONLY the safe curated messages from the closed
 *     CloudStreamRepositoryError taxonomy.
 *   - `no-store` cache headers (admin mutation surface).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';
import { setRepositoryEnabled, listRepositories } from '$lib/server/cloudstream/repository/service';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

type RepositoryMutateBody = {
  action?: unknown;
  id?: unknown;
  enabled?: unknown;
};

function invalid(status: 400 | 404 | 413 | 503, code: string, message: string) {
  return json({ ok: false, error: { code, message } }, { status, headers: NO_STORE_HEADERS });
}

export const POST: RequestHandler = async ({ request, locals }) => {
  // Admin-only — called BEFORE any repository logic.
  await requireAdmin(locals, { redirectTo: '/admin/system/integrations?tab=extension' });

  const parsed = await readJsonBody<RepositoryMutateBody>(request);
  if (!parsed.ok) {
    return invalid(parsed.status, parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', parsed.message);
  }
  const { action, id, enabled } = parsed.value;

  if (action !== 'setEnabled') {
    return invalid(400, 'INVALID_REQUEST', 'The action is invalid.');
  }
  if (typeof id !== 'string' || id.length === 0) {
    return invalid(400, 'VALIDATION', 'A repository id is required.');
  }
  if (typeof enabled !== 'boolean') {
    return invalid(400, 'VALIDATION', 'The enabled flag must be a boolean.');
  }

  try {
    await setRepositoryEnabled(locals.supabase, id, enabled);
    // Fresh view for the targeted client patch (ONE repository — the
    // response never re-ships the whole catalog).
    const repositories = await listRepositories(locals.supabase);
    const repository = repositories.find((row) => row.id === id) ?? null;
    if (repository === null) {
      return invalid(404, 'NOT_FOUND', 'The repository could not be found.');
    }
    return json({ ok: true, repository }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof CloudStreamRepositoryError) {
      return invalid(error.code === 'NOT_FOUND' ? 404 : 400, 'VALIDATION', error.message);
    }
    const result = classifyAdminMutationError(error, 'Unable to update the CloudStream repository.');
    return json(
      {
        ok: false,
        error: { code: result.status === 'unknown' ? 'UNEXPECTED' : result.status.toUpperCase(), message: result.message },
      },
      { status: result.status === 'unknown' ? 503 : 400, headers: NO_STORE_HEADERS },
    );
  }
};
