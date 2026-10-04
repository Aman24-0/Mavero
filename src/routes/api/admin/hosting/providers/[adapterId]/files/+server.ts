/**
 * Admin 2.0 — List unlinked provider files for a hosting adapter.
 *
 * GET /api/admin/hosting/providers/[adapterId]/files
 *   Returns provider-side files (Vidara/Abyss/…) that are NOT currently
 *   linked to any Mavero media_asset. Used by the "Link existing file"
 *   pickers (AdminMediaDetailDrawer, Media Library header action, and
 *   the Missing Media link flow) to let an admin manually connect a
 *   provider file to a canonical media_item.
 *
 * Path param:
 *   adapterId — must be a registered HOSTING adapter key (derived from
 *   the canonical registry — adding a new hosting adapter to
 *   registry.ts automatically extends this endpoint, no per-provider
 *   hardcode). Any other value returns 400 INVALID_REQUEST.
 *
 * Response shape:
 *   { ok: true, files: Array<{ providerAssetId, title, filename,
 *           sizeBytes, durationSeconds, status, playbackUrl }> }
 *
 * Errors are HONEST: an unconfigured adapter (missing credentials) or a
 * missing provider/source row returns a typed error (400) — never a
 * fabricated empty file list.
 *
 * Security: Admin-only (requireAdmin). Service-role client. The
 * response contains only public provider file metadata (title,
 * filename, provider ids, size, duration, status) — NO credentials,
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
import { getHostingAdapterKeys } from '$lib/server/hosting/registry';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

// Hosting adapters that support listing unlinked files — DERIVED from the
// canonical registry (src/lib/server/hosting/registry.ts). A future
// hosting adapter registered there is automatically linkable here.
const SUPPORTED_ADAPTERS = new Set<string>(getHostingAdapterKeys());

export const GET: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const management = new ManagementService(adminClient, mediaService);

  const adapterId = params.adapterId;
  if (!adapterId || !SUPPORTED_ADAPTERS.has(adapterId)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: `Unknown hosting adapter: '${adapterId}'. Supported: ${[...SUPPORTED_ADAPTERS].join(', ')}.` } },
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
