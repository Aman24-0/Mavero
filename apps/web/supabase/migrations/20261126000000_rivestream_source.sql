-- Round 36: Vidstream (Rivestream) — app_config columns only.
-- The Vidstream adapter is called in-adapter from vidsrc-scrape; adapters
-- resolve from streaming_providers.adapter_id, so NO streaming_sources
-- INSERT is needed (adapter_id lives on streaming_providers, not
-- streaming_sources).
--
-- direct_stream_default_server: 'vidstream' | 'vidsrc' — which server the
--   player preselects on the first resolve.
-- direct_stream_vidsrc_enabled: per-source toggle for Vidsrc.
-- direct_stream_vidstream_enabled: per-source toggle for Vidstream.

ALTER TABLE app_config ADD COLUMN IF NOT EXISTS direct_stream_default_server text DEFAULT 'vidstream';
UPDATE app_config SET direct_stream_default_server = 'vidstream' WHERE id = 1;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS direct_stream_vidsrc_enabled boolean DEFAULT true;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS direct_stream_vidstream_enabled boolean DEFAULT true;
