/**
 * Admin — App Config (Global Settings).
 *
 * Currently edits the Telegram + Discord community links shown in the footer
 * and the Account menu. Stored in the single-row `app_config` table; public
 * read (RLS select for everyone), writes via the service-role admin client.
 */
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { getAppConfig } from '$lib/server/app-config';

function cleanUrl(value: FormDataEntryValue | null): string | null {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	await requireAdmin(locals, { redirectTo: '/admin/system/app-config' });
	const config = await getAppConfig(locals.supabase);
	return { config };
};

export const actions: Actions = {
	saveSocial: async ({ request, locals }) => {
		await requireAdmin(locals, { redirectTo: '/admin/system/app-config' });
		const form = await request.formData();
		const rawTelegram = String(form.get('telegram_url') ?? '').trim();
		const rawDiscord = String(form.get('discord_url') ?? '').trim();
		const telegram_url = cleanUrl(form.get('telegram_url'));
		const discord_url = cleanUrl(form.get('discord_url'));
		// A non-empty input that is not a valid http(s) URL is a user error.
		if (rawTelegram && !telegram_url) return fail(400, { message: 'Telegram URL must be a valid http(s) link.' });
		if (rawDiscord && !discord_url) return fail(400, { message: 'Discord URL must be a valid http(s) link.' });

		const { error } = await locals.supabase
			.from('app_config')
			.upsert({ id: 1, telegram_url, discord_url, updated_at: new Date().toISOString() });
		if (error) return fail(500, { message: 'Could not save the social links.' });
		return { notice: 'Social links saved.' };
	},
};
