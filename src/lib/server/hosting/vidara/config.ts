/**
 * Vidara environment configuration (Phase 3).
 *
 * Reads server-only environment variables for the Vidara API key and
 * optional base URL. Credentials are NEVER exposed to the client —
 * `$env/dynamic/private` is guaranteed server-only by SvelteKit.
 *
 * Convention (matching the existing project pattern):
 *   - VIDARA_API_KEY — server-only API key (no PUBLIC_ prefix)
 *   - VIDARA_API_BASE_URL — optional API base URL override
 *
 * Missing credentials fail closed: `createVidaraConfig()` throws a
 * typed error so the adapter cannot be accidentally instantiated
 * without credentials.
 */

import { env as privateEnv } from '$env/dynamic/private';

const DEFAULT_VIDARA_BASE_URL = 'https://api.vidara.so';

export type VidaraConfig = {
  apiKey: string;
  baseUrl: string;
};

/**
 * Creates a Vidara config from environment variables.
 * Throws when the API key is missing — the caller MUST handle this.
 */
export function createVidaraConfig(): VidaraConfig {
  const apiKey = privateEnv.VIDARA_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('VIDARA_API_KEY is not configured. Set it in the deployment secret manager.');
  }
  const baseUrl = privateEnv.VIDARA_API_BASE_URL || DEFAULT_VIDARA_BASE_URL;
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, '') }; // strip trailing slash
}

/**
 * Non-throwing variant for capability checks.
 * Returns null when the API key is missing.
 */
export function getVidaraConfigOrNull(): VidaraConfig | null {
  try { return createVidaraConfig(); } catch { return null; }
}
