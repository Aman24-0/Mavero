-- Add 'link' and 'reactivate' to the media_operations action CHECK constraint.
-- These actions are used by the ManagementService.linkAsset() and
-- ManagementService.reactivateAsset() methods, which were added as part
-- of the hosting lifecycle fix (detach → reactivate → relink).
--
-- The original migration (20260928200724) did not include these actions
-- because the link/reactivate functionality was added later.
--
-- Idempotent: drops and re-adds the constraint with the expanded list.

ALTER TABLE public.media_operations
  DROP CONSTRAINT IF EXISTS media_operations_action_check;

ALTER TABLE public.media_operations
  ADD CONSTRAINT media_operations_action_check CHECK (action IN (
    'upload', 'upload_remote', 'processing_started', 'ready', 'failed',
    'retry', 'rename', 'move', 'replace', 'subtitle_upload', 'sync',
    'provider_delete', 'detach', 'create_media_item', 'update_media_item',
    'delete_media_item', 'create_folder', 'update_folder', 'delete_folder',
    'create_folder_mapping', 'update_folder_mapping', 'delete_folder_mapping',
    'resolve_availability', 'link', 'reactivate'
  ));
