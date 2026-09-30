import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/users/viewing route — migrated to /admin/analytics?tab=viewing.
 * Phase 3: canonical Analytics workspace owns the viewing dashboard.
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'viewing');
  throw redirect(303, `/admin/analytics?${params.toString()}`);
};
