import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

/**
 * MAVERO Player — Stremio addon resolution session tokens (Phase 10, GOAL 1).
 *
 * Progressive addon resolution is driven by the CLIENT: it first asks the
 * server for a RESOLUTION SESSION, then fires one independent request per
 * eligible addon. Each per-addon request is authorized by a short-lived,
 * SIGNED, content-bound OPAQUE TOKEN — never by client-supplied addon ids,
 * manifest URLs or configuration.
 *
 * Token properties (Phase 10 spec):
 *   * SIGNED — HMAC-SHA256 over the canonical payload; any tampering with
 *     any field invalidates the signature (timing-safe comparison).
 *   * SHORT-LIVED — every token carries an absolute `exp` (epoch seconds).
 *     Expired tokens are rejected (the client starts a fresh session).
 *   * CONTENT-BOUND — mediaType, contentId and (for series/anime) BOTH
 *     season AND episode are part of the signed payload, so a token minted
 *     for movie A can never resolve movie B (GOAL 5).
 *   * ADDON-BOUND — the payload carries the exact `streaming_addons` row id
 *     the session planned. A token cannot be redirected at another addon
 *     ("unusable for arbitrary addon selection").
 *   * SESSION-BOUND — the payload carries the server-issued sessionId; the
 *     per-addon endpoint requires the caller to echo it, tying every
 *     request to ONE resolution session.
 *   * SECRET-CARRYING — the payload embeds NOTHING except the binding
 *     fields above. Manifest URLs, addon configuration, header sets and
 *     stream endpoints stay server-side (the token is a reference, not a
 *     capability URL).
 *
 * Format: `v1.<base64url(payload-json)>.<base64url(hmac)>`.
 *
 * NO ENV ACCESS IN THIS MODULE (repo convention — see adult-cookie.ts): the
 * secret is an explicit parameter. The env wiring
 * (`MAVERO_STREMIO_SESSION_SECRET`) lives in the endpoint layer, and every
 * service function receives the secret via its deps so tests can inject
 * deterministic keys. A missing/empty secret FAILS CLOSED — the server
 * refuses to mint or accept tokens it cannot sign/verify.
 */

export const ADDON_TOKEN_VERSION = 'v1';

/**
 * Default token time-to-live (seconds). Long enough to cover the slowest
 * addon resolution window AND user-initiated retries of a failed addon
 * (observed live: the slowest addon answered after ~11s), short enough that
 * a leaked token is worthless afterwards. A token only ever re-requests ONE
 * addon's streams for ONE content item — the same thing a fresh session
 * could request — so a bounded replay window is the correct risk trade-off.
 */
export const ADDON_TOKEN_TTL_SECONDS = 600;

