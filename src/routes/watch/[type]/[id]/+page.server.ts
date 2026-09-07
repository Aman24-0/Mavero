import { error } from '@sveltejs/kit';
import { getDetail, getSeriesSeason } from '$lib/server/content/service';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, cookies, url }) => {
  if (!isContentType(params.type)) throw error(404, 'Unsupported content type');

  // Phase 6 — direct watch enforcement (server-side, non-disclosing).
  //
  // The watch route is the highest-value adult bypass: it returns protected
  // metadata, episode data AND streaming configuration for any TMDB id.
  // Before ANY watch data is returned, the resolved title is classified by
  // the ONE central classifier (getDetail -> getTmdbDetail tags the detail
  // 'Adult' through isAdultContent over networks/providers/adult/isAnime)
  // and the CURRENT REQUEST's authorization is evaluated with the Phase 5
  // policy function (fresh per-request admin policy + verified preference —
  // never cached, never client-controlled).
  //
  // Adult + unauthorized -> the SAME non-disclosing 404 as any missing
  // title: no title, no Adult classification, no provider/network details,
  // no episode data, no streaming configuration, no resolver hints. The
  // client cannot distinguish "adult and forbidden" from "does not exist".
  let item;
  try {
    // Anime content is now backed by TMDB TV. getDetail('anime', id) maps
    // internally to the TMDB /tv/{id} endpoint and returns an item with
    // type='series' + isAnime=true (when genre 16 + 'ja' match).
    item = await getDetail(params.type, params.id);
  } catch {
    // Fail-closed: an unresolvable title (including a failed classification
    // fetch) is a 404 — never an unclassified watch page.
    throw error(404, 'Title not found');
  }
  if (detailVerdict(item.tags) === 'adult') {
    const { user } = await locals.safeGetSession();
    const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
    if (!canAccess) {
      throw error(404, 'Title not found');
    }
  }

  try {
    let episodes = item.seasonsData?.flatMap((season) => season.episodes ?? []) ?? [];
    // For series AND anime series, fetch the explicit season episode list
    // via TMDB. Anime movies (animeFormat === 'movie') have no episode
    // guide — the player just plays the movie file.
    const isSeriesLike = params.type === 'series'
      || (item.isAnime === true && item.animeFormat !== 'movie')
      || params.type === 'anime';
    if (isSeriesLike) {
      const seasonNumber = Number(url.searchParams.get('season') || '') || 1;
      try {
        const season = await getSeriesSeason(params.id, seasonNumber);
        episodes = season.episodes ?? episodes;
      } catch {
        // Episode navigation stays optional when the provider cannot load a season.
      }
    }
    let streamingConfig;
    try {
      streamingConfig = await getPublicStreamingConfig(locals.supabase);
    } catch {
      streamingConfig = { version: 1, updatedAt: new Date(0).toISOString(), providers: [], sources: [], categories: [], sourceCategories: [], defaults: {} };
    }
    return { item: toMediaItem(item), streamingConfig, episodes };
  } catch {
    throw error(404, 'Title not found');
  }
};
