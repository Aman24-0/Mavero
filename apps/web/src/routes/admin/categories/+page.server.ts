import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/categories route — migrated to /admin/system/api-sources?tab=categories
 * (categories moved into the API & Sources workspace during the 2026-10
 * admin restructure; content-rules was deleted). The canonical route owns
 * all category CRUD actions.
 */
export const load: PageServerLoad = ({ url }) => {
  const notice = url.searchParams.get('notice');
  const target = '/admin/system/api-sources?tab=categories' + (notice ? `&notice=${encodeURIComponent(notice)}` : '');
  throw redirect(303, target);
};
