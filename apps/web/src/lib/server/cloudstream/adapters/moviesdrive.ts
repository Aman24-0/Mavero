/**
 * MAVERO CloudStream adapter — MoviesDrive port (CS-2).
 *
 * Faithful port of the verified Kotlin `MoviesDriveProvider`
 * (SaurabhKaperwan/CSX `MoviesDriveProvider.kt` + `Extractors.kt`):
 *
 *   * domain: dynamic urls.json key `moviesdrive` (fallback
 *     new5.moviesdrive.christmas);
 *   * search: `$mainUrl/search.php?q=<query>&page=1` JSON —
 *     `hits[].document.{permalink, post_thumbnail, post_title}`;
 *   * load: page title; series detection when the title contains
 *     'Episode', a `(?i)season\s*\d+` match, or 'series';
 *   * movie links: `h5 > a` buttons → each button page's `a` hrefs
 *     matching `hubcloud|gdflix|gdlink` (case-insensitive);
 *   * series: `h5 > a` (Zip excluded) → season number from the button's
 *     parent's PREVIOUS sibling text → button page → episode sources:
 *     either `span` elements matching `Ep` (walking NEXT siblings whose
 *     text matches hubcloud/gdflix/gdlink and taking their `a@href`, with
 *     the episode number from `Ep(\d{2})`), OR direct `a` elements
 *     matching `HubCloud|GDFlix` (numbered sequentially from 1);
 *   * extractors: gdflix/gdlink → GDFlix port; hubcloud → HubCloud port.
 *
 * Mavero deltas (documented, bounded): candidate ranking by normalized
 * title + year; fan-out bounded (≤20 candidates, ≤8 buttons, ≤24 links).
 */

import type {
  CloudStreamEpisodeRequest,
  CloudStreamLinkResult,
  CloudStreamResolveRequest,
  CloudStreamRuntimeContext,
  MaveroCloudStreamAdapter,
} from '../types/runtime';
import { buildNormalizedLink, type CloudStreamNormalizedLink } from '../normalize/links';
import { rankCandidates, parseSeasonNumber, classifyNetworkFailure } from './common';

const MOVIESDRIVE_ID = 'MoviesDrive';
const MOVIESDRIVE_FALLBACK_BASE = 'https://new5.moviesdrive.christmas';
const MOVIESDRIVE_DYNAMIC_KEY = 'moviesdrive';

/** Bounded fan-out constants (plan §10.5). */
const MAX_CANDIDATES = 20;
const MAX_BUTTONS = 8;
const MAX_SOURCE_LINKS = 24;

interface SearchHit {
  title: string;
  href: string;
}

/** search.php JSON API port (Kotlin: MSearchResponse). */
async function searchAndRank(
  req: CloudStreamResolveRequest,
  ctx: CloudStreamRuntimeContext,
): Promise<SearchHit[]> {
  const base = await ctx.resolveBaseUrl(MOVIESDRIVE_FALLBACK_BASE, MOVIESDRIVE_DYNAMIC_KEY);
  const query = encodeURIComponent(req.title.trim().slice(0, 100));
  const body = await ctx.fetchJson(`${base}/search.php?q=${query}&page=1`);

  const cards: SearchHit[] = [];
  if (typeof body === 'object' && body !== null && Array.isArray((body as { hits?: unknown }).hits)) {
    const hits = (body as { hits: unknown[] }).hits;
    for (const hit of hits) {
      if (cards.length >= MAX_CANDIDATES) break;
      if (typeof hit !== 'object' || hit === null) continue;
      const document = (hit as { document?: unknown }).document;
      if (typeof document !== 'object' || document === null) continue;
      const doc = document as { post_title?: unknown; permalink?: unknown };
      const title = typeof doc.post_title === 'string' ? doc.post_title.replace('Download ', '').trim() : '';
      const permalink = typeof doc.permalink === 'string' ? doc.permalink : '';
      if (title && permalink) {
        const href = permalink.startsWith('http') ? permalink : `${base}${permalink.startsWith('/') ? '' : '/'}${permalink}`;
        cards.push({ title, href });
      }
    }
  }

  return rankCandidates({ title: req.title, ...(req.year !== undefined ? { year: req.year } : {}) }, cards, MAX_CANDIDATES)
    .map((match) => ({ title: match.title, href: match.href }));
}

