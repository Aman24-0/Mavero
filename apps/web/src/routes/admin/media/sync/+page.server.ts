import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/media/sync route — redirected to the Hosting Control
 * Providers view (the canonical home of all sync actions since the
 * Hosting navigation consolidation: Refresh health + Sync all providers
 * live on the Providers tab, per-provider Sync on each provider card).
 *
 * The old target `?tab=sync` no longer exists — the separate Sync tab was
 * removed. Server-side 303 redirect (was client-side goto() only in the
 * earliest phase). Preserves nothing from the query string (the legacy
 * route had no meaningful params).
 */
export const load: PageServerLoad = () => {
  throw redirect(303, '/admin/hosting');
};
