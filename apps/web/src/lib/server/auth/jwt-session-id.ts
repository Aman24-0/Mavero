/**
 * JWT Session ID extractor.
 *
 * Extracts the Supabase `session_id` claim from a JWT access token
 * WITHOUT any network call. The access_token is already available on
 * `locals.session.access_token` (resolved by the server hook). The
 * JWT payload (base64-decoded middle segment) contains a `session_id`
 * field (UUID string) that uniquely identifies the Supabase auth
 * session.
 *
 * This is the canonical session identity for the device_sessions
 * registry — NOT the access_token itself (which rotates) and NOT
 * the user_id (which is shared across all sessions for a user).
 */

/**
 * Decodes the JWT payload (middle segment) without verifying the
 * signature. This is safe for extracting the session_id claim
 * because:
 *   1. The JWT was already verified by Supabase's auth.getSession()
 *      in the server hook. We're reading an already-trusted token.
 *   2. We use the session_id only as a registry key, not as an
 *      authentication credential. A forged session_id cannot grant
 *      access — it would need to match a real Supabase session
 *      that the server hook already validated.
 *
 * Returns the session_id UUID string, or null if the token is
 * malformed or missing the session_id claim.
 */
export function extractSessionId(accessToken: string | null | undefined): string | null {
  if (!accessToken || typeof accessToken !== 'string') return null;
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    // JWT payload is base64url-encoded JSON.
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const decoded = JSON.parse(payload);
    const sessionId = decoded?.session_id;
    if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId;
    return null;
  } catch {
    return null;
  }
}
