import { json } from '@sveltejs/kit';
import { discover } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isContentType } from '$lib/server/content/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
  if (!isContentType(params.type)) {
    return json({ ok: false, error: { code: 'INVALID_TYPE', message: 'Unsupported content type.' } }, { status: 400 });
  }

  const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? 1) || 1, 20));
  try {
    const result = await discover(params.type, page);
    return json({ ok: true, ...result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
