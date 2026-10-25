/**
 * Admin CloudStream repository preview endpoint (CS-1).
 *
 * POST /api/admin/integrations/cloudstream/preview
 *   Body: { repositoryUrl: string }
 *   200: { ok: true, preview: CloudStreamRepositoryPreview }
 *   4xx/5xx: { ok: false, error: { code, message } }
 *
 * Mirrors the existing Stremio preview endpoint
 * (/api/admin/integrations/preview) so the Add Integration CloudStream flow
 * gets the same reliable JSON envelope the Stremio flow already uses.
 *
 * Security:
 *   - Admin-only (`requireAdmin` — same gate as every admin route; called
 *     before any repository logic so anon/normal users never reach the
 *     network-fetching preview path).
 *   - Delegates to the CloudStream repository service, which runs the FULL
 *     SSRF-safe pipeline (fetchStremioManifest: URL validation, redirect/DNS
 *     policy, connect-time re-validation, timeouts, body limits, JSON-only)
 *     via the cloudstream/security facade. No fetching logic is duplicated
 *     here.
 *   - Discovery only: validates the repository URL, fetches CS.json,
 *     resolves pluginLists, parses plugins.json and returns bounded,
 *     normalized extension metadata. Does NOT persist anything and NEVER
 *     fetches/executes `.cs3` artifacts.
 *   - Surfaces ONLY the safe, curated messages from the CloudStream error
 *     taxonomy — never internal IP/DNS/stack details.
 *   - `no-store` cache headers (admin mutation surface).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { previewRepository } from '$lib/server/cloudstream/repository/service';
import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ request, locals }) => {
  // Admin-only — called before any repository logic so anon/normal users
  // never reach the network-fetching preview path.
  await requireAdmin(locals, { redirectTo: '/admin/system/integrations?tab=extension' });

  const parsed = await readJsonBody<{ repositoryUrl?: unknown }>(request);
  if (!parsed.ok) {
    return json(
      {
        ok: false,
        error: {
          code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
          message: parsed.status === 413 ? parsed.message : 'The preview request is invalid.',
        },
      },
      { status: parsed.status, headers: NO_STORE_HEADERS },
    );
  }

  const { repositoryUrl } = parsed.value;
  if (typeof repositoryUrl !== 'string' || repositoryUrl.trim().length === 0) {
    return json(
      {
        ok: false,
        error: { code: 'VALIDATION', message: 'A CloudStream repository URL is required.' },
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    // Validation + discovery only — NO persistence. The function performs
    // duplicate-URL detection, repository validation, SSRF protection and
    // extension metadata discovery through the secure pipeline.
    const preview = await previewRepository(locals.supabase, repositoryUrl);
    return json({ ok: true, preview }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    // Safe-error contract: only surface curated messages from the known
    // error type. Unknown errors go through `classifyAdminMutationError`
    // which never leaks internals.
    if (error instanceof CloudStreamRepositoryError) {
      return json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const result = classifyAdminMutationError(error, 'Unable to preview the CloudStream repository.');
    return json(
      {
        ok: false,
        error: { code: result.status === 'unknown' ? 'UNEXPECTED' : result.status.toUpperCase(), message: result.message },
      },
      { status: result.status === 'unknown' ? 503 : 400, headers: NO_STORE_HEADERS },
    );
  }
};
