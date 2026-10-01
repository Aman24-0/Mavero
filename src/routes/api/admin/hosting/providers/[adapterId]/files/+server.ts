/**
 * Admin 2.0 — List unlinked provider files for a hosting adapter.
 *
 * GET /api/admin/hosting/providers/[adapterId]/files
 *   Returns provider-side files (Vidara/Abyss) that are NOT currently
 *   linked to any Mavero media_asset. Used by the "Link existing file"
 *   UI in AdminMediaDetailDrawer to let an admin manually connect a
 *   provider file to a canonical media_item.
 *
 * Path param:
 *   adapterId — must be 'vidara' or 'abyss'. Any other value returns
 *   400 INVALID_REQUEST. This endpoint only serves hosting adapters
 *   that implement `listAssets`; non-hosting playback sources have no
 *   "files" concept.
 *
 * Response shape:
 *   { ok: true, files: Array<{ providerAssetId, title, filename,
 *           sizeBytes, durationSeconds, status, playbackUrl }> }
 *
 * Security: Admin-only (requireAdmin). Service-role client. The
 * response contains only public provider file metadata (title,
 * filename, filecode, size, duration, status) — NO credentials,
 * JWTs, or provider API keys leak.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { ManagementService } from '$lib/server/hosting/management/service';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { HostingProviderError } from '$lib/server/hosting/errors';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

// Whitelist of hosting adapter ids that support listing unlinked files.
// This matches the registry in src/lib/server/hosting/registry.ts.
const SUPPORTED_ADAPTERS = new Set(['vidara', 'abyss']);

export const GET: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const management = new ManagementService(adminClient, mediaService);

  const adapterId = params.adapterId;
  if (!adapterId || !SUPPORTED_ADAPTERS.has(adapterId)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: `Unknown hosting adapter: '${adapterId}'. Supported: vidara, abyss.` } },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const files = await management.listUnlinkedProviderFiles(adapterId);
    return json({ ok: true, files }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof HostingProviderError) {
      return json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const message = error instanceof Error ? error.message : 'Failed to list provider files.';
    return json(
      { ok: false, error: { code: 'HOSTING_FILES_FAILED', message } },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
};
