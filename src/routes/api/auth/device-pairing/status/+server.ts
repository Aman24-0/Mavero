import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { getPairingBySecret } from '$lib/server/auth/device-pairing';
import type { Database } from '$lib/server/supabase/database.types';

/**
 * GET /api/auth/device-pairing/status?secret=<pairing_secret>
 *
 * Returns the current status of a pairing request.
 * The TV polls this endpoint to detect when the phone has approved.
 *
 * Response shape (Phase 3.2):
 *   { ok: true, status: "pending" | "approved" | "consumed" | "expired" | "cancelled" }
 *
 * The dedicated /api/auth/device-pairing/exchange endpoint owns the
 * exchange credential — the status path must NEVER load or expose
 * the OTP code, any auth token, or any session material.
 *
 * No authentication required — the pairing secret itself is the
 * authorization. The secret is high-entropy (32 bytes random) and
 * short-lived (5 minutes).
 *
 * SECURITY:
 *   - cache-control: no-store on every response.
 *   - The status service selects ONLY `status` and `expires_at`
 *     from the database — never the exchange credential.
 */
export const GET: RequestHandler = async ({ url }) => {
  const secret = url.searchParams.get('secret');
  if (!secret || secret.length < 16) {
    return json({ ok: false, status: 'expired', message: 'Invalid pairing request.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!adminUrl || !adminKey) {
    return json({ ok: false, status: 'expired', message: 'Pairing service unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient<Database>(adminUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { request, error } = await getPairingBySecret(admin, secret);

  if (error || !request) {
    return json({ ok: false, status: 'expired', message: error ?? 'Pairing request not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  return json({
    ok: true,
    status: request.status,
  }, { headers: { 'cache-control': 'no-store' } });
};
