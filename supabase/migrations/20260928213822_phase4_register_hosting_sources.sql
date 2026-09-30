-- ============================================================
-- Phase 4 — Register Vidara + Abyss providers and Mavero 1/2 sources
-- Migration timestamp: 20260928213822 (2026-09-28 21:38:22 IST)
-- ============================================================
--
-- Registers the two hosting providers (Vidara, Abyss) and their
-- corresponding Mavero sources (Mavero 1, Mavero 2) in the existing
-- streaming_providers / streaming_sources / streaming_source_categories
-- registry. This makes them first-class registered Mavero sources
-- discoverable by the existing source-selection architecture.
--
-- NO secrets are stored in the database. API keys, passwords, and JWTs
-- remain in server-side environment configuration (VIDARA_API_KEY,
-- ABYSS_EMAIL, ABYSS_PASSWORD).
--
-- Idempotency:
--   This migration uses INSERT ... ON CONFLICT DO NOTHING so it is
--   safe to re-apply. Provider rows use stable slug keys for the
--   ON CONFLICT clause. Source rows use (provider_id, slug) composite
--   for the ON CONFLICT clause.
--
-- Backward compatibility:
--   0 existing rows are modified. Only new rows are inserted.
--   The 10 existing providers, 11 existing sources, 2 existing
--   categories, and 11 existing source-category mappings are
--   untouched.
--
-- Source semantics (user task brief §6):
--   The providers return PLAYER/EMBED URLs (not raw media streams).
--   integration_type = 'custom' — the source is backed by a custom
--   server-side adapter (HostingProviderAdapter from Phase 3), NOT a
--   template URL with placeholder substitution. The adapter_id field
--   on the provider row links the provider to the hosting adapter
--   key ('vidara', 'abyss').
--
--   The capabilities JSON includes only PUBLIC, non-secret metadata
--   required by the existing architecture:
--     - movie/series/anime support flags
--     - result_type = 'embed' (player/embed URL, NOT raw direct)
--     - sandbox_policy (unrestricted — the player URL is loaded in an
--       iframe, same as existing embed sources)
--     - supports_direct = false (these are NOT raw direct streams)
--     - allowed_embed_origins (the provider's player URL origin)
--     - allow_experimental_playback = true
--     - hosting_provider = 'vidara'/'abyss' (links to the Phase 3 adapter)
-- ============================================================


-- ============================================================
-- 1. Register Vidara provider
-- ============================================================

INSERT INTO public.streaming_providers (
  name, slug, description, icon, status, enabled,
  integration_type, adapter_id, capabilities, notes
)
VALUES (
  'Vidara',
  'vidara',
  'Self-hosted media provider (Mavero 1). Multi-audio, single uploaded quality (720p target), embedded/external subtitles.',
  null,
  'experimental',
  true,
  'custom',
  'vidara',
  jsonb_build_object(
    'movie', true,
    'series', true,
    'anime', false,
    'result_type', 'embed',
    'sandbox_policy', 'unrestricted',
    'supports_direct', false,
    'supports_episode', true,
    'supports_download', false,
    'supports_subtitles', true,
    'allowed_embed_origins', jsonb_build_array('https://vidara.so'),
    'allow_experimental_playback', true,
    'supports_language_selection', true,
    'hosting_provider', 'vidara'
  ),
  'Phase 4 — Vidara self-hosted media provider. API key in VIDARA_API_KEY env var (server-only). Adapter: VidaraAdapter (src/lib/server/hosting/vidara/adapter.ts).'
)
ON CONFLICT (slug) DO NOTHING;


-- ============================================================
-- 2. Register Abyss provider
-- ============================================================

INSERT INTO public.streaming_providers (
  name, slug, description, icon, status, enabled,
  integration_type, adapter_id, capabilities, notes
)
VALUES (
  'Abyss',
  'abyss',
  'Self-hosted media provider (Mavero 2). Original/single audio, multi-quality processing (480p/720p/1080p), embedded/external subtitles.',
  null,
  'experimental',
  true,
  'custom',
  'abyss',
  jsonb_build_object(
    'movie', true,
    'series', true,
    'anime', false,
    'result_type', 'embed',
    'sandbox_policy', 'unrestricted',
    'supports_direct', false,
    'supports_episode', true,
    'supports_download', false,
    'supports_subtitles', true,
    'allowed_embed_origins', jsonb_build_array('https://player.abyssplayer.com'),
    'allow_experimental_playback', true,
    'supports_language_selection', false,
    'hosting_provider', 'abyss'
  ),
  'Phase 4 — Abyss self-hosted media provider. Credentials in ABYSS_EMAIL/ABYSS_PASSWORD env vars (server-only). Adapter: AbyssAdapter (src/lib/server/hosting/abyss/adapter.ts).'
)
ON CONFLICT (slug) DO NOTHING;


-- ============================================================
-- 3. Register Mavero 1 source (Vidara)
-- ============================================================

INSERT INTO public.streaming_sources (
  provider_id, name, slug, description, enabled, visibility,
  status, ordering, integration_type, identifier_mode,
  movie_template, series_template, anime_template,
  audio_languages, subtitle_capability, quality_capability,
  capabilities, notes, badge, icon
)
SELECT
  p.id,
  'Mavero 1',
  'mavero-1',
  'Self-hosted media via Vidara (multi-audio, 720p target).',
  true,
  'public',
  'experimental',
  500,  -- high ordering = low priority in the source selector (experimental)
  'custom',
  'tmdb_id',
  null, null, null,
  ARRAY[]::text[],  -- audio_languages populated dynamically from provider
  false,            -- subtitle_capability (per-asset, not per-source)
  ARRAY[]::text[],  -- quality_capability populated dynamically from provider
  jsonb_build_object(
    'hosting_provider', 'vidara',
    'result_type', 'embed'
  ),
  'Phase 4 — Mavero 1 source backed by VidaraAdapter. Provider: Vidara (slug=vidara). Hosted asset availability checked in future phases.',
  null,
  null
FROM public.streaming_providers p
WHERE p.slug = 'vidara'
ON CONFLICT (provider_id, slug) DO NOTHING;


-- ============================================================
-- 4. Register Mavero 2 source (Abyss)
-- ============================================================

INSERT INTO public.streaming_sources (
  provider_id, name, slug, description, enabled, visibility,
  status, ordering, integration_type, identifier_mode,
  movie_template, series_template, anime_template,
  audio_languages, subtitle_capability, quality_capability,
  capabilities, notes, badge, icon
)
SELECT
  p.id,
  'Mavero 2',
  'mavero-2',
  'Self-hosted media via Abyss (original audio, multi-quality 480p/720p/1080p).',
  true,
  'public',
  'experimental',
  501,  -- high ordering = low priority in the source selector (experimental)
  'custom',
  'tmdb_id',
  null, null, null,
  ARRAY[]::text[],  -- audio_languages populated dynamically from provider
  false,            -- subtitle_capability (per-asset, not per-source)
  ARRAY[]::text[],  -- quality_capability populated dynamically from provider
  jsonb_build_object(
    'hosting_provider', 'abyss',
    'result_type', 'embed'
  ),
  'Phase 4 — Mavero 2 source backed by AbyssAdapter. Provider: Abyss (slug=abyss). Hosted asset availability checked in future phases.',
  null,
  null
FROM public.streaming_providers p
WHERE p.slug = 'abyss'
ON CONFLICT (provider_id, slug) DO NOTHING;


-- ============================================================
-- 5. Category mappings
-- ============================================================
-- Vidara → "Multi Audio" category (Vidara supports multi-audio per plan §3.1)
-- Abyss → "Org Audio" category (Abyss uses original/single audio per plan §3.2)
--
-- The streaming_source_categories table has:
--   PK (source_id, category_id)
--   UNIQUE (category_id, ordering)
-- So we need to determine the next available ordering per category.

-- 5a. Mavero 1 → Multi Audio category
INSERT INTO public.streaming_source_categories (source_id, category_id, ordering)
SELECT
  s.id,
  c.id,
  COALESCE(
    (SELECT max(ssc.ordering) + 1 FROM public.streaming_source_categories ssc WHERE ssc.category_id = c.id),
    0
  )
FROM public.streaming_sources s
CROSS JOIN public.streaming_categories c
WHERE s.slug = 'mavero-1' AND c.slug = 'multi-audio'
ON CONFLICT (source_id, category_id) DO NOTHING;

-- 5b. Mavero 2 → Org Audio category
INSERT INTO public.streaming_source_categories (source_id, category_id, ordering)
SELECT
  s.id,
  c.id,
  COALESCE(
    (SELECT max(ssc.ordering) + 1 FROM public.streaming_source_categories ssc WHERE ssc.category_id = c.id),
    0
  )
FROM public.streaming_sources s
CROSS JOIN public.streaming_categories c
WHERE s.slug = 'mavero-2' AND c.slug = 'org-audio'
ON CONFLICT (source_id, category_id) DO NOTHING;


-- ============================================================
-- End of Phase 4 migration.
--
-- Summary:
--   * 2 new providers inserted: Vidara (slug=vidara), Abyss (slug=abyss)
--   * 2 new sources inserted: Mavero 1 (slug=mavero-1), Mavero 2 (slug=mavero-2)
--   * 2 new category mappings inserted
--   * 0 existing rows modified
--   * 0 secrets stored in the database
--   * integration_type = 'custom' (not template/embed — uses Phase 3 adapter)
--   * adapter_id = 'vidara'/'abyss' (links to HostingProviderAdapter)
--   * capabilities.hosting_provider = 'vidara'/'abyss' (links to adapter key)
--   * status = 'experimental' (new providers start experimental)
--   * visibility = 'public' (visible in source selector)
-- ============================================================
