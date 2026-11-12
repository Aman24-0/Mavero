-- LT-15 — Extend the closed analytics event taxonomy with the Live TV
-- automatic embed-fallback event.
--
-- Follows the documented convention (20261008000000_analytics_foundation.sql:
-- "Adding a new event requires a migration that extends the CHECK constraint
-- — this is intentional (taxonomy changes are auditable)") and the LT-5
-- precedent (20261103000000_live_tv_analytics_events.sql).
--
-- ONE event is added:
--   live_tv_fallback_embed — the automatic embed fallback ACTIVATED: the
--     native Shaka engine genuinely failed (a fatal playback error) and the
--     documented LiveGT V1 embed iframe ({base}/embed/{id}) took over the
--     player surface.
--
-- Emitted exclusively by src/lib/client/live-tv/analytics.ts
-- (trackLiveTvFallbackEmbed), whose payload contract guarantees the ONLY
-- fields ever sent:
--   content_id  — the LiveGT channel id (a safe catalogue identifier)
--   metadata    — { error_kind } — the normalized kind of the native
--                 failure that triggered the fallback (fixed LT-3 table
--                 value; low-cardinality, non-sensitive)
--
-- NEVER sent (enforced by the adapter module and regression-tested):
--   signed MPD URLs, embed/watch URLs, ClearKey key ids/values, DRM
--   configuration, raw LiveGT/Shaka error objects, stack traces, source
--   arrays, query strings, or any user free-text input.
--
-- This is a pure-superset CHECK widening: no tables, no columns, no data
-- migration — every existing row remains valid, and the event is NOT added
-- to the "meaningful activity" list (fallback activation is not a new
-- engagement signal; the channel selection was already counted).

-- ============================================================
-- 1. Extend the closed taxonomy CHECK (full list re-declared)
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
      'live_tv_fullscreen',
      'live_tv_fallback_embed'
    ));