/** Kotlin series detection: title contains Episode / season regex / series. */
function isSeriesTitle(title: string): boolean {
  return /\bseason\s*\d+/i.test(title) || /\bepisode\b/i.test(title) || /\bseries\b/i.test(title);
}

/** Kotlin movie path: h5 > a buttons → inner hubcloud/gdflix/gdlink hrefs. */
async function movieSourcesFromPage(pageUrl: string, ctx: CloudStreamRuntimeContext): Promise<string[]> {
  const page = await ctx.fetchHtml(pageUrl);
  const $ = ctx.parseHtml(page.html);
  const sources: string[] = [];
  const buttons = $('h5 > a').toArray().slice(0, MAX_BUTTONS);
  for (const button of buttons) {
    const href = ($(button).attr('href') ?? '').trim();
    if (!href) continue;
    try {
      const innerPage = await ctx.fetchHtml(href);
      const $inner = ctx.parseHtml(innerPage.html);
      $inner('a').each((_, el) => {
        const link = ($inner(el).attr('href') ?? '').trim();
        if (link && /hubcloud|gdflix|gdlink/i.test(link) && sources.length < MAX_SOURCE_LINKS) {
          sources.push(link);
        }
      });
    } catch {
      // One broken button page never aborts the movie walk.
    }
  }
  return sources;
}

/** Kotlin series path (span Ep + next-sibling walk OR direct a elements). */
async function episodeSourcesFromPage(
  pageUrl: string,
  season: number,
  episode: number,
  ctx: CloudStreamRuntimeContext,
): Promise<string[]> {
  const page = await ctx.fetchHtml(pageUrl);
  const $ = ctx.parseHtml(page.html);

  const buttons = $('h5 > a').toArray()
    .filter((el) => !($(el).text() ?? '').toLowerCase().includes('zip'))
    .slice(0, MAX_BUTTONS);

  const episodeMap = new Map<string, string>();
  for (const button of buttons) {
    const $button = $(button);
    const href = ($button.attr('href') ?? '').trim();
    if (!href) continue;
    const parent = $button.parent();
    const prev = parent.length > 0 ? parent.prev() : null;
    const mainTitle = prev !== null && prev.length > 0 ? prev.text() : '';
    const buttonSeason = parseSeasonNumber(mainTitle) ?? 0;
    if (buttonSeason !== season) continue;

    try {
      const docPage = await ctx.fetchHtml(href);
      const $doc = ctx.parseHtml(docPage.html);

      // Kotlin branch 1: span elements containing 'Ep'.
      const spans = $doc('span').toArray().filter((el) => /ep/i.test($doc(el).text() ?? ''));
      if (spans.length > 0) {
        for (const span of spans) {
          const $span = $doc(span);
          const spanHtml = $span.toString();
          const epMatch = /Ep(\d{2})/.exec(spanHtml);
          const epNumber = epMatch ? Number.parseInt(epMatch[1]!, 10) : null;
          // Walk NEXT siblings whose text matches hubcloud/gdflix/gdlink.
          let sibling = $span.parent().next();
          let currentEp = epNumber ?? 0;
          while (sibling !== null && sibling.length > 0) {
            const siblingText = sibling.text() ?? '';
            if (/hubcloud|gdflix|gdlink/i.test(siblingText)) {
              const anchor = sibling.find('a').first();
              const link = (anchor.attr('href') ?? '').trim();
              if (link && currentEp > 0) {
                const key = `s${buttonSeason}e${currentEp}`;
                if (!episodeMap.has(key) && episodeMap.size < MAX_SOURCE_LINKS) episodeMap.set(key, link);
              }
              sibling = sibling.next();
              continue;
            }
            break;
          }
        }
      } else {
        // Kotlin branch 2: direct a elements matching HubCloud|GDFlix.
        const anchors = $doc('a').toArray().filter((el) => /hubcloud|gdflix/i.test($doc(el).text() ?? ''));
        let index = 1;
        for (const anchor of anchors) {
          const link = ($doc(anchor).attr('href') ?? '').trim();
          if (link) {
            const key = `s${buttonSeason}e${index}`;
            if (!episodeMap.has(key) && episodeMap.size < MAX_SOURCE_LINKS) episodeMap.set(key, link);
          }
          index += 1;
        }
      }
    } catch {
      // One broken button page never aborts the episode walk.
    }
  }

  const key = `s${season}e${episode}`;
  const direct = episodeMap.get(key);
  if (direct !== undefined) return [direct];
  // Fall back to positional index (Kotlin numbers sequentially from 1 when
  // the Ep regex does not match).
  const positional = [...episodeMap.values()][episode - 1];
  return positional !== undefined ? [positional] : [];
}

