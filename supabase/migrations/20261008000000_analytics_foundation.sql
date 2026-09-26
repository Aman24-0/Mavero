-- MAVERO User Management & App Analytics — Phase 1: Analytics Foundation.
--
-- Establishes the first-party event, identity, and session tables required
-- by every later analytics phase (overview dashboard, user management,
-- viewing/search/provider analytics, retention, cohorts).
--
-- DESIGN PRINCIPLES (per docs/mavero-user-management-analytics-plan.md):
--   * Central event model: every meaningful Mavero product interaction
--     lands in ONE table (analytics_events) with a stable taxonomy.
--   * Identity: anonymous_id (stable random per browser) + user_id (FK
--     to auth.users, nullable for guests). The two coexist so a single
--     event stream can describe both guest and authenticated behavior.
--   * Sessions: a lightweight analytics_sessions table (separate from
--     the auth-only device_sessions registry) so guests and authenticated
--     users share one consistent session concept for analytics.
--   * Idempotency: event_id is the client/server-supplied UUID primary
--     key. Retries with the same event_id are deduplicated by the
--     INSERT ... ON CONFLICT DO NOTHING pattern. This prevents network
--     retries from inflating watch_start / login / search counts.
--   * Admin-only reads: analytics data is operational intelligence, not
--     user-facing. RLS allows admin SELECT only; writes are performed by
--     the service-role admin client (bypasses RLS) in the new
--     /api/events ingest endpoint and the server-side recordEvent helper.
--   * No raw IP storage: ip_hash is a SHA-256 hex digest used only for
--     coarse abuse/rate-limit correlation; raw IP is never persisted.
--
-- The migration is idempotent (every create uses IF NOT EXISTS, every
-- policy uses DROP IF EXISTS first) per the repo's migration conventions.

-- ============================================================
-- 1. analytics_sessions
-- ============================================================
-- A "session" here is an analytics session, NOT a Supabase auth session
-- and NOT a device_sessions registry row. It is the product-analytics
-- concept of "one continuous usage period" (default 30-minute idle
-- timeout, enforced client-side by the dispatcher). Guests and
-- authenticated users share the same table; the difference is whether
-- user_id is populated.
--
-- The session_id is a stable text value (e.g. "sess_<uuid>") generated
-- client-side, persisted in localStorage, and re-used across reloads
-- within the idle window. The server upserts a row per session_id and
-- updates last_activity_at on each event.

