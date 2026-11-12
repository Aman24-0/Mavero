import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/addons route — migrated to /admin/system/integrations.
 * The canonical route owns all Stremio addon CRUD actions.
 */
export const load: PageServerLoad = ({ url }) => {
  const notice = url.searchParams.get('notice');
  const target = '/admin/system/integrations' + (notice ? `?notice=${encodeURIComponent(notice)}` : '');
  throw redirect(303, target);
};
