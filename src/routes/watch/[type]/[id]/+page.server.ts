import { error } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType } from '$lib/server/content/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  if (!isContentType(params.type)) throw error(404, 'Unsupported content type');
  try {
    const item = await getDetail(params.type, params.id);
    return { item: toMediaItem(item) };
  } catch {
    throw error(404, 'Title not found');
  }
};
