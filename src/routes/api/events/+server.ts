import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { errorResponses } from '$lib/server/http/error-response';
import { checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import type { Json } from '$lib/server/supabase/database.types';
import { isValidAnonymousId, ANONYMOUS_ID_COOKIE } from '$lib/server/analytics/anonymous-id';
import { recordEvents, upsertAnalyticsSession, hashIp, type AnalyticsEventInput } from '$lib/server/analytics/ingest';
import { isAnalyticsEventName } from '$lib/shared/analytics-taxonomy';

/**
 * Phase 1 Analytics Foundation — event ingest endpoint.
 *
 * POST /api/events
 *
 * Accepts a BATCH of analytics events from the client dispatcher. The
 * client queues events in-memory and flushes periodically (every 5s),
 * on visibilitychange (tab switch), and on beforeunload (page close).
 *
 * BODY SHAPE:
 *   {
 *     events: [
 *       {
 *         event_id: string,         // client-generated UUID (idempotency key)
 *         event_name: string,       // must be in the closed taxonomy
 *         session_id?: string,      // client-generated session_id
 *         event_time?: string,      // ISO 8601, defaults to now()
 *         content_id?: string,
 *         content_type?: 'movie'|'series'|'anime',
 *         provider_id?: string,
 *         source_id?: string,
 *         metadata?: object
 *       }
 *     ],
 *     session?: {                   // optional, sent on the first event of a session
 *       session_id: string,
 *       device_type?: string,
 *       metadata?: object
 *     }
 *   }
 *
 * IDENTITY MODEL:
 *   - anonymous_id is read from the `mavero:anonymous-id` cookie. The
 *     server is the source of truth — a client-supplied anonymous_id
 *     is NEVER trusted. If the cookie is missing or invalid, the
 *     event is dropped (the client should reload to get a cookie
 *     issued by the hook).
 *   - user_id is read from locals.user.id (resolved by the auth hook).
 *     A client-supplied user_id is NEVER trusted. Events from
 *     unauthenticated requests have user_id = null (guest events).
 *
 * IDEMPOTENCY:
 *   - The client generates event_id (UUID) when it queues the event.
 *     Retries with the same event_id are deduplicated at the DB layer
 *     (primary key on event_id, .upsert with ignoreDuplicates: true).
 *
 * RATE LIMIT:
 *   - 60 batches per minute per identity (user or IP). A batch may
 *     contain up to 50 events, so the effective ceiling is 3000
 *     events/min per client — generous for any realistic UX.
 *
 * RELIABILITY:
 *   - If ingestion fails, the endpoint returns 200 with a safe body
 *     so the client dispatcher does not retry indefinitely. Analytics
 *     is observability, NOT a dependency — losing an event is
 *     preferable to blocking the user action.
 *   - The endpoint itself never throws; all errors are caught.
 */

const MAX_EVENTS_PER_BATCH = 50;

type IngestEvent = {
  event_id: unknown;
  event_name: unknown;
  session_id?: unknown;
  event_time?: unknown;
  content_id?: unknown;
  content_type?: unknown;
  provider_id?: unknown;
  source_id?: unknown;
  metadata?: unknown;
};

type IngestBody = {
  events?: unknown;
  session?: {
    session_id?: unknown;
    device_type?: unknown;
    metadata?: unknown;
  };
};

export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
  // Rate limit — 60 batches/min per identity. Generous; bounded by
  // the in-memory per-instance counter (see rate-limit.ts header).
  const rateVerdict = checkRateLimit('eventsIngest', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return errorResponses.rateLimited(rateVerdict.retryAfterSeconds);
  }

  // Parse body.
  const body = await readJsonBody<IngestBody>(request);
  if (!body.ok) {
    return errorResponses.invalidRequest(body.message);
  }
  const payload = body.value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return errorResponses.invalidRequest('The request body must be an object.');
  }

  // Validate events array.
  const eventsRaw = payload.events;
  if (!Array.isArray(eventsRaw)) {
    return errorResponses.invalidRequest('`events` must be an array.');
  }
  if (eventsRaw.length === 0) {
    // Empty batch is a no-op — common on flush-with-no-queue. Return ok
    // so the client dispatcher clears its queue.
    return json({ ok: true, inserted: 0, dropped: 0 });
  }
  if (eventsRaw.length > MAX_EVENTS_PER_BATCH) {
    return errorResponses.invalidRequest(`A batch may contain at most ${MAX_EVENTS_PER_BATCH} events.`);
  }

  // Identity resolution — server is source of truth.
  // anonymous_id from cookie (NEVER client-supplied).
  const anonymousIdCookie = cookies.get(ANONYMOUS_ID_COOKIE);
  if (!isValidAnonymousId(anonymousIdCookie)) {
    // Cookie missing or invalid — drop the batch. The client should
    // reload (the hook issues the cookie on the next request). Return
    // ok so the client does not retry indefinitely.
    return json({ ok: true, inserted: 0, dropped: eventsRaw.length, reason: 'no_anonymous_id' });
  }
  const anonymousId = anonymousIdCookie;
  // user_id from locals.user (NEVER client-supplied).
  const userId = locals.user?.id ?? null;

  // Build the event inputs.
  const events: AnalyticsEventInput[] = [];
  let dropped = 0;
  for (const raw of eventsRaw) {
    if (!raw || typeof raw !== 'object') {
      dropped += 1;
      continue;
    }
    const e = raw as IngestEvent;
    // Coerce and validate fields. Invalid events are dropped (not
    // rejected wholesale) so one bad event does not poison the batch.
    if (typeof e.event_id !== 'string' || typeof e.event_name !== 'string') {
      dropped += 1;
      continue;
    }
    if (!isAnalyticsEventName(e.event_name)) {
      dropped += 1;
      continue;
    }
    events.push({
      event_id: e.event_id,
      event_name: e.event_name,
      anonymous_id: anonymousId,
      user_id: userId,
      session_id: typeof e.session_id === 'string' ? e.session_id : null,
      event_time: typeof e.event_time === 'string' ? e.event_time : undefined,
      content_id: typeof e.content_id === 'string' ? e.content_id : null,
      content_type: typeof e.content_type === 'string' ? e.content_type : null,
      provider_id: typeof e.provider_id === 'string' ? e.provider_id : null,
      source_id: typeof e.source_id === 'string' ? e.source_id : null,
      metadata: e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : null,
      request_id: locals.requestId,
    });
  }

  if (events.length === 0) {
    return json({ ok: true, inserted: 0, dropped });
  }

  // Compute ip_hash (best-effort; never store raw IP).
  let ipHash: string | null = null;
  try {
    const forwarded = request.headers.get('x-forwarded-for');
    const realIp = request.headers.get('x-nf-client-connection-ip');
    const rawIp = (forwarded?.split(',')[0]?.trim() || realIp || '').trim();
    if (rawIp) ipHash = await hashIp(rawIp);
  } catch {
    // ignore — ip_hash is best-effort.
  }
  const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null;
  // Attach ip_hash + user_agent to each event (cheap — both are
  // computed once per batch).
  for (const ev of events) {
    if (ipHash) ev.ip_hash = ipHash;
    if (userAgent) ev.user_agent = userAgent;
  }

  // Write events via the service-role admin client (bypasses RLS).
  // Failure is non-blocking: we return ok so the client does not retry.
  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    // Admin client init failed (missing service-role key in env). Drop
    // the batch silently — analytics must not break the user action.
    return json({ ok: true, inserted: 0, dropped: events.length + dropped });
  }

  const result = await recordEvents(admin, events);

  // Upsert the analytics_sessions row if the client sent one.
  // Best-effort; failures are logged inside upsertAnalyticsSession.
  const sessionPayload = payload.session;
  if (sessionPayload && typeof sessionPayload.session_id === 'string' && sessionPayload.session_id.length > 0 && sessionPayload.session_id.length <= 100) {
    await upsertAnalyticsSession(admin, {
      session_id: sessionPayload.session_id,
      anonymous_id: anonymousId,
      user_id: userId,
      device_type: typeof sessionPayload.device_type === 'string' ? sessionPayload.device_type.slice(0, 50) : null,
      metadata: (sessionPayload.metadata && typeof sessionPayload.metadata === 'object' && !Array.isArray(sessionPayload.metadata) ? sessionPayload.metadata : {}) as unknown as Json,
      last_activity_at: new Date().toISOString(),
    });
  }

  // Always return ok — analytics is observability, not a dependency.
  return json({
    ok: true,
    inserted: result.inserted,
    dropped: result.dropped + dropped,
  });
};
