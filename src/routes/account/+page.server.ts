import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 3 — legacy compatibility redirect.
//
// /account is no longer a canonical destination: the account-management
// experience moved to /settings (the page component and the form actions
// were MOVED, not duplicated). This directory is intentionally
// redirect-only — the exact pattern /profile and the pre-Phase-3
// /settings used.
//
// Permanent 308 preserves the full query string so bookmarked views keep
// working. The load always throws, so no page ever renders here.
export const load: PageServerLoad = ({ url }) => {
  throw redirect(308, `/settings${url.search}`);
};
