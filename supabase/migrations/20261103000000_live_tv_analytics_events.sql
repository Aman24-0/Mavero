-- LT-5 — Extend the closed analytics event taxonomy with Live TV events.
--
-- The analytics foundation (20261008000000_analytics_foundation.sql)
-- enforces the event taxonomy with a CHECK constraint on
-- analytics_events.event_name: "Adding a new event requires a migration
-- that extends the CHECK constraint — this is intentional (taxonomy
-- changes are auditable)."
--
-- This migration adds the seven Live TV events approved in
-- live-tv-plan.md §14 and the LT-5 brief §7. They are emitted exclusively
-- by src/lib/client/live-tv/analytics.ts (the Live TV analytics adapter),
-- whose payload contract guarantees that ONLY these fields are ever sent:
--
--   content_id  — the LiveGT channel id (a safe catalogue identifier)
--   metadata    — { reason?, category?, error_kind?, fullscreen_action? }
--                 (low-cardinality, non-sensitive values)
--
-- NEVER sent (enforced by the adapter module and regression-tested by
-- scripts/live_tv_hardening_test.ts):
--   signed MPD URLs, ClearKey key ids/values, DRM configuration, raw
--   LiveGT/Shaka error objects, stack traces, source arrays, query
--   strings, or any user free-text input.
--
-- Event semantics (LT-5 brief §7 — real user actions/states only):
--   live_tv_open            — the /live-tv page was opened (page mount)
--   live_tv_channel_select  — first channel selection / retry selection
--   live_tv_channel_switch  — a different channel selected while one was
--                             already active (the VOD provider_selected /
--                             provider_switched convention)
--   live_tv_play            — a session actually reached playback
--   live_tv_pause           — user paused an active session
--   live_tv_error           — playback failed (normalized error kind only)
--   live_tv_fullscreen      — user entered/exited fullscreen
--
-- No high-frequency telemetry (timeupdate/buffering/seek positions) is
-- part of this taxonomy.

-- ============================================================
-- 1. Extend the closed taxonomy CHECK
-- ============================================================

alter table public.analytics_events
  drop constraint analytics_events_event_name_check;

alter table public.analytics_events
  add constraint analytics_events_event_name_check
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
      'download_completed',
      'live_tv_open',
      'live_tv_channel_select',
      'live_tv_channel_switch',
      'live_tv_play',
      'live_tv_pause',
      'live_tv_error',
      'live_tv_fullscreen'
    ));

-- No data migration is required: the constraint is widened (a pure
-- superset), so every existing row remains valid. No table or column
-- is added — this is a taxonomy extension only (the LT-5 rule: no Live
-- TV Supabase tables for V1; the existing analytics_events table is the
-- documented, approved home for these events).
