-- MAVP-4 Issue 4: rich source ICONS + EXTENSIBLE source BADGES.
--
-- Scope (admin source-editor presentation metadata ONLY — no playback,
-- provider, resolver or progress architecture changes):
--
--   1. streaming_sources.icon — WIDENED value contract. The Task 13 shape
--      (safe lucide key, `^[a-z][a-z0-9-]{0,29}$`) stays byte-valid; the
--      column may now also carry:
--        * data:image/png;base64,…        (uploaded PNG, ≤64KB → ≤100k chars)
--        * data:image/svg+xml;base64,…    (SANITIZED pasted SVG — the server
--          rejects scripts/event handlers/external references BEFORE saving;
--          rendering is <img>-based, so the markup is never injected as HTML)
--        * http(s)://… image URL          (bounded to 500 chars like every
--          other icon URL in the codebase — icon-url.ts contract)
--      Length bounds mirror the application-side validation exactly.
--
--   2. streaming_sources.badge — WIDENED value contract. The Task 13 legacy
--      enum ('ads' | 'ad-free' | NULL) stays byte-valid (all existing rows
--      keep rendering identically); the column may now also carry a CANONICAL
--      JSON ARRAY of badge configurations:
--        [{"id":"4k","label":"4K","variant":"accent"}, …]
--      Application contract (shared/source-presentation.ts): at most 3
--      badges, kebab-case ids ≤32 chars, labels 1–24 chars, variant limited
--      to accent|positive|warning|neutral, serialized JSON ≤1000 chars.
--      Definitions are PER-SOURCE COPIES — the Admin editor harvests
--      previously used definitions for reuse, so creating/renaming/deleting
--      a badge on one source can never corrupt another source's config.
--
-- Additive only: the public mirror (streaming_public_sources.badge/icon)
-- carries the columns VERBATIM with no constraints (added in
-- 20260926150000) and refresh_streaming_public_config() already copies both
-- columns — NO mirror/refresh/RLS change is required. Existing rows are
-- untouched and keep matching their original (narrower) shape.
--
-- Application-side strict validation remains the primary gate
-- (parseSourceForm → badgeValue/iconValue/iconFileValue + the shared
-- presentation contract); these CHECKs are the database-level defense.

-- ============================================================
-- 1. streaming_sources.icon — widen the value contract
-- ============================================================

alter table public.streaming_sources
  drop constraint if exists streaming_sources_icon_check;

alter table public.streaming_sources
  add constraint streaming_sources_icon_check check (
    icon is null
    or icon ~ '^[a-z][a-z0-9-]{0,29}$'
    or (
      icon ~ '^data:image/(png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$'
      and length(icon) <= 100000
    )
    or (
      icon ~ '^https?://'
      and length(icon) <= 500
    )
  );

comment on column public.streaming_sources.icon is
  'Source icon: a safe lucide KEY from the application allowlist (legacy), a base64 data:image/png or SANITIZED data:image/svg+xml data URL (≤100k chars), or an http(s) image URL (≤500 chars). SVG markup is sanitized server-side before storage (scripts/handlers/external refs rejected); rendering is <img>-based. Unknown keys/values fall back to the default icon client-side.';

-- ============================================================
-- 2. streaming_sources.badge — widen the value contract
-- ============================================================

alter table public.streaming_sources
  drop constraint if exists streaming_sources_badge_check;

alter table public.streaming_sources
  add constraint streaming_sources_badge_check check (
    badge is null
    or badge in ('ads', 'ad-free')
    or (
      badge like '[%'
      and length(badge) <= 1000
    )
  );

comment on column public.streaming_sources.badge is
  'User-facing source badges rendered beside the source name in the player selector. Legacy single enum (''ads'' | ''ad-free'') or a canonical JSON array of at most 3 {id,label,variant} configs (id kebab-case ≤32, label 1–24, variant accent|positive|warning|neutral; ≤1000 chars). Definitions are per-source copies; rendering parses strictly and never injects markup.';
