/**
 * MAVERO CloudStream adapter — VegaMovies port (CS-2).
 *
 * Faithful port of the verified Kotlin `VegaMoviesProvider`
 * (SaurabhKaperwan/CSX `VegaMoviesProvider.kt` + `Extractors.kt`):
 *
 *   * domain: dynamic urls.json key `vegamovies` (fallback
 *     vegamovies.gallery);
 *   * search: `$mainUrl/search.php?q=<query>&page=1` JSON —
 *     `hits[].document.{post_title, permalink, post_thumbnail}`;
 *   * load: page title; series detection when an `h3` matching
 *     `(?i)Series-SYNOPSIS/PLOT | Series Info | Series synopsis/PLOT`
 *     exists;
 *   * movie links: `a:has(button.dwd-button)` buttons → each button page's
 *     `a:contains(V-Cloud)@href`;
 *   * series: `main > h3/h5` elements matching `(?i)(4K|[0-9]*0p)` (Zip
 *     excluded) → season number regex from the tag → the NEXT `p` sibling's
 *     anchors (or the tag's own) → the first anchor whose text matches
 *     V-Cloud / Episode / Download (fallback G-Direct) → that page's
 *     `p > a` hrefs containing `vcloud`, indexed by position (1-based) as
 *     the episode number;
 *   * extractors: vcloud → the Hub-Cloud port (vcloud dynamic key).
 *
 * Mavero deltas (documented, bounded): candidate ranking by normalized
 * title + year; fan-out bounded (≤20 candidates, ≤8 tags, ≤24 links).
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
import type { CheerioAPI } from 'cheerio';

const VEGAMOVIES_ID = 'VegaMovies';
const VEGAMOVIES_FALLBACK_BASE = 'https://vegamovies.gallery';
const VEGAMOVIES_DYNAMIC_KEY = 'vegamovies';

/** Bounded fan-out constants (plan §10.5). */
const MAX_CANDIDATES = 20;
const MAX_QUALITY_TAGS = 8;
const MAX_SOURCE_LINKS = 24;

interface SearchHit {
  title: string;
  href: string;
}

