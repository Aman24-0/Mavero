import { error } from '@sveltejs/kit';
import { getAnimeSeason, getDetail, getSeriesSeason } from '$lib/server/content/service';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType } from '$lib/server/content/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
  if (!isContentType(params.type)) throw error(404, 'Unsupported content type');
  try {
    const item = await getDetail(params.type, params.id);
    let episodes = item.seasonsData?.flatMap((season) => season.episodes ?? []) ?? [];
    if (params.type === 'series') {
      const seasonNumber = Number(url.searchParams.get('season') || '') || 1;
      try {
        const season = await getSeriesSeason(params.id, seasonNumber);
        episodes = season.episodes ?? episodes;
      } catch {
        // Episode navigation stays optional when the provider cannot load a season.
      }
    } else if (params.type === 'anime' || item.isAnime === true) {
      // Phase 7F+ (anime routing): for anime series (including TMDB-tagged
      // anime series like Attack on Titan), fetch the episode guide via
      // Jikan (MyAnimeList API). For anime movies (Demon Slayer: Infinity
      // Castle), getAnimeSeason returns an empty episode list — no guide.
      if (item.animeFormat !== 'movie') {
        try {
          const season = await getAnimeSeason(item, 1);
          episodes = season.episodes ?? [];
        } catch {
          // Jikan failure is non-fatal — episodes stays empty, the player
          // still works with default episode=1.
        }
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
