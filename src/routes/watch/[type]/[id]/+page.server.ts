import { error } from '@sveltejs/kit';
import { getDetail, getSeriesSeason } from '$lib/server/content/service';
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
    }
    let streamingConfig;
    try {
      streamingConfig = await getPublicStreamingConfig(locals.supabase);
    } catch {
      streamingConfig = { version: 1, updatedAt: new Date(0).toISOString(), providers: [], sources: [], categories: [], sourceCategories: [] };
    }
    return { item: toMediaItem(item), streamingConfig, episodes };
  } catch {
    throw error(404, 'Title not found');
  }
};
