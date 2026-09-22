import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { createHash } from 'node:crypto';
import { readJsonBody } from '$lib/server/http/body';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type ExchangeRequest = {
  secret?: unknown;
};

/**
 * POST /api/auth/device-pairing/exchange
 *
 * Performs the server-side session exchange for the TV. This endpoint:
 *   1. Validates the pairing secret.
 *   2. Checks that the pairing is in 'approved' status.
 *   3. Reads the stored OTP code (hashed_token from generateLink).
 *   4. Calls locals.supabase.auth.exchangeCodeForSession(code) —
 *      this establishes the TV's OWN independent Supabase session.
 *   5. The exchange code is NEVER returned to the client.
 *
 * This endpoint uses the request's Supabase client (from the server hook)
 * to perform the exchange — the resulting session is set via cookies by
 * the Supabase SSR client, exactly like the existing /auth/callback flow.
 *
 * No authentication required — the pairing secret is the authorization.
 * This is called by the TV AFTER detecting 'approved' status via polling.
 */
export const POST: RequestHandler = async ({ request, locals, url }) => {
  const body = await readJsonBody<ExchangeRequest>(request, MAX_BODY_BYTES);
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

  // Look up the pairing request by secret_hash.
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const { data: pairing, error: lookupError } = await admin
    .from('device_pairing_requests')
    .select('id, status, expires_at, exchange_code, consumed_at')
    .eq('secret_hash', secretHash)
    .maybeSingle();

  if (lookupError || !pairing) {
    return json({ ok: false, message: 'Pairing request not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  // Check status — only approved requests can be exchanged.
  if (pairing.status !== 'approved') {
    return json({ ok: false, message: `This request is ${pairing.status}.` }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  // Check expiration.
  if (new Date(pairing.expires_at).getTime() < Date.now()) {
    await admin.from('device_pairing_requests').update({ status: 'expired' }).eq('id', pairing.id).eq('status', 'approved');
    return json({ ok: false, message: 'This request has expired.' }, { status: 410, headers: { 'cache-control': 'no-store' } });
  }

  // Check if already consumed.
  if (pairing.consumed_at) {
    return json({ ok: false, message: 'This request has already been consumed.' }, { status: 409, headers: { 'cache-control': 'no-store' } });
  }

  // Check if exchange_code exists.
  if (!pairing.exchange_code) {
    return json({ ok: false, message: 'Exchange code unavailable.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  // Perform the exchange using the TV's own Supabase SSR client.
  // This sets cookies on the response — establishing the TV's session.
  const { error: exchangeError } = await locals.supabase.auth.exchangeCodeForSession(pairing.exchange_code);

  if (exchangeError) {
    // Log only safe fields — NEVER log the exchange code.
    console.error('[Pairing] Exchange failed', { name: exchangeError.name, code: exchangeError.code });
    return json({ ok: false, message: 'Unable to establish a session.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  // Success — the TV now has its own independent session.
  // The consume endpoint will be called separately to clear the code.
  return json({ ok: true, message: 'Session established.' }, { headers: { 'cache-control': 'no-store' } });
};
