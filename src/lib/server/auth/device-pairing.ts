/**
 * Device pairing service.
 *
 * Manages the lifecycle of QR-based device pairing requests:
 *   create → pending → approved → exchanging (lease) → consumed
 *                     ↺ approved (recoverable release)  ↘ failed
 *                     → expired
 *                     → cancelled
 *
 * EXCHANGE CREDENTIAL SEMANTICS (post-94ce1ef production regression fix):
 *   The exchange credential is the `hashed_token` returned by
 *   `admin.auth.admin.generateLink({ type: 'magiclink' })`. Per the
 *   installed @supabase/supabase-js 2.112.3 typings and the GoTrue
 *   (supabase/auth) /verify implementation, that token hash is verified
 *   with:
 *
 *     supabase.auth.verifyOtp({ token_hash, type: 'email' })
 *
 *   GoTrue's verifyTokenHash maps type 'email' to a lookup over the
 *   confirmation OR recovery token (a magiclink generateLink sets the
 *   user's recovery token; the verify handler dynamically adapts the
 *   type/expiry check to 'magiclink' when the recovery token matches),
 *   then runs recoverVerify — which CLEARS the recovery token
 *   (one-time use) — and issues a full session in the response body.
 *   The SSR client persists that session through the cookie adapter's
 *   setAll(), i.e. Set-Cookie headers on the TV's HTTP response.
 *
 *   `exchangeCodeForSession()` was previously (and WRONGLY) used for
 *   this: it is the PKCE authorization-code exchange — it requires a
 *   code_verifier stored by a client that initiated an OAuth/PKCE
 *   flow. The TV's SSR client never runs such a flow, so the call
 *   could never succeed. This was the production regression observed
 *   on real devices: approval worked, session establishment failed.
 *
 * LEASE STATE MACHINE (no permanent dead state on exchange failure):
 *   The OLD claim RPC flipped approved → consumed and cleared the
 *   credential BEFORE the Supabase verification ran — a transient
 *   verify failure permanently killed the pairing. The NEW RPCs
 *   (20261003000000 migration) implement:
 *
 *     claim_device_pairing        approved (or lease-expired
 *                                 exchanging) → exchanging, 30s lease,
 *                                 credential KEPT for retry
 *     verifyOtp                   on the TV's own SSR client
 *     complete_device_pairing     exchanging → consumed (success;
 *                                 clears credential)
 *     release_device_pairing_…    exchanging → approved (recoverable
 *                                 failure — token NOT consumed at
 *                                 Supabase; same credential retried)
 *     fail_device_pairing         exchanging → failed (terminal —
 *                                 token expired/consumed at Supabase,
 *                                 or cookies could not be established)
 *
 *   Race safety: SELECT ... FOR UPDATE in the claim serializes
 *   concurrent exchangers; only the lease holder can complete,
 *   release, or fail (bound to the claim's row id). Replay after
 *   consumption is impossible — consumed/failed rows are never
 *   claimable. A crashed exchangeer's lease expires, allowing a
 *   takeover claim with the same still-stored credential.
 *
 * Security:
 *   - The pairing secret is a 32-byte random string (URL-safe base64).
 *   - Only the SHA-256 hash is stored in the database.
 *   - The raw secret is returned ONCE to the big screen that creates
 *     the request. It's encoded in the QR code (URL fragment).
 *   - The short_code is a human-readable fallback (8 chars). Lookups
 *     by short code are AUTHENTICATED + rate limited and never return
 *     the pairing secret — they return a one-time 32-byte manual
 *     handle (hashed at rest, bound to the resolving user, 2-min TTL)
 *     that feeds the SAME approval pipeline.
 *   - Requests expire after 5 minutes (bounded lifetime — no stuck
 *     state can outlive the TTL).
 *   - The exchange_code is stored ONLY between approval and terminal
 *     state. It is never returned to any client and is cleared
 *     atomically on consumption/failure.
 *   - The exchange_code lives in server memory only between the claim
 *     RPC and the verifyOtp() call.
 */

