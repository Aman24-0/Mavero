-- Round 36: Add the Vidstream (Rivestream) source under the DirectStream provider.
-- Also add the direct_stream_default_server app_config column.
-- The multi-stream-vidcore source row is already deleted from the DB by the user.

-- 1. Add the new source under the existing DirectStream provider.
INSERT INTO streaming_sources (provider_id, name, slug, adapter_id, integration_type, identifier_mode, status, visibility, ordering, capabilities)
SELECT p.id, 'Vidstream', 'direct-stream-rivestream', 'rivestream', 'api', 'tmdb_id', 'active', 'public', 405, '{}'::jsonb
FROM streaming_providers p
WHERE p.slug = 'directstream'
ON CONFLICT (slug) DO NOTHING;

-- 2. Add the direct_stream_default_server column to app_config.
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS direct_stream_default_server text DEFAULT 'vidstream';

-- 3. Set the default value on the existing row (id=1).
UPDATE app_config SET direct_stream_default_server = 'vidstream' WHERE id = 1;
