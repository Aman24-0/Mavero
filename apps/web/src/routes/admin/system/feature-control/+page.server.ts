/**
 * Admin 2.0 — Feature Control workspace page server.
 *
 * Independent route (extracted from the legacy /admin/system/content-rules
 * tab during the 2026-10 admin restructure). Owns THREE feature groups:
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
 *
 *   3. 2026-11 round 36 — LIVE TV INDIAN PROXY URL (app_config
 *      .livetv_indian_proxy_url). Jio's CDNs 451 every non-Indian egress
 *      IP (the Cloudflare Worker's and Netlify's included) — a geo-block
 *      NO header spoofing can fix. The admin deploys the standalone
 *      `indian-proxy/` service (repo root) on an Indian VPS / Render and
 *      pastes its URL here; every Jio Live TV stream then routes through
 *      it. Empty normalizes to NULL → the deployment-level
 *      PUBLIC_INDIAN_PROXY_URL env var applies; when BOTH are unset the
 *      Live TV router fails Jio candidates fast with the honest setup
 *      message instead of a guaranteed-451 playback attempt. http(s)
 *      accepted (an Indian VPS may terminate TLS itself), validated here
 *      before any write. The upsert touches ONLY this column — the
 *      social links and scraper config on the same row are never clobbered.
 */

import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
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
  // Surface the saved community links + the Indian proxy override so the
  // forms can prefill. The adult-mode policy is loaded client-side via
  // /api/admin/adult-mode (preserving the existing partial-loading behavior).
  const config = await getAppConfig(locals.supabase);
  const envIndianProxy = (env.PUBLIC_INDIAN_PROXY_URL ?? '').trim();
  return {
    telegramInviteUrl: config.telegramUrl ?? '',
    discordInviteUrl: config.discordUrl ?? '',
    indianProxyUrl: config.livetvIndianProxyUrl ?? '',
    // The deployment-level fallback, surfaced read-only so the admin can
    // see WHY an Indian proxy may already be active without saving one.
    indianProxyEnvUrl: envIndianProxy,
    indianProxyEffective: config.livetvIndianProxyUrl ?? (envIndianProxy || null),
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
    // Empty input is allowed — it normalizes to NULL (the public UI hides
    // the chip), so an admin can save Telegram-only or Discord-only.
    if (rawTelegram && !telegram_url) return fail(400, { message: 'Telegram URL must be a valid http(s) link.' });
    if (rawDiscord && !discord_url) return fail(400, { message: 'Discord URL must be a valid http(s) link.' });

    const { error } = await locals.supabase
      .from('app_config')
      .upsert({ id: 1, telegram_url, discord_url, updated_at: new Date().toISOString() });
    if (error) {
      // Log the actual Supabase error so the next failure is debuggable
      // from the server logs — the generic user-facing message hides
      // the cause (RLS denial, schema mismatch, connectivity, etc.).
      console.error('[feature-control] saveSocial upsert failed', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return fail(500, { message: 'Could not save the social links.' });
    }
    return { notice: 'Social links saved.' };
  },

  /**
   * 2026-11 round 36 — save the Live TV Indian Proxy URL. Only this column
   * is written (PostgREST upserts update the payload's columns alone), the
   * empty input normalizes to NULL (the PUBLIC_INDIAN_PROXY_URL env var
   * then applies), and a non-empty non-URL input is a 400 user error.
   */
  saveIndianProxy: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/feature-control' });
    const form = await request.formData();
    const raw = String(form.get('livetv_indian_proxy_url') ?? '').trim();
    const livetv_indian_proxy_url = cleanUrl(form.get('livetv_indian_proxy_url'));
    if (raw && !livetv_indian_proxy_url) {
      return fail(400, { message: 'The Indian Proxy URL must be a valid http(s) link.' });
    }
    const { error } = await locals.supabase
      .from('app_config')
      .upsert({ id: 1, livetv_indian_proxy_url, updated_at: new Date().toISOString() });
    if (error) {
      console.error('[feature-control] saveIndianProxy upsert failed', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return fail(500, { message: 'Could not save the Indian Proxy URL.' });
    }
    return { notice: livetv_indian_proxy_url ? 'Indian Proxy URL saved — Jio Live TV now routes through it.' : 'Indian Proxy URL cleared — the env fallback applies.' };
  },
};
