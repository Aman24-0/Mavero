/**
 * Phase 1 Analytics Foundation — server-side event ingestion.
 *
 * Provides:
 *   - recordEvent / recordEvents: low-level writes to analytics_events
 *     via the service-role admin client (bypasses RLS). Idempotent on
 *     event_id (uses INSERT ... ON CONFLICT DO NOTHING via
 *     .upsert(ignoreDuplicates: true)).
 *   - upsertAnalyticsSession: keeps analytics_sessions in sync with
 *     the latest activity for a session_id.
 *   - recordServerEvent: convenience wrapper that builds an event from
 *     a server-known identity (anonymous_id + user_id from the request
 *     hook) and dispatches it fire-and-forget with a bounded timeout.
 *
 * RELIABILITY CONTRACT (per plan §35):
 *   Analytics is observability/product intelligence, NOT a dependency.
 *   If ingestion fails, the main user action MUST still succeed.
 *   recordServerEvent therefore NEVER throws — it catches all errors
 *   and logs a safe diagnostic (requestId + error class only; never
 *   tokens or session IDs). This mirrors the device-sessions
 *   registration reliability pattern in hooks.server.ts.
 */

import type { SupabaseAdminClient } from '$lib/server/supabase/admin';
import type { Database } from '$lib/server/supabase/database.types';
import type { Json } from '$lib/server/supabase/database.types';
import { isAnalyticsEventName } from '$lib/shared/analytics-taxonomy';
import { isValidAnonymousId } from './anonymous-id';

/** Shape of a raw analytics event row ready for insert. */
export type AnalyticsEventInsert = Database['public']['Tables']['analytics_events']['Insert'];

/** Shape of an analytics session row ready for upsert. */
export type AnalyticsSessionUpsert = Database['public']['Tables']['analytics_sessions']['Insert'];

/**
 * Input shape for a single event coming from EITHER the client dispatcher
 * OR a server-authoritative code path. Identity fields (anonymous_id,
 * user_id) are populated by the caller; the ingest endpoint populates
 * them from the cookie + locals.user (never from client input).
 */
export type AnalyticsEventInput = {
  event_id: string;
  event_name: string;
  anonymous_id: string;
  user_id?: string | null;
  session_id?: string | null;
  event_time?: string;
  content_id?: string | null;
  content_type?: string | null;
  provider_id?: string | null;
  source_id?: string | null;
  metadata?: Record<string, unknown> | null;
  request_id?: string | null;
  ip_hash?: string | null;
  user_agent?: string | null;
};

/**
 * Validates and normalizes a single analytics event input.
 *
 * Returns null if the event is malformed and must be dropped (with a
 * safe diagnostic log). Specifically drops:
 *   - unknown event_name (not in the closed taxonomy)
 *   - invalid anonymous_id (must be guest_<uuid>)
 *   - invalid user_id (must be a UUID, if present)
 *   - invalid event_id (must be a UUID)
 *   - invalid content_type (must be 'movie'|'series'|'anime' if present)
 *
 * This is the SECOND line of defense — the DB CHECK constraint is the
 * first. Doing it here means we can drop malformed events with a log
 * instead of a DB error per row.
 */
