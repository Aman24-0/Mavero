import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { createPairingRequest } from '$lib/server/auth/device-pairing';
import type { Database } from '$lib/server/supabase/database.types';
import { checkRateLimit } from '$lib/server/http/rate-limit';

/**
 * POST /api/auth/device-pairing/create
 *
 * Creates a new device pairing request. Called by the unauthenticated
 * TV browser. Returns the pairing secret (for QR code generation) and
 * the short code (for manual entry fallback).
 *
 * Phase 4 hardening: rate-limited via the dedicated `pairingCreate`
 * bucket (10/min per IP). Each challenge persists a row + secret_hash,
 * so a tighter limit than `search` is appropriate.
 *
 * Serverless honesty: this rate limit is per-instance (Netlify function
 * instance). A distributed attacker could exceed 10/min globally, but
 * the limit caps the per-instance cost and protects the upstream
 * Supabase INSERT. The deployment-level control (Netlify WAF / per-IP
 * limits) is the authoritative global layer.
 */
export const POST: RequestHandler = async ({ request }) => {
  // Rate limit by IP — unauthenticated endpoint.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateResult = checkRateLimit('pairingCreate', `pairing:create:${ip}`);
  if (!rateResult.allowed) {
    return json(
      { ok: false, message: 'Too many pairing requests. Please try again shortly.' },
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

  const userAgent = request.headers.get('user-agent');
  const { pairing, error } = await createPairingRequest(admin, userAgent);

  if (error || !pairing) {
    return json({ ok: false, message: error ?? 'Unable to create pairing request.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  // Build the QR URL — the phone will scan this and open the authorize page.
  // Phase 8: the pairing secret is placed in the URL FRAGMENT (#s=) rather
  // than the query string (?s=). A URL fragment is NOT sent to the HTTP
  // server, so the secret never appears in server logs, browser history
  // request lines, or referrer headers. The phone scanner extracts it
  // client-side and passes it via POST body to /info and /approve.
  const origin = new URL(request.url).origin;
  const qrUrl = `${origin}/authorize#s=${encodeURIComponent(pairing.secret)}`;

  return json({
    ok: true,
    pairing: {
      secret: pairing.secret,
      shortCode: pairing.shortCode,
      qrUrl,
      expiresAt: pairing.expiresAt,
      deviceName: pairing.deviceName,
    },
  }, { headers: { 'cache-control': 'no-store' } });
};
