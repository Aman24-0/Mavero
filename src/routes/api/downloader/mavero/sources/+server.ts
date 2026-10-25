import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAddonDownloadTargets } from '$lib/server/streaming/stremio/addon-download-service';
import { StreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import { listCloudStreamDownloadTabs } from '$lib/server/cloudstream/downloader/service';
import { CloudStreamDownloaderError } from '$lib/server/cloudstream/downloader/errors';
import { getGlobalSourceOrder } from '$lib/server/downloader/source-order';
import { rankUnifiedSources, type UnifiedSourceView } from '$lib/shared/unified-downloader';
import { assertAdultDownloadAllowed } from '$lib/server/content/adult-guard';
import type { ContentType } from '$lib/server/content/types';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';

/**
 * UNIFIED MAVERO DOWNLOADER — merged source list endpoint (FINAL TASK).
 *
 *   GET /api/downloader/mavero/sources?mediaType=movie&contentId=movie-123&tmdbId=123
 *   GET /api/downloader/mavero/sources?mediaType=series&contentId=series-94605&tmdbId=94605&season=1&episode=2
 *
 * Returns the ONE merged, globally ranked source list for the unified
 * Mavero Downloader panel — BOTH source kinds interleaved:
 *
 *     { ok: true, sources: [{ kind: 'addon' | 'plugin', id, name, position }] }
 *
 * The endpoint COMPOSES the two EXISTING resolution catalogs (no second
 * resolution engine — task PART D "backend contracts may be reused
 * internally"):
 *   * add-on tabs    — listAddonDownloadTargets (the Stremio path, unchanged)
 *   * extension tabs — listCloudStreamDownloadTabs (the CloudStream/Nuvio
 *                      path, unchanged — permanent adapters, never the
 *                      Builder)
 *
 * and merges them through rankUnifiedSources over the persisted global
 * ordering (downloader_source_order):
 *   1. positioned sources ascending by position;
 *   2. unpositioned add-ons (streaming_addons ordering, then name);
 *   3. unpositioned extensions (catalog order).
 * When the ordering table is absent (migration not yet applied),
 * getGlobalSourceOrder degrades to [] and the documented fallback order
 * applies — the panel works, only explicit reordering waits.
 *
 * SECURITY CONTRACT (mirrors the two tabs endpoints):
 *   * only safe display metadata crosses the wire — no manifest/plugin
 *     URLs, no extension configuration, no auth tokens;
 *   * validation → rate limit (own bucket) → Adult Mode guard run BEFORE
 *     any catalog access;
 *   * `no-store` — enable/adapter/ordering state must stay fresh;
 *   * the browser never executes provider code; every resolution stays
 *     server-side behind the existing /addon and /mavero2 endpoints.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

const INVALID_REQUEST_MESSAGE = 'The Mavero Downloader request is invalid.';

function validMediaType(value: string | null): value is ContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

/** Season/episode bounds (audit API-17 convention): 1..10000 safe integers. */
function validEpisodeContext(value: number | undefined): boolean {
  if (value === undefined) return true;
  return Number.isSafeInteger(value) && value >= 1 && value <= 10000;
}

export const GET: RequestHandler = async ({ url, request, locals, cookies }) => {
  const mediaType = url.searchParams.get('mediaType');
  const contentId = url.searchParams.get('contentId')?.trim() ?? '';
  const tmdbId = url.searchParams.get('tmdbId')?.trim() ?? '';
  const seasonRaw = url.searchParams.get('season');
  const episodeRaw = url.searchParams.get('episode');
  const season = seasonRaw === null ? undefined : Number(seasonRaw);
  const episode = episodeRaw === null ? undefined : Number(episodeRaw);

  if (!validMediaType(mediaType) || !contentId || contentId.length > 200 || !tmdbId || tmdbId.length > 50) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: INVALID_REQUEST_MESSAGE } },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!validEpisodeContext(season) || !validEpisodeContext(episode)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: INVALID_REQUEST_MESSAGE } },
      { status: 400, headers: NO_STORE },
    );
  }
  // Movie vs series-episode contract (the stricter mavero2 shape — this
  // endpoint composes both catalogs, so it must satisfy BOTH contracts).
  if (mediaType === 'movie' && (season !== undefined || episode !== undefined)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: INVALID_REQUEST_MESSAGE } },
      { status: 400, headers: NO_STORE },
    );
  }
  if (mediaType !== 'movie' && (season === undefined || episode === undefined)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: INVALID_REQUEST_MESSAGE } },
      { status: 400, headers: NO_STORE },
    );
  }

  // Bounded per-identity rate limit — SEPARATE bucket from the two tabs
  // endpoints so the unified panel cannot lock out the standalone panels.
  const rateVerdict = checkRateLimit('downloaderUnifiedSources', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(rateVerdict.retryAfterSeconds) } });
  }
  // Adult Mode enforced at the server boundary (non-disclosing 404; runs
  // BEFORE catalog access — never swallowed by the catch below).
  await assertAdultDownloadAllowed(locals.supabase, locals.user, cookies, mediaType, contentId);

  // Lazily resolved admin client (the adult-guard pattern — the mavero2
  // tabs endpoint convention: the catalog tables have no public read
  // policy, so reads go through the service-role client).
  const { createSupabaseAdminClient } = await import('$lib/server/supabase/admin');
  const client = createSupabaseAdminClient();

  const requestContext = {
    mediaType,
    contentId,
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
  };

  // Compose BOTH catalogs. Each engine keeps its OWN failure semantics —
  // a failed catalog contributes ZERO sources (honest partial success: the
  // other kind's sources still render; the unified panel surfaces a
  // per-kind failure message from the empty contribution, never a global
  // error). The underlying request validation failures propagate as typed
  // 400s (identical contracts on both engines).
  let addonTabs: Array<{ addonId: string; addonName: string }> = [];
  let consideredAddons = 0;
  let extensionTabs: Array<{ extensionId: string; extensionName: string; canonicalKey: string }> = [];
  let consideredExtensions = 0;

  try {
    const result = await listAddonDownloadTargets(client, requestContext);
    addonTabs = result.tabs.map((tab) => ({ addonId: tab.addonId, addonName: tab.addonName }));
    consideredAddons = result.consideredAddons;
  } catch (error) {
    if (error instanceof StreamServiceError && error.code === 'INVALID_REQUEST') {
      return json(
        { ok: false, error: { code: 'INVALID_REQUEST', message: INVALID_REQUEST_MESSAGE } },
        { status: 400, headers: NO_STORE },
      );
    }
    console.warn('[MaveroDownloader/sources] addon catalog failed', error instanceof StreamServiceError ? error.code : error);
    // Honest degradation: zero add-on sources; the panel shows the add-on
    // kind's unavailable state. Never a global 503 — the plugin sources
    // must still resolve.
  }

  try {
    const result = await listCloudStreamDownloadTabs(client, requestContext);
    extensionTabs = result.tabs.map((tab) => ({
      extensionId: tab.extensionId,
      extensionName: tab.extensionName,
      canonicalKey: tab.canonicalKey ?? tab.extensionId,
    }));
    consideredExtensions = result.consideredExtensions;
  } catch (error) {
    if (error instanceof CloudStreamDownloaderError && error.code === 'INVALID_REQUEST') {
      return json(
        { ok: false, error: { code: 'INVALID_REQUEST', message: INVALID_REQUEST_MESSAGE } },
        { status: 400, headers: NO_STORE },
      );
    }
    console.warn('[MaveroDownloader/sources] extension catalog failed', error instanceof CloudStreamDownloaderError ? error.code : error);
    // Honest degradation: zero plugin sources (same partial-success rule).
  }

  // The persisted global order (degrades to [] pre-migration — the
  // deterministic fallback ordering applies).
  let order: Array<{ sourceKey: string; position: number }> = [];
  try {
    order = await getGlobalSourceOrder(client);
  } catch (error) {
    console.warn('[MaveroDownloader/sources] global order lookup failed', error instanceof Error ? error.message : error);
    // Honest degradation: the fallback order applies; reordering stays
    // unavailable until the ordering store is healthy.
  }

  const sources: UnifiedSourceView[] = rankUnifiedSources(addonTabs, extensionTabs, order);

  return json(
    {
      ok: true,
      sources,
      consideredAddons,
      consideredExtensions,
      // Per-kind degraded flags: the honest signals the panel needs to show
      // "add-ons unavailable" / "plugin sources unavailable" WITHOUT turning
      // a half-failed merged list into a global error.
      ...(addonTabs.length === 0 && consideredAddons > 0 ? { addonCatalogFailed: true } : {}),
      ...(extensionTabs.length === 0 && consideredExtensions > 0 ? { extensionCatalogFailed: true } : {}),
    },
    { headers: NO_STORE },
  );
};
