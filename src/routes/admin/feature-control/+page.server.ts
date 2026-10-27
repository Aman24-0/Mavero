import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /admin/feature-control route — now points to the independent
 * /admin/system/feature-control page (extracted from content-rules during
 * the 2026-10 admin restructure). Server-side 303 redirect preserves
 * query params (e.g. ?notice=...).
 */
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.searchParams);
  throw redirect(303, `/admin/system/feature-control?${params.toString()}`);
};
