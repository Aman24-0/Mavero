import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /profile is retained only as a compatibility redirect (Phase C).
//
// Since the Navigation & Settings Redesign (Phase 3), Settings (/settings)
// is the single canonical account-management destination. This load always
// throws a permanent server-side redirect, so the legacy Profile UI can
// never render — the old page component was removed and no client-side
// redirect is involved.
export const load: PageServerLoad = () => {
  throw redirect(308, '/settings');
};
