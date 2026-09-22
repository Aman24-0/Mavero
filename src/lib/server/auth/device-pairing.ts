/**
 * Device pairing service.
 *
 * Manages the lifecycle of QR-based device pairing requests:
 *   create → pending → approved → consumed
 *                     → expired
 *                     → cancelled
 *
 * Security:
 *   - The pairing secret is a 32-byte random string (URL-safe base64).
 *   - Only the SHA-256 hash is stored in the database.
 *   - The raw secret is returned ONCE to the TV that creates the
 *     request. It's encoded in the QR code.
 *   - The short_code is a human-readable fallback (8 chars).
 *   - Requests expire after 5 minutes.
 *   - The exchange_code (Supabase OTP from generateLink) is stored
 *     ONLY between approval and consumption. It is never returned to
 *     any client and is cleared atomically in the same UPDATE that
 *     marks the pairing as consumed.
 *   - Single-use claim: the dedicated exchange endpoint performs a
 *     single atomic UPDATE…RETURNING that flips `approved → consumed`
 *     and clears `exchange_code` in the same statement. The
 *     exchange_code is returned ONLY to the claiming request, lives
 *     in server memory only for the duration of
 *     exchangeCodeForSession(), and is never serialized to JSON,
 *     logs, or client state.
 */

import { createHash } from 'node:crypto';
import type { SupabaseAdminClient } from '$lib/server/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { parseDeviceMetadata } from './device-metadata';

const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SHORT_CODE_LENGTH = 8;
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

export type PairingStatus = 'pending' | 'approved' | 'consumed' | 'expired' | 'cancelled';

export type PairingRequest = {
  id: string;
  secret: string; // raw secret — only returned on creation
  shortCode: string;
  status: PairingStatus;
  deviceType: string;
  deviceName: string;
  browser: string | null;
  os: string | null;
  platform: string | null;
  expiresAt: string;
  createdAt: string;
};

/**
 * Status-only response shape. The dedicated /exchange endpoint owns
 * the exchange credential; the generic status path must never load
 * or expose it.
 */
export type PairingStatusResponse = {
  status: PairingStatus;
};

/**
 * Creates a new pairing request.
 * Called by the unauthenticated TV browser.
 */
export async function createPairingRequest(
  admin: SupabaseAdminClient,
  userAgent: string | null
): Promise<{ pairing: PairingRequest | null; error: string | null }> {
  try {
    // Generate cryptographic random secret (32 bytes, URL-safe base64).
    const secretBytes = new Uint8Array(32);
    crypto.getRandomValues(secretBytes);
    const secret = Buffer.from(secretBytes).toString('base64url');

    // Generate short code.
    const shortCode = generateShortCode();

    // Hash the secret for storage.
    const secretHash = hashSecret(secret);

    // Parse device metadata from the TV's User-Agent.
    const metadata = parseDeviceMetadata(userAgent);

    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();

    const { data, error } = await admin
      .from('device_pairing_requests')
      .insert({
        secret_hash: secretHash,
        short_code: shortCode,
        status: 'pending',
        requested_device_type: metadata.deviceType,
        requested_device_name: metadata.deviceName,
        requested_browser: metadata.browser,
        requested_os: metadata.os,
        requested_platform: metadata.platform,
        expires_at: expiresAt,
      })
      .select('*')
      .single();

    if (error || !data) {
      console.error('[Pairing] Create error', { name: error?.name, code: error?.code });
      return { pairing: null, error: 'Unable to create pairing request.' };
    }

    return {
      pairing: {
        id: data.id,
        secret, // raw — only returned once
        shortCode: data.short_code,
        status: 'pending',
        deviceType: data.requested_device_type,
        deviceName: data.requested_device_name,
        browser: data.requested_browser,
        os: data.requested_os,
        platform: data.requested_platform,
        expiresAt: data.expires_at,
        createdAt: data.created_at,
      },
      error: null,
    };
  } catch (err) {
    console.error('[Pairing] Create exception', { name: (err as Error)?.name ?? 'unknown' });
    return { pairing: null, error: 'Unable to create pairing request.' };
  }
}

