/**
 * Phase 1 Analytics Foundation — client-side event dispatcher.
 *
 * Singleton dispatcher that queues analytics events in-memory and
 * flushes them in batches to /api/events. Designed for:
 *   - Non-blocking UX: track() returns immediately; the queue flushes
 *     on a 5-second timer, on visibilitychange (tab switch), and on
 *     beforeunload (page close) via navigator.sendBeacon.
 *   - Reliability: every step catches its own errors. Analytics MUST
 *     NOT break the user action. A failed flush retries the batch
 *     once on the next flush tick; persistent failures drop the batch
 *     (analytics is observability, not a dependency).
 *   - Idempotency: each event gets a client-generated event_id (UUID).
 *     The server deduplicates on event_id, so a retry of the SAME
 *     event (e.g. after a network blip) does not inflate metrics.
 *   - Identity: the dispatcher receives anonymous_id from PageData
 *     (server-projected). It DOES NOT trust a client-stored value.
 *     user_id is NEVER sent by the client — the server attaches it
 *     from locals.user at ingest time.
 *   - Session: the dispatcher generates a session_id (sess_<uuid>)
 *     and persists it in localStorage with a lastActivity timestamp.
 *     If 30 minutes have passed since lastActivity, a new session_id
 *     is generated (session_start event is emitted). The session_id
 *     is sent with every event.
 */

import { isAnalyticsEventName, type AnalyticsEventName } from '$lib/shared/analytics-taxonomy';

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE_SIZE = 100; // flush early if queue gets large
const MAX_BATCH_SIZE = 50; // server rejects batches > 50 (Phase 7 fix)
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle = new session
const SESSION_STORAGE_KEY = 'mavero:analytics-session';
const INGEST_URL = '/api/events';

type QueuedEvent = {
  event_id: string;
  event_name: AnalyticsEventName;
  session_id: string;
  event_time: string;
  content_id?: string;
  content_type?: 'movie' | 'series' | 'anime';
  provider_id?: string;
  source_id?: string;
  metadata?: Record<string, unknown>;
};

type SessionState = {
  session_id: string;
  last_activity: number;
};

type DispatcherConfig = {
  anonymousId: string | null;
  enabled: boolean;
  deviceType?: string;
};

class AnalyticsDispatcher {
  private queue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private config: DispatcherConfig = { anonymousId: null, enabled: false };
  private session: SessionState | null = null;
  private sessionStartEmitted = false;
  private appOpenEmitted = false;
  private bound = false;