import { createHash } from 'node:crypto';
import type { SupabaseAdminClient } from '$lib/server/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { parseDeviceMetadata } from './device-metadata';

const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SHORT_CODE_LENGTH = 8;
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const SHORT_CODE_PATTERN = /^[A-Z0-9]{8}$/;

/** Exchange lease: how long a single claim may run before another claim can take over. */
export const EXCHANGE_LEASE_MS = 30_000;
/** Hard cap on exchange attempts per pairing (protects the Supabase verify endpoint). */
export const MAX_EXCHANGE_ATTEMPTS = 5;
/**
 * Manual-code authorization handle TTL. Matches the pairing TTL:
 * the handle's useful life IS the pairing's life (approve + exchange
 * happen inside it). It is one-time and user-bound regardless; a
 * shorter TTL would cut off the phone's legitimate post-approval
 * completion polling.
 */
export const MANUAL_HANDLE_TTL_MS = 5 * 60 * 1000;

export type PairingStatus = 'pending' | 'approved' | 'exchanging' | 'consumed' | 'failed' | 'expired' | 'cancelled';

/**
 * Safe, machine-readable failure reason for server logs. NEVER
 * includes credential material. The taxonomy is required by the
 * regression audit (§21) so operators can distinguish:
 *   claim-rpc-missing        → migration NOT deployed (PGRST202)
 *   claim-rpc-failed         → RPC exists but the call errored
 *   pairing-not-approved     → claim found no eligible row (pending)
 *   pairing-expired          → TTL passed
 *   pairing-consumed         → already used (replay attempt)
 *   pairing-failed           → terminal failure state
 *   exchange-lease-busy      → another exchange holds the lease
 *   token-verification-failed (+ transient|otp-expired|invalid)
 *   cookie-establishment-failed
 */
export type ExchangeFailureReason =
  | 'missing-supabase-config'
  | 'claim-rpc-missing'
  | 'claim-rpc-failed'
  | 'pairing-not-found'
  | 'pairing-not-approved'
  | 'pairing-expired'
  | 'pairing-consumed'
  | 'pairing-failed'
  | 'exchange-lease-busy'
  | 'token-verification-failed'
  | 'cookie-establishment-failed';

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

// ---------------------------------------------------------------------------
// Logging helper — safe diagnostics only (requestId + reason + safe error
// name/code). NEVER the pairing secret, token hash, OTP, or tokens.
// ---------------------------------------------------------------------------

function logExchange(reason: ExchangeFailureReason, requestId: string, detail?: { name?: string; code?: string | number }) {
  console.error(`[Pairing] ${reason}`, {
    requestId,
    reason,
    ...(detail?.name !== undefined ? { errorName: detail.name } : {}),
    ...(detail?.code !== undefined ? { errorCode: detail.code } : {}),
  });
}

/**
 * Creates a new pairing request.
 * Called by the unauthenticated big-screen browser.
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

    // Parse device metadata from the big screen's User-Agent.
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
 * Used by the big-screen status polling and the phone authorization
 * page (post-approval confirmation polling).
 *
 * SECURITY: This function must NOT select `exchange_code` or
 * `consumed_at`. The exchange credential is owned exclusively by
 * the dedicated /exchange endpoint's claim flow.
 *
 * Lazy expiry: pending (and stale exchanging) rows past their TTL
 * are flipped to 'expired' so no state can persist forever.
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

    // Lazy expiry: pending (never scanned) or exchanging (crashed
    // exchangeer — its 30s lease is long past) rows are terminal
    // once the pairing TTL passes.
    const isExpired = new Date(data.expires_at).getTime() < Date.now();
    if (isExpired && (data.status === 'pending' || data.status === 'exchanging' || data.status === 'approved')) {
      await admin
        .from('device_pairing_requests')
        .update({ status: 'expired', exchange_lease_until: null })
        .eq('secret_hash', secretHash)
        .in('status', ['pending', 'approved', 'exchanging']);
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
 * Resolves a pairing request's STATUS by manual handle (the phone's
 * "Enter TV code" path). The handle is the one-time credential
 * returned by an authenticated short-code lookup; it is bound to the
 * resolving user id and short-lived.
 *
 * SECURITY: status only — never the exchange credential.
 */
