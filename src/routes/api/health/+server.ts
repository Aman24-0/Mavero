import { json, type RequestHandler } from '@sveltejs/kit';
import { env as publicEnv } from '$env/dynamic/public';
import { cacheStats } from '$lib/server/content/cache';
import { negativeCacheStats } from '$lib/server/resolver/negative-cache';
import { providerCooldownStats } from '$lib/server/resolver/provider-cooldown';

// Phase 3-C (audit OBS-3) — Health / readiness endpoint.
//
// Two semantics, served from ONE endpoint to keep the Netlify function
// footprint minimal:
//
//   GET /api/health          — liveness: the function process is
//                              responding. Cheap, always 200 (when the
//                              function is reachable at all). Never
//                              depends on Supabase or TMDB.
//   GET /api/health?deep=1   — readiness: a bounded check that the
//                              CRITICAL Supabase dependency is reachable.
//                              Returns 503 with a non-disclosing message
//                              when Supabase is unreachable; 200 when
//                              the cheap probe succeeds.
//
// DESIGN CONTRACTS:
//
//   * Liveness is FREE — no external calls, no DB, no env reads. It
//     works even when the Supabase env is missing (the hook's default-
//     deny 503 still fires for /api/* but /api/health is in the env-free
//     allowlist so probes can confirm the function itself is alive).
//
//   * Readiness (deep=1) makes ONE cheap, bounded call to Supabase:
//       HEAD on the Supabase REST root (the PostgREST root), with a
//       2-second timeout. This is the cheapest possible "is Supabase
//       reachable" probe — no auth, no query, no RLS, no table read.
//     A 200/401/4xx response means Supabase is REACHABLE (the function
//     can connect); a network error or timeout means it is NOT.
//     We deliberately do NOT call Supabase Auth (health-checking the
//     auth endpoint requires an API key and would surface rate-limit
//     state); we do NOT query any application table (that would couple
//     the probe to a specific table's RLS and indexes).
//
//   * TMDB is NOT a readiness dependency — the app degrades gracefully
//     when TMDB is slow (cached fixtures + per-endpoint timeouts). A
//     TMDB outage does NOT make the app "not ready" in the k8s/Netlify
//     sense (the function still serves cached/fixture content).
//
//   * NO SECRETS are exposed:
//       - the response body never includes the Supabase URL, project
//         ref, API keys, service-role keys, or any env value;
//       - the readiness check uses the EXISTING public Supabase URL
//         (already public, baked into the client bundle) — it reveals
//         nothing an attacker couldn't already read from the DOM;
//       - error responses are non-disclosing: "Supabase unreachable"
//         with a requestId for operator correlation.
//
//   * MEDIA-WORKER is a SEPARATELY-DEPLOYED service. Its own /health
//     endpoint (apps/media-worker/src/server.ts) is the canonical
//     source for media-worker health. This endpoint does NOT proxy to
//     it — operators who need media-worker health should probe its
//     own endpoint directly. (Proxying would couple the app's readiness
//     to a service it doesn't own.)
//
// CACHING:
//   Liveness: no-store (always fresh — probes need to know NOW).
//   Readiness: no-store (a stale readiness answer is worse than none).

const READINESS_TIMEOUT_MS = 2_000;

type HealthStatus = 'ok' | 'degraded' | 'unavailable';

type HealthResponse = {
  status: HealthStatus;
  /** Epoch milliseconds — useful for probe freshness checks. */
  now: number;
  /** ISO 8601 uptime of the function process (best-effort). */
  uptimeSeconds?: number;
  /** Liveness never carries dependency info. Readiness carries a
   *  non-disclosing summary: which dependency was checked + the
   *  outcome (reachable / unreachable). Never the URL or credentials. */
  dependencies?: Array<{ name: string; status: HealthStatus; latencyMs?: number }>;
};

function livenessResponse(): Response {
  const body: HealthResponse = {
    status: 'ok',
    now: Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
  };
  return json(body, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}

async function probeSupabaseReachability(): Promise<{ reachable: boolean; latencyMs: number }> {
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    // No env configured — the hook would already have returned a 503
    // for non-env-free routes. For /api/health (env-free), we report
    // the readiness as "unavailable" so an operator probing deep=1
    // sees the config gap.
    return { reachable: false, latencyMs: 0 };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
  try {
    // HEAD on the Supabase REST root — the cheapest possible "is it
    // reachable" probe. PostgREST responds to HEAD / with 200/401/4xx
    // (no body). We do NOT send an API key (would leak it through the
    // request URL even if it's the publishable key — the response
    // status alone tells us reachability).
    const response = await fetch(supabaseUrl, {
      method: 'HEAD',
      signal: controller.signal,
      // No Authorization header — we only care about TCP/HTTP reachability.
      // A 401 still means "Supabase is up and answering".
    });
    return { reachable: response.ok || response.status === 401 || (response.status >= 400 && response.status < 500), latencyMs: Date.now() - started };
  } catch {
    // Network error or abort — Supabase is unreachable.
    return { reachable: false, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function readinessResponse(): Promise<Response> {
  const probe = await probeSupabaseReachability();
  const status: HealthStatus = probe.reachable ? 'ok' : 'unavailable';
  const body: HealthResponse = {
    status,
    now: Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
    dependencies: [{ name: 'supabase', status: probe.reachable ? 'ok' : 'unavailable', latencyMs: probe.latencyMs }],
  };
  return json(body, {
    // 503 when any critical dependency is unreachable — probes can use
    // this to decide whether to route traffic to this instance.
    status: probe.reachable ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}

export const GET: RequestHandler = async ({ url }) => {
  const deep = url.searchParams.get('deep') === '1';
  if (deep) return readinessResponse();
  const stats = url.searchParams.get('stats') === '1';
  if (stats) return statsResponse();
  return livenessResponse();
};

/**
 * Phase 3-H (audit OBS-7) — Lightweight instrumentation exposed via the
 * health endpoint. Operators can poll /api/health?stats=1 to see cache +
 * resolver stats WITHOUT a separate observability platform.
 *
 * Returns:
 *   * content cache stats (entries, evictions, sweeps, in-flight)
 *   * negative cache stats (entries, max, TTL)
 *   * provider cooldown stats (providers tracked, cooling down, threshold)
 *
 * NO SECRETS: the stats contain ONLY aggregate counts + bounds — never
 * user data, never provider URLs, never content ids. The response is
 * cacheable for 5 seconds (operators polling every 10-30s get fresh
 * data without hammering the function).
 *
 * This is NOT a full metrics endpoint — it does not export Prometheus-
 * format counters or integrate with an external metrics platform. It
 * is the minimum viable instrumentation for Phase 3: operators can
 * confirm the caches are working + see when providers are cooling down.
 */
function statsResponse(): Response {
  const body = {
    status: 'ok' as HealthStatus,
    now: Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
    caches: {
      content: cacheStats(),
      negative: negativeCacheStats(),
      providerCooldown: providerCooldownStats(),
    },
  };
  return json(body, {
    status: 200,
    headers: { 'cache-control': 'public, max-age=5' },
  });
}
