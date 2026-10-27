import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

/**
 * App-wide config read (the single-row `app_config` table). Currently only the
 * Telegram + Discord community links, shown in the footer and the Account menu.
 *
 * TOTAL + FAIL-SAFE: any read error or malformed value degrades to `null`, so
 * the footer/account sheet simply hide the missing icon(s) — a config read can
 * never break a page render.
 */
export type AppConfig = {
	telegramUrl: string | null;
	discordUrl: string | null;
};

function cleanUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

export async function getAppConfig(client: SupabaseClient<Database>): Promise<AppConfig> {
	try {
		const { data, error } = await client
			.from('app_config')
			.select('telegram_url, discord_url')
			.eq('id', 1)
			.maybeSingle();
		if (error || !data) return { telegramUrl: null, discordUrl: null };
		return { telegramUrl: cleanUrl(data.telegram_url), discordUrl: cleanUrl(data.discord_url) };
	} catch {
		return { telegramUrl: null, discordUrl: null };
	}
}