export async function getPairingStatusByHandle(
  admin: SupabaseAdminClient,
  handle: string,
  userId: string
): Promise<{ request: PairingStatusResponse | null; error: string | null }> {
  try {
    const handleHash = hashSecret(handle);
    const { data, error } = await admin
      .from('device_pairing_requests')
      .select('status, expires_at, manual_handle_user_id, manual_handle_expires_at')
      .eq('manual_handle_hash', handleHash)
      .maybeSingle();

    if (error) {
      return { request: null, error: 'Unable to lookup pairing request.' };
    }
    if (!data) {
      return { request: null, error: 'Pairing request not found.' };
    }

    // Handle binding: only the authenticated user who resolved the
    // short code may use it.
    if (data.manual_handle_user_id !== userId) {
      return { request: null, error: 'Pairing request not found.' };
    }

    // Handle expiry — a stale handle behaves like an unknown one
    // (no information leak beyond "not found").
    if (
      !data.manual_handle_expires_at ||
      new Date(data.manual_handle_expires_at).getTime() < Date.now()
    ) {
      return { request: null, error: 'This code has expired. Please enter a new one.' };
    }

    const isExpired = new Date(data.expires_at).getTime() < Date.now();
    if (isExpired) {
      return { request: { status: 'expired' }, error: null };
    }

    return { request: { status: data.status as PairingStatus }, error: null };
  } catch {
    return { request: null, error: 'Unable to lookup pairing request.' };
  }
}

/**
 * AUTHENTICATED short-code lookup for the phone's "Enter TV code"
 * path. NEVER returns the pairing secret — the 8-char code has far
 * lower entropy than the 256-bit secret, so the browser must never
 * hold the secret for a code entry. Instead a fresh 32-byte one-time
 * handle (hashed at rest, bound to this user, MANUAL_HANDLE_TTL_MS)
 * is stored and returned once. The handle feeds the SAME approval
 * pipeline as the QR secret (see approvePairingRequest).
 */
export type ShortCodeLookupStatus = 'invalid' | 'expired' | 'ok';

export async function createManualHandleForShortCode(
  admin: SupabaseAdminClient,
  shortCode: string,
  userId: string
): Promise<{ handle: string | null; expiresAt: string | null; error: string | null; status: ShortCodeLookupStatus }> {
  try {
    const normalized = normalizeShortCode(shortCode);
    if (!normalized) {
      return { handle: null, expiresAt: null, error: 'Invalid code format.', status: 'invalid' };
    }

    // Only PENDING, unexpired pairings are resolvable by code.
    const { data: pairing, error: lookupError } = await admin
      .from('device_pairing_requests')
      .select('id, status, expires_at')
      .eq('short_code', normalized)
      .eq('status', 'pending')
      .maybeSingle();

    if (lookupError || !pairing) {
      // Uniform message for not-found / already-approved / consumed /
      // expired — no oracle about pairing states beyond validity.
      return { handle: null, expiresAt: null, error: 'Invalid or expired code.', status: 'invalid' };
    }

    if (new Date(pairing.expires_at).getTime() < Date.now()) {
      await admin
        .from('device_pairing_requests')
        .update({ status: 'expired' })
        .eq('id', pairing.id)
        .eq('status', 'pending');
      return { handle: null, expiresAt: null, error: 'This code has expired.', status: 'expired' };
    }

    // Generate the one-time handle (same entropy class as the QR secret).
    const handleBytes = new Uint8Array(32);
    crypto.getRandomValues(handleBytes);
    const handle = Buffer.from(handleBytes).toString('base64url');
    const handleHash = hashSecret(handle);
    const handleExpiresAt = new Date(Date.now() + MANUAL_HANDLE_TTL_MS).toISOString();

    // Bind the handle to THIS authenticated user. Atomic update
    // while still pending — a concurrent second lookup replaces the
    // handle (last resolver wins; the previous handle is dead).
    const { data: updatedRows, error: updateError } = await admin
      .from('device_pairing_requests')
      .update({
        manual_handle_hash: handleHash,
        manual_handle_user_id: userId,
        manual_handle_expires_at: handleExpiresAt,
      })
      .eq('id', pairing.id)
      .eq('status', 'pending')
      .select('id');

    if (updateError || !updatedRows || updatedRows.length === 0) {
      return { handle: null, expiresAt: null, error: 'Invalid or expired code.', status: 'invalid' };
    }

    return { handle, expiresAt: handleExpiresAt, error: null, status: 'ok' };
  } catch {
    return { handle: null, expiresAt: null, error: 'Unable to look up the code.', status: 'invalid' };
  }
}

