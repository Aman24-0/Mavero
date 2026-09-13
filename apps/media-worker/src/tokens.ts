/**
 * MAVERO media worker — compatibility token verification (Phase 11, GOAL B5).
 *
 * BYTE-COMPATIBLE with the MAVERO app's `verifyCompatToken`
 * (`src/lib/server/streaming/stremio/session-tokens.ts`): format
 * `cv1.<base64url(payload-json)>.<base64url(HMAC-SHA256(payloadB64, secret))>`,
 * payload `{ v:'cv1', s, a, c, m, se?, ep?, u, k, exp }`.
 *
 * THE SECURITY MODEL (GOAL 12/24 — the worker is NOT a proxy):
 *   * the ONLY accepted input is a signed reference minted by the MAVERO
 *     app at addon-resolution time — the source URL travels INSIDE the
 *     signature, so a client can NEVER submit its own URL;
 *   * the worker independently verifies signature (timing-safe), version,
 *     expiry and the structural URL/kind constraints, then re-validates the
 *     URL itself (https-only, credential-free, non-private host — see
 *     validate.ts) before any FFmpeg run;
 *   * the token binds addon/content/session/media-type/conversion-kind —
 *     the worker logs them for correlation but grants NO semantics to them
 *     beyond the URL + kind.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const COMPAT_TOKEN_VERSION = 'cv1';

export type CompatTokenPayload = {
  v: typeof COMPAT_TOKEN_VERSION;
  s: string;
  a: string;
  c: string;
  m: string;
  se?: number;
  ep?: number;
  /** The EXACT validated playback URL this reference authorizes. */
  u: string;
  k: 'remux' | 'transcode';
  exp: number;
};

export type CompatTokenVerification =
  | { ok: true; payload: CompatTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'version' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a ?? '', 'utf8').digest();
  const db = createHash('sha256').update(b ?? '', 'utf8').digest();
  return timingSafeEqual(da, db);
}

function fromBase64url(input: string): string | null {
  try {
    return Buffer.from(input, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function signatureOf(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
}

export function verifyCompatToken(token: unknown, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): CompatTokenVerification {
  if (!secret) return { ok: false, reason: 'bad-signature' };
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const version = parts[0];
  const encoded = parts[1];
  const signature = parts[2];
  if (!version || !encoded || !signature) return { ok: false, reason: 'malformed' };
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
