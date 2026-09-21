import { createHash } from 'node:crypto';
import { env as privateEnv } from '$env/dynamic/private';

/**
 * MAVERO Player — session signing secret wiring.
 *
 * Endpoint-layer env resolution for the Stremio addon session tokens
 * (the crypto modules themselves never touch `$env` — repo convention,
 * see adult-cookie.ts).
 *
 * Resolution order:
 *   1. `MAVERO_STREMIO_SESSION_SECRET` — a dedicated deployment secret
 *      (recommended; generate with `openssl rand -hex 32`).
 *   2. Fallback: a DOMAIN-SEPARATED SHA-256 derivation from the existing
 *      `PRIVATE_SUPABASE_SERVICE_ROLE_KEY`. Every deployment already carries
 *      that high-entropy secret, so progressive resolution works without new
 *      required configuration. The derivation is one-way and domain-tagged —
 *      the raw service key is never used as an HMAC key, never appears in a
 *      token, and the derived key is useful for nothing except verifying
 *      this deployment's own playback session tokens.
 *
 * A deployment with NEITHER secret fails closed (empty string → the token
 * modules refuse to sign/verify).
 */
export function stremioSessionSecret(): string {
  const dedicated = privateEnv.MAVERO_STREMIO_SESSION_SECRET;
  if (typeof dedicated === 'string' && dedicated.length > 0) return dedicated;
  const serviceKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (typeof serviceKey === 'string' && serviceKey.length > 0) {
    return createHash('sha256').update(`mavero:stremio-session:v1:${serviceKey}`, 'utf8').digest('hex');
  }
  return '';
}
