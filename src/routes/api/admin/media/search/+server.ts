/**
 * Phase 6 — Admin media search API.
 *
 * Proxies TMDB search for the admin upload workflow. Admin-only.
 * Uses the existing `searchTmdb` function from the TMDB adapter.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { searchTmdb } from '$lib/server/content/adapters/tmdb';
import { isContentType } from '$lib/server/content/types';

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });

  const query = url.searchParams.get('q')?.trim() ?? '';
  const typeParam = url.searchParams.get('type') ?? 'movie';
  const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? '1') || 1, 20));

  if (!query) {
    return json({ ok: false, error: { code: 'INVALID_QUERY', message: 'Search query is required.' } }, { status: 400 });
  }
  if (query.length > 120) {
    return json({ ok: false, error: { code: 'INVALID_QUERY', message: 'Search query is too long.' } }, { status: 400 });
  }

  const type = isContentType(typeParam) ? typeParam as 'movie' | 'series' : 'movie';
    // Anime searches as series on TMDB. The contentType is set based on
    // the TMDB type (movie/series). The admin can override to 'anime' later.
    const tmdbType = type;

  try {
    const results = await searchTmdb(query, tmdbType, page);
    return json({ ok: true, results });
  } catch {
    return json({ ok: false, error: { code: 'SEARCH_FAILED', message: 'TMDB search failed.' } }, { status: 502 });
  }
};
