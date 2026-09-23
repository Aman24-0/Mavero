-- ============================================================
-- Phase 8: Sandbox simplification + embed origin restoration
-- ============================================================
--
-- This migration:
-- 1. Removes legacy source-level sandbox_policy from ALL streaming_sources.
-- 2. Normalizes provider policies: optional -> required.
-- 3. Restores missing allowed_embed_origins for Mapple, VidAPI.tw, YapGrid.
--
-- Sandbox is now provider-level only (required/unrestricted).
-- Sources no longer carry sandbox_policy.
-- ============================================================

-- 1. Remove sandbox_policy from ALL source capabilities.
-- Uses jsonb_set with a null value to delete the key, then
-- removes the key entirely. This preserves all other capability
-- keys (allowed_embed_origins, result_type, supports_*, etc.).
UPDATE public.streaming_sources
SET capabilities = (capabilities - 'sandbox_policy')
WHERE capabilities ? 'sandbox_policy';

-- 2. Normalize provider sandbox_policy: optional -> required.
-- This updates the capabilities JSON in-place using jsonb_set.
UPDATE public.streaming_providers
SET capabilities = jsonb_set(
  capabilities - 'sandbox_policy',
  '{sandbox_policy}',
  '"required"'::jsonb,
  true
)
WHERE capabilities->>'sandbox_policy' = 'optional';

-- 3. Restore missing allowed_embed_origins for affected providers.
-- Uses jsonb_set to add/overwrite only the allowed_embed_origins key,
-- preserving all other capability keys.

-- Mapple: https://mapple.uk
UPDATE public.streaming_providers
SET capabilities = jsonb_set(
  capabilities,
  '{allowed_embed_origins}',
  '["https://mapple.uk"]'::jsonb,
  true
)
WHERE slug = 'mapple';

-- VidAPI.tw: https://vaplayer.ru
UPDATE public.streaming_providers
SET capabilities = jsonb_set(
  capabilities,
  '{allowed_embed_origins}',
  '["https://vaplayer.ru"]'::jsonb,
  true
)
WHERE slug = 'vidapi-tw';

-- YapGrid: https://yapgrid.com
UPDATE public.streaming_providers
SET capabilities = jsonb_set(
  capabilities,
  '{allowed_embed_origins}',
  '["https://yapgrid.com"]'::jsonb,
  true
)
WHERE slug = 'yapgrid';
