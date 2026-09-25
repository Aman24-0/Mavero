import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Mavero Embed Gateway — stateless encrypted token.
 *
 * The provider embed URL is AES-256-GCM encrypted inside an opaque
 * token. The token is the iframe's `src` attribute value:
 *
 *   <iframe src="/api/embed/session/<encrypted-token>">
 *
 * The browser CANNOT decrypt the token — it requires the server-side
 * secret. The gateway endpoint decrypts it server-side, extracts the
 * provider URL, and returns an HTML page with a JavaScript redirect.
 *
 * STATELESS — no in-memory store, no database writes. Works across
 * Netlify serverless function instances (each instance can decrypt
 * the token independently using the shared secret).
 *
 * SECURITY:
 *   * AES-256-GCM (authenticated encryption) — the ciphertext cannot
 *     be tampered with (the auth tag would fail).
 *   * The key is domain-separated from the Stremio session secret
 *     (`mavero:embed-gateway:v1:...`) so the two token systems are
 *     cryptographically independent.
 *   * Short-lived: 4-hour TTL (covers a long movie + source switches).
 *   * The token payload includes content-binding fields (sourceId,
 *     providerId, contentId, mediaType, season/episode) so the gateway
 *     can verify the token is being used for the correct content.
 *
 * ENV WIRING (repo convention — see adult-cookie.ts, session-tokens.ts):
 * this module NEVER imports `$env/dynamic/private`. The secret is an
 * explicit parameter. The env wiring lives in the endpoint layer
 * (`embed-gateway/env.ts`), so tests can inject deterministic keys.
 *
 * OPAQUE — the browser sees a base64url string. Even if someone
 * base64url-decodes it, they get raw ciphertext bytes (not JSON).
 * The provider URL is NOT client-readable.
 */

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Default token TTL: 4 hours (covers a long movie + source switches). */
export const EMBED_TOKEN_TTL_SECONDS = 4 * 60 * 60;

export type EmbedTokenPayload = {
  /** The actual provider embed URL (HTTPS). Encrypted in the token. */
  url: string;
  /** The provider origin (e.g. `https://vidlink.pro`). NOT the full URL —
   * just the origin, already hardcoded in each adapter. Used by the client
   * for adapter selection (passed via `metadata.providerOrigin`). */
  origin: string;
  /** Content binding fields. */
  sourceId: string;
  providerId: string;
  contentId: string;
  mediaType: string;
  season?: number;
  episode?: number;
  /** Expiry (epoch seconds). */
  exp: number;
};

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Embed gateway: secret is not configured; refusing to proceed (fail closed).');
  }
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(`mavero:embed-gateway:v1:${secret}`, 'utf8').digest();
}

/**
 * Creates an encrypted embed token containing the provider URL + metadata.
 * The token is opaque — the browser cannot decrypt it without the
 * server-side secret.
 *
 * Returns `null` if the secret is empty (fail closed — the resolver
 * falls back to the raw URL, playback still works, just without
 * URL hiding).
 */
export function createEmbedToken(
  params: Omit<EmbedTokenPayload, 'exp'>,
  secret: string,
  ttlSeconds: number = EMBED_TOKEN_TTL_SECONDS,
): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: EmbedTokenPayload = { ...params, exp };
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Token = base64url(iv + tag + ciphertext) — opaque blob.
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

/**
 * Decrypts and verifies an embed token. Returns the payload (including
 * the provider URL) if the token is valid and not expired. Returns
 * `null` otherwise (decryption failure, tampering, or expiry).
 */
export function verifyEmbedToken(token: string, secret: string): EmbedTokenPayload | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) return null;
  const key = deriveKey(secret);
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null; // auth tag mismatch (tampered token) or decryption failure
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<EmbedTokenPayload>;
  if (typeof p.url !== 'string' || !p.url) return null;
  if (typeof p.origin !== 'string' || !p.origin) return null;
  if (typeof p.sourceId !== 'string' || !p.sourceId) return null;
  if (typeof p.providerId !== 'string' || !p.providerId) return null;
  if (typeof p.contentId !== 'string' || !p.contentId) return null;
  if (typeof p.mediaType !== 'string' || !p.mediaType) return null;
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null;
  if (p.exp <= Math.floor(Date.now() / 1000)) return null; // expired
  if (p.season !== undefined && (!Number.isSafeInteger(p.season) || p.season <= 0)) return null;
  if (p.episode !== undefined && (!Number.isSafeInteger(p.episode) || p.episode <= 0)) return null;
  return p as EmbedTokenPayload;
}
