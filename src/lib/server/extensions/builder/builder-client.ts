/**
 * MAVERO — Adapter Builder CLIENT (Permanent Adapter Plan Phase 3 — plan §4/§5).
 *
 * The ONLY code in Mavero that talks to the external Adapter Builder
 * Service. It is called EXCLUSIVELY by the admin create-adapter
 * orchestration (build-service.ts) — never by Downloader 2, never by any
 * resolver/runtime path (plan §3 hard rule; pinned by static + behavioral
 * tests).
 *
 * SECURITY (plan §5):
 *   * The shared secret is read from PRIVATE_ADAPTER_BUILDER_SECRET at
 *     call time (dynamic import — testable, never bundled client-side) and
 *     is NEVER stored in the database, NEVER returned to any client, and
 *     NEVER logged.
 *   * Timeouts are bounded (PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS, default
 *     conservative for serverless) — a cold/unreachable Builder can never
 *     stall an admin request indefinitely.
 *   * BUILDER_UNAVAILABLE is a controlled admin-facing outcome: zero
 *     Downloader 2 impact, zero wake-up side effects.
 */

import type {
  AdapterBuildRequest,
  AdapterBuildResponse,
} from '$lib/shared/adapter-artifact';

/** Client configuration (env-driven; absent Builder = honest unavailability). */
export type BuilderClientConfig = {
  url: string;
  secret: string;
  timeoutMs: number;
};

/** Default request budget (conservative for serverless platforms). */
export const DEFAULT_BUILDER_TIMEOUT_MS = 150_000;

/** Closed client-side outcome vocabulary (admin-facing, safe messages). */
export type BuilderClientOutcome =
  | { ok: true; response: AdapterBuildResponse }
  | { ok: false; code: 'BUILDER_UNAVAILABLE' | 'BUILDER_TIMEOUT'; message: string };

export type BuilderClientDeps = {
  /** Injectable configuration (tests; defaults to the env read). */
  config?: BuilderClientConfig;
  /** Injectable fetcher (tests never touch the real network). */
  fetcher?: typeof fetch;
};

/**
 * Reads the Builder connection configuration from the server environment.
 * Returns null when the Builder is not configured (the honest
 * BUILDER_UNAVAILABLE admin outcome — never a guess, never a default URL).
 */
export async function readBuilderClientConfig(): Promise<BuilderClientConfig | null> {
  const { env } = await import('$env/dynamic/private');
  const url = (env.PRIVATE_ADAPTER_BUILDER_URL ?? '').trim();
  const secret = env.PRIVATE_ADAPTER_BUILDER_SECRET ?? '';
  if (url.length === 0 || secret.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const timeoutRaw = Number.parseInt(env.PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw >= 5_000 && timeoutRaw <= 600_000
    ? timeoutRaw
    : DEFAULT_BUILDER_TIMEOUT_MS;
  return { url: parsed.toString(), secret, timeoutMs };
}

/**
 * Sends one authorized build request to the external Builder.
 * NEVER called from the Downloader 2 path (statically pinned).
 */
export async function requestAdapterBuild(
  request: AdapterBuildRequest,
  deps: BuilderClientDeps = {},
): Promise<BuilderClientOutcome> {
  const config = deps.config ?? (await readBuilderClientConfig());
  if (config === null) {
    return {
      ok: false,
      code: 'BUILDER_UNAVAILABLE',
      message: 'The Adapter Builder is not configured on this deployment.',
    };
  }
  const fetcher = deps.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetcher(`${config.url.replace(/\/+$/, '')}/build`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'BUILDER_UNAVAILABLE', message: 'The Adapter Builder rejected the request authorization.' };
    }
    if (response.status === 504 || response.status === 502) {
      // Builder-side timeout / upstream unavailability: controlled outcome.
      return { ok: false, code: 'BUILDER_TIMEOUT', message: 'The Adapter Builder did not respond in time.' };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, code: 'BUILDER_UNAVAILABLE', message: 'The Adapter Builder returned an unreadable response.' };
    }
    const shaped = body as AdapterBuildResponse;
    if (typeof shaped !== 'object' || shaped === null || typeof shaped['ok'] !== 'boolean') {
      return { ok: false, code: 'BUILDER_UNAVAILABLE', message: 'The Adapter Builder returned an unexpected response shape.' };
    }
    return { ok: true, response: shaped };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, code: 'BUILDER_TIMEOUT', message: 'The Adapter Builder did not respond in time.' };
    }
    return { ok: false, code: 'BUILDER_UNAVAILABLE', message: 'The Adapter Builder could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}
