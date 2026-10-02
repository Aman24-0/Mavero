/**
 * MAVERO CloudStream extractor — Hub-Cloud / V-Cloud port (CS-2).
 *
 * Faithful port of the verified Kotlin `HubCloud` and `VCloud` extractors
 * (MoviesDrive `Extractors.kt`; VegaMovies `Extractors.kt` ships the same
 * logic under the V-Cloud name). The two Kotlin classes are IDENTICAL apart
 * from the display name and the dynamic-domain key, so one port covers both
 * (`hubcloud.ist` / `vcloud.fit` at verification time).
 *
 *   1. resolve the CURRENT domain (urls.json keys `hubcloud` | `vcloud`) and
 *      rebase the link;
 *   2. resolve the intermediate download URL:
 *        * `/video/` pages → `div.vd > center > a@href`;
 *        * vcloud pages → `var url = atob(atob('…'))` (double base64);
 *        * hubcloud pages → `var url = '…'` (plain);
 *   3. load the file card: `div.card-header` (quality source), `i#size`;
 *   4. walk `h2 a.btn` server buttons: FSL Server / FSLv2 / Mega Server /
 *      Download File are direct; BuzzServer reads the `hx-redirect` header
 *      of `<link>/download`; pixeldrain uses the page's `var pxl = '…'` var
 *      then converts to the API download URL; "Server : 10Gbps" follows the
 *      bounded HEAD redirect chain and strips `link=`; Gofile delegates to
 *      the Kotlin global registry (unknown in Mavero → skipped honestly).
 *
 * Bounds: SSRF-guarded fetches through the context, bounded server-button
 * fan-out, per-button failure isolation.
 */

import type { MaveroCloudStreamExtractor, CloudStreamRuntimeContext } from '../types/runtime';
import type { CloudStreamExtractedLink } from '../normalize/links';
import { classifyUrlKind, parseSizeBytes, parseIndexQuality, qualityLabel, pixeldrainDownloadUrl } from '../normalize/links';
import { rebaseDynamicUrl } from '../runtime/dynamic-urls';

const HUBCLOUD_ID = 'hubcloud';
const HUBCLOUD_FALLBACK_BASE = 'https://hubcloud.ist';
const VCLOUD_FALLBACK_BASE = 'https://vcloud.fit';
/** Bounded server-button fan-out per extractor call. */
const MAX_HUBCLOUD_LINKS = 24;

/** Kotlin `getBaseUrl` port. */
function baseUrlOf(url: string): string {
  try {
    return `${new URL(url).protocol}//${new URL(url).host}`;
  } catch {
    return url;
  }
}

/** Kotlin `extractPxlUrl` port: `var pxl = '…'` from the page source. */
function extractPxlUrl(html: string): string | null {
  const match = /var\s+pxl\s*=\s*["']([^"']+)["']/.exec(html);
  return match?.[1] ?? null;
}

