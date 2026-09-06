import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { asResolverError } from '$lib/server/resolver/errors';
import { resolveSourceDiagnostics } from '$lib/server/resolver/service';

/**
 * Phase 7: Admin-only source resolution test endpoint.
 *
 * This endpoint invokes the resolver with `skipHealthMutation: true` so the
 * test does NOT mutate `streaming_provider_health`. It resolves ONLY the
 * requested source (no fallback to other sources) and returns diagnostic
 * info (attempts, ranking, duration) safe for an admin to review.
 *
 * Security:
 *   - `requireAdmin` is called at the top — anon/normal users get 403/redirect.
 *   - The service-role client is used server-side only (never sent to browser).
 *   - The resolved URL is included in the response (admin diagnostic), but
 *     no credentials/headers are exposed beyond what `SourceResult` already
 *     carries (which is the safe, sanitized shape used by the player).
 *   - No private `notes`/`templates`/`adapter_id` columns are returned.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  // Admin-only: this MUST be called before any resolver logic.
  await requireAdmin(locals, { redirectTo: '/admin/sources' });

  const parsed = await readJsonBody<unknown>(request);
  if (!parsed.ok) {
    return json({ ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The test request is invalid.' } }, { status: parsed.status });
  }
  const body = parsed.value;

  const startTime = Date.now();
  try {
    const diagnostics = await resolveSourceDiagnostics(locals.supabase, body, { skipHealthMutation: true });
    const durationMs = Date.now() - startTime;

    // Build a safe adapter-capability summary for the resolved source.
    // The adapter_id is read from the trusted config inside the resolver;
    // we look it up here via the result's provider/source relationship.
    // For security, we do NOT expose `adapter_id` or private columns.
    const result = diagnostics.result;
    const sourceId = result.sourceId;
    const providerId = result.providerId;

    return json({
      ok: result.type === 'direct' || result.type === 'embed',
      result,
      attempts: diagnostics.attempts,
      rankingDiagnostics: diagnostics.ranking,
      durationMs,
      // Minimal adapter info for the admin UI (no secrets).
      adapterInfo: {
        sourceId,
        providerId,
        type: result.type,
        // The admin UI can look up the full capability matrix from the
        // provider's adapter_id via the shared capability module. We don't
        // expose adapter_id here; the admin UI already has it from the
        // provider list load.
      },
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const resolverError = asResolverError(error);
    const durationMs = Date.now() - startTime;
    if (resolverError.code === 'INTERNAL_RESOLUTION_ERROR') console.error('[Admin Source Test] Resolution failed', { code: resolverError.code });
    return json({
      ok: false,
      error: { code: resolverError.code, message: resolverError.message },
      durationMs,
    }, { status: resolverError.status, headers: { 'cache-control': 'no-store' } });
  }
};