/**
 * Looks up a pairing request's STATUS ONLY by its raw secret.
 * Used by the TV status polling and the phone authorization page.
 *
 * SECURITY: This function must NOT select `exchange_code` or
 * `consumed_at`. The exchange credential is owned exclusively by
 * the dedicated /exchange endpoint's atomic claim flow.
 */
export async function getPairingBySecret(
  admin: SupabaseAdminClient,
  secret: string
): Promise<{ request: PairingStatusResponse | null; error: string | null }> {
  try {
    const secretHash = hashSecret(secret);
    const { data, error } = await admin
      .from('device_pairing_requests')
      .select('status, expires_at')
      .eq('secret_hash', secretHash)
      .maybeSingle();

    if (error) {
      return { request: null, error: 'Unable to lookup pairing request.' };
    }
    if (!data) {
      return { request: null, error: 'Pairing request not found.' };
    }

    // Lazy expiry: if pending and past TTL, flip to 'expired'.
    const isExpired = new Date(data.expires_at).getTime() < Date.now();
    if (isExpired && data.status === 'pending') {
      await admin
        .from('device_pairing_requests')
        .update({ status: 'expired' })
        .eq('secret_hash', secretHash)
        .eq('status', 'pending');
      return { request: { status: 'expired' }, error: null };
    }

    return {
      request: { status: data.status as PairingStatus },
      error: null,
    };
  } catch {
    return { request: null, error: 'Unable to lookup pairing request.' };
  }
}

/**
 * Looks up a pairing request by its short code.
 * Used by the manual code entry fallback.
 */
export async function getPairingByShortCode(
  admin: SupabaseAdminClient,
  shortCode: string
): Promise<{ request: PairingRequest | null; error: string | null }> {
  try {
    const { data, error } = await admin
      .from('device_pairing_requests')
      .select('*')
      .eq('short_code', shortCode.toUpperCase())
      .eq('status', 'pending')
      .maybeSingle();

    if (error || !data) {
      return { request: null, error: 'Invalid or expired code.' };
    }

    // Check expiration.
    if (new Date(data.expires_at).getTime() < Date.now()) {
      await admin
        .from('device_pairing_requests')
        .update({ status: 'expired' })
        .eq('id', data.id)
        .eq('status', 'pending');
      return { request: null, error: 'This code has expired.' };
    }

    return {
      request: {
        id: data.id,
        secret: '', // NOT returned for short-code lookup (phone needs the secret to approve)
        shortCode: data.short_code,
        status: 'pending',
        deviceType: data.requested_device_type,
        deviceName: data.requested_device_name,
        browser: data.requested_browser,
        os: data.requested_os,
        platform: data.requested_platform,
        expiresAt: data.expires_at,
        createdAt: data.created_at,
      },
      error: null,
    };
  } catch {
    return { request: null, error: 'Unable to lookup pairing request.' };
  }
}

/**
 * Approves a pairing request.
 * Called by the authenticated phone user.
 *
 * Uses Supabase admin.auth.admin.generateLink() to create a magic
 * link for the approving user. The OTP code from the link is stored
 * in the pairing request — the TV's dedicated /exchange endpoint
 * will atomically claim it and call exchangeCodeForSession(code)
 * to establish its OWN independent Supabase session.
 */