/** Kotlin `extractDoubleAtob` port: `var url = atob(atob('…'))`. */
function extractDoubleAtob(html: string): string | null {
  const match = /var\s+url\s*=\s*atob\s*\(\s*atob\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/.exec(html);
  if (!match?.[1]) return null;
  try {
    const once = Buffer.from(match[1], 'base64').toString('utf8');
    return Buffer.from(once, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Kotlin single-atob variant: `var url = '…'` (plain quoted value). */
function extractPlainVarUrl(html: string): string | null {
  const match = /var\s+url\s*=\s*['"]([^'"]+)['"]/.exec(html);
  return match?.[1] ?? null;
}

/** Joins a possibly-relative link onto a base (never double-concatenates). */
function joinUrl(base: string, link: string): string {
  if (link.startsWith('http://') || link.startsWith('https://')) return link;
  if (link.startsWith('/')) return `${base}${link}`;
  return `${base}/${link}`;
}

export const hubcloudExtractor: MaveroCloudStreamExtractor = {
  id: HUBCLOUD_ID,
  displayName: 'Hub-Cloud',
  matches(url: string): boolean {
    return /hubcloud\./i.test(url) || /vcloud\./i.test(url);
  },

  async extract(url: string, ctx: CloudStreamRuntimeContext): Promise<CloudStreamExtractedLink[]> {
    const isVcloud = url.toLowerCase().includes('vcloud');
    const originalBase = baseUrlOf(url);
    const dynamicKey = url.toLowerCase().includes('hubcloud') ? 'hubcloud' : 'vcloud';
    const fallbackBase = isVcloud ? VCLOUD_FALLBACK_BASE : HUBCLOUD_FALLBACK_BASE;
    const latestBase = await ctx.resolveBaseUrl(originalBase, dynamicKey);
    const targetUrl = rebaseDynamicUrl(url, latestBase.length > 0 ? latestBase : fallbackBase);

    const page = await ctx.fetchHtml(targetUrl);
    const $ = ctx.parseHtml(page.html);

    // Intermediate download URL resolution (Kotlin step 2).
    let intermediate: string;
    if (targetUrl.includes('/video/')) {
      intermediate = ($('div.vd > center > a').attr('href') ?? '').trim();
    } else {
      const scriptHtml = $('script').toArray().map((el) => $(el).html() ?? '').join('\n');
      const urlScript = scriptHtml.includes('url') ? scriptHtml : '';
      intermediate = isVcloud
        ? (extractDoubleAtob(urlScript) ?? '')
        : (extractPlainVarUrl(urlScript) ?? '');
    }
    if (!intermediate) return [];
    const cardUrl = intermediate.startsWith('http://') || intermediate.startsWith('https://')
      ? intermediate
      : joinUrl(latestBase.length > 0 ? latestBase : fallbackBase, intermediate);

    // File card (Kotlin step 3).
    let cardHtml = '';
    try {
      const cardPage = await ctx.fetchHtml(cardUrl);
      cardHtml = cardPage.html;
    } catch {
      return [];
    }
    const $card = ctx.parseHtml(cardHtml);
    const header = ($card('div.card-header').text() ?? '').trim();
    const size = ($card('i#size').text() ?? '').trim();
    const quality = qualityLabel(parseIndexQuality(header));

    const links: CloudStreamExtractedLink[] = [];
    const emit = (rawUrl: string, server: string) => {
      if (links.length >= MAX_HUBCLOUD_LINKS) return;
      if (typeof rawUrl !== 'string' || rawUrl.length === 0) return;
      if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://') && !rawUrl.startsWith('magnet:')) return;
      links.push({
        url: rawUrl,
        kind: classifyUrlKind(rawUrl),
        ...(header ? { filename: header } : {}),
        ...(size ? { sizeBytes: parseSizeBytes(size) } : {}),
        ...(quality ? { quality } : {}),
        sourceName: `${isVcloud ? 'V-Cloud' : 'Hub-Cloud'}${server}`,
        extractor: HUBCLOUD_ID,
      });
    };

    // Server buttons (Kotlin step 4: h2 a.btn).
    const buttons = $card('h2 a.btn').toArray();
    for (const button of buttons) {
      if (links.length >= MAX_HUBCLOUD_LINKS) break;
      const $button = $card(button);
      const text = ($button.text() ?? '').trim();
      const href = ($button.attr('href') ?? '').trim();

      try {
        if (text.includes('FSL Server')) {
          emit(href, ' [FSL Server]');
        } else if (text.includes('FSLv2')) {
          emit(href, ' [FSLv2 Server]');
        } else if (text.includes('Mega Server')) {
          emit(href, ' [Mega Server]');
        } else if (text.includes('Download File')) {
          emit(href, '');
        } else if (text.includes('BuzzServer')) {
          // Kotlin: GET <link>/download with referer, no redirects → hx-redirect.
          try {
            const buzzUrl = joinUrl(href, '/download');
            const probe = await ctx.fetchRedirect(buzzUrl);
            const dlink = probe.headerName === 'hx-redirect' ? (probe.headerValue ?? '') : '';
            if (dlink) emit(joinUrl(baseUrlOf(href), dlink), ' [BuzzServer]');
          } catch {
            // BuzzServer failure isolates to this button.
          }
        } else if (href.includes('pixeldra')) {
          const pixelLink = extractPxlUrl(cardHtml);
          if (pixelLink) {
            const finalUrl = pixelLink.includes('download') ? pixelLink : (pixeldrainDownloadUrl(pixelLink) ?? pixelLink);
            emit(finalUrl, ' [Pixeldrain]');
          }
        } else if (text.includes('Server : 10Gbps')) {
          try {
            let redirectUrl = await ctx.resolveRedirects(href);
            if (redirectUrl && redirectUrl.includes('link=')) {
              redirectUrl = redirectUrl.slice(redirectUrl.indexOf('link=') + 5);
            }
            if (redirectUrl) emit(redirectUrl, ' [Download]');
          } catch {
            // 10Gbps failure isolates to this button.
          }
        }
        // Gofile buttons delegate to the Kotlin global registry; Mavero runs
        // only owned ports — unknown hosts are skipped honestly.
      } catch {
        // One bad server button must never abort the walk.
      }
    }

    return links;
  },
};
