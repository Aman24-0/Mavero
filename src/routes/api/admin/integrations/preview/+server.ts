/**
 * Admin Stremio addon preview endpoint.
 *
 * POST /api/admin/integrations/preview
 *   Body: { manifestUrl: string }
 *   200: { ok: true, preview: AdminAddonPreview }
 *   4xx/5xx: { ok: false, error: { code, message } }
 *
 * Why a dedicated JSON endpoint (vs. the existing `?/previewAddon` form
 * action on /admin/system/integrations):
 *   The form-action response shape is SvelteKit-specific (the action's
 *   return value is wrapped as `{ form: { ... } }` and is not a standard
 *   API response). The previous client manually invoked the form action
 *   via `fetch('/admin/system/integrations?/previewAddon', …)` and
 *   parsed `json.form?.preview` — a fragile shape that silently failed
 *   and left the `previewing` spinner stuck. This endpoint returns a
 *   standard JSON envelope (`{ ok, preview | error }`) the client can
 *   parse reliably.
 *
 * Security:
 *   - Admin-only (`requireAdmin` — same gate as every admin route).
 *   - Delegates to the EXISTING secure `previewAddonFromManifestUrl`
 *     function (Phase 2 pipeline: SSRF validation, redirect/DNS policy,
 *     timeouts, body limits, normalization, capability detection). No
 *     manifest-fetching or validation logic is duplicated here.
 *   - Surfaces ONLY the safe, curated messages from `ManifestServiceError`,
 *     `StreamingValidationError` and `AddonUnsupportedError` — never
 *     internal IP/DNS/stack details.
 *   - Does NOT persist anything — preview is validation-only.
 *   - `no-store` cache headers (admin mutation surface).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  previewAddonFromManifestUrl,
  AddonUnsupportedError,
} from '$lib/server/streaming/stremio/admin-addons';
import { StreamingValidationError } from '$lib/server/streaming/validation';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ request, locals }) => {
  // Admin-only — called before any manifest logic so anon/normal users
  // never reach the network-fetching preview path.
  await requireAdmin(locals, { redirectTo: '/admin/system/integrations' });

  const parsed = await readJsonBody<{ manifestUrl?: unknown }>(request);
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

  const { manifestUrl } = parsed.value;
  if (typeof manifestUrl !== 'string' || manifestUrl.trim().length === 0) {
    return json(
      {
        ok: false,
        error: { code: 'VALIDATION', message: 'A manifest URL is required.' },
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    // Delegate to the EXISTING secure preview function. It uses
    // `locals.supabase` (the user-scoped Supabase client, authenticated
    // as the admin) — the same client the form-action preview used. The
    // function performs duplicate-URL detection, manifest validation,
    // SSRF protection and capability detection.
    const preview = await previewAddonFromManifestUrl(locals.supabase, manifestUrl);
    return json({ ok: true, preview }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    // Safe-error contract: only surface curated messages from the known
    // error types. Unknown errors go through `classifyAdminMutationError`
    // which never leaks internals.
    if (error instanceof StreamingValidationError || error instanceof AddonUnsupportedError) {
      return json(
        { ok: false, error: { code: 'VALIDATION', message: error.message } },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof ManifestServiceError) {
      // `ManifestServiceError.code` is a curated safe union; the message
      // is the only text the Phase 2 pipeline ever persists, so it is
      // safe to surface verbatim.
      return json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const result = classifyAdminMutationError(error, 'Unable to preview addon.');
    return json(
      {
        ok: false,
        error: { code: result.status === 'unknown' ? 'UNEXPECTED' : result.status.toUpperCase(), message: result.message },
      },
      { status: result.status === 'unknown' ? 503 : 400, headers: NO_STORE_HEADERS },
    );
  }
};
