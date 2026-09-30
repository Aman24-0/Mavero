import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/users/retention route — migrated to /admin/analytics?tab=retention.
 * Phase 3: canonical Analytics workspace owns the retention cohort dashboard.
 * Forwards the ?cohort= param (signup | first-use | first-watch).
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'retention');
  throw redirect(303, `/admin/analytics?${params.toString()}`);
};
