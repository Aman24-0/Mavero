import { discover, getFixtureContent } from './service';
import { toMediaItem } from './presenter';
import type { ContentType } from './types';
import type { MediaItem } from '$data/content';

async function loadRail(type: ContentType): Promise<MediaItem[]> {
  try {
    const result = await discover(type, 1);
    return result.items.map(toMediaItem);
  } catch {
    return getFixtureContent(type).map(toMediaItem);
  }
}

export async function loadCollectionData(type: ContentType) {
  const items = await loadRail(type);
  return { items, type };
}

export async function loadDiscoverData() {
  const [movies, series, anime] = await Promise.all([loadRail('movie'), loadRail('series'), loadRail('anime')]);
  return {
    movies,
    series,
    anime,
    featured: movies[0]
  };
}
