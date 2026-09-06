import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
  const type = params.type === 'series' || params.type === 'anime' || params.type === 'movie' ? params.type : undefined;
  const season = Number(params.season);
  const episode = Number(params.episode);
  if (!type || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 1) throw error(404, 'Episode not found');
  throw redirect(307, `/watch/${type}/${params.id}?season=${season}&episode=${episode}`);
};