create table if not exists public.analytics_sessions (
  session_id text primary key,
  anonymous_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz,
  device_type text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Active sessions by user (for DAU/WAU/MAU and "current users" queries).
create index if not exists analytics_sessions_user_active_idx
  on public.analytics_sessions (user_id, last_activity_at)
  where ended_at is null;

-- Active sessions by anonymous_id (for guest reach / guest active queries).
create index if not exists analytics_sessions_anon_active_idx
  on public.analytics_sessions (anonymous_id, last_activity_at)
  where ended_at is null;

-- Recent-session lookup for retention/cohort windowing.
create index if not exists analytics_sessions_started_at_idx
  on public.analytics_sessions (started_at);

-- ============================================================
-- 2. analytics_events
-- ============================================================
-- The canonical raw-event table. Every meaningful Mavero interaction
-- is one row. Later phases will add aggregate tables (analytics_daily,
-- analytics_content_daily, etc.) that are populated by scheduled jobs
-- reading from this raw table.
--
-- Identity contract:
--   * anonymous_id is ALWAYS set (every event comes from a browser we
--     have issued a guest cookie to). Even authenticated users retain
--     their anonymous_id so we can stitch pre-signup activity to
--     post-signup activity when safe.
--   * user_id is set ONLY for authenticated requests. The server
--     populates it from locals.user.id (server-resolved) — NEVER from
--     client input. The CHECK constraint enforces "at least one
--     identity" so a malformed event with neither is rejected at the
--     DB layer as well as at the ingestion layer.
--
-- Idempotency contract:
--   * event_id is a UUID generated client-side (for client events) or
--     server-side (for server-authoritative events). It is the PRIMARY
--     KEY. The ingest helper uses .upsert(row, { onConflict: 'event_id',
--     ignoreDuplicates: true }) so a retry with the same event_id is a
--     no-op. Network retries therefore cannot inflate metrics.
--
-- Taxonomy contract:
--   * event_name is constrained to the closed set defined in the plan.
--     Unknown event names are rejected at ingestion AND at the DB layer.
--     Adding a new event requires a migration that extends the CHECK
--     constraint — this is intentional (taxonomy changes are auditable).

create table if not exists public.analytics_events (
  event_id uuid primary key,
  anonymous_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  session_id text,
  event_name text not null,
  event_time timestamptz not null default now(),
  content_id text,
  content_type text check (content_type is null or content_type in ('movie', 'series', 'anime')),
  provider_id uuid,
  source_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  ip_hash text,
  user_agent text,
  ingested_at timestamptz not null default now(),
  -- At least one identity must be present. In practice anonymous_id is
  -- always set by the ingest layer (the cookie is server-issued), but
  -- this guards against a future code path that forgets it.
  constraint analytics_events_identity_check
    check (anonymous_id is not null or user_id is not null),
  -- Closed taxonomy. Adding an event requires extending this list via
  -- a follow-up migration (intentional friction — taxonomy is auditable).
  constraint analytics_events_event_name_check
    check (event_name in (
      'app_open',
      'session_start',
      'session_end',
      'search',
      'search_result_open',
      'detail_open',
      'watch_start',
      'watch_progress',
      'watch_stop',
      'watch_complete',
      'playback_success',
      'playback_failed',
      'provider_selected',
      'provider_switched',
      'signup_started',
      'signup_completed',
      'login',
      'logout',
      'favorite_added',
      'favorite_removed',
      'mylist_open',
      'continue_watching_open',
      'download_started',
      'download_completed'
    ))
);

-- Idempotency: the primary key on event_id already enforces "one row
-- per event_id". No additional unique index needed.

-- Query-pattern indexes (justified by the analytics query shapes the
-- later phases will run; kept minimal here — Phase 7 audits expansion).
create index if not exists analytics_events_event_time_idx
  on public.analytics_events (event_time);

create index if not exists analytics_events_event_name_time_idx
  on public.analytics_events (event_name, event_time);

create index if not exists analytics_events_user_time_idx
  on public.analytics_events (user_id, event_time)
  where user_id is not null;

create index if not exists analytics_events_anon_time_idx
  on public.analytics_events (anonymous_id, event_time);

create index if not exists analytics_events_session_time_idx
  on public.analytics_events (session_id, event_time)
  where session_id is not null;

create index if not exists analytics_events_content_time_idx
  on public.analytics_events (content_id, event_time)
  where content_id is not null;

create index if not exists analytics_events_provider_time_idx
  on public.analytics_events (provider_id, event_time)
  where provider_id is not null;

-- ============================================================
-- 3. RLS — admin-only reads, NO client writes
-- ============================================================
-- Analytics data is operational intelligence. Ordinary users must NEVER
-- read it (a user must not see another user's activity, search queries,
-- or watch history beyond their own watch_history table). Admins read
-- via the service-role admin client (which bypasses RLS), but the RLS
-- policies below provide defense-in-depth: even if a query accidentally
-- uses the user-scoped client, only admins see anything.
--
-- There are NO INSERT/UPDATE/DELETE policies. All writes go through the
-- service-role admin client in the ingest endpoint / recordEvent helper.

alter table public.analytics_events enable row level security;
alter table public.analytics_sessions enable row level security;

drop policy if exists analytics_events_admin_select on public.analytics_events;
create policy analytics_events_admin_select
  on public.analytics_events for select
  to authenticated
  using ((select public.is_admin()));

drop policy if exists analytics_sessions_admin_select on public.analytics_sessions;
create policy analytics_sessions_admin_select
  on public.analytics_sessions for select
  to authenticated
  using ((select public.is_admin()));

-- Defense in depth: even if a grant is accidentally added later, anon
-- has no access and authenticated can only SELECT (no writes).
revoke all on table public.analytics_events from anon, authenticated;
grant select on table public.analytics_events to authenticated;

revoke all on table public.analytics_sessions from anon, authenticated;
grant select on table public.analytics_sessions to authenticated;

-- ============================================================
-- 4. Comments
-- ============================================================

comment on table public.analytics_events is 'Phase 1 Analytics Foundation — canonical raw event table. Admin-only reads; writes via service-role admin client only. Closed taxonomy enforced by CHECK constraint. Idempotent on event_id.';
comment on table public.analytics_sessions is 'Phase 1 Analytics Foundation — analytics session registry (separate from auth device_sessions). One row per analytics session_id; upserted by the ingest endpoint. Admin-only reads.';