/** Runs every resolved source URL through the extractor registry. */
async function extractSources(
  sources: string[],
  ctx: CloudStreamRuntimeContext,
  adapterId: string,
): Promise<CloudStreamNormalizedLink[]> {
  const links: CloudStreamNormalizedLink[] = [];
  for (const source of sources.slice(0, MAX_SOURCE_LINKS)) {
    if (typeof source !== 'string' || source.length === 0) continue;
    const extracted = await ctx.runExtractor(source, { label: adapterId });
    for (const link of extracted) {
      if (links.length >= MAX_SOURCE_LINKS) break;
      links.push(buildNormalizedLink(link, adapterId));
    }
  }
  return links;
}

export const moviesdriveAdapter: MaveroCloudStreamAdapter = {
  id: MOVIESDRIVE_ID,
  version: '1.0.0',
  displayName: 'MoviesDrive',
  language: 'hi',
  supports: { movie: true, series: true, anime: true },

  async resolveMovie(req: CloudStreamResolveRequest, ctx: CloudStreamRuntimeContext): Promise<CloudStreamLinkResult> {
    try {
      return await resolveMovieInner(req, ctx);
    } catch (error) {
      return { links: [], failure: classifyNetworkFailure(error) };
    }
  },

  async resolveEpisode(req: CloudStreamEpisodeRequest, ctx: CloudStreamRuntimeContext): Promise<CloudStreamLinkResult> {
    try {
      return await resolveEpisodeInner(req, ctx);
    } catch (error) {
      return { links: [], failure: classifyNetworkFailure(error) };
    }
  },
};

async function resolveMovieInner(req: CloudStreamResolveRequest, ctx: CloudStreamRuntimeContext): Promise<CloudStreamLinkResult> {
  const candidates = await searchAndRank(req, ctx);
  if (candidates.length === 0) {
    return { links: [], failure: { category: 'NO_MATCH', message: 'No matching title was found on MoviesDrive.' } };
  }
  const best = candidates[0]!;
  const page = await ctx.fetchHtml(best.href);
  const $ = ctx.parseHtml(page.html);
  const title = ($('title').first().text() ?? '').replace('Download ', '').trim();

  if (isSeriesTitle(title)) {
    return { links: [], failure: { category: 'UNSUPPORTED', message: 'The matched MoviesDrive title is a series; episode context is required.' } };
  }

  const sources = await movieSourcesFromPage(best.href, ctx);
  if (sources.length === 0) {
    return { links: [], failure: { category: 'NO_LINKS', message: 'The MoviesDrive page contained no resolvable download links.' } };
  }

  const links = await extractSources(sources, ctx, MOVIESDRIVE_ID);
  return {
    links,
    matchedTitle: title || best.title,
    ...(links.length === 0 ? { failure: { category: 'EXTRACTOR_FAILED', message: 'MoviesDrive sources were found but no extractor could resolve them.' } } : {}),
  };
}

async function resolveEpisodeInner(req: CloudStreamEpisodeRequest, ctx: CloudStreamRuntimeContext): Promise<CloudStreamLinkResult> {
  const candidates = await searchAndRank(req, ctx);
  if (candidates.length === 0) {
    return { links: [], failure: { category: 'NO_MATCH', message: 'No matching title was found on MoviesDrive.' } };
  }
  const best = candidates[0]!;
  const page = await ctx.fetchHtml(best.href);
  const $ = ctx.parseHtml(page.html);
  const title = ($('title').first().text() ?? '').replace('Download ', '').trim();
  if (!isSeriesTitle(title)) {
    return { links: [], failure: { category: 'UNSUPPORTED', message: 'The matched MoviesDrive title is a movie, not a series.' } };
  }

  const sources = await episodeSourcesFromPage(best.href, req.season, req.episode, ctx);
  if (sources.length === 0) {
    return { links: [], failure: { category: 'NO_LINKS', message: `No download links were found for season ${req.season} episode ${req.episode} on MoviesDrive.` } };
  }

  const links = await extractSources(sources, ctx, MOVIESDRIVE_ID);
  return {
    links,
    matchedTitle: title || best.title,
    ...(links.length === 0 ? { failure: { category: 'EXTRACTOR_FAILED', message: 'MoviesDrive episode sources were found but no extractor could resolve them.' } } : {}),
  };
}
