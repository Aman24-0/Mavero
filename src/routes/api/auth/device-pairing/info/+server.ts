import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { getPairingBySecret } from '$lib/server/auth/device-pairing';
import type { Database } from '$lib/server/supabase/database.types';

/**
 * GET /api/auth/device-pairing/info?s=<pairing_secret>
 *
 * Returns safe device metadata for a pairing request. Used by the
 * phone authorization page to display device information before
 * the user approves.
 *
 * No authentication required — the pairing secret is the authorization
 * for reading this specific request's metadata.
 */
export const GET: RequestHandler = async ({ url }) => {
  const secret = url.searchParams.get('s');
  if (!secret || secret.length < 16) {
    return json({ ok: false, message: 'Invalid pairing request.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
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

  // Look up the full pairing request for device metadata display.
  const { createClient: _, ...rest } = { createClient };
  // Actually, we need to query the pairing request by secret_hash.
  // Let's add a helper that returns device metadata.
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
