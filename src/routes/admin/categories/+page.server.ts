import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/categories route — migrated to /admin/system/content-rules?tab=categories.
 * The canonical route owns all category CRUD actions.
 */
export const load: PageServerLoad = ({ url }) => {
  const notice = url.searchParams.get('notice');
  const target = '/admin/system/content-rules?tab=categories' + (notice ? `&notice=${encodeURIComponent(notice)}` : '');
  throw redirect(303, target);
};