/** search.php JSON API port (Kotlin: VegaSearchResponse). */
async function searchAndRank(
  req: CloudStreamResolveRequest,
  ctx: CloudStreamRuntimeContext,
): Promise<SearchHit[]> {
  const base = await ctx.resolveBaseUrl(VEGAMOVIES_FALLBACK_BASE, VEGAMOVIES_DYNAMIC_KEY);
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

/** Kotlin series detection: h3 matching the Series-Info headline variants. */
function hasSeriesHeadline($: CheerioAPI): boolean {
  const h3Texts = $('h3').toArray().map((el) => $(el).text() ?? '');
  return h3Texts.some((text) => /series[- ]?(synopsis\/plot|info)/i.test(text ?? ''));
}

/** Kotlin quality-tag matcher: (?i)(4K|[0-9]*0p) excluding Zip. */
function isQualityTag(text: string): boolean {
  if (!text || text.toLowerCase().includes('zip')) return false;
  return /(?:4k|\d*0p)/i.test(text);
}

/** Kotlin movie path: a:has(button.dwd-button) → a:contains(V-Cloud). */
async function movieSourcesFromPage(pageUrl: string, ctx: CloudStreamRuntimeContext): Promise<string[]> {
  const page = await ctx.fetchHtml(pageUrl);
  const $ = ctx.parseHtml(page.html);
  const sources: string[] = [];
  const buttons = $('a:has(button.dwd-button)').toArray().slice(0, MAX_QUALITY_TAGS);
  for (const button of buttons) {
    const href = ($(button).attr('href') ?? '').trim();
    if (!href) continue;
    try {
      const innerPage = await ctx.fetchHtml(href);
      const $inner = ctx.parseHtml(innerPage.html);
      $inner('a').each((_, el) => {
        const text = $inner(el).text() ?? '';
        if (text.includes('V-Cloud')) {
          const link = ($inner(el).attr('href') ?? '').trim();
          if (link && sources.length < MAX_SOURCE_LINKS) sources.push(link);
        }
      });
    } catch {
      // One broken button page never aborts the movie walk.
    }
  }
  return sources;
}

/** Kotlin series path: quality tags → V-Cloud/Episode link page → p > a[vcloud]. */
async function episodeSourcesFromPage(
  pageUrl: string,
  season: number,
  episode: number,
  ctx: CloudStreamRuntimeContext,
): Promise<string[]> {
  const page = await ctx.fetchHtml(pageUrl);
  const $ = ctx.parseHtml(page.html);

  const episodeMap = new Map<string, string>();
  const tags = $('main > h3, main > h5').toArray()
    .filter((el) => isQualityTag($(el).text() ?? ''))
    .slice(0, MAX_QUALITY_TAGS);

  for (const tag of tags) {
    const $tag = $(tag);
    const tagSeason = parseSeasonNumber($tag.toString()) ?? 0;
    if (tagSeason !== season) continue;

    // Kotlin: the NEXT sibling when it is a <p>, else the tag's own anchors.
    const next = $tag.next();
    const anchors = next.length > 0 && next.prop('tagName')?.toLowerCase() === 'p'
      ? next.find('a')
      : $tag.find('a');

    let unilinkHref: string | null = null;
    for (const el of anchors.toArray()) {
      const text = $(el).text() ?? '';
      if (/v-?cloud/i.test(text) || /episode/i.test(text) || /download/i.test(text)) {
        unilinkHref = $(el).attr('href') ?? null;
        break;
      }
    }
    if (unilinkHref === null) {
      // Kotlin fallback: the G-Direct anchor.
      for (const el of anchors.toArray()) {
        const text = $(el).text() ?? '';
        if (/g-?direct/i.test(text)) {
          unilinkHref = $(el).attr('href') ?? null;
          break;
        }
      }
    }
    if (unilinkHref === null) continue;

    const episodePageUrl = unilinkHref.trim();
    if (!episodePageUrl) continue;

    try {
      const episodePage = await ctx.fetchHtml(episodePageUrl);
      const $ep = ctx.parseHtml(episodePage.html);
      const vcloudLinks: string[] = [];
      $ep('p > a').each((_, el) => {
        const href = ($ep(el).attr('href') ?? '').trim();
        if (href && href.toLowerCase().includes('vcloud') && vcloudLinks.length < MAX_SOURCE_LINKS) {
          vcloudLinks.push(href);
        }
      });
      // Kotlin: episode number = position in the vcloud link list (1-based).
      const index = episode - 1;
      const chosen = vcloudLinks[index];
      if (chosen !== undefined) {
        const key = `s${season}e${episode}`;
        if (!episodeMap.has(key) && episodeMap.size < MAX_SOURCE_LINKS) episodeMap.set(key, chosen);
      }
    } catch {
      // One broken episode page never aborts the walk.
    }
  }

  const key = `s${season}e${episode}`;
  const direct = episodeMap.get(key);
  return direct !== undefined ? [direct] : [];
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

export const vegamoviesAdapter: MaveroCloudStreamAdapter = {
  id: VEGAMOVIES_ID,
  version: '1.0.0',
  displayName: 'VegaMovies',
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
    return { links: [], failure: { category: 'NO_MATCH', message: 'No matching title was found on VegaMovies.' } };
  }
  const best = candidates[0]!;
  const page = await ctx.fetchHtml(best.href);
  const $ = ctx.parseHtml(page.html);
  const title = ($('title').first().text() ?? '').replace('Download ', '').trim();

  if (hasSeriesHeadline($)) {
    return { links: [], failure: { category: 'UNSUPPORTED', message: 'The matched VegaMovies title is a series; episode context is required.' } };
  }

  const sources = await movieSourcesFromPage(best.href, ctx);
  if (sources.length === 0) {
    return { links: [], failure: { category: 'NO_LINKS', message: 'The VegaMovies page contained no resolvable download links.' } };
  }

  const links = await extractSources(sources, ctx, VEGAMOVIES_ID);
  return {
    links,
    matchedTitle: title || best.title,
    ...(links.length === 0 ? { failure: { category: 'EXTRACTOR_FAILED', message: 'VegaMovies sources were found but no extractor could resolve them.' } } : {}),
  };
}

async function resolveEpisodeInner(req: CloudStreamEpisodeRequest, ctx: CloudStreamRuntimeContext): Promise<CloudStreamLinkResult> {
  const candidates = await searchAndRank(req, ctx);
  if (candidates.length === 0) {
    return { links: [], failure: { category: 'NO_MATCH', message: 'No matching title was found on VegaMovies.' } };
  }
  const best = candidates[0]!;
  const page = await ctx.fetchHtml(best.href);
  const $ = ctx.parseHtml(page.html);
  if (!hasSeriesHeadline($)) {
    return { links: [], failure: { category: 'UNSUPPORTED', message: 'The matched VegaMovies title is a movie, not a series.' } };
  }
  const title = ($('title').first().text() ?? '').replace('Download ', '').trim();

  const sources = await episodeSourcesFromPage(best.href, req.season, req.episode, ctx);
  if (sources.length === 0) {
    return { links: [], failure: { category: 'NO_LINKS', message: `No download links were found for season ${req.season} episode ${req.episode} on VegaMovies.` } };
  }

  const links = await extractSources(sources, ctx, VEGAMOVIES_ID);
  return {
    links,
    matchedTitle: title || best.title,
    ...(links.length === 0 ? { failure: { category: 'EXTRACTOR_FAILED', message: 'VegaMovies episode sources were found but no extractor could resolve them.' } } : {}),
  };
}
