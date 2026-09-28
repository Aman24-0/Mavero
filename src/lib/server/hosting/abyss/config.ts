/**
 * Abyss environment configuration (Phase 3).
 *
 * Reads server-only environment variables for Abyss API credentials.
 * Credentials are NEVER exposed to the client.
 *
 * Convention:
 *   - ABYSS_API_BASE_URL — Abyss API base URL
 *   - ABYSS_EMAIL — login email (server-only)
 *   - ABYSS_PASSWORD — login password (server-only)
 *
 * Missing credentials fail closed.
 */

import { env as privateEnv } from '$env/dynamic/private';

const DEFAULT_ABYSS_BASE_URL = 'https://api.abyssplayer.com';

export type AbyssConfig = {
  baseUrl: string;
  email: string;
  password: string;
};

export function createAbyssConfig(): AbyssConfig {
  const email = privateEnv.ABYSS_EMAIL;
  const password = privateEnv.ABYSS_PASSWORD;
  if (!email || !password) {
    throw new Error('ABYSS_EMAIL / ABYSS_PASSWORD are not configured. Set them in the deployment secret manager.');
  }
  const baseUrl = privateEnv.ABYSS_API_BASE_URL || DEFAULT_ABYSS_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/$/, ''), email, password };
}

export function getAbyssConfigOrNull(): AbyssConfig | null {
  try { return createAbyssConfig(); } catch { return null; }
}
