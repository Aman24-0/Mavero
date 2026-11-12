/**
 * MAVERO Adapter Builder Service — configuration (Permanent Adapter Plan
 * Phase 3 — plan §2/§4/§5/§14).
 *
 * The Builder is a STANDALONE deployable service (Render / Oracle Cloud /
 * any dedicated host — the deployment target is pure configuration, never
 * business logic). It exists ONLY to analyze → generate → test permanent
 * adapters; it NEVER serves Downloader 2 runtime traffic (plan §3 hard
 * rule — enforced by having no runtime routes at all).
 *
 * Configuration (env vars — deployment-provider agnostic):
 *   BUILDER_SECRET            required — shared secret for POST /build auth
 *                             (timing-safe compared; never logged)
 *   BUILDER_PORT              default 8787
 *   BUILDER_BUILD_TIMEOUT_MS  default 120000 — overall per-build budget
 *   BUILDER_MODULE_MAX_BYTES  default 524288 (512 KiB) — provider source cap
 *   BUILDER_BODY_MAX_BYTES    default 65536 (64 KiB) — request body cap
 *   BUILDER_MAX_REQUESTS      default 40 — network requests per analysis
 *   BUILDER_RESPONSE_MAX_BYTES default 2097152 (2 MiB) per response
 *   BUILDER_TOTAL_MAX_BYTES   default 12582912 (12 MiB) per build
 *   BUILDER_REPLAY_WINDOW_MS  default 900000 (15 min) + LRU 2048 entries
 *   BUILDER_TEST_TIMEOUT_MS   default 30000 — per DSL test case
 *   BUILDER_SANDBOX_SCRIPT_TIMEOUT_MS default 5000 — per synchronous script
 *
 * The service has NO database access, NO filesystem writes, NO secrets
 * other than BUILDER_SECRET, and NO production data — a compromised
 * builder worker gains nothing (by design, plan §5).
 */

import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';

export const BUILDER_VERSION = 'mavero-adapter-builder/1.0.0';

export type BuilderLimits = {
  buildTimeoutMs: number;
  moduleMaxBytes: number;
  bodyMaxBytes: number;
  maxNetworkRequests: number;
  responseMaxBytes: number;
  totalMaxBytes: number;
  replayWindowMs: number;
  testTimeoutMs: number;
  sandboxScriptTimeoutMs: number;
};

export type BuilderConfig = {
  secret: string;
  port: number;
  limits: BuilderLimits;
};

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

const DEFAULTS: BuilderLimits = {
  buildTimeoutMs: 120_000,
  moduleMaxBytes: 524_288,
  bodyMaxBytes: 65_536,
  maxNetworkRequests: 40,
  responseMaxBytes: 2 * 1_048_576,
  totalMaxBytes: 12 * 1_048_576,
  replayWindowMs: 900_000,
  testTimeoutMs: 30_000,
  sandboxScriptTimeoutMs: 5_000,
};

/** Reads the builder configuration from the environment. */
export function readBuilderConfig(): BuilderConfig {
  const secret = process.env['BUILDER_SECRET'] ?? '';
  return {
    secret,
    port: intEnv('BUILDER_PORT', 8787, 1, 65_535),
    limits: {
      buildTimeoutMs: intEnv('BUILDER_BUILD_TIMEOUT_MS', DEFAULTS.buildTimeoutMs, 5_000, 600_000),
      moduleMaxBytes: intEnv('BUILDER_MODULE_MAX_BYTES', DEFAULTS.moduleMaxBytes, 1_024, 8 * 1_048_576),
      bodyMaxBytes: intEnv('BUILDER_BODY_MAX_BYTES', DEFAULTS.bodyMaxBytes, 1_024, 1_048_576),
      maxNetworkRequests: intEnv('BUILDER_MAX_REQUESTS', DEFAULTS.maxNetworkRequests, 1, 200),
      responseMaxBytes: intEnv('BUILDER_RESPONSE_MAX_BYTES', DEFAULTS.responseMaxBytes, 16 * 1_024, 32 * 1_048_576),
      totalMaxBytes: intEnv('BUILDER_TOTAL_MAX_BYTES', DEFAULTS.totalMaxBytes, 64 * 1_024, 128 * 1_048_576),
      replayWindowMs: intEnv('BUILDER_REPLAY_WINDOW_MS', DEFAULTS.replayWindowMs, 60_000, 3_600_000),
      testTimeoutMs: intEnv('BUILDER_TEST_TIMEOUT_MS', DEFAULTS.testTimeoutMs, 1_000, 120_000),
      sandboxScriptTimeoutMs: intEnv('BUILDER_SANDBOX_SCRIPT_TIMEOUT_MS', DEFAULTS.sandboxScriptTimeoutMs, 500, 30_000),
    },
  };
}

/** Injectable fetch surface for the guarded network layer (tests). */
export type BuilderFetchDeps = {
  fetcher?: typeof fetch;
  dnsResolver?: SafeDnsResolver;
};
