import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/users/overview route — migrated to /admin/analytics?tab=overview.
 *
 * Phase 3: the canonical Analytics workspace (Phase H) now owns the overview
 * dashboard. Forwards period/mode/metric params.
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'overview');
  throw redirect(303, `/admin/analytics?${params.toString()}`);
};
