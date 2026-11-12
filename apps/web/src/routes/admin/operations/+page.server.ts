/**
 * Admin 2.0 — Operations Center page server.
 *
 * ARCHITECTURE: Operations has been merged into Hosting Control.
 * This route redirects to /admin/hosting with the appropriate tab.
 *
 * Tab mapping:
 *   ?tab=jobs       → /admin/hosting?tab=jobs
 *   ?tab=history    → /admin/hosting?tab=activity
 *   ?tab=attention  → /admin/hosting?tab=attention
 *   (default)       → /admin/hosting?tab=jobs
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const oldTab = url.searchParams.get('tab') ?? 'jobs';
  const newTab = oldTab === 'history' ? 'activity' : oldTab;
  const validTabs = new Set(['jobs', 'activity', 'attention']);
  const finalTab = validTabs.has(newTab) ? newTab : 'jobs';

  // Preserve any other query params.
  const params = new URLSearchParams(url.searchParams);
  params.set('tab', finalTab);

  throw redirect(303, `/admin/hosting?${params.toString()}`);
};
