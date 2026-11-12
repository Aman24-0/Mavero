import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/providers route — migrated to /admin/system/api-sources?tab=providers.
 * Server-side redirect stub. The +page.svelte also performs a client-side
 * goto() as a fallback. The canonical route's +page.server.ts owns all
 * provider CRUD actions; this file no longer defines any actions.
 */
export const load: PageServerLoad = ({ url }) => {
  const notice = url.searchParams.get('notice');
  const target = '/admin/system/api-sources?tab=providers' + (notice ? `&notice=${encodeURIComponent(notice)}` : '');
  throw redirect(303, target);
};
