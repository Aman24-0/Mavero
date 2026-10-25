import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/media/assets route — migrated to /admin/hosting?tab=assets.
 * Phase 6: added server-side 303 redirect (was client-side goto() only).
 * Preserves query params (e.g. ?notice=..., ?provider=..., ?status=...).
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', 'assets');
  throw redirect(303, `/admin/hosting?${params.toString()}`);
};
