import { json } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isContentType, isValidContentId } from '$lib/server/content/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  if (!isContentType(params.type) || !isValidContentId(params.id)) {
    return json({ ok: false, error: { code: 'INVALID_ID', message: 'Unsupported content identifier.' } }, { status: 400 });
  }

  try {
    const result = await getDetail(params.type, params.id);
    return json({ ok: true, item: result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
