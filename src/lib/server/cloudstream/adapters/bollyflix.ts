/**
 * MAVERO CloudStream adapter — Bollyflix port (CS-2).
 *
 * Faithful port of the verified Kotlin `BollyflixProvider`
 * (SaurabhKaperwan/CSX `BollyflixProvider.kt` + `Extractors.kt`):
 *
 *   * domain: dynamic urls.json key `bollyflix` (fallback new.bollyflix.vote);
 *   * search: `$mainUrl/search/<query>/page/1/` HTML →
 *     `div.post-cards > article` cards (a@title minus 'Download ', a@href);
 *   * load: page `<title>` minus 'Download '; series detection when the
 *     title contains 'Series' OR the URL contains 'web-series';
 *   * movie links: `a.dl` buttons; `?id=` links resolve through the
 *     sidexfee base64 bypass; `fastdlserver` links pass through directly;
 *   * series: buttons (`a.maxbutton-download-links, a.dl, a.btnn`) →
 *     season number from the button's parent's PREVIOUS sibling text
 *     (`(?:Season |S)(\d+)`) → load the season page → `h3 > a` episode
 *     links (Zip excluded), numbered sequentially from 1;
 *   * extractors: gdflix/gdlink → GDFlix port; fastdlserver → the
 *     redirect-hop port; anything else → Mavero-owned registry only.
 *
 * Mavero deltas (documented, bounded): result matching ranks candidates by
 * normalized title + year (CloudStream relies on human selection in-app);
 * fan-out is bounded (≤20 candidates, ≤8 season buttons, ≤24 links).
 */

import type {
  CloudStreamEpisodeRequest,
  CloudStreamLinkResult,
  CloudStreamResolveRequest,
  CloudStreamRuntimeContext,
  MaveroCloudStreamAdapter,
} from '../types/runtime';
import { buildNormalizedLink, type CloudStreamNormalizedLink } from '../normalize/links';
import { rankCandidates, parseSeasonNumber, sidexfeeBypass, classifyNetworkFailure } from './common';

const BOLLYFLIX_ID = 'Bollyflix';
const BOLLYFLIX_FALLBACK_BASE = 'https://new.bollyflix.vote';
const BOLLYFLIX_DYNAMIC_KEY = 'bollyflix';

/** Bounded fan-out constants (plan §10.5). */
const MAX_CANDIDATES = 20;
const MAX_SEASON_BUTTONS = 8;
const MAX_EPISODE_LINKS = 24;
const MAX_SOURCE_LINKS = 24;

interface SearchCard {
  title: string;
  href: string;
}

/** Search + rank port (Kotlin: search() → article cards). */
async function searchAndRank(
  req: CloudStreamResolveRequest,
  ctx: CloudStreamRuntimeContext,
): Promise<SearchCard[]> {
  const base = await ctx.resolveBaseUrl(BOLLYFLIX_FALLBACK_BASE, BOLLYFLIX_DYNAMIC_KEY);
  const query = encodeURIComponent(req.title.trim().slice(0, 100));
  const page = await ctx.fetchHtml(`${base}/search/${query}/page/1/`);
  const $ = ctx.parseHtml(page.html);

  const cards: SearchCard[] = [];
  $('div.post-cards > article').each((_, el) => {
    if (cards.length >= MAX_CANDIDATES) return;
    const $card = $(el);
    const title = ($card.find('a').attr('title') ?? '').replace('Download ', '').trim();
    const href = ($card.find('a').attr('href') ?? '').trim();
    if (title && href) cards.push({ title, href });
  });

  return rankCandidates({ title: req.title, ...(req.year !== undefined ? { year: req.year } : {}) }, cards, MAX_CANDIDATES)
    .map((match) => ({ title: match.title, href: match.href }));
}

/** Resolves one `a.dl`-style source URL through the bypass when required. */
async function resolveSourceLink(href: string, ctx: CloudStreamRuntimeContext): Promise<string | null> {
  if (href.includes('fastdlserver')) return href;
  if (href.includes('?id=')) {
    const id = href.slice(href.lastIndexOf('id=') + 3).split('&')[0] ?? '';
    return sidexfeeBypass(id, ctx);
  }
  return href.startsWith('http://') || href.startsWith('https://') ? href : null;
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
    // Kotlin parity: gdflix/gdlink + fastdlserver + loadExtractor registry.
    const extracted = await ctx.runExtractor(source, { label: adapterId });
    for (const link of extracted) {
      if (links.length >= MAX_SOURCE_LINKS) break;
      links.push(buildNormalizedLink(link, adapterId));
    }
  }
  return links;
}

