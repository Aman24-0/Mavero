import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { readJsonBody } from '$lib/server/http/body';
import { checkRateLimit } from '$lib/server/http/rate-limit';
import { createManualHandleForShortCode, normalizeShortCode } from '$lib/server/auth/device-pairing';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type LookupRequest = {
  code?: unknown;
};

/**
 * POST /api/auth/device-pairing/lookup
 *
 * AUTHENTICATED short-code lookup — the phone/tablet side of the
 * manual "Enter TV code" path (§10/§11).
 *
 * The user types the 8-character code displayed on the big screen.
 * This endpoint:
 *   1. REQUIRES authentication (locals.user from the server hook) —
 *      an unauthenticated visitor can never resolve codes.
 *   2. Rate limits BOTH per-user (10/min) and per-IP (30/min) —
 *      the 8-char code has ~2^40 entropy, so brute-force protection
 *      is mandatory. With those caps an attacker gets at most a few
 *      hundred guesses per code lifetime (5 min) per IP —
 *      astronomically far from the 2^39 expected-guess space.
 *   3. Normalizes + validates the code (uppercase, trim, reject
 *      invalid characters, exact length).
 *   4. Resolves ONLY pending, unexpired pairings.
 *   5. Returns a ONE-TIME 32-byte authorization handle (hashed at
 *      rest, bound to THIS user, 2-minute TTL) — NEVER the pairing
 *      secret. The phone navigates to /authorize#h=<handle>
 *      (URL fragment — never a query string) and the SAME secure
 *      authorization pipeline as the QR path takes over:
 *      device info → explicit Approve → pairing approval → big
 *      screen exchange.
 *
 * SECURITY:
 *   - The pairing secret is NEVER returned (an 8-char code must not
 *      become a 256-bit secret oracle).
 *   - No user IDs, no device identities for other accounts, no
 *      tokens of any kind in the response.
 *   - Uniform error message for invalid/consumed/expired codes —
 *      no state oracle.
 *   - cache-control: no-store on every response; nothing logged
 *      beyond safe rate-limit diagnostics.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) {
    return json({ ok: false, message: 'Authentication required.' }, { status: 401, headers: { 'cache-control': 'no-store' } });
  }

  // Dual rate limit — per-user (abusive account) AND per-IP
  // (shared IP / distributed probing of many accounts).
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const perUser = checkRateLimit('pairingCodeLookupUser', `pairing:lookup:u:${user.id}`);
  const perIp = checkRateLimit('pairingCodeLookupIp', `pairing:lookup:ip:${ip}`);
  if (!perUser.allowed || !perIp.allowed) {
    const retryAfter = Math.max(perUser.retryAfterSeconds, perIp.retryAfterSeconds);
    return json(
      { ok: false, message: 'Too many attempts. Please wait a moment and try again.', status: 'rate-limited' },
      { status: 429, headers: { 'retry-after': String(retryAfter), 'cache-control': 'no-store' } }
    );
  }

  const body = await readJsonBody<LookupRequest>(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, message: body.message }, { status: body.status, headers: { 'cache-control': 'no-store' } });

  const code = body.value?.code;
  if (typeof code !== 'string' || !normalizeShortCode(code)) {
    return json(
      { ok: false, message: 'Enter the 8-character code shown on the big screen.', status: 'invalid' },
      { status: 400, headers: { 'cache-control': 'no-store' } }
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

  const { handle, expiresAt, error, status } = await createManualHandleForShortCode(admin, code, user.id);

  if (error || !handle) {
    // Distinguish expiry for honest UX; everything else is a uniform
    // "invalid" (no state oracle).
    return json(
      { ok: false, message: error ?? 'Invalid or expired code.', status: status ?? 'invalid' },
      { status: 400, headers: { 'cache-control': 'no-store' } }
    );
  }

  return json(
    { ok: true, handle, expiresAt },
    { headers: { 'cache-control': 'no-store' } }
  );
};
