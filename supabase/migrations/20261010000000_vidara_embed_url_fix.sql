-- Phase 6 fix: Vidara embed URL correction.
--
-- The original migration set allowed_embed_origins to 'https://vidara.so'
-- and the normalize.ts used 'https://vidara.so/v/<code>' as the playback URL.
-- Production testing revealed that this URL renders the Vidara share/download
-- page, NOT the embedded player.
--
-- The correct embed URL is 'https://vidara.to/e/<code>' (different domain:
-- vidara.to, and different path: /e/ for embed). This migration updates the
-- allowed_embed_origins to include both domains during the transition period.
--
-- Existing media_assets.playback_url rows containing 'https://vidara.so/v/'
-- should be updated via a one-time SQL UPDATE or by running a Vidara sync:
--   UPDATE media_assets
--   SET playback_url = REPLACE(playback_url, 'https://vidara.so/v/', 'https://vidara.to/e/')
--   WHERE playback_url LIKE 'https://vidara.so/v/%';

UPDATE public.streaming_providers
SET capabilities = jsonb_set(
  capabilities,
  '{allowed_embed_origins}',
  jsonb_build_array('https://vidara.to', 'https://vidara.so')
)
WHERE adapter_id = 'vidara';
