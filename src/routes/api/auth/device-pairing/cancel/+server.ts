import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { cancelPairingRequest } from '$lib/server/auth/device-pairing';
import { readJsonBody } from '$lib/server/http/body';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type CancelRequest = {
  secret?: unknown;
};

/**
 * POST /api/auth/device-pairing/cancel
 *
 * Cancels a pairing request. Called by the authenticated phone user
 * when they choose "Cancel" on the authorization page.
 *
 * Security:
 *   - The pairing secret is the authorization for cancelling —
 *     only the phone that scanned the QR (or the TV that created it)
 *     can cancel the request.
 *   - Only 'pending' requests can be cancelled (atomic state transition).
 *   - After cancellation, the request cannot be approved or consumed.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readJsonBody<CancelRequest>(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, message: body.message }, { status: body.status, headers: { 'cache-control': 'no-store' } });

  const secret = body.value?.secret;
  if (typeof secret !== 'string' || secret.length < 16) {
    return json({ ok: false, message: 'A valid pairing secret is required.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!adminUrl || !adminKey) {
    return json({ ok: false, message: 'Pairing service unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient<Database>(adminUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const success = await cancelPairingRequest(admin, secret);

  if (!success) {
    return json({ ok: false, message: 'Unable to cancel the pairing request.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  return json({ ok: true, message: 'Pairing request cancelled.' }, { headers: { 'cache-control': 'no-store' } });
};
