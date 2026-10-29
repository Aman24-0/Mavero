/**
 * Admin 2.0 — DirectStream scraper workspace page server (2026-10 round 13).
 *
 * Owns the DirectStream scraper config (stored on the single-row `app_config`
 * table):
 *   * scraper_vidsrc_embed_domain — the vidsrc embed front domain
 *     (e.g. `https://vidsrc.to`). The admin updates this when vidsrc rotates
 *     its embed domain — no code change or redeploy needed.
 *   * scraper_vidsrc_cdn_domains — a comma-separated list of CDN domains
 *     used to resolve the `{v1}`–`{v5}` placeholders in the prorcp `file:`
 *     field (e.g. `cloudnestra.com,neonhorizonworkshops.com`).
 *   * scraper_enabled — the global on/off toggle. When false, the scraper
 *     adapter throws SOURCE_DISABLED and the resolver falls back to the next
 *     source. When true, the DirectStream source is eligible for playback.
 *
 * The page also surfaces the current status of the DirectStream
 * streaming_source (enabled/disabled) so the admin can see the full state.
 * The streaming_source row itself is managed via the existing Sources admin
 * page (this page only manages the scraper CONFIG, not the source row).
 */

import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { getScraperConfig } from '$lib/server/app-config';
import { DEFAULT_SCRAPER_CONFIG } from '$lib/server/vod/vidsrc-scraper';

export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin/system/direct-stream' });
  const { config, enabled } = await getScraperConfig(locals.supabase);
  return {
    embedDomain: config.embedDomain,
    cdnDomains: config.cdnDomains.join(', '),
    scraperEnabled: enabled,
    defaultEmbedDomain: DEFAULT_SCRAPER_CONFIG.embedDomain,
    defaultCdnDomains: DEFAULT_SCRAPER_CONFIG.cdnDomains.join(', '),
  };
};

export const actions: Actions = {
  saveConfig: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/direct-stream' });
    const form = await request.formData();
    const embedDomainRaw = String(form.get('embed_domain') ?? '').trim();
    const cdnDomainsRaw = String(form.get('cdn_domains') ?? '').trim();

    // Validate the embed domain is an https URL.
    let embedDomain: string | null = null;
    if (embedDomainRaw) {
      try {
        const url = new URL(embedDomainRaw);
        if (url.protocol !== 'https:') {
          return fail(400, { message: 'Embed domain must be an https URL.' });
        }
        embedDomain = url.origin;
      } catch {
        return fail(400, { message: 'Embed domain is not a valid URL.' });
      }
    }

    // Validate the CDN domains: comma-separated, non-empty after trim.
    const cdnDomains = cdnDomainsRaw
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter((d) => d.length > 0);
    if (embedDomain && cdnDomains.length === 0) {
      return fail(400, { message: 'At least one CDN domain is required when an embed domain is set.' });
    }
    const cdnDomainsString = cdnDomains.join(', ');

    const { error } = await locals.supabase
      .from('app_config')
      .upsert({
        id: 1,
        scraper_vidsrc_embed_domain: embedDomain,
        scraper_vidsrc_cdn_domains: cdnDomainsString || null,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      console.error('[direct-stream] saveConfig upsert failed', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return fail(500, { message: 'Could not save the scraper config.' });
    }
    return { notice: 'Scraper config saved.' };
  },

  toggleEnabled: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/direct-stream' });
    const form = await request.formData();
    const enabled = form.get('enabled') === 'true';
    const { error } = await locals.supabase
      .from('app_config')
      .upsert({
        id: 1,
        scraper_enabled: enabled,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      console.error('[direct-stream] toggleEnabled upsert failed', {
        code: error.code,
        message: error.message,
      });
      return fail(500, { message: 'Could not toggle the scraper.' });
    }
    return { notice: enabled ? 'DirectStream scraper enabled.' : 'DirectStream scraper disabled.' };
  },
};