export async function approvePairingRequest(
  admin: SupabaseAdminClient,
  secret: string,
  userId: string,
  userEmail: string
): Promise<{ success: boolean; error: string | null }> {
  try {
    const secretHash = hashSecret(secret);

    // 1. Look up the pairing request (status + expiry only — we do
    //    NOT need exchange_code here).
    const { data: pairing, error: lookupError } = await admin
      .from('device_pairing_requests')
      .select('id, status, expires_at')
      .eq('secret_hash', secretHash)
      .maybeSingle();

    if (lookupError || !pairing) {
      return { success: false, error: 'Pairing request not found.' };
    }

    // 2. Check status.
    if (pairing.status !== 'pending') {
      return { success: false, error: `This request is already ${pairing.status}.` };
    }

    // 3. Check expiration.
    if (new Date(pairing.expires_at).getTime() < Date.now()) {
      await admin
        .from('device_pairing_requests')
        .update({ status: 'expired' })
        .eq('id', pairing.id);
      return { success: false, error: 'This request has expired.' };
    }

    // 4. Generate a magic link for the user via Supabase admin API.
    //    This creates an OTP code that the TV browser can use with
    //    exchangeCodeForSession(code) to establish its own session.
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: userEmail,
    });

    if (linkError || !linkData) {
      console.error('[Pairing] generateLink error', { name: linkError?.name, code: linkError?.code });
      return { success: false, error: 'Unable to authorize this device right now.' };
    }

    // Extract the OTP code from the magic link URL.
    // The hashed_token is what exchangeCodeForSession expects.
    const otpCode = linkData.properties?.hashed_token;
    if (!otpCode) {
      console.error('[Pairing] No exchange code in generateLink response');
      return { success: false, error: 'Unable to authorize this device right now.' };
    }

    // 5. Atomically update: pending → approved + store exchange_code.
    //    The .eq('status', 'pending') ensures only one approval can
    //    succeed (race condition protection).
    const { error: updateError } = await admin
      .from('device_pairing_requests')
      .update({
        status: 'approved',
        approved_by_user_id: userId,
        approved_at: new Date().toISOString(),
        exchange_code: otpCode,
      })
      .eq('id', pairing.id)
      .eq('status', 'pending');

    if (updateError) {
      // Could be a race condition — another approval already happened.
      return { success: false, error: 'This request may have already been processed.' };
    }

    return { success: true, error: null };
  } catch (err) {
    console.error('[Pairing] Approve exception', { name: (err as Error)?.name ?? 'unknown' });
    return { success: false, error: 'Unable to approve the pairing request.' };
  }
}

/**
 * Cancels a pairing request.
 * Called by the authenticated phone user (or automatically on TV page unload).
 *
 * Only `pending` requests can be cancelled — this is intentional.
 * Once a request is `approved`, the exchange_code has been issued by
 * Supabase and the TV may already have consumed it; cancelling an
 * approved request is NOT supported by design.
 */
export async function cancelPairingRequest(
  admin: SupabaseAdminClient,
  secret: string
): Promise<boolean> {
  try {
    const secretHash = hashSecret(secret);
    const { error } = await admin
      .from('device_pairing_requests')
      .update({ status: 'cancelled' })
      .eq('secret_hash', secretHash)
      .eq('status', 'pending');

    return !error;
  } catch {
    return false;
  }
}

/**
 * Outcome of an atomic claim+exchange attempt.
 */
export type ExchangeOutcome =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Atomically claims an approved pairing request and exchanges the
 * stored OTP code for a Supabase session on the TV's behalf.
 *
 * This is the SINGLE operation that:
 *   1. Validates the pairing secret.
 *   2. Atomically claims the approved pairing request (single-winner
 *      UPDATE…RETURNING — Postgres row-level lock serializes
 *      concurrent attempts on the same row).
 *   3. Only the request that successfully claims it receives the
 *      exchange_code in RETURNING. The code lives in server memory
 *      only for the duration of step 4.
 *   4. Calls `exchangeCodeForSession(code)` on the TV's OWN Supabase
 *      SSR client — the resulting session is established through
 *      cookies on the TV's response (NOT a copy of the phone's
 *      session, NOT a JSON token).
 *   5. Marks the pairing as `consumed` and clears `exchange_code`
 *      in the SAME atomic UPDATE as the claim — so no second
 *      request can ever read the code.
 *
 * Concurrency analysis:
 *   Two concurrent requests with the same secret_hash both target
 *   the same row. Postgres acquires a row-level lock on the first
 *   UPDATE; the second UPDATE blocks until the first commits, then
 *   re-evaluates the WHERE clause. Because the first UPDATE set
 *   `status='consumed'` and `consumed_at = now()`, the second
 *   UPDATE's `WHERE status='approved' AND consumed_at IS NULL` no
 *   longer matches — RETURNING yields zero rows. The second request
 *   therefore cannot obtain the exchange_code and fails safely with
 *   HTTP 409.
 *
 * Failure semantics:
 *   If `exchangeCodeForSession()` fails (network, Supabase error,
 *   already-consumed OTP), the pairing is ALREADY in `consumed`
 *   state from step 2 — the OTP has been either consumed by the
 *   failed call or is now unusable. The user must re-pair (create
 *   a new QR). This is the intended behavior: we cannot retry
 *   because `generateLink()` requires the phone user's auth context
 *   which the TV does not have.
 *
 * SECURITY:
 *   - The exchange_code is NEVER returned to the client.
 *   - The exchange_code is NEVER logged.
 *   - The exchange_code exists in server memory only between the
 *     RETURNING step and the exchangeCodeForSession() call.
 *   - The raw pairing secret is NEVER logged.
 */