/**
 * Looks up a pairing request by its short code — internal helper
 * that returns safe device metadata for the phone's authorize page
 * (handle path). The pairing secret is NEVER included.
 */
export async function getPairingInfoByHandle(
  admin: SupabaseAdminClient,
  handle: string,
  userId: string
): Promise<{ pairing: Omit<PairingRequest, 'secret'> | null; error: string | null; status?: string | null }> {
  try {
    const handleHash = hashSecret(handle);
    const { data, error } = await admin
      .from('device_pairing_requests')
      .select(
        'id, status, expires_at, requested_device_type, requested_device_name, requested_browser, requested_os, requested_platform, short_code, created_at, manual_handle_user_id, manual_handle_expires_at'
      )
      .eq('manual_handle_hash', handleHash)
      .maybeSingle();

    if (error || !data) {
      return { pairing: null, error: 'Pairing request not found.' };
    }
    if (data.manual_handle_user_id !== userId) {
      // Handle bound to a different session — behave as not found.
      return { pairing: null, error: 'Pairing request not found.' };
    }
    if (!data.manual_handle_expires_at || new Date(data.manual_handle_expires_at).getTime() < Date.now()) {
      return { pairing: null, error: 'This code has expired. Please enter a new one.', status: 'expired' };
    }
    if (new Date(data.expires_at).getTime() < Date.now()) {
      return { pairing: null, error: 'This request has expired.', status: 'expired' };
    }
    if (data.status !== 'pending') {
      return { pairing: null, error: `This request is already ${data.status}.`, status: data.status };
    }

    const { secret: _secret, ...safe } = rowToPairingRequest(data) as PairingRequest;
    return { pairing: safe, error: null };
  } catch {
    return { pairing: null, error: 'Unable to load pairing request.' };
  }
}

function rowToPairingRequest(data: Record<string, unknown>): PairingRequest {
  return {
    id: String(data.id),
    secret: String(data.secret ?? ''),
    shortCode: String(data.short_code),
    status: String(data.status) as PairingStatus,
    deviceType: String(data.requested_device_type),
    deviceName: String(data.requested_device_name),
    browser: (data.requested_browser as string | null) ?? null,
    os: (data.requested_os as string | null) ?? null,
    platform: (data.requested_platform as string | null) ?? null,
    expiresAt: String(data.expires_at),
    createdAt: String(data.created_at),
  };
}

/**
 * Approves a pairing request.
 * Called by the authenticated phone user — via the QR secret (scan
 * path) or via the manual handle (code path). Both converge into
 * THIS function: the single authorization state machine.
 *
 * Uses Supabase admin.auth.admin.generateLink({ type: 'magiclink' })
 * to create a one-time email token hash for the approving user. The
 * hash is stored in the pairing request — the big screen's dedicated
 * /exchange endpoint will atomically claim it and call
 * verifyOtp({ token_hash, type: 'email' }) to establish its OWN
 * independent Supabase session.
 */
