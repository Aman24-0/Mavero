/**
 * (2026-10-15) — Media operation audit writer.
 *
 * The Upload/Import workflow was REMOVED from Mavero (all upload pages,
 * routes, and the UploadService were deleted). The ONE capability the
 * remaining media-management surface still needed from that service was
 * `recordOperation`: the best-effort INSERT into `media_operations` that
 * builds the shared audit trail for link / unlink / relink / rename /
 * detach / delete actions.
 *
 * That writer is rehomed HERE as a standalone function so the manual-link,
 * bulk-link, bulk-unlink, and management services keep the exact same
 * audit contract (same table, same columns, same silently-absorbed
 * failures) without any dependency on the removed upload pipeline.
 *
 * SECURITY: never store credentials, tokens, or API keys in `details`.
 * The `details` field is jsonb and may be visible to admins.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

export type MediaOperationAuditParams = {
  action: string;
  status: 'success' | 'failed' | 'pending';
  media_item_id?: string;
  media_asset_id?: string;
  provider_source_id?: string;
  upload_operation_id?: string;
  admin_user_id?: string;
  details?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
};

/**
 * Records a management operation in the media_operations audit table.
 *
 * Best-effort by design (identical semantics to the previous
 * UploadService.recordOperation):
 *   - A failure to record history must NEVER break the main operation —
 *     insert errors are silently absorbed.
 *   - FK-sensitive callers must respect the schema: `media_asset_id` and
 *     `media_item_id` reference live rows. Success-path unlink audits pass
 *     the (now-deleted) asset id inside `details` instead.
 */
export async function recordMediaOperation(
  client: SupabaseClient<Database>,
  params: MediaOperationAuditParams,
): Promise<void> {
  try {
    await client.from('media_operations').insert({
      action: params.action,
      status: params.status,
      media_item_id: params.media_item_id ?? null,
      media_asset_id: params.media_asset_id ?? null,
      provider_source_id: params.provider_source_id ?? null,
      upload_operation_id: params.upload_operation_id ?? null,
      admin_user_id: params.admin_user_id ?? null,
      details: (params.details ?? {}) as never,
      error_code: params.error_code ?? null,
      error_message: params.error_message ?? null,
    });
  } catch {
    // Silently absorb — operation history is a best-effort audit trail.
    // A failure to record history must NOT break the main operation.
  }
}
