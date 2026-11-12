-- MAV-FOCUSED (2026-10) — Add 'unlink' to the media_operations action CHECK constraint.
--
-- The new unlinkAsset() method in ManagementService records an 'unlink'
-- operation when a media-to-provider-file association is removed without
-- deleting the provider file. This migration is ADDITIVE — it only adds
-- 'unlink' to the existing allowed values; no existing action is removed.
--
-- Idempotent: DROP IF EXISTS + ADD CONSTRAINT (same pattern as the
-- 20261012000000 migration that added 'link' and 'reactivate').

ALTER TABLE public.media_operations
  DROP CONSTRAINT IF EXISTS media_operations_action_check;

ALTER TABLE public.media_operations
  ADD CONSTRAINT media_operations_action_check CHECK (action IN (
    'upload', 'upload_remote', 'processing_started', 'ready', 'failed',
    'retry', 'rename', 'move', 'replace', 'subtitle_upload', 'sync',
    'provider_delete', 'detach', 'create_media_item', 'update_media_item',
    'delete_media_item', 'create_folder', 'update_folder', 'delete_folder',
    'create_folder_mapping', 'update_folder_mapping', 'delete_folder_mapping',
    'resolve_availability', 'link', 'reactivate', 'unlink'
  ));
