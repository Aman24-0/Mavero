import { json } from '@sveltejs/kit';
import { getSeriesSeason } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isValidContentId } from '$lib/server/content/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const season = Number(params.season);
  if (!isValidContentId(params.id) || !Number.isInteger(season) || season < 0 || season > 99) {
    return json({ ok: false, error: { code: 'INVALID_SEASON', message: 'Unsupported series season.' } }, { status: 400 });
  }
  try {
    const result = await getSeriesSeason(params.id, season);
    return json({ ok: true, season: result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
