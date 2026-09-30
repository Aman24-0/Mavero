import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/defaults route — migrated to /admin/system/api-sources
 * (defaults are now a sheet inside the API & Sources workspace).
 * The canonical route owns the saveDefault / clearDefault actions.
 */
export const load: PageServerLoad = ({ url }) => {
  const notice = url.searchParams.get('notice');
  const target = '/admin/system/api-sources' + (notice ? `?notice=${encodeURIComponent(notice)}` : '');
  throw redirect(303, target);
};
