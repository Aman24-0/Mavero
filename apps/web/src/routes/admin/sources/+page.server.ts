import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/sources route — migrated to /admin/system/api-sources?tab=sources.
 * Server-side redirect stub. The canonical route owns all source CRUD actions.
 */
export const load: PageServerLoad = ({ url }) => {
  const notice = url.searchParams.get('notice');
  const target = '/admin/system/api-sources?tab=sources' + (notice ? `&notice=${encodeURIComponent(notice)}` : '');
  throw redirect(303, target);
};
