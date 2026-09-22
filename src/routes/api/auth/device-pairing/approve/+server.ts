import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { approvePairingRequest } from '$lib/server/auth/device-pairing';
import { readJsonBody } from '$lib/server/http/body';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type ApproveRequest = {
  secret?: unknown;
};

/**
 * POST /api/auth/device-pairing/approve
 *
 * Approves a device pairing request. Called by the authenticated
 * phone user after scanning the QR code.
 *
 * Security:
 *   - Authentication required (locals.user from the server hook).
 *   - User identity from server-side auth context, NEVER from client.
 *   - The server calls admin.auth.admin.generateLink() to create a
 *     one-time OTP code for the user. The TV uses this code to
 *     establish its OWN independent Supabase session.
 *   - The phone's session is NOT copied to the TV.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return json({ ok: false, message: 'Authentication required.' }, { status: 401, headers: { 'cache-control': 'no-store' } });
  if (!user.email) return json({ ok: false, message: 'Account email required for device authorization.' }, { status: 400, headers: { 'cache-control': 'no-store' } });

  const body = await readJsonBody<ApproveRequest>(request, MAX_BODY_BYTES);
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

  const { success, error } = await approvePairingRequest(admin, secret, user.id, user.email);

  if (!success) {
    return json({ ok: false, message: error ?? 'Unable to approve the device.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  return json({ ok: true, message: 'Device authorized.' }, { headers: { 'cache-control': 'no-store' } });
};
