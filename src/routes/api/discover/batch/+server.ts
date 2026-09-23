import { json } from '@sveltejs/kit';
import { discoverBatchDeduped, isDiscoverLanguage } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { contentErrorResponse } from '$lib/server/content/response';
import type { RequestHandler } from './$types';

/**
 * GET /api/discover/batch?language=all&provider=xxx
 *
 * Returns ALL non-adult Discover rails in a single response with
 * cross-rail deduplication applied. Each title appears in ONE primary
 * location only, based on section priority.
 *
 * This endpoint fetches all sections sequentially in priority order,
 * maintaining a global seen set. Bounded continuation (up to 3 pages)
 * is used to fill rails that lost items to higher-priority rails.
 *
 * Adult sections are NOT included — they remain fetched independently
 * via the existing per-rail endpoint.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     language: "all",
 *     provider: "xxx" | null,
 *     rails: {
 *       "theatre": { items: [...], page: 1, hasNextPage: true },
 *       "new-ott": { items: [...], page: 1, hasNextPage: false },
 *       ...
 *     }
 *   }
 */
export const GET: RequestHandler = async ({ url, locals, cookies }) => {
  const languageParam = url.searchParams.get('language') ?? 'all';
  const provider = url.searchParams.get('provider') ?? undefined;

  if (!isDiscoverLanguage(languageParam)) {
    return json({ ok: false, error: { code: 'INVALID_LANGUAGE', message: 'Unknown language filter.' } }, { status: 400 });
  }

  const safeProvider = provider && provider.trim() && provider.length <= 80 ? provider.trim() : undefined;

  try {
    const rails = await discoverBatchDeduped(languageParam, safeProvider, false);
    const responseRails: Record<string, { items: ReturnType<typeof toMediaItem>[]; page: number; hasNextPage: boolean }> = {};
    for (const [section, rail] of Object.entries(rails)) {
      responseRails[section] = {
        items: rail.items.map(toMediaItem),
        page: rail.page,
        hasNextPage: rail.hasNextPage,
      };
    }
    return json({
      ok: true,
      language: languageParam,
      provider: safeProvider ?? null,
      rails: responseRails,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
