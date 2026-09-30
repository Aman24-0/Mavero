import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { readJsonBody } from '$lib/server/http/body';
import { checkRateLimit } from '$lib/server/http/rate-limit';
import { getPairingBySecret, getPairingStatusByHandle } from '$lib/server/auth/device-pairing';
import type { Database } from '$lib/server/supabase/database.types';
import type { SupabaseAdminClient } from '$lib/server/supabase/admin';

const MAX_BODY_BYTES = 4 * 1024;

type StatusRequest = {
  secret?: unknown;
  handle?: unknown;
};

/**
 * POST /api/auth/device-pairing/status
 *
 * Returns the current status of a pairing request. The big screen
 * polls this endpoint to detect when the phone has approved; the
 * phone polls it after approving to confirm the device completed
 * sign-in.
 *
 * Converted from GET (?secret=<secret>) to POST with a JSON body —
 * the pairing secret is a bearer credential and must not appear in
 * URL query strings (server logs, browser history, referrer
 * headers). Mirrors the Phase 8 /info hardening.
 *
 * Two lookup modes:
 *   { secret } — the big screen's QR secret (no auth; the secret is
 *                the authorization).
 *   { handle } — the phone's manual-code handle. REQUIRES
 *                authentication; the handle is bound to the user
 *                who resolved the short code.
 *
 * Response shape:
 *   { ok: true, status: "pending" | "approved" | "exchanging" |
 *                 "consumed" | "failed" | "expired" | "cancelled" }
 *
 * The dedicated /api/auth/device-pairing/exchange endpoint owns the
 * exchange credential — this path must NEVER load or expose the
 * token hash, any auth token, or any session material.
 *
 * Phase 4 hardening: rate-limited via the `pairingPoll` bucket
 * (60/min per IP+credential-tag). The big screen polls every 3s;
 * 60/min accommodates the 5-minute TTL with margin. The identity
 * key includes a (truncated) credential tag so polling different
 * pairings from the same IP are tracked separately.
 *
 * SECURITY:
 *   - cache-control: no-store on every response.
 *   - Selects ONLY `status` (+ expiry/binding fields) from the
 *     database — never the exchange credential.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  // Rate limit by IP + (truncated) credential tag.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  const body = await readJsonBody<StatusRequest>(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, status: 'expired', message: body.message }, { status: body.status, headers: { 'cache-control': 'no-store' } });

  const secret = body.value?.secret;
  const handle = body.value?.handle;

  if (typeof secret === 'string' && secret.length >= 16) {
    const secretTag = secret.slice(0, 8);
    const rateResult = checkRateLimit('pairingPoll', `pairing:status:${ip}:${secretTag}`);
    if (!rateResult.allowed) {
      return json(
        { ok: false, status: 'expired', message: 'Too many status requests. Please slow down.' },
        { status: 429, headers: { 'retry-after': String(rateResult.retryAfterSeconds), 'cache-control': 'no-store' } }
      );
    }
    return await respondWithPairingStatus(async (admin) => getPairingBySecret(admin, secret));
  }

  if (typeof handle === 'string' && handle.length >= 16) {
    // Handle path — authentication required; the handle is bound to
    // the user who resolved the short code.
    const user = locals.user;
    if (!user) {
      return json({ ok: false, status: 'expired', message: 'Authentication required.' }, { status: 401, headers: { 'cache-control': 'no-store' } });
    }
    // Authenticated polling is keyed by user (the handle is already
    // account-bound) with an IP tag for shared-account abuse.
    const rateResult = checkRateLimit('pairingPoll', `pairing:status:h:${user.id}:${ip}`);
    if (!rateResult.allowed) {
      return json(
        { ok: false, status: 'expired', message: 'Too many status requests. Please slow down.' },
        { status: 429, headers: { 'retry-after': String(rateResult.retryAfterSeconds), 'cache-control': 'no-store' } }
      );
    }
    return await respondWithPairingStatus(async (admin) => getPairingStatusByHandle(admin, handle, user.id));
  }

  return json({ ok: false, status: 'expired', message: 'Invalid pairing request.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
};

/** Shared response helper — resolves the status via the given lookup and maps errors. */
async function respondWithPairingStatus(
  lookup: (admin: SupabaseAdminClient) => Promise<{ request: { status: string } | null; error: string | null }>
): Promise<Response> {
  const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!adminUrl || !adminKey) {
    return json({ ok: false, status: 'expired', message: 'Pairing service unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient<Database>(adminUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { request, error } = await lookup(admin);

  if (error || !request) {
    return json({ ok: false, status: 'expired', message: error ?? 'Pairing request not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  return json({
    ok: true,
    status: request.status,
  }, { headers: { 'cache-control': 'no-store' } });
}
