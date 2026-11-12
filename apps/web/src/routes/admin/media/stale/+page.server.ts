import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/media/stale route — migrated to /admin/operations?tab=attention.
 * Phase 6: added server-side 303 redirect (was client-side goto() only).
 * Preserves query params.
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'attention');
  throw redirect(303, `/admin/operations?${params.toString()}`);
};
