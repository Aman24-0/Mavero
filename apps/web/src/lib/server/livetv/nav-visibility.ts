import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

/**
 * Live TV nav visibility — `livetv_config_meta.nav_visible` (row id 1).
 *
 * The admin toggle that hides the "Live TV" nav entry for guests / standard
 * users. Admins ALWAYS see it (the AppShell receives the admin capability from
 * the root layout and ORs it in). This is a UI-exposure control only: the
 * /live-tv route + its APIs keep their own authorization, and this flag never
 * grants or removes access to anything.
 *
 * Cached briefly (30s) because it is read on the availability endpoint (which
 * the AppShell fetches once per mount) — not a hot path, but a per-request DB
 * read is still wasteful.
 */

const TTL_MS = 30_000;
let cache: { value: boolean; expiresAt: number } | null = null;

/** Test seam — clears the module-level cache. */
export function resetLivetvNavVisibilityCacheForTests(): void {
	cache = null;
}

/**
 * Read the nav-visibility flag. FAIL-OPEN to TRUE: a missing column/table or
 * any read error resolves to `true` (Live TV stays visible). We never hide a
 * working feature because of a config read failure.
 */
export async function getLivetvNavVisible(client: SupabaseClient<Database>, now = Date.now()): Promise<boolean> {
	if (cache && cache.expiresAt > now) return cache.value;
	let value = true;
	try {
		const { data, error } = await client
			.from('livetv_config_meta')
			.select('nav_visible')
			.eq('id', 1)
			.limit(1)
			.maybeSingle();
		if (!error && data && typeof data.nav_visible === 'boolean') value = data.nav_visible;
	} catch {
		value = true;
	}
	cache = { value, expiresAt: now + TTL_MS };
	return value;
}

/** Persist the toggle (admin action). Throws on a write error. */
export async function setLivetvNavVisible(client: SupabaseClient<Database>, visible: boolean): Promise<void> {
	const { error } = await client.from('livetv_config_meta').update({ nav_visible: visible }).eq('id', 1);
	if (error) throw new Error(error.message);
	cache = { value: visible, expiresAt: Date.now() + TTL_MS };
}
