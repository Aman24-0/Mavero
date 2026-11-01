import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { DEFAULT_SCRAPER_CONFIG, type ScraperConfig } from '$lib/server/vod/vidsrc-scraper';

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
        /**
         * 2026-11 round 36 — the LIVE TV INDIAN PROXY override
         * (app_config.livetv_indian_proxy_url, the Admin → Feature Control
         * field). When set it wins over the PUBLIC_INDIAN_PROXY_URL env var:
         * every Jio Live TV stream routes through this Indian-egress proxy
         * (indian-proxy/ in the repo root) instead of failing with the
         * geo-block's 451. Empty/invalid → null (the env fallback applies).
         */
        livetvIndianProxyUrl: string | null;
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
                        .select('telegram_url, discord_url, livetv_indian_proxy_url')
                        .eq('id', 1)
                        .maybeSingle();
                if (error || !data) return { telegramUrl: null, discordUrl: null, livetvIndianProxyUrl: null };
                return {
                        telegramUrl: cleanUrl(data.telegram_url),
                        discordUrl: cleanUrl(data.discord_url),
                        livetvIndianProxyUrl: cleanUrl(data.livetv_indian_proxy_url)
                };
        } catch {
                return { telegramUrl: null, discordUrl: null, livetvIndianProxyUrl: null };
        }
}

/**
 * 2026-11 round 36 — the effective LIVE TV INDIAN PROXY base (admin-set
 * override from `app_config.livetv_indian_proxy_url`), or null when the
 * admin has not configured one (the caller then falls back to the
 * PUBLIC_INDIAN_PROXY_URL env var and, when both are unset, the Live TV
 * router fails Jio candidates fast with the honest setup message).
 */
export async function getLivetvIndianProxyUrl(client: SupabaseClient<Database>): Promise<string | null> {
        return (await getAppConfig(client)).livetvIndianProxyUrl;
}

/**
 * Reads the DirectStream scraper config from `app_config`. Falls back to
 * DEFAULT_SCRAPER_CONFIG on any read error or missing values — the scraper
 * is always usable (the admin can override the defaults at runtime).
 *
 * @returns `{ config: ScraperConfig, enabled: boolean }` — `enabled` is the
 *          global on/off toggle (app_config.scraper_enabled).
 */
export async function getScraperConfig(client: SupabaseClient<Database>): Promise<{ config: ScraperConfig; enabled: boolean }> {
        try {
                const { data, error } = await client
                        .from('app_config')
                        .select('scraper_vidsrc_embed_domain, scraper_vidsrc_cdn_domains, scraper_enabled')
                        .eq('id', 1)
                        .maybeSingle();
                if (error || !data) return { config: DEFAULT_SCRAPER_CONFIG, enabled: false };
                const embedDomain = typeof data.scraper_vidsrc_embed_domain === 'string' && data.scraper_vidsrc_embed_domain.trim()
                        ? data.scraper_vidsrc_embed_domain.trim()
                        : DEFAULT_SCRAPER_CONFIG.embedDomain;
                const cdnDomains = typeof data.scraper_vidsrc_cdn_domains === 'string' && data.scraper_vidsrc_cdn_domains.trim()
                        ? data.scraper_vidsrc_cdn_domains.split(',').map((d) => d.trim()).filter((d) => d.length > 0)
                        : DEFAULT_SCRAPER_CONFIG.cdnDomains;
                const enabled = data.scraper_enabled === true;
                return { config: { embedDomain, cdnDomains }, enabled };
        } catch {
                return { config: DEFAULT_SCRAPER_CONFIG, enabled: false };
        }
}
