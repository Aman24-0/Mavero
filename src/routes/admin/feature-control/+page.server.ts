import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/feature-control route — migrated to /admin/system/content-rules?tab=features.
 * Phase 6: added server-side 303 redirect (was client-side goto() only).
 * Preserves query params (e.g. ?notice=...).
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'features');
  throw redirect(303, `/admin/system/content-rules?${params.toString()}`);
};