export async function approvePairingRequest(
  admin: SupabaseAdminClient,
  credential: { secret: string } | { handle: string; userId: string },
  userId: string,
  userEmail: string
): Promise<{ success: boolean; error: string | null }> {
  try {
    // 1. Resolve the pairing row + a status/expiry check. The QR path
    //    resolves by secret hash; the manual-code path resolves by
    //    handle hash (bound to the resolving user). Both enforce the
    //    same pending + unexpired eligibility.
    let pairingId: string;
    let status: string;

    if ('secret' in credential) {
      const secretHash = hashSecret(credential.secret);
      const { data: pairing, error: lookupError } = await admin
        .from('device_pairing_requests')
        .select('id, status, expires_at')
        .eq('secret_hash', secretHash)
        .maybeSingle();
      if (lookupError || !pairing) {
        return { success: false, error: 'Pairing request not found.' };
      }
      pairingId = pairing.id;
      status = pairing.status;
      if (new Date(pairing.expires_at).getTime() < Date.now()) {
        await admin.from('device_pairing_requests').update({ status: 'expired' }).eq('id', pairing.id).eq('status', 'pending');
        return { success: false, error: 'This request has expired.' };
      }
    } else {
      const handleHash = hashSecret(credential.handle);
      const { data: pairing, error: lookupError } = await admin
        .from('device_pairing_requests')
        .select('id, status, expires_at, manual_handle_user_id, manual_handle_expires_at')
        .eq('manual_handle_hash', handleHash)
        .maybeSingle();
      if (lookupError || !pairing) {
        return { success: false, error: 'Pairing request not found.' };
      }
      if (pairing.manual_handle_user_id !== credential.userId) {
        return { success: false, error: 'Pairing request not found.' };
      }
      if (!pairing.manual_handle_expires_at || new Date(pairing.manual_handle_expires_at).getTime() < Date.now()) {
        return { success: false, error: 'This code has expired. Please enter a new one.' };
      }
      if (new Date(pairing.expires_at).getTime() < Date.now()) {
        return { success: false, error: 'This request has expired.' };
      }
      pairingId = pairing.id;
      status = pairing.status;
    }

    // 2. Check status — only pending can be approved (race-safe via
    //    the atomic status='pending' UPDATE below).
    if (status !== 'pending') {
      return { success: false, error: `This request is already ${status}.` };
    }

    // 3. Generate a magic-link token hash for the user via the
    //    Supabase admin API. properties.hashed_token is verified on
    //    the big screen's SSR client with
    //    verifyOtp({ token_hash, type: 'email' }).
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: userEmail,
    });

    if (linkError || !linkData) {
      console.error('[Pairing] generateLink error', { name: linkError?.name, code: linkError?.code });
      return { success: false, error: 'Unable to authorize this device right now.' };
    }

    const tokenHash = linkData.properties?.hashed_token;
    if (!tokenHash) {
      console.error('[Pairing] generateLink returned no verification credential');
      return { success: false, error: 'Unable to authorize this device right now.' };
    }

    // 4. Atomically update: pending → approved + store exchange_code.
    //    The .eq('status', 'pending') + .select() chain ensures only
    //    one concurrent approval can succeed — a loser gets an empty
    //    result and reports failure honestly.
    const { data: updatedRows, error: updateError } = await admin
      .from('device_pairing_requests')
      .update({
        status: 'approved',
        approved_by_user_id: userId,
        approved_at: new Date().toISOString(),
        exchange_code: tokenHash,
      })
      .eq('id', pairingId)
      .eq('status', 'pending')
      .select('id');

    if (updateError) {
      return { success: false, error: 'This request may have already been processed.' };
    }
    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: 'This request was already approved.' };
    }

    return { success: true, error: null };
  } catch (err) {
    console.error('[Pairing] Approve exception', { name: (err as Error)?.name ?? 'unknown' });
    return { success: false, error: 'Unable to approve the pairing request.' };
  }
}

