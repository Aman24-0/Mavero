import { json } from '@sveltejs/kit';
import { discoverBatchDeduped, isDiscoverLanguage, isDiscoverSectionKey } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { contentErrorResponse } from '$lib/server/content/response';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import type { RequestHandler } from './$types';

/**
 * GET /api/discover/batch?language=all&provider=xxx&sections=a,b,c
 *
 * Returns Discover rails in a single response with cross-rail
 * deduplication applied. Each title appears in ONE primary location
 * only, based on section priority.
 *
 * This endpoint fetches all sections sequentially in priority order,
 * maintaining a global seen set. Bounded continuation (up to 3 pages)
 * is used to fill rails that lost items to higher-priority rails.
 *
 * MAV-20 Phase E — `sections` (optional, comma-separated, validated
 * against the closed section-key union, bounded at 32 entries): scopes
 * the RESPONSE to a subset of rails. The dedup processing always walks
 * the full priority list, so a scoped response's rails are identical to
 * the full batch's entries for those sections. The client uses this to
 * fetch the batch in priority tiers — the first tier renders before the
 * rest is computed. Omitting the param returns ALL rails (unchanged
 * legacy contract).
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
  const sectionsParam = url.searchParams.get('sections') ?? undefined;

  if (!isDiscoverLanguage(languageParam)) {
    return json({ ok: false, error: { code: 'INVALID_LANGUAGE', message: 'Unknown language filter.' } }, { status: 400 });
  }

  const safeProvider = provider && provider.trim() && provider.length <= 80 ? provider.trim() : undefined;

  // Response scoping (MAV-20 Phase E): a closed, bounded subset of the
  // known section keys. Unknown keys are rejected — the client only ever
  // sends keys from the same closed union the endpoint validates
  // sections against, and a silent ignore would hide typos.
  let safeSections: string[] | undefined;
  if (sectionsParam !== undefined && sectionsParam.trim() !== '') {
    const requested = sectionsParam
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 32);
    if (requested.length === 0 || requested.some((value) => !isDiscoverSectionKey(value) || value === 'adult-shows')) {
      return json({ ok: false, error: { code: 'INVALID_SECTIONS', message: 'Unknown section scope.' } }, { status: 400 });
    }
    safeSections = requested;
  }

  try {
    const rails = await discoverBatchDeduped(languageParam, safeProvider, false, safeSections);
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
    }, { headers: { 'cache-control': PUBLIC_CATALOG_CACHE } });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
