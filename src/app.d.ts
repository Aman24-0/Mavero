import type { SupabaseClient, User, Session } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

// Phase 2-B (audit PERF-002) — projected page payload.
//
// The root layout (src/routes/+layout.server.ts) no longer serializes the
// full Supabase `Session`/`User` object into the page payload. The client
// only needs identity: an opaque user id, the email, the display name, and
// whether the user is authenticated. Tokens (access/refresh/expires_at)
// never reach the client bundle, the DOM, or service-worker caches.
export type LayoutUser = {
  id: string;
  email: string | undefined;
  displayName: string | null;
};

declare global {
  namespace App {
    interface Locals {
      supabase: SupabaseClient<Database>;
      safeGetSession: () => Promise<{ session: Session | null; user: User | null }>;
      // Phase 2-A: server hook resolves auth ONCE per request and stores
      // the result here. Every server load/api route that only needs
      // identity (the overwhelming majority) reads these directly instead
      // of triggering a SECOND Supabase Auth network roundtrip. Only routes
      // whose session genuinely changes mid-request (e.g. /auth/reset after
      // exchangeCodeForSession) re-call safeGetSession deliberately.
      session: Session | null;
      user: User | null;
      // Phase 3-A: server hook resolves a request/correlation ID ONCE per
      // request and stores it here. The structured logger (http/log.ts)
      // reads it from locals so every log line for a single request shares
      // the same ID — operators can grep Netlify logs by requestId to see
      // the full request trace. NEVER used as an auth/authorization
      // boundary — only as a diagnostic correlation label.
      requestId: string;
    }

    interface PageData {
      // Projected payload — no tokens, no full session object.
      user: LayoutUser | null;
      isAuthenticated: boolean;
      // Newtask §7 — server-derived device class (descriptive only,
      // never an identity or authorization signal). Same string union
      // as ClientDeviceType in $lib/shared/device-class.ts (kept as a
      // literal here so app.d.ts stays import-free).
      deviceType: 'mobile' | 'tablet' | 'desktop' | 'tv' | 'unknown';
    }

  }
}

export {};
