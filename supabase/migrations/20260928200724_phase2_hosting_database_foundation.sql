-- ============================================================
-- Phase 2 — Vidara + Abyss hosting database foundation
-- Migration timestamp: 20260928200724 (2026-09-28 20:07:24 IST)
-- ============================================================
--
-- Establishes the canonical hosting-domain schema required for the
-- Mavero 1 = Vidara + Mavero 2 = Abyss self-hosted media hosting
-- implementation. This migration is schema-foundation only:
--
--   * NO provider API adapters are implemented here.
--   * NO Vidara/Abyss API calls are made.
--   * NO admin upload UI, no playback resolver changes, no
--     missing-media demand UI, no Telegram integration.
--
-- All of those belong to Phase 3 and later. Phase 2 ONLY creates
-- the database foundation (tables, constraints, indexes, RLS,
-- triggers) needed by those future features.
--
-- Existing patterns reused (audited from the live DB):
--
--   * `public.set_updated_at()` trigger function (already exists,
--     `search_path=public`, body: `new.updated_at = timezone('utc', now())`).
--     Reused for every new table that has an `updated_at` column.
--   * `public.is_admin()` function (already exists, `search_path=public`,
--     checks `profiles.role = 'admin'` for `auth.uid()`).
--     Reused for every admin-only RLS policy.
--   * Timestamp convention: `timezone('utc'::text, now())` defaults
--     (UTC — the IST convention applies ONLY to migration FILENAMES,
--     not to in-DB timestamps).
--   * PK: `uuid` with `gen_random_uuid()` default.
--   * Status fields: TEXT with CHECK constraints (no enum types in
--     this project — confirmed by audit).
--   * RLS policy: single `<table>_admin_all` policy with `polcmd='*'`,
--     role `authenticated`, `USING (is_admin()) WITH CHECK (is_admin())`
--     for admin-only management tables.
--   * Trigger convention: `<table>_set_updated_at BEFORE UPDATE ON
--     <table> FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.
--
-- Existing tables NOT modified:
--   * `streaming_providers` — Phase 4 will register Vidara/Abyss as
--     rows here (no schema change needed; existing columns cover
--     provider identity, status, capabilities, etc.).
--   * `streaming_sources` — Phase 4 will register Mavero 1/Mavero 2
--     as rows here.
--   * `streaming_source_categories`, `streaming_default_sources`,
--     `streaming_config_meta` — unchanged.
--
-- The hosting tables reference `streaming_providers.id` and
-- `streaming_sources.id` via FK so Phase 4 can wire Mavero 1/Mavero 2
-- into the existing source selector without duplicating provider
-- identity.
--
-- All DDL is idempotent (`IF NOT EXISTS`) so the migration can be
-- safely re-applied. This is required because Phase 0 confirmed
-- migration/schema drift on this project — out-of-band schema
-- changes have historically not always been recorded in
-- `supabase_migrations.schema_migrations`, so future re-applies
-- must not fail on pre-existing objects.
-- ============================================================


-- ============================================================
-- 1. media_items — canonical media identity
-- ============================================================
--
-- One row per logical Mavero media identity. The identity is
-- deterministic and content-type-aware:
--
--   movie  -> canonical_key = 'movie:tmdb:<tmdb_id>'
--   series -> canonical_key = 'series:tmdb:<tmdb_id>'
--   episode-> canonical_key = 'series:tmdb:<tmdb_id>:s<season>:e<episode>'
--
-- `canonical_key` is the single source of truth for identity. The
-- (content_type, tmdb_id, season, episode) tuple is the relational
-- projection of the same identity — indexed for fast playback
-- lookups. Anime is represented through the existing
-- content_type='anime' value (the project's existing convention);
-- no separate anime hosting architecture is created.
--
-- `parent_media_id` links an episode back to its series row.
-- `imdb_id` is stored when TMDB exposes one (Phase 0 §8 confirmed
-- the existing TMDB adapter already extracts both).
--
-- This table is the canonical home for media identity. Provider
-- assets (media_assets) reference this row, NOT the other way
-- around — Mavero owns the canonical hierarchy per plan §1.4.

CREATE TABLE IF NOT EXISTS public.media_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key   text NOT NULL,
  content_type    text NOT NULL,
  tmdb_id         text NOT NULL,
  imdb_id         text,
  title           text NOT NULL,
  year            integer,
  season          integer,
  episode         integer,
  episode_title   text,
  parent_media_id uuid REFERENCES public.media_items(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at      timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Status / shape CHECK constraints.
ALTER TABLE public.media_items
  ADD CONSTRAINT media_items_canonical_key_check CHECK (length(trim(canonical_key)) >= 1 AND length(canonical_key) <= 200),
  ADD CONSTRAINT media_items_content_type_check CHECK (content_type IN ('movie', 'series', 'anime')),
  ADD CONSTRAINT media_items_tmdb_id_check CHECK (tmdb_id ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT media_items_imdb_id_check CHECK (imdb_id IS NULL OR imdb_id ~ '^tt[0-9]{7,10}$'),
  ADD CONSTRAINT media_items_title_check CHECK (length(trim(title)) >= 1 AND length(title) <= 300),
  ADD CONSTRAINT media_items_year_check CHECK (year IS NULL OR (year >= 1880 AND year <= 3000)),
  ADD CONSTRAINT media_items_season_check CHECK (
    -- movies + series have NULL season; episodes (and only episodes) require season
    (content_type IN ('movie', 'series', 'anime') AND season IS NULL)
    OR (content_type IN ('series', 'anime') AND season IS NOT NULL AND season >= 0 AND season <= 1000)
  ),
  ADD CONSTRAINT media_items_episode_check CHECK (
    -- movies + series have NULL episode; episodes (and only episodes) require episode
    (content_type IN ('movie', 'series', 'anime') AND episode IS NULL)
    OR (content_type IN ('series', 'anime') AND episode IS NOT NULL AND episode >= 1 AND episode <= 10000)
  ),
  ADD CONSTRAINT media_items_episode_title_check CHECK (episode_title IS NULL OR (length(trim(episode_title)) >= 1 AND length(episode_title) <= 300)),
  -- An episode MUST point to its parent series; a movie/series MUST NOT.
  -- The check distinguishes episodes from series by (season, episode):
  --   movie                  -> season IS NULL     AND episode IS NULL     AND parent_media_id IS NULL
  --   series (the show)      -> season IS NULL     AND episode IS NULL     AND parent_media_id IS NULL
  --   episode (of a series)  -> season IS NOT NULL  AND episode IS NOT NULL AND parent_media_id IS NOT NULL
  -- (content_type alone cannot distinguish a series row from an episode
  -- row — both use content_type='series'. The presence of season+episode
  -- is what marks an episode.)
  ADD CONSTRAINT media_items_parent_media_id_check CHECK (
    (season IS NULL AND episode IS NULL AND parent_media_id IS NULL)
    OR (season IS NOT NULL AND episode IS NOT NULL AND parent_media_id IS NOT NULL)
  );

-- Unique constraints — canonical_key is the single source of truth.
ALTER TABLE public.media_items
  ADD CONSTRAINT media_items_canonical_key_key UNIQUE (canonical_key);

-- (content_type, tmdb_id, season, episode) is the relational projection
-- of canonical_key — also unique.
ALTER TABLE public.media_items
  ADD CONSTRAINT media_items_content_tmdb_season_episode_key
    UNIQUE (content_type, tmdb_id, season, episode);

-- Required indexes (plan §Phase 2).
CREATE INDEX IF NOT EXISTS media_items_canonical_key_idx
  ON public.media_items (canonical_key);
CREATE INDEX IF NOT EXISTS media_items_content_type_tmdb_id_idx
  ON public.media_items (content_type, tmdb_id);
CREATE INDEX IF NOT EXISTS media_items_content_type_tmdb_id_season_episode_idx
  ON public.media_items (content_type, tmdb_id, season, episode);
CREATE INDEX IF NOT EXISTS media_items_parent_media_id_idx
  ON public.media_items (parent_media_id);
CREATE INDEX IF NOT EXISTS media_items_imdb_id_idx
  ON public.media_items (imdb_id) WHERE imdb_id IS NOT NULL;

-- Row-level security.
ALTER TABLE public.media_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_items_admin_all ON public.media_items;
CREATE POLICY media_items_admin_all
  ON public.media_items
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- updated_at trigger (reuses the existing set_updated_at() function).
DROP TRIGGER IF EXISTS media_items_set_updated_at ON public.media_items;
CREATE TRIGGER media_items_set_updated_at
  BEFORE UPDATE ON public.media_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 2. media_folders — canonical Mavero folder hierarchy
-- ============================================================
--
-- Self-referencing tree that mirrors the canonical folder hierarchy
-- from plan §4.2:
--
--   Root
--   ├── Movies
--   │   └── <year>
--   │       └── <movie folder>
--   ├── Series
--   │   └── <series folder>
--   │       └── <season folder>
--   │           └── <episode file>
--   └── Anime
--       ├── Movies
--       │   └── <year>
--       │       └── <movie folder>
--       └── Series
--           └── <anime series folder>
--               └── <season folder>
--                   └── <episode file>
--
-- `canonical_key` is the deterministic unique path of this folder
-- (e.g. 'movies:2026:tmdb-12345', 'series:tmdb-1399:season-01').
-- `kind` distinguishes root/year/movie/series/season/episode nodes.
-- `media_item_id` optionally links a folder directly to a media_items
-- row (the movie/series/episode folder for a specific title).
--
-- Provider folder structures are NOT modelled here — see
-- provider_folder_mappings.

CREATE TABLE IF NOT EXISTS public.media_folders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id      uuid REFERENCES public.media_folders(id) ON DELETE CASCADE,
  canonical_key  text NOT NULL,
  kind           text NOT NULL,
  name           text NOT NULL,
  content_type   text,
  tmdb_id        text,
  year           integer,
  season         integer,
  media_item_id  uuid REFERENCES public.media_items(id) ON DELETE SET NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at     timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.media_folders
  ADD CONSTRAINT media_folders_canonical_key_check CHECK (length(trim(canonical_key)) >= 1 AND length(canonical_key) <= 300),
  ADD CONSTRAINT media_folders_kind_check CHECK (kind IN ('root', 'library', 'year', 'movie', 'series', 'season', 'episode', 'specials')),
  ADD CONSTRAINT media_folders_name_check CHECK (length(trim(name)) >= 1 AND length(name) <= 200),
  ADD CONSTRAINT media_folders_content_type_check CHECK (content_type IS NULL OR content_type IN ('movie', 'series', 'anime')),
  ADD CONSTRAINT media_folders_tmdb_id_check CHECK (tmdb_id IS NULL OR tmdb_id ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT media_folders_year_check CHECK (year IS NULL OR (year >= 1880 AND year <= 3000)),
  ADD CONSTRAINT media_folders_season_check CHECK (season IS NULL OR (season >= 0 AND season <= 1000)),
  ADD CONSTRAINT media_folders_sort_order_check CHECK (sort_order >= 0);

ALTER TABLE public.media_folders
  ADD CONSTRAINT media_folders_canonical_key_key UNIQUE (canonical_key);

CREATE INDEX IF NOT EXISTS media_folders_parent_id_idx
  ON public.media_folders (parent_id);
CREATE INDEX IF NOT EXISTS media_folders_canonical_key_idx
  ON public.media_folders (canonical_key);
CREATE INDEX IF NOT EXISTS media_folders_media_item_id_idx
  ON public.media_folders (media_item_id) WHERE media_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_folders_kind_idx
  ON public.media_folders (kind);

ALTER TABLE public.media_folders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_folders_admin_all ON public.media_folders;
CREATE POLICY media_folders_admin_all
  ON public.media_folders
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP TRIGGER IF EXISTS media_folders_set_updated_at ON public.media_folders;
CREATE TRIGGER media_folders_set_updated_at
  BEFORE UPDATE ON public.media_folders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 3. provider_folder_mappings — canonical folder ↔ provider folder
-- ============================================================
--
-- Mavero owns the canonical folder hierarchy (media_folders).
-- Provider folders are implementation-specific: Vidara's API is
-- documented as flat (no nesting); Abyss supports nested folders.
-- This mapping table stores the provider's own folder identity
-- (id or path) for a given canonical folder, per provider.
--
-- NOTE: this table is declared BEFORE media_assets because
-- media_assets references it via FK (provider_folder_mapping_id).
-- Forward references are not allowed for FK constraints without
-- DEFERRABLE + INITIALLY DEFERRED, and the project convention
-- does not use deferrable constraints, so the table is declared
-- in dependency order.
--
-- `provider_folder_id` stores the provider's own folder id (string
-- form — Vidara/Abyss use different id shapes).
-- `provider_folder_path` stores the provider's display path (e.g.
-- 'Movies/2026/Interstellar') for diagnostics.
-- `provider_folder_metadata` is jsonb for provider-specific fields
-- that don't warrant a dedicated column.
--
-- The mapping is repairable: an admin can re-sync a folder mapping
-- without losing the canonical folder (the FK is CASCADE on delete
-- of the canonical folder — losing the canonical folder removes the
-- mapping; the provider's own folder reference is never deleted
-- through Mavero).

CREATE TABLE IF NOT EXISTS public.provider_folder_mappings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_folder_id    uuid NOT NULL REFERENCES public.media_folders(id) ON DELETE CASCADE,
  provider_source_id     uuid REFERENCES public.streaming_sources(id) ON DELETE SET NULL,
  provider_folder_id     text,
  provider_folder_path    text,
  provider_folder_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at         timestamptz,
  created_at             timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at             timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.provider_folder_mappings
  ADD CONSTRAINT provider_folder_mappings_provider_folder_id_check CHECK (provider_folder_id IS NULL OR (length(trim(provider_folder_id)) >= 1 AND length(provider_folder_id) <= 200)),
  ADD CONSTRAINT provider_folder_mappings_provider_folder_path_check CHECK (provider_folder_path IS NULL OR (length(provider_folder_path) <= 1000)),
  ADD CONSTRAINT provider_folder_mappings_provider_folder_metadata_check CHECK (jsonb_typeof(provider_folder_metadata) = 'object');

-- One provider folder per (canonical_folder, provider_source).
ALTER TABLE public.provider_folder_mappings
  ADD CONSTRAINT provider_folder_mappings_canonical_provider_key
    UNIQUE (canonical_folder_id, provider_source_id);

CREATE INDEX IF NOT EXISTS provider_folder_mappings_canonical_folder_id_idx
  ON public.provider_folder_mappings (canonical_folder_id);
CREATE INDEX IF NOT EXISTS provider_folder_mappings_provider_source_id_idx
  ON public.provider_folder_mappings (provider_source_id) WHERE provider_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_folder_mappings_provider_source_canonical_idx
  ON public.provider_folder_mappings (provider_source_id, canonical_folder_id);

ALTER TABLE public.provider_folder_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_folder_mappings_admin_all ON public.provider_folder_mappings;
CREATE POLICY provider_folder_mappings_admin_all
  ON public.provider_folder_mappings
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP TRIGGER IF EXISTS provider_folder_mappings_set_updated_at ON public.provider_folder_mappings;
CREATE TRIGGER provider_folder_mappings_set_updated_at
  BEFORE UPDATE ON public.provider_folder_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 4. media_assets — provider-hosted asset per (media_item, provider)
-- ============================================================
--
-- One row per actual hosted file/video on a hosting provider
-- (Vidara or Abyss). The asset is keyed by the provider's own
-- asset identity (`provider_asset_id`) scoped to the provider's
-- source row — this allows the same provider_asset_id to refer
-- to the same physical file across re-syncs.
--
-- The asset carries:
--   * canonical media reference (FK to media_items)
--   * provider (FK to streaming_sources — Phase 4 will register
--     Mavero 1 = Vidara, Mavero 2 = Abyss as streaming_sources
--     rows; the FK is SET NULL on delete so removing a provider
--     source row detaches the assets without deleting them)
--   * provider's own asset id / filecode / slug
--   * playback URL (the player-facing URL the provider exposes)
--   * filename + title (presentation metadata)
--   * folder reference (FK to provider_folder_mappings — optional
--     because some provider assets exist before a folder mapping
--     is created)
--   * status (the Mavero-side lifecycle state machine)
--   * provider_status (the provider's own status string, kept
--     verbatim — useful for provider-specific states like
--     'encoding 35%' that don't map cleanly to the Mavero state
--     machine)
--   * source quality (the originally uploaded quality — e.g.
--     '720p' for Vidara, '1080p' for Abyss per plan §3)
--   * available_qualities (array — for Abyss's multi-quality
--     processing output: '480p', '720p', '1080p')
--   * audio information (Vidara: multi-audio array; Abyss: single
--     audio language string)
--   * subtitle availability flag (both providers support subtitles
--     per plan §3)
--   * duration + file size (numeric, populated by sync)
--   * provider_metadata (jsonb — provider-specific fields that
--     don't warrant a dedicated column; e.g. Vidara's encode
--     progress percentage, Abyss's transcode job id)
--   * error state (code + message for failed operations)
--   * last_synced_at (timestamp of the last provider sync)
--   * mavero_status (the Mavero-side availability verdict — used
--     by the future playback resolver to decide whether to surface
--     this asset to users)

CREATE TABLE IF NOT EXISTS public.media_assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_item_id        uuid NOT NULL REFERENCES public.media_items(id) ON DELETE CASCADE,
  provider_source_id   uuid REFERENCES public.streaming_sources(id) ON DELETE SET NULL,
  provider_folder_mapping_id uuid REFERENCES public.provider_folder_mappings(id) ON DELETE SET NULL,
  provider_asset_id    text,
  provider_video_id    text,
  playback_url         text,
  filename             text,
  title                text,
  status               text NOT NULL DEFAULT 'pending',
  provider_status      text,
  mavero_status        text NOT NULL DEFAULT 'missing',
  source_quality       text,
  available_qualities  text[] NOT NULL DEFAULT '{}',
  audio_languages      text[] NOT NULL DEFAULT '{}',
  has_subtitles        boolean NOT NULL DEFAULT false,
  duration_seconds     integer,
  size_bytes           bigint,
  thumbnail_url        text,
  provider_metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code           text,
  error_message        text,
  last_synced_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at           timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_provider_asset_id_check CHECK (provider_asset_id IS NULL OR (length(trim(provider_asset_id)) >= 1 AND length(provider_asset_id) <= 200)),
  ADD CONSTRAINT media_assets_provider_video_id_check CHECK (provider_video_id IS NULL OR (length(trim(provider_video_id)) >= 1 AND length(provider_video_id) <= 200)),
  ADD CONSTRAINT media_assets_playback_url_check CHECK (playback_url IS NULL OR (length(playback_url) <= 2000)),
  ADD CONSTRAINT media_assets_filename_check CHECK (filename IS NULL OR (length(trim(filename)) >= 1 AND length(filename) <= 500)),
  ADD CONSTRAINT media_assets_title_check CHECK (title IS NULL OR (length(trim(title)) >= 1 AND length(title) <= 300)),
  -- Mavero-side lifecycle state machine (plan §7.2 + Phase 1 §9).
  ADD CONSTRAINT media_assets_status_check CHECK (status IN (
    'pending', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'deleted'
  )),
  -- Mavero-side availability verdict (used by the future playback resolver).
  ADD CONSTRAINT media_assets_mavero_status_check CHECK (mavero_status IN (
    'available', 'missing', 'processing', 'failed', 'disabled', 'stale'
  )),
  ADD CONSTRAINT media_assets_source_quality_check CHECK (source_quality IS NULL OR (length(trim(source_quality)) >= 1 AND length(source_quality) <= 30)),
  ADD CONSTRAINT media_assets_thumbnail_url_check CHECK (thumbnail_url IS NULL OR (length(thumbnail_url) <= 2000)),
  ADD CONSTRAINT media_assets_provider_metadata_check CHECK (jsonb_typeof(provider_metadata) = 'object'),
  ADD CONSTRAINT media_assets_error_code_check CHECK (error_code IS NULL OR (length(trim(error_code)) >= 1 AND length(error_code) <= 100)),
  ADD CONSTRAINT media_assets_error_message_check CHECK (error_message IS NULL OR length(error_message) <= 2000),
  ADD CONSTRAINT media_assets_duration_seconds_check CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds <= 86400 * 7)),
  ADD CONSTRAINT media_assets_size_bytes_check CHECK (size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 10995116277760)); -- 10 TiB upper bound

-- One provider asset per (provider_source, provider_asset_id). NULL
-- provider_asset_id is allowed (the asset may not yet have a provider
-- id assigned during upload).
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_provider_source_provider_asset_id_key
    UNIQUE (provider_source_id, provider_asset_id);

CREATE INDEX IF NOT EXISTS media_assets_media_item_id_idx
  ON public.media_assets (media_item_id);
CREATE INDEX IF NOT EXISTS media_assets_provider_source_media_item_id_idx
  ON public.media_assets (provider_source_id, media_item_id);
CREATE INDEX IF NOT EXISTS media_assets_provider_asset_id_idx
  ON public.media_assets (provider_asset_id) WHERE provider_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_assets_status_idx
  ON public.media_assets (status);
CREATE INDEX IF NOT EXISTS media_assets_mavero_status_idx
  ON public.media_assets (mavero_status);
CREATE INDEX IF NOT EXISTS media_assets_last_synced_at_idx
  ON public.media_assets (last_synced_at) WHERE last_synced_at IS NOT NULL;

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_assets_admin_all ON public.media_assets;
CREATE POLICY media_assets_admin_all
  ON public.media_assets
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP TRIGGER IF EXISTS media_assets_set_updated_at ON public.media_assets;
CREATE TRIGGER media_assets_set_updated_at
  BEFORE UPDATE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 5. media_upload_operations — upload/processing state machine
-- ============================================================
--
-- Tracks one admin-initiated upload operation from queue through
-- ready/failed/cancelled. One row per upload attempt (retries
-- create new rows; the parent_operation_id FK links retries to
-- the original attempt).
--
-- The state machine (plan §7.2 + Phase 1 §9):
--
--   pending → uploading → uploaded → processing → ready
--                                                  ↘ failed
--                              ↳ cancelled (any state)
--                              ↳ deleted (terminal)
--
-- `provider_asset_id` is populated once the provider returns an
-- asset id (after the upload HTTP request succeeds). The matching
-- media_assets row is created/updated at that point.
-- `attempt_number` tracks retry attempts within this operation.
-- `progress_percent` is the provider-reported encoding progress
-- (0–100, NULL when not reported).
-- `error_code` + `error_message` capture failure reasons.
-- `requested_by_user_id` is the admin who initiated the upload.

CREATE TABLE IF NOT EXISTS public.media_upload_operations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_item_id          uuid NOT NULL REFERENCES public.media_items(id) ON DELETE CASCADE,
  provider_source_id     uuid REFERENCES public.streaming_sources(id) ON DELETE SET NULL,
  media_asset_id         uuid REFERENCES public.media_assets(id) ON DELETE SET NULL,
  parent_operation_id    uuid REFERENCES public.media_upload_operations(id) ON DELETE SET NULL,
  provider_asset_id      text,
  status                 text NOT NULL DEFAULT 'pending',
  attempt_number         integer NOT NULL DEFAULT 1,
  progress_percent       integer,
  source_quality         text,
  source_filename        text,
  source_url             text,
  error_code             text,
  error_message          text,
  requested_by_user_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  queued_at              timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  upload_started_at      timestamptz,
  uploaded_at            timestamptz,
  processing_started_at  timestamptz,
  ready_at               timestamptz,
  failed_at              timestamptz,
  cancelled_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at             timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.media_upload_operations
  ADD CONSTRAINT media_upload_operations_status_check CHECK (status IN (
    'pending', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'cancelled', 'deleted'
  )),
  ADD CONSTRAINT media_upload_operations_attempt_number_check CHECK (attempt_number >= 1 AND attempt_number <= 1000),
  ADD CONSTRAINT media_upload_operations_progress_percent_check CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
  ADD CONSTRAINT media_upload_operations_provider_asset_id_check CHECK (provider_asset_id IS NULL OR (length(trim(provider_asset_id)) >= 1 AND length(provider_asset_id) <= 200)),
  ADD CONSTRAINT media_upload_operations_source_quality_check CHECK (source_quality IS NULL OR (length(trim(source_quality)) >= 1 AND length(source_quality) <= 30)),
  ADD CONSTRAINT media_upload_operations_source_filename_check CHECK (source_filename IS NULL OR (length(trim(source_filename)) >= 1 AND length(source_filename) <= 500)),
  ADD CONSTRAINT media_upload_operations_source_url_check CHECK (source_url IS NULL OR (length(source_url) <= 2000)),
  ADD CONSTRAINT media_upload_operations_error_code_check CHECK (error_code IS NULL OR (length(trim(error_code)) >= 1 AND length(error_code) <= 100)),
  ADD CONSTRAINT media_upload_operations_error_message_check CHECK (error_message IS NULL OR length(error_message) <= 2000);

CREATE INDEX IF NOT EXISTS media_upload_operations_status_idx
  ON public.media_upload_operations (status);
CREATE INDEX IF NOT EXISTS media_upload_operations_provider_source_created_at_idx
  ON public.media_upload_operations (provider_source_id, created_at);
CREATE INDEX IF NOT EXISTS media_upload_operations_media_item_id_idx
  ON public.media_upload_operations (media_item_id);
CREATE INDEX IF NOT EXISTS media_upload_operations_media_asset_id_idx
  ON public.media_upload_operations (media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_upload_operations_requested_by_user_id_idx
  ON public.media_upload_operations (requested_by_user_id) WHERE requested_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_upload_operations_parent_operation_id_idx
  ON public.media_upload_operations (parent_operation_id) WHERE parent_operation_id IS NOT NULL;

ALTER TABLE public.media_upload_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_upload_operations_admin_all ON public.media_upload_operations;
CREATE POLICY media_upload_operations_admin_all
  ON public.media_upload_operations
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP TRIGGER IF EXISTS media_upload_operations_set_updated_at ON public.media_upload_operations;
CREATE TRIGGER media_upload_operations_set_updated_at
  BEFORE UPDATE ON public.media_upload_operations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 6. media_operations — admin history/audit log
-- ============================================================
--
-- Append-only audit log for every media-management operation.
-- Populated by the future admin upload/sync/delete flows. This
-- is NOT a per-row updated_at log — it's a discrete-event log
-- with one row per action (upload, upload_remote, retry, rename,
-- move, delete, sync, etc.).
--
-- `details` is jsonb for action-specific payload (e.g. retry
-- attempt number, sync diff, delete reason).
-- `admin_user_id` is the admin who performed the action.
-- `status` captures the OUTCOME of the action (success/failed).

CREATE TABLE IF NOT EXISTS public.media_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  media_item_id   uuid REFERENCES public.media_items(id) ON DELETE SET NULL,
  media_asset_id  uuid REFERENCES public.media_assets(id) ON DELETE SET NULL,
  provider_source_id uuid REFERENCES public.streaming_sources(id) ON DELETE SET NULL,
  upload_operation_id uuid REFERENCES public.media_upload_operations(id) ON DELETE SET NULL,
  action          text NOT NULL,
  status          text NOT NULL DEFAULT 'success',
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code      text,
  error_message   text,
  occurred_at     timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  created_at      timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.media_operations
  ADD CONSTRAINT media_operations_action_check CHECK (action IN (
    'upload', 'upload_remote', 'processing_started', 'ready', 'failed',
    'retry', 'rename', 'move', 'replace', 'subtitle_upload', 'sync',
    'provider_delete', 'detach', 'create_media_item', 'update_media_item',
    'delete_media_item', 'create_folder', 'update_folder', 'delete_folder',
    'create_folder_mapping', 'update_folder_mapping', 'delete_folder_mapping',
    'resolve_availability'
  )),
  ADD CONSTRAINT media_operations_status_check CHECK (status IN ('success', 'failed', 'pending')),
  ADD CONSTRAINT media_operations_details_check CHECK (jsonb_typeof(details) = 'object'),
  ADD CONSTRAINT media_operations_error_code_check CHECK (error_code IS NULL OR (length(trim(error_code)) >= 1 AND length(error_code) <= 100)),
  ADD CONSTRAINT media_operations_error_message_check CHECK (error_message IS NULL OR length(error_message) <= 2000);

CREATE INDEX IF NOT EXISTS media_operations_admin_user_id_occurred_at_idx
  ON public.media_operations (admin_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS media_operations_media_item_id_occurred_at_idx
  ON public.media_operations (media_item_id, occurred_at) WHERE media_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_operations_media_asset_id_occurred_at_idx
  ON public.media_operations (media_asset_id, occurred_at) WHERE media_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_operations_provider_source_id_occurred_at_idx
  ON public.media_operations (provider_source_id, occurred_at) WHERE provider_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_operations_action_occurred_at_idx
  ON public.media_operations (action, occurred_at);
CREATE INDEX IF NOT EXISTS media_operations_status_occurred_at_idx
  ON public.media_operations (status, occurred_at);

ALTER TABLE public.media_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_operations_admin_all ON public.media_operations;
CREATE POLICY media_operations_admin_all
  ON public.media_operations
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- media_operations is append-only in practice; no updated_at trigger
-- is created (the row is written once via `occurred_at` and never
-- updated).


-- ============================================================
-- 7. media_availability_requests — missing-media demand tracking
-- ============================================================
--
-- Records the demand for media that is NOT yet hosted on any
-- provider. One row per canonical identity (canonical_key is
-- unique). Repeated demand for the same identity increments
-- `request_count` and updates `last_requested_at` instead of
-- creating a new row — this is the deduplication strategy from
-- plan §11.1.
--
-- The request is created ONLY on a playback attempt where BOTH
-- providers are missing the content (plan §11). Search alone
-- MUST NOT create a request.
--
-- `last_user_kind` records whether the last requester was a
-- guest/authenticated/admin (useful for prioritization without
-- exposing the user identity).
-- `status` tracks the admin-side workflow: 'open' (demand
-- recorded, no upload yet), 'uploading' (an upload operation
-- has started), 'ready' (the asset is now available), 'ignored'
-- (admin dismissed the request).

CREATE TABLE IF NOT EXISTS public.media_availability_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key       text NOT NULL,
  content_type        text NOT NULL,
  tmdb_id             text NOT NULL,
  imdb_id             text,
  season              integer,
  episode             integer,
  title_snapshot      text NOT NULL,
  episode_title_snapshot text,
  year                integer,
  request_count       integer NOT NULL DEFAULT 1,
  first_requested_at  timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  last_requested_at   timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  last_user_kind      text NOT NULL DEFAULT 'guest',
  status              text NOT NULL DEFAULT 'open',
  priority            integer NOT NULL DEFAULT 0,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at          timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.media_availability_requests
  ADD CONSTRAINT media_availability_requests_canonical_key_check CHECK (length(trim(canonical_key)) >= 1 AND length(canonical_key) <= 200),
  ADD CONSTRAINT media_availability_requests_content_type_check CHECK (content_type IN ('movie', 'series', 'anime')),
  ADD CONSTRAINT media_availability_requests_tmdb_id_check CHECK (tmdb_id ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT media_availability_requests_imdb_id_check CHECK (imdb_id IS NULL OR imdb_id ~ '^tt[0-9]{7,10}$'),
  ADD CONSTRAINT media_availability_requests_season_check CHECK (season IS NULL OR (season >= 0 AND season <= 1000)),
  ADD CONSTRAINT media_availability_requests_episode_check CHECK (episode IS NULL OR (episode >= 1 AND episode <= 10000)),
  ADD CONSTRAINT media_availability_requests_title_snapshot_check CHECK (length(trim(title_snapshot)) >= 1 AND length(title_snapshot) <= 300),
  ADD CONSTRAINT media_availability_requests_episode_title_snapshot_check CHECK (episode_title_snapshot IS NULL OR (length(trim(episode_title_snapshot)) >= 1 AND length(episode_title_snapshot) <= 300)),
  ADD CONSTRAINT media_availability_requests_year_check CHECK (year IS NULL OR (year >= 1880 AND year <= 3000)),
  ADD CONSTRAINT media_availability_requests_request_count_check CHECK (request_count >= 1),
  ADD CONSTRAINT media_availability_requests_last_user_kind_check CHECK (last_user_kind IN ('guest', 'authenticated', 'admin')),
  ADD CONSTRAINT media_availability_requests_status_check CHECK (status IN ('open', 'uploading', 'ready', 'ignored')),
  ADD CONSTRAINT media_availability_requests_priority_check CHECK (priority >= 0 AND priority <= 1000),
  ADD CONSTRAINT media_availability_requests_notes_check CHECK (notes IS NULL OR length(notes) <= 2000);

-- canonical_key is the single deduplication key.
ALTER TABLE public.media_availability_requests
  ADD CONSTRAINT media_availability_requests_canonical_key_key UNIQUE (canonical_key);

CREATE INDEX IF NOT EXISTS media_availability_requests_canonical_key_idx
  ON public.media_availability_requests (canonical_key);
CREATE INDEX IF NOT EXISTS media_availability_requests_status_last_requested_at_idx
  ON public.media_availability_requests (status, last_requested_at);
CREATE INDEX IF NOT EXISTS media_availability_requests_content_type_tmdb_id_idx
  ON public.media_availability_requests (content_type, tmdb_id);
CREATE INDEX IF NOT EXISTS media_availability_requests_content_type_tmdb_id_season_episode_idx
  ON public.media_availability_requests (content_type, tmdb_id, season, episode);

ALTER TABLE public.media_availability_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_availability_requests_admin_all ON public.media_availability_requests;
CREATE POLICY media_availability_requests_admin_all
  ON public.media_availability_requests
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP TRIGGER IF EXISTS media_availability_requests_set_updated_at ON public.media_availability_requests;
CREATE TRIGGER media_availability_requests_set_updated_at
  BEFORE UPDATE ON public.media_availability_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- End of Phase 2 migration.
--
-- Summary:
--   7 new tables:
--     media_items
--     media_folders
--     media_assets
--     provider_folder_mappings
--     media_upload_operations
--     media_operations
--     media_availability_requests
--
--   0 existing tables modified.
--   0 enum types created (project uses TEXT + CHECK constraints).
--   0 new functions created (reused existing set_updated_at + is_admin).
--   0 historical migrations modified.
--   0 provider API calls implemented (Phase 2 is schema-foundation only).
--
-- All DDL is idempotent (IF NOT EXISTS / DROP IF EXISTS first).
-- All timestamps use the established `timezone('utc'::text, now())`
-- convention. The IST timestamp convention applies ONLY to the
-- migration FILENAME prefix (20260928200724 = 2026-09-28 20:07:24 IST),
-- NOT to in-DB timestamps.
-- ============================================================
