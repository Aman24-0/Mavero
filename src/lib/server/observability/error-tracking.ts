// Phase 6.3 — Production error tracking.
//
// A minimal, dependency-free error reporting utility that sends structured
// error events to a Sentry-compatible endpoint. The integration is
// DISABLED by default — it activates only when MAVERO_SENTRY_DSN is
// set in the environment.
//
// DESIGN CONTRACTS:
//   * NO external dependency (no @sveltejs/sentry, no @sentry/node). The
//     utility uses the native fetch() API to POST a JSON envelope to the
//     Sentry-compatible ingest endpoint. This keeps the bundle small and
//     avoids version-lock to a specific Sentry SDK.
//   * DISABLED until DSN is supplied. When MAVERO_SENTRY_DSN is unset,
//     captureException/captureMessage are no-ops — zero overhead.
//   * NEVER captures secrets. Uses the existing redaction utility
//     (src/lib/server/http/log.ts) to scrub sensitive fields before
//     sending.
//   * Request ID propagation. Every error event carries the request ID.
//   * Graceful degradation. If the endpoint is unreachable, the error
//     is logged via the existing structured logger and the application
//     continues normally — no crash, no retry loop.
//
// WHAT THIS IS NOT:
//   * Not a full Sentry SDK. No performance monitoring, no session replay.
//   * Not a replacement for the existing structured logger.
//   * Not a client-side error tracker (server-only: $lib/server).

import { env as privateEnv } from '$env/dynamic/private';
import { redactFields } from '$lib/server/http/log';

type SentryEvent = {
  event_id?: string;
  timestamp?: string;
  level: 'info' | 'warning' | 'error' | 'fatal';
  message?: string;
  exception?: { type: string; value: string; stacktrace?: string };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

let dsn: string | null = null;
let endpoint: string | null = null;
let release: string | null = null;
let initialized = false;

function init(): void {
  initialized = true;
  const rawDsn = privateEnv.MAVERO_SENTRY_DSN;
  if (!rawDsn) return;
  try {
    const parsed = new URL(rawDsn);
    const projectId = parsed.pathname.replace(/^\//, '');
    endpoint = `https://${parsed.host}/api/${projectId}/store/`;
    dsn = rawDsn;
    release = privateEnv.MAVERO_RELEASE_ID ?? null;
  } catch {
    dsn = null;
    endpoint = null;
  }
}

function isEnabled(): boolean {
  if (!initialized) init();
  return dsn !== null && endpoint !== null;
}

function randomEventId(): string {
  try { return crypto.randomUUID().replace(/-/g, ''); }
  catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
}

async function sendEvent(event: SentryEvent): Promise<void> {
  if (!isEnabled() || !endpoint) return;
  try {
    const parsed = new URL(dsn!);
    const publicKey = parsed.username;
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sentry-auth': `Sentry sentry_key=${publicKey}, sentry_version=7`,
      },
      body: JSON.stringify({
        event_id: event.event_id ?? randomEventId(),
        timestamp: event.timestamp ?? new Date().toISOString(),
        platform: 'node',
        level: event.level,
        message: event.message,
        exception: event.exception ? { values: [event.exception] } : undefined,
        tags: event.tags,
        extra: redactFields(event.extra ?? {}),
        release: release ?? undefined,
        environment: privateEnv.MAVERO_ENV ?? 'production',
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Graceful degradation — the structured logger already captured the error.
  }
}

export function captureException(
  error: unknown,
  context?: { requestId?: string; route?: string; extra?: Record<string, unknown> }
): void {
  if (!isEnabled()) return;
  const err = error instanceof Error ? error : new Error(String(error));
  void sendEvent({
    level: 'error',
    exception: { type: err.name, value: err.message, stacktrace: err.stack },
    tags: {
      ...(context?.requestId ? { requestId: context.requestId } : {}),
      ...(context?.route ? { route: context.route } : {}),
    },
    extra: context?.extra,
  });
}

export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'warning',
  context?: { requestId?: string; route?: string; extra?: Record<string, unknown> }
): void {
  if (!isEnabled()) return;
  void sendEvent({
    level, message,
    tags: {
      ...(context?.requestId ? { requestId: context.requestId } : {}),
      ...(context?.route ? { route: context.route } : {}),
    },
    extra: context?.extra,
  });
}

export function isErrorTrackingEnabled(): boolean { return isEnabled(); }