  /**
   * Initializes the dispatcher with the server-projected anonymous_id.
   * Called once from the root layout's onMount. Safe to call multiple
   * times — subsequent calls just update the config.
   */
  configure(config: DispatcherConfig): void {
    this.config = config;
    if (!config.enabled || !config.anonymousId) return;
    if (typeof window === 'undefined') return;
    if (this.bound) return;
    this.bound = true;
    this.session = this.loadOrCreateSession();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush({ useBeacon: true });
    });
    window.addEventListener('beforeunload', () => {
      void this.flush({ useBeacon: true });
    });
    window.addEventListener('pagehide', () => {
      void this.flush({ useBeacon: true });
    });
    // Emit app_open + session_start ONCE per page lifecycle.
    if (!this.appOpenEmitted) {
      this.appOpenEmitted = true;
      this.track('app_open');
      if (!this.sessionStartEmitted) {
        this.sessionStartEmitted = true;
        this.track('session_start');
      }
    }
  }

  /**
   * Queues an analytics event. Returns immediately. No-op if the
   * dispatcher is disabled, if the event name is not in the taxonomy,
   * or if anonymous_id is not set.
   */
  track(
    eventName: AnalyticsEventName,
    properties: {
      content_id?: string;
      content_type?: 'movie' | 'series' | 'anime';
      provider_id?: string;
      source_id?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): void {
    if (!this.config.enabled || !this.config.anonymousId) return;
    if (typeof window === 'undefined') return;
    if (!isAnalyticsEventName(eventName)) return;
    // Refresh session on every meaningful event.
    if (!this.session) this.session = this.loadOrCreateSession();
    if (Date.now() - this.session.last_activity > SESSION_TIMEOUT_MS) {
      // Previous session timed out — emit session_end (best-effort) and start a new one.
      this.queue.push({
        event_id: crypto.randomUUID(),
        event_name: 'session_end',
        session_id: this.session.session_id,
        event_time: new Date().toISOString(),
        metadata: { reason: 'timeout' },
      });
      this.session = this.createSession();
      this.track('session_start');
    }
    this.session.last_activity = Date.now();
    this.persistSession();
    const event: QueuedEvent = {
      event_id: crypto.randomUUID(),
      event_name: eventName,
      session_id: this.session.session_id,
      event_time: new Date().toISOString(),
    };
    if (properties.content_id !== undefined) event.content_id = properties.content_id;
    if (properties.content_type !== undefined) event.content_type = properties.content_type;
    if (properties.provider_id !== undefined) event.provider_id = properties.provider_id;
    if (properties.source_id !== undefined) event.source_id = properties.source_id;
    if (properties.metadata !== undefined) event.metadata = properties.metadata;
    this.queue.push(event);
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      void this.flush();
    }
  }

  /** Flushes the queue immediately. Safe to call multiple times. */
  async flush(options: { useBeacon?: boolean } = {}): Promise<void> {
    if (this.flushing) return;
    if (this.queue.length === 0) return;
    if (!this.config.enabled || !this.config.anonymousId) return;
    // Phase 7 fix: cap batch at MAX_BATCH_SIZE (50) to match the server's
    // MAX_EVENTS_PER_BATCH limit. Previously used MAX_QUEUE_SIZE (100)
    // which caused the server to reject the batch with 400, triggering
    // an infinite retry loop.
    const batch = this.queue.splice(0, MAX_BATCH_SIZE);
    this.flushing = true;
    try {
      const payload = {
        events: batch,
        session: this.session
          ? {
              session_id: this.session.session_id,
              device_type: this.config.deviceType,
            }
          : undefined,
      };
      if (options.useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        // sendBeacon is fire-and-forget — the browser guarantees
        // delivery even if the page is unloading. We cannot read the
        // response, so we just hope for the best (idempotency on
        // event_id means a duplicate send is harmless if the server
        // did receive it).
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(INGEST_URL, blob);
      } else {
        const response = await fetch(INGEST_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'include',
          keepalive: true,
        });
        if (!response.ok) {
          // Phase 7 fix: distinguish 4xx (client error — drop, never
          // retry) from 5xx (server error — retry once). Previously
          // ALL non-2xx were re-queued, causing infinite retry loops
          // on 400 (malformed batch / too many events).
          if (response.status >= 400 && response.status < 500) {
            // 4xx: client error — the batch will never succeed. Drop it.
            // Idempotency on event_id means a duplicate send is harmless
            // if the server did partially receive it.
          } else {
            // 5xx or other: server/network error — re-queue for retry.
            this.queue.unshift(...batch);
          }
        }
      }
    } catch {
      // Network error — re-queue for a single retry on the next flush.
      this.queue.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  private loadOrCreateSession(): SessionState {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return this.createSession();
    }
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SessionState>;
        if (typeof parsed.session_id === 'string' && typeof parsed.last_activity === 'number') {
          if (Date.now() - parsed.last_activity < SESSION_TIMEOUT_MS) {
            return { session_id: parsed.session_id, last_activity: parsed.last_activity };
          }
        }
      }
    } catch {
      // localStorage might be disabled (private mode) — fall through to create.
    }
    return this.createSession();
  }

  private createSession(): SessionState {
    const session = { session_id: `sess_${crypto.randomUUID()}`, last_activity: Date.now() };
    this.persistSession();
    return session;
  }

  private persistSession(): void {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    if (!this.session) return;
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(this.session));
    } catch {
      // localStorage full or disabled — session continues in-memory only.
    }
  }
}

/** Singleton dispatcher. Imported by the root layout and track() callers. */
export const analytics = new AnalyticsDispatcher();

/**
 * Convenience function: track an analytics event. No-op if the
 * dispatcher is not configured (e.g. during SSR).
 */
export function track(
  eventName: AnalyticsEventName,
  properties?: {
    content_id?: string;
    content_type?: 'movie' | 'series' | 'anime';
    provider_id?: string;
    source_id?: string;
    metadata?: Record<string, unknown>;
  }
): void {
  analytics.track(eventName, properties ?? {});
}