export function normalizeEvent(input: AnalyticsEventInput): AnalyticsEventInsert | null {
  // event_id must be a UUID.
  if (typeof input.event_id !== 'string' || !UUID_RE.test(input.event_id)) return null;
  // event_name must be in the closed taxonomy.
  if (!isAnalyticsEventName(input.event_name)) return null;
  // anonymous_id is mandatory and must be well-formed.
  if (!isValidAnonymousId(input.anonymous_id)) return null;
  // user_id, if present, must be a UUID.
  if (input.user_id != null && !UUID_RE.test(input.user_id)) return null;
  // content_type, if present, must be one of the known content types.
  if (input.content_type != null && !VALID_CONTENT_TYPES.has(input.content_type)) return null;

  return {
    event_id: input.event_id,
    event_name: input.event_name,
    anonymous_id: input.anonymous_id,
    user_id: input.user_id ?? null,
    session_id: input.session_id ?? null,
    event_time: input.event_time ?? new Date().toISOString(),
    content_id: input.content_id ?? null,
    content_type: input.content_type ?? null,
    provider_id: input.provider_id ?? null,
    source_id: input.source_id ?? null,
    metadata: (input.metadata ?? {}) as Json,
    request_id: input.request_id ?? null,
    ip_hash: input.ip_hash ?? null,
    user_agent: input.user_agent ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CONTENT_TYPES = new Set(['movie', 'series', 'anime']);

/**
 * Writes a batch of analytics events to the DB. Idempotent on event_id
 * (uses .upsert with ignoreDuplicates: true so a retry with the same
 * event_id is a no-op). Drops malformed events before the write.
 *
 * NEVER throws — returns a safe result shape. The caller (ingest
 * endpoint or recordServerEvent) is responsible for logging failures
 * and continuing the main user action.
 */
export async function recordEvents(
  admin: SupabaseAdminClient,
  events: AnalyticsEventInput[]
): Promise<{ inserted: number; dropped: number; error: string | null }> {
  const valid: AnalyticsEventInsert[] = [];
  let dropped = 0;
  for (const input of events) {
    const normalized = normalizeEvent(input);
    if (normalized) {
      valid.push(normalized);
    } else {
      dropped += 1;
    }
  }
  if (valid.length === 0) {
    return { inserted: 0, dropped, error: null };
  }
  try {
    const result = await admin
      .from('analytics_events')
      .upsert(valid, { onConflict: 'event_id', ignoreDuplicates: true });
    if (result.error) {
      return { inserted: 0, dropped, error: result.error.message };
    }
    return { inserted: valid.length, dropped, error: null };
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown error';
    return { inserted: 0, dropped, error: message };
  }
}

/**
 * Writes a single analytics event. Convenience wrapper around
 * recordEvents for the common single-event case.
 */
export async function recordEvent(
  admin: SupabaseAdminClient,
  event: AnalyticsEventInput
): Promise<{ inserted: number; dropped: number; error: string | null }> {
  return recordEvents(admin, [event]);
}

/**
 * Upserts a row in analytics_sessions. Called by the ingest endpoint
 * on every event that carries a session_id, so the session row's
 * last_activity_at stays fresh.
 *
 * NEVER throws — returns a safe result shape.
 */
export async function upsertAnalyticsSession(
  admin: SupabaseAdminClient,
  session: AnalyticsSessionUpsert
): Promise<{ error: string | null }> {
  try {
    const result = await admin
      .from('analytics_sessions')
      .upsert(session, { onConflict: 'session_id' });
    if (result.error) {
      return { error: result.error.message };
    }
    return { error: null };
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown error';
    return { error: message };
  }
}

/**
 * Server-authoritative event recording. Fire-and-forget with a bounded
 * timeout — NEVER awaits on the request path. Used by server flows
 * (sign-in, sign-out, signup, search, detail_open, playback_success/
 * failed, favorite_added/removed) that have a reliable identity and
 * want to emit an event without blocking the user action.
 *
 * The returned promise resolves once the write completes (or the
 * timeout fires) — the caller MAY await it (e.g. in a sign-out flow
 * where the redirect tolerates a small delay) or ignore it (e.g. in a
 * search API that returns immediately).
 *
 * On any failure (timeout, DB error, validation drop), the function
 * logs a safe diagnostic and resolves — it NEVER rejects.
 */
export function recordServerEvent(
  admin: SupabaseAdminClient,
  event: AnalyticsEventInput,
  options: { requestId?: string; timeoutMs?: number } = {}
): Promise<{ inserted: number; dropped: number; error: string | null; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const recordPromise = recordEvent(admin, event);
  const bounded = new Promise<{ inserted: number; dropped: number; error: string | null; timedOut: boolean }>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ inserted: 0, dropped: 0, error: 'timeout', timedOut: true });
    }, timeoutMs);
    recordPromise.then(
      (result) => {
        if (timedOut) return; // already resolved with timeout
        clearTimeout(timer);
        resolve({ ...result, timedOut: false });
      },
      (err) => {
        if (timedOut) return;
        clearTimeout(timer);
        const message = (err as Error)?.message ?? 'unknown error';
        resolve({ inserted: 0, dropped: 0, error: message, timedOut: false });
      }
    );
  });
  // Log failures safely (no tokens, no session IDs).
  bounded.then((result) => {
    if (result.error && !result.timedOut) {
      try {
        console.error('[Analytics] server event ingest failed', {
          requestId: options.requestId ?? 'n/a',
          eventName: event.event_name,
          error: result.error,
        });
      } catch {
        // console.error itself must never throw — ignore.
      }
    } else if (result.timedOut) {
      try {
        console.error('[Analytics] server event ingest timed out (non-blocking)', {
          requestId: options.requestId ?? 'n/a',
          eventName: event.event_name,
        });
      } catch {
        // ignore
      }
    }
  });
  return bounded;
}

/**
 * Computes a SHA-256 hex hash of a string. Used for ip_hash — we never
 * store raw IP, only the hash (for coarse abuse correlation).
 */
export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
