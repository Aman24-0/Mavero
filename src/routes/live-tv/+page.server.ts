// ============================================================================
// Unified Live TV R-2 — SSR availability guard for the /live-tv route.
//
// The route guard that makes the source ON/OFF contract AUTHORITATIVE for
// the legacy LiveGT V1 catalogue path. When `available` is false (no
// eligible public source — every source is OFF, non-eligible, or non-public)
// the page receives `available: false` and renders the honest unavailable
// state WITHOUT calling the legacy `getLiveTvChannels()` catalogue path.
//
// This closes the R-1 regression: a disabled LiveGT source could previously
// bypass the owner's decision through the legacy fallback (the unified
// catalogue path already filtered by source.enabled in R-1, but the legacy
// path ran unconditionally when the unified flag was OFF — which is the
// production default).
//
// SECURITY:
//   * Read via the service-role client (the livetv_* tables are fail-closed
//     admin-only by RLS; the /api/downloader/mavero public-read precedent).
//   * The page receives ONLY `available: boolean` and `sources: [{id, name}]`
//     — never config, URLs, slugs, capabilities, visibility/status labels.
//   * Fail-closed: ANY read error resolves to `available: false` (the safe
//     direction — never render Live TV when the registry is unreadable).
//   * This guard does NOT touch `unified_enabled`: the production default
//     (FALSE) is preserved, and the catalogue/guide flag-gating on the
//     client side stays byte-identical to R-1.
// ============================================================================

import type { PageServerLoad } from './$types';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { getLivetvAvailabilityState } from '$lib/server/livetv/user-catalogue';

export const load: PageServerLoad = async () => {
        try {
                const client = createSupabaseAdminClient();
                const availability = await getLivetvAvailabilityState(client);
                return { availability };
        } catch {
                // Fail-closed: an unexpected failure is an unavailable answer
                // — the page renders the honest unavailable state and never
                // loads the legacy LiveGT catalogue against an unreadable
                // registry.
                return { availability: { available: false, sources: [] } };
        }
};
