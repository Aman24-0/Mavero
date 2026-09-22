import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { consumePairingRequest } from '$lib/server/auth/device-pairing';
import { readJsonBody } from '$lib/server/http/body';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type ConsumeRequest = {
  secret?: unknown;
};

/**
 * POST /api/auth/device-pairing/consume
 *
 * Marks a pairing request as consumed after the TV has successfully
 * exchanged the code for a Supabase session. This clears the
 * exchange_code (single-use) and prevents replay.
 *
 * No authentication required — the pairing secret is the authorization.
 * This is called by the TV AFTER it has called
 * exchangeCodeForSession(code) and established its own session.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readJsonBody<ConsumeRequest>(request, MAX_BODY_BYTES);
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

  const success = await consumePairingRequest(admin, secret);

  if (!success) {
    return json({ ok: false, message: 'Unable to consume the pairing request.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  return json({ ok: true, message: 'Pairing consumed.' }, { headers: { 'cache-control': 'no-store' } });
};
