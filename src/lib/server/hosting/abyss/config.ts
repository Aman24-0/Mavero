/**
 * Abyss environment configuration (Phase 3).
 *
 * Reads server-only environment variables for Abyss API credentials.
 * Credentials are NEVER exposed to the client.
 *
 * VERIFIED CONTRACT (live API, 2026-09-29):
 *   - The correct API base URL is `https://api.abyss.to` (NOT
 *     `https://api.abyssplayer.com` — the previous default returned
 *     404 for /auth/login). Verified: POST https://api.abyss.to/auth/login
 *     with { email, password } returns { token, expiresIn }.
 *
 *   - The upload endpoint is `POST http://up.abyss.to/:key` where
 *     `:key` is the Abyss **apiKey** (NOT the JWT from login). The
 *     apiKey is a separate credential obtained from the Abyss dashboard
 *     settings page. It CANNOT be derived from the email+password JWT.
 *
 * Convention:
 *   - ABYSS_API_BASE_URL — Abyss API base URL (default: https://api.abyss.to)
 *   - ABYSS_EMAIL — login email (server-only)
 *   - ABYSS_PASSWORD — login password (server-only)
 *   - ABYSS_API_KEY — the Abyss apiKey for uploads via up.abyss.to (server-only)
 *
 * Missing credentials fail closed.
 */

import { env as privateEnv } from '$env/dynamic/private';

const DEFAULT_ABYSS_BASE_URL = 'https://api.abyss.to';

export type AbyssConfig = {
  baseUrl: string;
  email: string;
  password: string;
  /** The Abyss apiKey used for uploads via up.abyss.to/:key. */
  apiKey: string | null;
};

export function createAbyssConfig(): AbyssConfig {
  const email = privateEnv.ABYSS_EMAIL;
  const password = privateEnv.ABYSS_PASSWORD;
  if (!email || !password) {
    throw new Error('ABYSS_EMAIL / ABYSS_PASSWORD are not configured. Set them in the deployment secret manager.');
  }
  const baseUrl = privateEnv.ABYSS_API_BASE_URL || DEFAULT_ABYSS_BASE_URL;
  const apiKey = privateEnv.ABYSS_API_KEY || null;
  return { baseUrl: baseUrl.replace(/\/$/, ''), email, password, apiKey };
}

export function getAbyssConfigOrNull(): AbyssConfig | null {
  try { return createAbyssConfig(); } catch { return null; }
}
