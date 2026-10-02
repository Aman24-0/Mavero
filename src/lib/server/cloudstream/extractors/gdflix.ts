/**
 * MAVERO CloudStream extractor — GDFlix port (CS-2).
 *
 * Faithful port of the verified Kotlin `GDFlix` extractor (Bollyflix +
 * MoviesDrive + VegaMovies/CSX `Extractors.kt`, all four copies identical):
 *
 *   1. resolve the CURRENT gdflix domain from the shared urls.json
 *      (`new4.gdflix.io` at verification time) and rebase the link;
 *   2. load the file page: `ul > li.list-group-item` rows carry
 *      `Name : <file>` and `Size : <size>`;
 *   3. walk `div.text-center a` server buttons and emit direct links per
 *      server label: FSL V2 / DIRECT DL / DIRECT SERVER / CLOUD DOWNLOAD
 *      [R2] are direct; GD Index opens two `?type=1|2` CF pages
 *      (`a.btn-success` hrefs); FAST CLOUD opens one card page
 *      (`div.card-body a@href`); pixeldrain links convert to the API
 *      download URL; Instant DL follows one no-redirect hop and strips
 *      `url=`; GoFile delegates to loadExtractor (unknown in Mavero →
 *      skipped honestly).
 *
 * Bounds: every fetch is SSRF-guarded + timeout-capped through the runtime
 * context; the emitted link count is capped (no unbounded fan-out); failures
 * of individual server buttons never abort the whole page walk.
 */

import type { MaveroCloudStreamExtractor, CloudStreamRuntimeContext } from '../types/runtime';
import type { CloudStreamExtractedLink } from '../normalize/links';
import { classifyUrlKind, parseSizeBytes, parseIndexQuality, qualityLabel, pixeldrainDownloadUrl } from '../normalize/links';
import { rebaseDynamicUrl } from '../runtime/dynamic-urls';

const GDFLIX_ID = 'gdflix';
const GDFLIX_FALLBACK_BASE = 'https://new4.gdflix.io';
const GDFLIX_DYNAMIC_KEY = 'gdflix';
/** Bounded server-button fan-out per extractor call. */
const MAX_GDFLIX_LINKS = 24;

/** Kotlin `getBaseUrl` port. */
function baseUrlOf(url: string): string {
  try {
    return `${new URL(url).protocol}//${new URL(url).host}`;
  } catch {
    return url;
  }
}

/** Kotlin `substringAfter("Name : ")` port — '' when the delimiter is absent. */
function textAfter(haystack: string, delimiter: string): string {
  const index = haystack.indexOf(delimiter);
  return index === -1 ? '' : haystack.slice(index + delimiter.length).trim();
}

/** Joins a possibly-relative link onto a base (never double-concatenates). */
function joinUrl(base: string, link: string): string {
  if (link.startsWith('http://') || link.startsWith('https://')) return link;
  if (link.startsWith('/')) return `${base}${link}`;
  return `${base}/${link}`;
}

export const gdflixExtractor: MaveroCloudStreamExtractor = {
  id: GDFLIX_ID,
  displayName: 'GDFlix',
  matches(url: string): boolean {
    return /(^|\.|\/\/)gdflix\./i.test(url) || /gdlink\./i.test(url);
  },

  async extract(url: string, ctx: CloudStreamRuntimeContext): Promise<CloudStreamExtractedLink[]> {
    const originalBase = baseUrlOf(url);
    const latestBase = await ctx.resolveBaseUrl(originalBase, GDFLIX_DYNAMIC_KEY);
    const targetUrl = rebaseDynamicUrl(url, latestBase);

    const page = await ctx.fetchHtml(targetUrl);
    const $ = ctx.parseHtml(page.html);

    // File metadata rows (Kotlin: li.list-group-item:contains(Name)/:contains(Size)).
    let fileName = '';
    let fileSize = '';
    $('ul > li.list-group-item').each((_, el) => {
      const text = $(el).text().trim();
      if (!fileName && text.includes('Name')) fileName = textAfter(text, 'Name :');
      if (!fileSize && text.includes('Size')) fileSize = textAfter(text, 'Size :');
    });
    const quality = qualityLabel(parseIndexQuality(fileName));

    const links: CloudStreamExtractedLink[] = [];
    const emit = (rawUrl: string, server: string) => {
      if (links.length >= MAX_GDFLIX_LINKS) return;
      if (typeof rawUrl !== 'string' || rawUrl.length === 0) return;
      if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://') && !rawUrl.startsWith('magnet:')) return;
      links.push({
        url: rawUrl,
        kind: classifyUrlKind(rawUrl),
        ...(fileName ? { filename: fileName } : {}),
        ...(fileSize ? { sizeBytes: parseSizeBytes(fileSize) } : {}),
        ...(quality ? { quality } : {}),
        sourceName: `GDFlix${server}`,
        extractor: GDFLIX_ID,
      });
    };

    // Server buttons (Kotlin: div.text-center a).
    const anchors = $('div.text-center a').toArray();
    for (const anchor of anchors) {
      if (links.length >= MAX_GDFLIX_LINKS) break;
      const $anchor = $(anchor);
      const text = ($anchor.text() || '').trim();
      const href = ($anchor.attr('href') ?? '').trim();

      try {
        if (text.includes('FSL V2')) {
          emit(href, ' [FSL V2]');
        } else if (text.includes('DIRECT DL') || text.includes('DIRECT SERVER')) {
          emit(href, ' [Direct]');
        } else if (text.includes('CLOUD DOWNLOAD [R2]')) {
          emit(href, ' [Cloud]');
        } else if (text.includes('GD Index')) {
          // Kotlin: two CF pages (?type=1|2) → a.btn-success hrefs.
          for (const cfType of [1, 2]) {
            if (links.length >= MAX_GDFLIX_LINKS) break;
            try {
              const cfPage = await ctx.fetchHtml(joinUrl(latestBase, `${href}?type=${cfType}`));
              const $cf = ctx.parseHtml(cfPage.html);
              $cf('a.btn-success').each((__, el) => {
                emit($(el).attr('href') ?? '', ' [CF]');
              });
            } catch {
              // CF page failure isolates to this button.
            }
          }
        } else if (text.includes('FAST CLOUD')) {
          try {
            const fastPage = await ctx.fetchHtml(joinUrl(latestBase, href));
            const $fast = ctx.parseHtml(fastPage.html);
            const dlink = ($fast('div.card-body a').attr('href') ?? '').trim();
            if (dlink) emit(dlink, ' [FAST CLOUD]');
          } catch {
            // FAST CLOUD failure isolates to this button.
          }
        } else if (href.includes('pixeldra')) {
          const pixelLink = href.includes('download') ? href : (pixeldrainDownloadUrl(href) ?? href);
          emit(pixelLink, ' [Pixeldrain]');
        } else if (text.includes('Instant DL')) {
          try {
            const probe = await ctx.fetchRedirect(href);
            const location = probe.headerValue ?? '';
            const instantLink = location.includes('url=') ? location.slice(location.indexOf('url=') + 4) : location;
            if (instantLink) emit(instantLink, ' [Instant Download]');
          } catch {
            // Instant DL failure isolates to this button.
          }
        }
        // GoFile buttons delegate to the Kotlin global registry; Mavero runs
        // only owned ports — unknown hosts are skipped honestly.
      } catch {
        // One bad server button must never abort the page walk.
      }
    }

    return links;
  },
};
