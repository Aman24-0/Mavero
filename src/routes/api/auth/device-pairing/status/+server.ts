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
 * When status is 'approved', the response includes the exchange_code
 * which the TV uses to establish its own Supabase session via
 * exchangeCodeForSession(code).
 *
 * No authentication required — the pairing secret itself is the
 * authorization. The secret is high-entropy (32 bytes random) and
 * short-lived (5 minutes).
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
    exchangeCode: request.exchangeCode,
  }, { headers: { 'cache-control': 'no-store' } });
};