export const bollyflixAdapter: MaveroCloudStreamAdapter = {
  id: BOLLYFLIX_ID,
  version: '1.0.0',
  displayName: 'BollyFlix',
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
      return { links: [], failure: { category: 'NO_MATCH', message: 'No matching title was found on Bollyflix.' } };
    }
    const best = candidates[0]!;
    const page = await ctx.fetchHtml(best.href);
    const $ = ctx.parseHtml(page.html);

    const title = ($('title').first().text() ?? '').replace('Download ', '').trim();
    // Kotlin: series when title contains 'Series' or url contains 'web-series'.
    const isSeries = title.includes('Series') || best.href.includes('web-series');

    if (isSeries) {
      // A movie request against a series page: the provider organizes
      // series as season pages → episodes; without episode context this
      // resolution cannot produce movie links → honest unsupported.
      return { links: [], failure: { category: 'UNSUPPORTED', message: 'The matched Bollyflix title is a series; episode context is required.' } };
    }

    const hrefs: string[] = [];
    $('a.dl').each((_, el) => {
      const href = ($(el).attr('href') ?? '').trim();
      if (href) hrefs.push(href);
    });
    if (hrefs.length === 0) {
      return { links: [], failure: { category: 'NO_LINKS', message: 'The Bollyflix page contained no download links.' } };
    }

    const sources: string[] = [];
    for (const href of hrefs.slice(0, MAX_SOURCE_LINKS)) {
      const resolved = await resolveSourceLink(href, ctx);
      if (resolved) sources.push(resolved);
    }
    if (sources.length === 0) {
      return { links: [], failure: { category: 'NO_LINKS', message: 'The Bollyflix download buttons could not be resolved.' } };
    }

    const links = await extractSources(sources, ctx, BOLLYFLIX_ID);
    return {
      links,
      matchedTitle: title || best.title,
      ...(links.length === 0 ? { failure: { category: 'EXTRACTOR_FAILED', message: 'Bollyflix sources were found but no extractor could resolve them.' } } : {}),
    };
}


async function resolveEpisodeInner(req: CloudStreamEpisodeRequest, ctx: CloudStreamRuntimeContext): Promise<CloudStreamLinkResult> {
    const candidates = await searchAndRank(req, ctx);
    if (candidates.length === 0) {
      return { links: [], failure: { category: 'NO_MATCH', message: 'No matching title was found on Bollyflix.' } };
    }
    const best = candidates[0]!;
    const page = await ctx.fetchHtml(best.href);
    const $ = ctx.parseHtml(page.html);
    const title = ($('title').first().text() ?? '').replace('Download ', '').trim();
    const isSeries = title.includes('Series') || best.href.includes('web-series');
    if (!isSeries) {
      return { links: [], failure: { category: 'UNSUPPORTED', message: 'The matched Bollyflix title is a movie, not a series.' } };
    }

    // Kotlin: buttons a.maxbutton-download-links, a.dl, a.btnn — each opens
    // a season page; the season number lives in the button's parent's
    // PREVIOUS sibling text.
    const buttons = $('a.maxbutton-download-links, a.dl, a.btnn').toArray().slice(0, MAX_SEASON_BUTTONS);
    const seasonTargets: Array<{ season: number; url: string }> = [];
    for (const button of buttons) {
      const $button = $(button);
      let href = ($button.attr('href') ?? '').trim();
      if (!href) continue;
      // Bypass resolution happens per season page (Kotlin resolves the
      // button href BEFORE loading the season document).
      const parent = $button.parent();
      const prev = parent.length > 0 ? parent.prev() : null;
      const seasonText = prev !== null && prev.length > 0 ? prev.text() : '';
      const season = parseSeasonNumber(seasonText) ?? 0;

      if (!href.includes('fastdlserver') && href.includes('?id=')) {
        const id = href.slice(href.lastIndexOf('id=') + 3).split('&')[0] ?? '';
        const bypassed = await sidexfeeBypass(id, ctx);
        if (bypassed === null) continue;
        href = bypassed;
      }
      seasonTargets.push({ season, url: href });
    }

    // Only the requested season's pages are walked (bounded).
    const requestedSeasonPages = seasonTargets.filter((target) => target.season === req.season);
    const pagesToWalk = requestedSeasonPages.length > 0 ? requestedSeasonPages : seasonTargets;

    const episodeSources: string[] = [];
    for (const target of pagesToWalk.slice(0, MAX_SEASON_BUTTONS)) {
      try {
        const seasonPage = await ctx.fetchHtml(target.url);
        const $season = ctx.parseHtml(seasonPage.html);
        // Kotlin: h3 > a links, Zip excluded, numbered sequentially from 1.
        const episodeLinks: string[] = [];
        $season('h3 > a').each((_, el) => {
          const text = ($(el).text() ?? '').trim();
          if (text.toLowerCase().includes('zip')) return;
          const href = ($(el).attr('href') ?? '').trim();
          if (href) episodeLinks.push(href);
        });
        const index = req.episode - 1;
        const chosen = episodeLinks[index];
        if (chosen) episodeSources.push(chosen);
      } catch {
        // One broken season page never aborts the episode walk.
      }
    }

    if (episodeSources.length === 0) {
      return { links: [], failure: { category: 'NO_LINKS', message: `No download links were found for season ${req.season} episode ${req.episode} on Bollyflix.` } };
    }

    const links = await extractSources(episodeSources, ctx, BOLLYFLIX_ID);
    return {
      links,
      matchedTitle: title || best.title,
      ...(links.length === 0 ? { failure: { category: 'EXTRACTOR_FAILED', message: 'Bollyflix episode sources were found but no extractor could resolve them.' } } : {}),
    };
}