/**
 * Cancels a pairing request.
 * Called by the authenticated phone user (or automatically on the
 * big screen's page unload).
 *
 * Only `pending` requests can be cancelled — this is intentional.
 * Once a request is `approved`, the exchange credential has been
 * issued and the big screen may already be exchanging it.
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
 * Outcome of a lease-based claim + verify attempt.
 *
 * `retryable` tells the big-screen client whether an automatic
 * retry can succeed:
 *   - true  → transient failure; the pairing was safely released
 *             back to 'approved' and the SAME credential will be
 *             retried by the next exchange call.
 *   - false → terminal; the user must generate a new code.
 */
export type ExchangeOutcome =
  | { ok: true }
  | { ok: false; status: number; message: string; reason: ExchangeFailureReason; retryable: boolean };

/** PostgREST error code for "function not found" — the RPC migration is not deployed. */
const PGRST_FUNCTION_NOT_FOUND = 'PGRST202';

function isClaimRpcMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === PGRST_FUNCTION_NOT_FOUND) return true;
  // Some PostgREST versions report a 404 hint instead of the code.
  return typeof err.message === 'string' && err.message.includes('Could not find the function');
}

/**
 * Lease-based claim + verify for the big screen.
 *
 * This is the SINGLE operation that:
 *   1. Validates the pairing secret.
 *   2. Atomically CLAIMS the approved pairing via claim_device_pairing
 *      (SELECT ... FOR UPDATE; approved-or-lease-expired → exchanging
 *      with a 30s lease; returns the stored exchange_code + attempt
 *      count). The credential REMAINS in the row (unlike the old
 *      consume-at-claim design) so recoverable failures can retry.
 *   3. Verifies the token hash on the big screen's OWN Supabase SSR
 *      client with verifyOtp({ token_hash, type: 'email' }) — GoTrue
 *      clears the underlying recovery token on success (one-time
 *      use) and returns a session, which the SSR client persists via
 *      the cookie adapter (Set-Cookie on THIS response).
 *   4. Verifies the auth cookies were actually queued on the
 *      response (the §5 acceptance condition — a successful
 *      verifyOtp without cookies is NOT a signed-in TV).
 *   5. On success: complete_device_pairing (exchanging → consumed,
 *      credential cleared).
 *      On recoverable failure: release_device_pairing_exchange
 *      (exchanging → approved, credential kept, retry allowed).
 *      On terminal failure: fail_device_pairing (exchanging →
 *      failed, credential cleared).
 *
 * The token hash NEVER reaches the client, logs, or JSON responses.
 */
