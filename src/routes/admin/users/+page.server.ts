import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/users route — migrated to /admin/analytics?tab=users.
 *
 * Phase 3: the canonical Analytics workspace (Phase H) now owns the user
 * list. This route is a server-side redirect stub that preserves all
 * applicable URL params (q, filter, page, period, from, to). The canonical
 * route's +page.server.ts owns the listUsers call.
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'users');
  // pageSize is not supported by the Analytics workspace (it hardcodes 25).
  params.delete('pageSize');
  throw redirect(303, `/admin/analytics?${params.toString()}`);
};
