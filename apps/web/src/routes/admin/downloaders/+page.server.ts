import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/downloaders route — migrated to /admin/system/downloads.
 * The canonical route owns all downloader CRUD actions.
 */
export const load: PageServerLoad = ({ url }) => {
  const notice = url.searchParams.get('notice');
  const target = '/admin/system/downloads' + (notice ? `?notice=${encodeURIComponent(notice)}` : '');
  throw redirect(303, target);
};