export async function claimAndExchangePairing(
  admin: SupabaseAdminClient,
  tvSupabase: SupabaseClient<Database>,
  secret: string
): Promise<ExchangeOutcome> {
  // Step 1: hash the secret for lookup.
  const secretHash = hashSecret(secret);

  // Step 2: atomic claim. Only one concurrent request can win this
  // UPDATE; all others get an empty RETURNING result.
  //
  // The .eq('status', 'approved') clause prevents claiming a
  // pending/cancelled/expired/consumed request. The
  // .eq('consumed_at', null) clause is belt-and-suspenders —
  // 'approved' status already implies consumed_at IS NULL (consumed
  // state always sets consumed_at in the same statement), but the
  // extra guard defends against any future bug that might leave
  // consumed_at NULL on a consumed row.
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await admin
    .from('device_pairing_requests')
    .update({
      status: 'consumed',
      consumed_at: now,
      exchange_code: null, // clear in the SAME statement as the claim
    })
    .eq('secret_hash', secretHash)
    .eq('status', 'approved')
    .is('consumed_at', null)
    .gt('expires_at', now)
    .select('id, exchange_code')
    .maybeSingle();

  if (claimError) {
    console.error('[Pairing] Claim error', { name: claimError.name, code: claimError.code });
    return { ok: false, status: 503, message: 'Unable to establish a session.' };
  }

  if (!claimed) {
    // Either: not found, not approved, already consumed, cancelled,
    // or expired. Determine which for a helpful client message —
    // but do NOT include any credential material.
    const { data: current } = await admin
      .from('device_pairing_requests')
      .select('status, expires_at')
      .eq('secret_hash', secretHash)
      .maybeSingle();

    if (!current) {
      return { ok: false, status: 404, message: 'Pairing request not found.' };
    }
    const isExpired = new Date(current.expires_at).getTime() < Date.now();
    if (isExpired || current.status === 'expired') {
      return { ok: false, status: 410, message: 'This request has expired.' };
    }
    if (current.status === 'consumed') {
      return { ok: false, status: 409, message: 'This request has already been consumed.' };
    }
    if (current.status === 'cancelled') {
      return { ok: false, status: 410, message: 'This request was cancelled.' };
    }
    // pending or unknown
    return { ok: false, status: 400, message: `This request is ${current.status}.` };
  }

  // Step 3: we have the exchange_code in memory ONLY. It has been
  // cleared from the DB in the same atomic UPDATE.
  const otpCode = claimed.exchange_code;
  if (!otpCode) {
    // Defensive: the row was in 'approved' state but exchange_code
    // was NULL. This shouldn't happen if approve works correctly,
    // but we treat it as a terminal failure — the pairing is now
    // consumed and the user must re-pair.
    console.error('[Pairing] Claim succeeded but stored credential was null', {
      requestId: claimed.id,
    });
    return { ok: false, status: 503, message: 'Unable to establish a session.' };
  }

  // Step 4: exchange on the TV's OWN Supabase SSR client. This sets
  // cookies on the response — establishing the TV's independent
  // session. The exchange_code is consumed here.
  const { error: exchangeError } = await tvSupabase.auth.exchangeCodeForSession(otpCode);

  if (exchangeError) {
    // Log only safe fields — NEVER log the exchange code, the
    // secret, the hashed_token, or any token material.
    console.error('[Pairing] Exchange failed', {
      name: exchangeError.name,
      code: exchangeError.code,
    });
    return { ok: false, status: 503, message: 'Unable to establish a session.' };
  }

  // Step 5: success. The pairing is already in 'consumed' state from
  // step 2. No further state mutation needed.
  return { ok: true };
}

// --- Helpers ---

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function generateShortCode(): string {
  const chars: string[] = [];
  const bytes = new Uint8Array(SHORT_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    chars.push(SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length]);
  }
  return chars.join('');
}
