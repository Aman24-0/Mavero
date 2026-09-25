import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { readJsonBody } from '$lib/server/http/body';
import { checkRateLimit } from '$lib/server/http/rate-limit';
import { claimVerifyAndEstablishPairingSession } from '$lib/server/auth/device-pairing';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type ExchangeRequest = {
  secret?: unknown;
};

/**
 * POST /api/auth/device-pairing/exchange
 *
 * Performs the server-side lease claim + Supabase token
 * verification + cookie establishment for the big screen.
 *
 * This endpoint is the SINGLE owner of the exchange credential. It:
 *   1. Validates the pairing secret (bearer credential).
 *   2. Atomically claims the approved pairing via claim_device_pairing
 *      (approved → exchanging with a 30s lease; the stored token hash
 *      is returned to the caller and KEPT in the row for retry).
 *   3. Verifies the token hash on the TV's OWN SSR client
 *      (locals.supabase) with verifyOtp({ token_hash, type: 'email' })
 *      — the officially supported primitive for a magic-link
 *      hashed_token. The resulting session is persisted through the
 *      SSR cookie adapter (Set-Cookie on THIS response) — an
 *      independent session, NOT a copy of the phone's.
 *   4. Verifies the auth cookies were actually queued for this
 *      response (§5 acceptance condition).
 *   5. Marks the pairing consumed (complete_device_pairing).
 *
 * Failure semantics (§21 taxonomy — safe server logs only, generic
 * user messages): the response carries a machine-readable `reason`
 * + `retryable` flag so the big-screen client can auto-retry
 * transient failures without burning a new pairing.
 *
 * No authentication required — the pairing secret is the
 * authorization. Called by the big screen AFTER detecting the
 * 'approved' status via polling.
 *
 * SECURITY:
 *   - The exchange_code (token hash) is NEVER returned to the
 *     client and NEVER logged.
 *   - The raw pairing secret is NEVER logged.
 *   - No auth tokens, OTP codes, or session material are ever
 *     logged or returned in the JSON body.
 *   - cache-control: no-store on every response.
 */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
  const body = await readJsonBody<ExchangeRequest>(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, message: body.message }, { status: body.status, headers: { 'cache-control': 'no-store' } });

  const secret = body.value?.secret;
  if (typeof secret !== 'string' || secret.length < 16) {
    return json({ ok: false, message: 'A valid pairing secret is required.', retryable: false }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  // Rate limit by IP — unauthenticated endpoint. Each exchange
  // attempt calls the Supabase verify endpoint, so a tighter cap
  // than polling is appropriate.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateResult = checkRateLimit('pairingExchange', `pairing:exchange:${ip}`);
  if (!rateResult.allowed) {
    return json(
      { ok: false, message: 'Too many exchange attempts. Please try again shortly.', retryable: true },
      { status: 429, headers: { 'retry-after': String(rateResult.retryAfterSeconds), 'cache-control': 'no-store' } }
    );
  }

  const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!adminUrl || !adminKey) {
    console.error('[Pairing] missing-supabase-config', { requestId: locals.requestId });
    return json(
      { ok: false, message: 'Pairing service unavailable.', retryable: false },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient<Database>(adminUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // The big screen's OWN Supabase SSR client — verifyOtp() on this
  // client persists the new session through the SSR cookie adapter
  // (event.cookies → Set-Cookie on this response), establishing the
  // device's independent session.
  const tvSupabase = locals.supabase;

  const outcome = await claimVerifyAndEstablishPairingSession(admin, tvSupabase, secret, {
    requestId: locals.requestId,
    // §5 acceptance check input: cookie names queued for THIS
    // response (SvelteKit's cookie cache reflects cookies set
    // during the request — the chunked sb-*-auth-token cookies must
    // be present after a successful verifyOtp).
    getCookieNames: () => cookies.getAll().map((cookie) => cookie.name),
  });

  if (!outcome.ok) {
    // Generic user message for security; the safe `reason` taxonomy
    // goes to server logs (see device-pairing.ts logExchange) and —
    // in non-sensitive, machine-readable form — to the client so it
    // can decide whether an automatic retry is safe.
    return json(
      { ok: false, message: outcome.message, reason: outcome.reason, retryable: outcome.retryable },
      { status: outcome.status, headers: { 'cache-control': 'no-store' } }
    );
  }

  return json({ ok: true, message: 'Session established.' }, { headers: { 'cache-control': 'no-store' } });
};
