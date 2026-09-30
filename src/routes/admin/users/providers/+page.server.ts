import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/users/providers route — migrated to /admin/analytics?tab=providers.
 * Phase 3: canonical Analytics workspace owns the provider usage dashboard.
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'providers');
  throw redirect(303, `/admin/analytics?${params.toString()}`);
};
