/**
 * Admin 2.0 — Feature Control workspace page server.
 *
 * Independent route (extracted from the legacy /admin/system/content-rules
 * tab during the 2026-10 admin restructure). Owns TWO feature groups:
 *
 *   1. Adult Mode policy (allowLoggedIn / allowGuest) — server-enforced
 *      gates that control who can access adult content. Read client-side
 *      via /api/admin/adult-mode (preserves the existing partial-load
 *      behavior; nothing else changed).
 *
 *   2. Community invite links (Telegram + Discord) — public-facing invite
 *      URLs stored on the single-row `app_config` table (telegram_url,
 *      discord_url). Same storage + helper as the rest of the app
 *      (getAppConfig in $lib/server/app-config). Empty submissions
 *      normalize to NULL (the public UI hides the chip). URLs must be
 *      http(s) — enforced here before any write so a malformed value can
 *      never reach the database. The 2026-10 restructure MOVED this UI
 *      here from /admin/system/app-config (consolidating Feature Control
 *      + community links into one workspace per the owner spec); the
 *      backend (table + getAppConfig + footer/account-sheet readers) is
 *      unchanged.
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
  await requireAdmin(locals, { redirectTo: '/admin/system/feature-control' });
  // Surface the saved community links so the form can prefill. The
  // adult-mode policy is loaded client-side via /api/admin/adult-mode
  // (preserving the existing partial-loading behavior).
  const config = await getAppConfig(locals.supabase);
  return {
    telegramInviteUrl: config.telegramUrl ?? '',
    discordInviteUrl: config.discordUrl ?? '',
  };
};

export const actions: Actions = {
  saveSocial: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/feature-control' });
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