/** Canonical signed payload for one addon's resolution authorization. */
export type AddonTokenPayload = {
  v: typeof ADDON_TOKEN_VERSION;
  /** Resolution session id (server-generated UUID). */
  s: string;
  /** The `streaming_addons` row id this token is bound to. */
  a: string;
  /** Bound content id. */
  c: string;
  /** Bound media type ('movie' | 'series' | 'anime'). */
  m: string;
  /** Bound season (series/anime only). */
  se?: number;
  /** Bound episode (series/anime only). */
  ep?: number;
  /** Absolute expiry, epoch seconds. */
  exp: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Timing-safe string equality (SHA-256 digests before compare — see adult-cookie.ts). */
function timingSafeStringEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function fromBase64url(input: string): string | null {
  try {
    return Buffer.from(input, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function signatureOf(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Stremio session tokens: MAVERO_STREMIO_SESSION_SECRET is not configured; refusing to proceed (fail closed).');
  }
}

/**
 * Mints one opaque signed token for ONE addon inside ONE resolution session.
 * Throws when the secret is missing (fail closed) or the payload shape is
 * invalid — the endpoint turns that into a typed service error.
 */
export function signAddonToken(payload: Omit<AddonTokenPayload, 'v'>, secret: string): string {
  assertSecret(secret);
  const full: AddonTokenPayload = { ...payload, v: ADDON_TOKEN_VERSION };
  const encoded = base64url(JSON.stringify(full));
  return `${ADDON_TOKEN_VERSION}.${encoded}.${signatureOf(encoded, secret)}`;
}

export type AddonTokenVerification =
  | { ok: true; payload: AddonTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'version' };

/**
 * Verifies a presented token: shape, version, signature (timing-safe) and
 * expiry. NO other trust is granted — the endpoint layer still re-checks
 * the addon's current enabled/status state and re-plans eligibility, so a
 * valid token for an addon that was disabled after session creation still
 * yields `skipped`.
 */
export function verifyAddonToken(token: unknown, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): AddonTokenVerification {
  assertSecret(secret);
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, encoded, signature] = parts;
  if (version !== ADDON_TOKEN_VERSION) return { ok: false, reason: 'version' };
  const payloadRaw = fromBase64url(encoded);
  if (!payloadRaw) return { ok: false, reason: 'malformed' };
  if (!timingSafeStringEqual(signature, signatureOf(encoded, secret))) return { ok: false, reason: 'bad-signature' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadRaw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'malformed' };
  const p = parsed as Partial<AddonTokenPayload>;
  if (p.v !== ADDON_TOKEN_VERSION) return { ok: false, reason: 'version' };
  if (typeof p.s !== 'string' || !p.s || typeof p.a !== 'string' || !p.a || typeof p.c !== 'string' || !p.c || typeof p.m !== 'string' || !p.m) {
    return { ok: false, reason: 'malformed' };
  }
  if (p.se !== undefined && (!Number.isSafeInteger(p.se) || p.se <= 0)) return { ok: false, reason: 'malformed' };
  if (p.ep !== undefined && (!Number.isSafeInteger(p.ep) || p.ep <= 0)) return { ok: false, reason: 'malformed' };
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return { ok: false, reason: 'malformed' };
  if (p.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p as AddonTokenPayload };
}

/** Fresh session id (server-generated UUID — clients echo it, never choose it). */
export function createSessionId(): string {
  return randomUUID();
}

/**
 * True when the presented session context matches the token's binding. The
 * per-addon endpoint requires this AFTER signature verification so a token
 * for movie A cannot even be REPLAYED against movie B's session id.
 */
export function tokenMatchesRequest(
  payload: AddonTokenPayload,
  context: { sessionId: string; contentId: string; mediaType: string; season?: number; episode?: number },
): boolean {
  if (payload.s !== context.sessionId) return false;
  if (payload.c !== context.contentId) return false;
  if (payload.m !== context.mediaType) return false;
  if ((payload.se ?? undefined) !== (context.season ?? undefined)) return false;
  if ((payload.ep ?? undefined) !== (context.episode ?? undefined)) return false;
  return true;
}

// ============================================================
// Compatibility references (Phase 10, GOAL 12)
// ============================================================

export const COMPAT_TOKEN_VERSION = 'cv1';

/**
 * Signed payload for ONE compatibility (remux/transcode) job. The resolved
 * stream URL is carried INSIDE the token (`u`) — the client NEVER submits a
 * URL to the compatibility gateway, it can only present a reference the
 * server itself minted at resolution time. That structural property is what
 * keeps the gateway from becoming an open media proxy (GOAL 12/24).
 */
export type CompatTokenPayload = {
  v: typeof COMPAT_TOKEN_VERSION;
  /** Owning resolution session id. */
  s: string;
  /** Owning addon row id. */
  a: string;
  /** Bound content id. */
  c: string;
  /** Bound media type. */
  m: string;
  se?: number;
  ep?: number;
  /** The EXACT validated playback URL this reference authorizes. */
  u: string;
  /** Compatibility action ('remux' | 'transcode'). */
  k: 'remux' | 'transcode';
  /** Absolute expiry, epoch seconds. */
  exp: number;
};

/** Mints one signed compatibility reference. Fails closed without a secret. */
export function signCompatToken(payload: Omit<CompatTokenPayload, 'v'>, secret: string): string {
  assertSecret(secret);
  if (payload.k !== 'remux' && payload.k !== 'transcode') throw new Error('Stremio compat tokens: invalid kind.');
  if (typeof payload.u !== 'string' || !payload.u.startsWith('https://') || payload.u.length > 2048) {
    throw new Error('Stremio compat tokens: refusing to sign a reference for a non-HTTPS or oversized URL.');
  }
  const full: CompatTokenPayload = { ...payload, v: COMPAT_TOKEN_VERSION };
  const encoded = base64url(JSON.stringify(full));
  return `${COMPAT_TOKEN_VERSION}.${encoded}.${signatureOf(encoded, secret)}`;
}

export type CompatTokenVerification =
  | { ok: true; payload: CompatTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'version' };

/** Verifies a presented compatibility reference (signature, version, expiry). */
export function verifyCompatToken(token: unknown, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): CompatTokenVerification {
  assertSecret(secret);
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, encoded, signature] = parts;
  if (version !== COMPAT_TOKEN_VERSION) return { ok: false, reason: 'version' };
  const payloadRaw = fromBase64url(encoded);
  if (!payloadRaw) return { ok: false, reason: 'malformed' };
  if (!timingSafeStringEqual(signature, signatureOf(encoded, secret))) return { ok: false, reason: 'bad-signature' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadRaw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'malformed' };
  const p = parsed as Partial<CompatTokenPayload>;
  if (p.v !== COMPAT_TOKEN_VERSION) return { ok: false, reason: 'version' };
  if (typeof p.s !== 'string' || !p.s || typeof p.a !== 'string' || !p.a || typeof p.c !== 'string' || !p.c || typeof p.m !== 'string' || !p.m) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof p.u !== 'string' || !p.u.startsWith('https://') || p.u.length > 2048) return { ok: false, reason: 'malformed' };
  if (p.k !== 'remux' && p.k !== 'transcode') return { ok: false, reason: 'malformed' };
  if (p.se !== undefined && (!Number.isSafeInteger(p.se) || p.se <= 0)) return { ok: false, reason: 'malformed' };
  if (p.ep !== undefined && (!Number.isSafeInteger(p.ep) || p.ep <= 0)) return { ok: false, reason: 'malformed' };
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return { ok: false, reason: 'malformed' };
  if (p.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p as CompatTokenPayload };
}
