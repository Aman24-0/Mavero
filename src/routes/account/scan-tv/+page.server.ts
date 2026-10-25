import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 3 — legacy compatibility redirect.
//
// The phone-side QR scanner moved to /settings/scan-tv (it is the
// "Login With QR" flow launched from Settings → Devices & Sessions).
// This directory is intentionally redirect-only. The auth-gating load
// of the moved route is preserved at the new path.
export const load: PageServerLoad = () => {
  throw redirect(308, '/settings/scan-tv');
};
