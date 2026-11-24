-- Round 37: VidPlay (NovaHD) — app_config column only.
-- The VidPlay adapter is called in-adapter from vidsrc-scrape (same pattern
-- as the Rivestream/Vidstream merge); adapters resolve from
-- streaming_providers.adapter_id, so NO streaming_sources INSERT is needed.
--
-- direct_stream_vidplay_enabled: per-source toggle for VidPlay (NovaHD).
--   When true, the vidsrc-scrape adapter calls the nova adapter and appends
--   its avc1-only HLS entries to the server list. When false, VidPlay is
--   omitted entirely (never blocks Vidsrc/Vidstream).
--
-- The default_server column (added by 20261126000000_rivestream_source.sql)
-- now also accepts 'vidplay' — no schema change needed for that (it's a text
-- column validated by the adapter).

ALTER TABLE app_config ADD COLUMN IF NOT EXISTS direct_stream_vidplay_enabled boolean DEFAULT true;
