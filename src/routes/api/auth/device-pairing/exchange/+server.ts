import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { readJsonBody } from '$lib/server/http/body';
import { checkRateLimit } from '$lib/server/http/rate-limit';
import { claimAndExchangePairing } from '$lib/server/auth/device-pairing';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type ExchangeRequest = {
  secret?: unknown;
};

/**
 * POST /api/auth/device-pairing/exchange
 *
 * Performs the server-side atomic claim + session exchange for the TV.
 *
 * This endpoint is the SINGLE owner of the exchange credential. It:
 *   1. Validates the pairing secret.
 *   2. Atomically claims the approved pairing request via a server-side
 *      PL/pgSQL RPC (claim_device_pairing) that uses SELECT ... FOR UPDATE
 *      to capture the OLD exchange_code BEFORE the UPDATE, then UPDATEs
 *      the row to 'consumed' and clears exchange_code in the SAME
 *      transaction. The OLD OTP is returned to the caller.
 *   3. Only the request that successfully claims it receives the
 *      exchange_code from the RPC. The code lives in server memory
 *      only for the duration of step 4.
 *   4. Calls locals.supabase.auth.exchangeCodeForSession(code) —
 *      this establishes the TV's OWN independent Supabase session
 *      via the SSR cookie mechanism (NOT a copy of the phone's
 *      session, NOT a JSON token, NOT client-side localStorage).
 *   5. The pairing is already in 'consumed' state from step 2 —
 *      no further state mutation is needed.
 *
 * Concurrency safety:
 *   Two concurrent requests with the same secret both call the RPC.
 *   Inside the RPC, the first transaction's SELECT ... FOR UPDATE
 *   acquires a row-level lock; the second transaction blocks, then
 *   re-evaluates the WHERE clause after the first commits. The
 *   second SELECT finds no row (status is now 'consumed') and the
 *   RPC returns an empty result set — the caller falls through to
 *   the diagnostic branch (HTTP 409).
 *
 * No authentication required — the pairing secret is the
 * authorization. This is called by the TV AFTER detecting 'approved'
 * status via polling.
 *
 * Phase 4 hardening: rate-limited via the `pairingExchange` bucket
 * (10/min per IP). Each exchange consumes a Supabase OTP, so a tighter
 * cap than polling is appropriate.
 *
 * SECURITY:
 *   - The exchange_code is NEVER returned to the client.
 *   - The exchange_code is NEVER logged.
 *   - The raw pairing secret is NEVER logged.
 *   - No auth tokens, OTP codes, or session material are ever
 *     logged or returned in the JSON body.
 *   - cache-control: no-store on every response.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const body = await readJsonBody<ExchangeRequest>(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, message: body.message }, { status: body.status, headers: { 'cache-control': 'no-store' } });

  const secret = body.value?.secret;
  if (typeof secret !== 'string' || secret.length < 16) {
    return json({ ok: false, message: 'A valid pairing secret is required.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  // Rate limit by IP — unauthenticated endpoint. Each exchange
  // consumes a Supabase OTP, so a tighter cap than polling.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateResult = checkRateLimit('pairingExchange', `pairing:exchange:${ip}`);
  if (!rateResult.allowed) {
    return json(
      { ok: false, message: 'Too many exchange attempts. Please try again shortly.' },
      { status: 429, headers: { 'retry-after': String(rateResult.retryAfterSeconds), 'cache-control': 'no-store' } }
    );
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

  // The TV's own Supabase SSR client — exchangeCodeForSession()
  // on this client sets cookies on the response, establishing the
  // TV's independent session through the standard SSR flow.
  const tvSupabase = locals.supabase;

  const outcome = await claimAndExchangePairing(admin, tvSupabase, secret);

  if (!outcome.ok) {
    return json({ ok: false, message: outcome.message }, { status: outcome.status, headers: { 'cache-control': 'no-store' } });
  }

  return json({ ok: true, message: 'Session established.' }, { headers: { 'cache-control': 'no-store' } });
};
