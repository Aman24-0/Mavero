import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/media/sync route — migrated to /admin/hosting?tab=sync.
 * Phase 6: added server-side 303 redirect (was client-side goto() only).
 * Preserves query params.
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'sync');
  throw redirect(303, `/admin/hosting?${params.toString()}`);
};
