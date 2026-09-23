import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { readJsonBody } from '$lib/server/http/body';
import { checkRateLimit } from '$lib/server/http/rate-limit';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type InfoRequest = {
  secret?: unknown;
};

/**
 * POST /api/auth/device-pairing/info
 *
 * Phase 8: converted from GET (?s=<secret>) to POST with JSON body
 * ({ secret }). The pairing secret is a bearer credential — placing it
 * in the URL query string exposed it to server logs, browser history,
 * and referrer headers. The POST body is NOT logged by default.
 *
 * Returns safe device metadata for a pairing request. Used by the
 * phone authorization page to display device information before the
 * user approves.
 *
 * No authentication required — the pairing secret is the authorization
 * for reading this specific request's metadata.
 *
 * Phase 8: rate-limited via the `pairingInfo` bucket (30/min per IP).
 *
 * SECURITY:
 *   - cache-control: no-store on every response.
 *   - Never returns exchange_code, access_token, refresh_token, or
 *     any session material.
 *   - The secret is NOT logged.
 */
export const POST: RequestHandler = async ({ request }) => {
  // Rate limit by IP — unauthenticated endpoint.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateResult = checkRateLimit('pairingInfo', `pairing:info:${ip}`);
  if (!rateResult.allowed) {
    return json(
      { ok: false, message: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'retry-after': String(rateResult.retryAfterSeconds), 'cache-control': 'no-store' } }
    );
  }

  const body = await readJsonBody<InfoRequest>(request, MAX_BODY_BYTES);
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

  try {
    const crypto = await import('node:crypto');
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
    const { data, error: lookupError } = await admin
      .from('device_pairing_requests')
      .select('status, expires_at, requested_device_name, requested_browser, requested_os, requested_platform')
      .eq('secret_hash', secretHash)
      .maybeSingle();

    if (lookupError || !data) {
      return json({ ok: false, message: 'Pairing request not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } });
    }

    // Check expiration.
    if (new Date(data.expires_at).getTime() < Date.now()) {
      return json({ ok: false, status: 'expired', message: 'This request has expired.' }, { status: 410, headers: { 'cache-control': 'no-store' } });
    }

    if (data.status !== 'pending') {
      return json({ ok: false, status: data.status, message: `This request is already ${data.status}.` }, { status: 409, headers: { 'cache-control': 'no-store' } });
    }

    return json({
      ok: true,
      pairing: {
        deviceName: data.requested_device_name,
        browser: data.requested_browser,
        os: data.requested_os,
        platform: data.requested_platform,
      },
    }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return json({ ok: false, message: 'Unable to load pairing request.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
};
