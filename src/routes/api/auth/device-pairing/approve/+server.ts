import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { approvePairingRequest } from '$lib/server/auth/device-pairing';
import { readJsonBody } from '$lib/server/http/body';
import { checkRateLimit } from '$lib/server/http/rate-limit';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type ApproveRequest = {
  secret?: unknown;
  handle?: unknown;
};

/**
 * POST /api/auth/device-pairing/approve
 *
 * Approves a device pairing request. Called by the authenticated
 * phone user — after scanning the QR code (credential = pairing
 * secret) OR after entering the 8-char TV code (credential = the
 * one-time manual handle from /lookup). Both paths converge into
 * the SAME approval state machine (approvePairingRequest).
 *
 * Security:
 *   - Authentication required (locals.user from the server hook).
 *   - User identity from server-side auth context, NEVER from client.
 *   - The server calls admin.auth.admin.generateLink({ type:
 *     'magiclink' }) to create a one-time token hash for the user.
 *     The big screen verifies it with verifyOtp({ token_hash,
 *     type: 'email' }) on its OWN SSR client — an independent
 *     session, NOT a copy of the phone's.
 *   - The handle path is additionally bound to the user who resolved
 *     the short code (an approved handle cannot be replayed by a
 *     different account).
 *   - The phone's session is NOT copied to the big screen.
 *
 * Rate limits (Phase 4 + manual-code hardening):
 *   - `pairingApprove` bucket: 20/min per user (both credential
 *     paths). Each approval calls Supabase generateLink which is
 *     itself rate-limited server-side.
 *   - The manual-code path is additionally throttled upstream at
 *     /lookup (dual per-user + per-IP buckets) — brute-force
 *     probing cannot even reach this endpoint without a valid
 *     handle.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return json({ ok: false, message: 'Authentication required.', status: 'auth' }, { status: 401, headers: { 'cache-control': 'no-store' } });
  if (!user.email) return json({ ok: false, message: 'Account email required for device authorization.' }, { status: 400, headers: { 'cache-control': 'no-store' } });

  // Rate limit by user — authenticated endpoint.
  const rateResult = checkRateLimit('pairingApprove', `pairing:approve:${user.id}`);
  if (!rateResult.allowed) {
    return json(
      { ok: false, message: 'Too many approval attempts. Please try again shortly.' },
      { status: 429, headers: { 'retry-after': String(rateResult.retryAfterSeconds), 'cache-control': 'no-store' } }
    );
  }

  const body = await readJsonBody<ApproveRequest>(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, message: body.message }, { status: body.status, headers: { 'cache-control': 'no-store' } });

  const secret = body.value?.secret;
  const handle = body.value?.handle;

  // Resolve the credential: EITHER a QR secret (256-bit, scanned)
  // OR a manual-code handle (256-bit, from the authenticated
  // short-code lookup — bound to this user).
  let credential: { secret: string } | { handle: string; userId: string };
  if (typeof secret === 'string' && secret.length >= 16) {
    credential = { secret };
  } else if (typeof handle === 'string' && handle.length >= 16) {
    credential = { handle, userId: user.id };
  } else {
    return json({ ok: false, message: 'A valid pairing credential is required.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
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

  const { success, error } = await approvePairingRequest(admin, credential, user.id, user.email);

  if (!success) {
    return json({ ok: false, message: error ?? 'Unable to approve the device.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  return json({ ok: true, message: 'Device authorized.' }, { headers: { 'cache-control': 'no-store' } });
};