export async function claimVerifyAndEstablishPairingSession(
  admin: SupabaseAdminClient,
  tvSupabase: SupabaseClient<Database>,
  secret: string,
  options: {
    requestId: string;
    /**
     * Returns the names of cookies queued for THIS response
     * (e.g. via SvelteKit's event.cookies.getAll()). Used for the
     * §5 acceptance check — a successful verifyOtp whose session
     * never reached Set-Cookie is NOT a signed-in big screen.
     */
    getCookieNames?: () => string[];
  }
): Promise<ExchangeOutcome> {
  const { requestId } = options;

  // Step 1: hash the secret for lookup.
  const secretHash = hashSecret(secret);

  // Step 2: atomic lease claim via server-side RPC.
  const { data: claimedRows, error: claimError } = await admin.rpc('claim_device_pairing', {
    p_secret_hash: secretHash,
    p_lease_ms: EXCHANGE_LEASE_MS,
    p_max_attempts: MAX_EXCHANGE_ATTEMPTS,
  });

  if (claimError) {
    // Distinguish "migration not deployed" from other RPC failures —
    // these need very different operator responses (§21/§22).
    if (isClaimRpcMissing(claimError)) {
      logExchange('claim-rpc-missing', requestId, { name: claimError.name, code: claimError.code });
      return {
        ok: false, status: 503, reason: 'claim-rpc-missing', retryable: false,
        message: 'Sign-in is not fully deployed on the server. Please try again later.',
      };
    }
    logExchange('claim-rpc-failed', requestId, { name: claimError.name, code: claimError.code });
    return { ok: false, status: 503, reason: 'claim-rpc-failed', retryable: true, message: 'Unable to establish a session. Please try again.' };
  }

  const claimed = Array.isArray(claimedRows) && claimedRows.length > 0 ? claimedRows[0] : null;

  if (!claimed) {
    // Not eligible: not found / pending / expired / consumed / failed /
    // active lease held by another exchange. Diagnostic lookup
    // (status only — never the credential) for the right HTTP code.
    const { data: current } = await admin
      .from('device_pairing_requests')
      .select('status, expires_at')
      .eq('secret_hash', secretHash)
      .maybeSingle();

    if (!current) {
      logExchange('pairing-not-found', requestId);
      return { ok: false, status: 404, reason: 'pairing-not-found', retryable: false, message: 'Pairing request not found.' };
    }
    const isExpired = new Date(current.expires_at).getTime() < Date.now();
    if (isExpired || current.status === 'expired') {
      logExchange('pairing-expired', requestId);
      return { ok: false, status: 410, reason: 'pairing-expired', retryable: false, message: 'This request has expired.' };
    }
    if (current.status === 'consumed') {
      logExchange('pairing-consumed', requestId);
      return { ok: false, status: 409, reason: 'pairing-consumed', retryable: false, message: 'This request has already been used.' };
    }
    if (current.status === 'failed') {
      logExchange('pairing-failed', requestId);
      return { ok: false, status: 410, reason: 'pairing-failed', retryable: false, message: 'This sign-in attempt failed. Please generate a new code.' };
    }
    if (current.status === 'exchanging') {
      // Another exchange holds the lease — the caller (or a retrying
      // twin request) should wait for the short lease and retry.
      logExchange('exchange-lease-busy', requestId);
      return { ok: false, status: 409, reason: 'exchange-lease-busy', retryable: true, message: 'Sign-in is already in progress. Waiting…' };
    }
    if (current.status === 'cancelled') {
      logExchange('pairing-not-approved', requestId);
      return { ok: false, status: 410, reason: 'pairing-not-approved', retryable: false, message: 'This request was cancelled.' };
    }
    // pending (not approved yet) or approved-but-raced-back.
    logExchange('pairing-not-approved', requestId);
    return { ok: false, status: 409, reason: 'pairing-not-approved', retryable: true, message: `This request is ${current.status}.` };
  }

  const pairingId: string = claimed.id ?? '';
  const tokenHash = claimed.exchange_code;

  if (!pairingId || !tokenHash) {
    // Defensive: claim succeeded but the stored credential is NULL.
    // The approval stored no token hash — treat as terminal for this
    // pairing (the row IS in exchanging now; fail it explicitly).
    logExchange('claim-rpc-failed', requestId, { name: 'null-exchange-code' });
    await admin.rpc('fail_device_pairing', { p_secret_hash: secretHash, p_pairing_id: pairingId });
    return { ok: false, status: 503, reason: 'claim-rpc-failed', retryable: false, message: 'Unable to establish a session. Please try again.' };
  }

  // Step 3: verify the token hash on the big screen's OWN Supabase
  // SSR client. verifyOtp({ token_hash, type: 'email' }) is the
  // officially supported verification primitive for a magic-link
  // hashed_token (installed @supabase/supabase-js 2.112.3 typings:
  // VerifyTokenHashParams { token_hash, type: EmailOtpType }).
  //
  //   - exchangeCodeForSession() is the PKCE auth-code exchange and
  //     MUST NOT be used for this token hash (it requires a stored
  //     code_verifier from an OAuth flow the big screen never ran —
  //     guaranteed failure; this was the production regression).
  //   - On success GoTrue runs recoverVerify: the recovery token is
  //     CLEARED (one-time use) and a full session is returned. The
  //     SSR client persists it via the cookie adapter's setAll().
  const { data: verifyData, error: verifyError } = await tvSupabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'email',
  });

  if (verifyError || !verifyData.session || !verifyData.user) {
    // Classify the failure:
    //   otp_expired / 403 / 400 → the token is invalid, expired, or
    //     ALREADY CONSUMED at Supabase — retrying can never succeed.
    //     Mark the pairing failed (terminal).
    //   anything else (network, 5xx, unknown) → the token was NOT
    //     confirmed consumed. Release the lease so the same stored
    //     credential can be retried (§4 "safely recover to approved").
    //     A worst-case false release (response lost AFTER GoTrue
    //     consumed the token) is self-correcting: the retry's
    //     verifyOtp gets otp_expired → terminal fail. No replay is
    //     possible — GoTrue has already cleared the recovery token.
    const status = (verifyError as { status?: number } | null)?.status;
    const terminal =
      verifyError?.code === 'otp_expired' ||
      status === 403 ||
      status === 400;
    logExchange('token-verification-failed', requestId, {
      name: verifyError?.name,
      code: verifyError?.code ?? status,
    });

    if (terminal) {
      await admin.rpc('fail_device_pairing', { p_secret_hash: secretHash, p_pairing_id: pairingId });
      return {
        ok: false, status: 410, reason: 'token-verification-failed', retryable: false,
        message: 'This sign-in link has expired. Please generate a new code.',
      };
    }
    const { error: releaseError } = await admin.rpc('release_device_pairing_exchange', {
      p_secret_hash: secretHash,
      p_pairing_id: pairingId,
    });
    if (releaseError) {
      // The lease will expire on its own (30s) — a later claim can
      // still take over. Not fatal for the user's retry.
      logExchange('claim-rpc-failed', requestId, { name: releaseError.name, code: releaseError.code });
    }
    return {
      ok: false, status: 503, reason: 'token-verification-failed', retryable: true,
      message: 'Unable to establish a session. Retrying…',
    };
  }

  // Step 4: §5 acceptance check — verify the auth cookies were
  // actually queued for THIS response. verifyOtp returned a session;
  // unless the SSR cookie adapter ran setAll(), the big-screen
  // browser never received it and the next request would still be a
  // guest. SvelteKit's event.cookies cache reflects cookies set
  // during this request, so we can assert on the chunked auth cookie
  // names directly (sb-<ref>-auth-token[.N] chunks) via getAll.
  const cookieNames = options.getCookieNames?.() ?? [];
  const hasAuthCookie = cookieNames.some((name) => name.includes('-auth-token'));
  if (!hasAuthCookie) {
    // The token WAS consumed by the successful verification — a
    // retry can never succeed. Terminal failure for this pairing.
    logExchange('cookie-establishment-failed', requestId);
    await admin.rpc('fail_device_pairing', { p_secret_hash: secretHash, p_pairing_id: pairingId });
    return {
      ok: false, status: 503, reason: 'cookie-establishment-failed', retryable: false,
      message: 'Unable to establish a session. Please try again.',
    };
  }

  // Step 5: success — flip exchanging → consumed and clear the
  // stored credential atomically. The big screen's session lives in
  // its own Supabase cookies now; nothing else is needed.
  const { error: completeError } = await admin.rpc('complete_device_pairing', {
    p_secret_hash: secretHash,
    p_pairing_id: pairingId,
  });
  if (completeError) {
    // The session IS established (cookies written). The pairing row
    // stays 'exchanging' with an expiring lease — the lazy expiry
    // in getPairingBySecret / the lease takeover keeps this safe,
    // and a replay attempt finds nothing claimable once the row
    // flips. Log for observability; do not fail the user's login.
    logExchange('claim-rpc-failed', requestId, { name: completeError.name, code: completeError.code });
  }

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

/** Normalizes user-entered short codes: trim, uppercase, reject invalid characters/length. */
export function normalizeShortCode(input: string): string | null {
  const normalized = (input || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!SHORT_CODE_PATTERN.test(normalized)) return null;
  return normalized;
}
