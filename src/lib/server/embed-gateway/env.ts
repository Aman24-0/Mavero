import { createHash } from 'node:crypto';
import { env as privateEnv } from '$env/dynamic/private';

/**
 * Mavero Embed Gateway — env wiring for the signing secret.
 *
 * Resolution order:
 *   1. `MAVERO_EMBED_GATEWAY_SECRET` — a dedicated deployment secret
 *      (recommended; generate with `openssl rand -hex 32`).
 *   2. Fallback: a domain-separated SHA-256 derivation from
 *      `MAVERO_STREMIO_SESSION_SECRET` (which itself falls back to
 *      the service role key). Every deployment already carries one
 *      of these secrets, so the embed gateway works without new
 *      configuration. The domain tag ensures the derived key is
 *      cryptographically independent from the Stremio token key.
 *
 * A deployment with NEITHER secret fails closed (empty string → the
 * token module refuses to mint/verify tokens, the resolver falls
 * back to the raw provider URL — playback still works, just without
 * URL hiding).
 *
 * This module is the ONLY embed-gateway file that imports
 * `$env/dynamic/private` (repo convention — see adult-cookie.ts,
 * session-tokens.ts, session-env.ts). The token module receives the
 * secret as an explicit parameter so tests can inject deterministic
 * keys.
 */
export function embedGatewaySecret(): string {
  const dedicated = privateEnv.MAVERO_EMBED_GATEWAY_SECRET;
  if (typeof dedicated === 'string' && dedicated.length > 0) return dedicated;
  const stremioSecret = privateEnv.MAVERO_STREMIO_SESSION_SECRET;
  if (typeof stremioSecret === 'string' && stremioSecret.length > 0) {
    return createHash('sha256').update(`mavero:embed-gateway:v1:${stremioSecret}`, 'utf8').digest('hex');
  }
  const serviceKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (typeof serviceKey === 'string' && serviceKey.length > 0) {
    return createHash('sha256').update(`mavero:embed-gateway:v1:${serviceKey}`, 'utf8').digest('hex');
  }
  return '';
}
