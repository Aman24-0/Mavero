import { json } from '@sveltejs/kit';
import { search } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isContentType, type SearchFilters, type SearchSort } from '$lib/server/content/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  const query = url.searchParams.get('q')?.trim() ?? '';
  const typeParam = url.searchParams.get('type');
  const type = isContentType(typeParam) ? typeParam : undefined;
  const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? 1) || 1, 20));
  const sortValue = url.searchParams.get('sort');
  const filters: SearchFilters = {
    ott: url.searchParams.get('ott') || undefined,
    genre: url.searchParams.get('genre') || undefined,
    sort: sortValue === 'release-asc' || sortValue === 'release-desc' ? sortValue as SearchSort : undefined
  };

  if (query.length > 120) {
    return json({ ok: false, error: { code: 'INVALID_QUERY', message: 'Search query is too long.' } }, { status: 400 });
  }

  try {
    const result = await search(query, type, page, filters);
    return json({ ok: true, ...result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
