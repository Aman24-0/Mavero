import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/media/history route — migrated to /admin/operations?tab=history.
 * Phase 6: added server-side 303 redirect (was client-side goto() only).
 * Preserves query params.
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'history');
  throw redirect(303, `/admin/operations?${params.toString()}`);
};
