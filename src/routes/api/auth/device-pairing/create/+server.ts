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
 * Rate limited to prevent abuse.
 */
export const POST: RequestHandler = async ({ request }) => {
  // Rate limit by IP.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateResult = checkRateLimit('resolve' as never, `pairing:${ip}`);
  // Use a simple inline rate limit check (reuse existing infrastructure
  // pattern but with a custom identity).
  // Actually, let's use the existing checkRateLimit with a new bucket name.
  // But adding a new bucket requires modifying rate-limit.ts. For Phase 3,
  // let's add the bucket name to the existing file. For now, use the
  // 'search' bucket as a reasonable proxy (30/min per identity).
  const searchRate = checkRateLimit('search', `pairing:${ip}`);
  if (!searchRate.allowed) {
    return json(
      { ok: false, message: 'Too many pairing requests. Please try again shortly.' },
      { status: 429, headers: { 'retry-after': String(searchRate.retryAfterSeconds), 'cache-control': 'no-store' } }
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
  const authorizeUrl = `${publicEnv.PUBLIC_SUPABASE_URL ? '' : ''}`; // placeholder
  // The QR URL points to the Mavero app's authorize page with the secret.
  // In production this would be the public app URL.
  const origin = new URL(request.url).origin;
  const qrUrl = `${origin}/authorize?s=${pairing.secret}`;

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
