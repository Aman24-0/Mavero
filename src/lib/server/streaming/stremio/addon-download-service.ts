import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { ContentType } from '$lib/server/content/types';
import { normalizeContentIdentifiers } from '$lib/server/resolver/identifiers';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import type { AudioClass } from '$lib/shared/stream-selection';
import { loadEnabledAddons } from './stream-resolver';
import { planAddonStreamRequest, stremioStreamTypeFor } from './stream-ids';
import { fetchStremioStreamResponse, STREAM_MAX_BYTES } from './stream-fetch';
import { normalizeStremioStreamResponse } from './stream-normalize';
import { buildDownloadCandidates, selectDownloadStreams, MAX_DOWNLOAD_STREAMS_PER_ADDON, type DownloadCodec, type DownloadQuality, type RankedDownloadStream } from './download-selection';
import { StreamServiceError } from './stream-errors';

/**
 * MAVERO Downloader — per-addon direct-link resolution service (Phase 14).
 *
 * The server-side engine behind `GET /api/downloader/mavero`. For EVERY
 * enabled Stremio HTTP addon it:
 *
 *   1. plans the addon stream request through the EXISTING id pipeline
 *      (`planAddonStreamRequest` — the same idProperty/idPrefixes logic the
 *      player uses, so a Pipe-shaped manifest resolves identically);
 *   2. fetches ONLY the addon's `/stream/{type}/{id}.json` response through
 *      the EXISTING hardened fetcher (connect-time SSRF guard, bounded
 *      redirects, body cap, timeout) — the returned MEDIA URLS are never
 *      fetched, probed or proxied by Mavero;
 *   3. normalizes the raw response through the SHARED stream normalizer
 *      (single source of truth for P2P/externalUrl/header/credential
 *      exclusion — the Phase 14 stream-type-aware rules included);
 *   4. selects the ≤ MAX_DOWNLOAD_STREAMS_PER_ADDON best practical direct
 *      links through the downloader-specific policy (`download-selection.ts`).
 *
 * STATE MODEL (task §4/§14) — the three addon states are DISTINCT:
 *   * `loaded`  — the addon responded and ≥1 supported direct link survived.
 *   * `empty`   — the addon responded fine but nothing usable remained
 *                 after filtering (NOT a failure).
 *   * `failed`  — the addon REQUEST failed (network/timeout/shape) with a
 *                 closed error code. A per-link problem NEVER produces this
 *                 state, and this state never contaminates other addons.
 *
 * FFmpeg is intentionally unreachable from here: no worker import, no compat
 * token, no conversion reference. The addon URL goes straight to the user's
 * external player / browser.
 */

/** The user-facing shape of one best link (lean, presentation-ready). */
export type AddonDownloadStreamView = {
  url: string;
  quality: DownloadQuality;
  codec: DownloadCodec;
  audio: AudioClass;
  audioLanguages?: string[];
  container?: string;
  filename?: string;
  title?: string;
  name?: string;
  description?: string;
  sizeBytes?: number;
  protocol: 'http' | 'https';
  /** Metadata-completeness confidence — NEVER a playback guarantee. */
  confidence: 'high' | 'medium' | 'low';
};

/** One addon's downloader result. `status` is the task §4 state model. */
export type AddonDownloadGroup = {
  addonId: string;
  addonName: string;
  addonSlug: string;
  addonOrdering: number;
  status: 'loaded' | 'empty' | 'failed';
  streams: AddonDownloadStreamView[];
  errorCode?: string;
};

export type AddonDownloadRequest = {
  mediaType: ContentType;
  contentId: string;
  season?: number;
  episode?: number;
};

export type AddonDownloadResult = {
  groups: AddonDownloadGroup[];
  /** Enabled addons CONSIDERED (the tab baseline). */
  consideredAddons: number;
};

/** Per-request timeout for ONE addon stream endpoint (smaller than the player's — downloads are opportunistic). */
const DOWNLOAD_TIMEOUT_MS = 9_000;
/** Aggregate budget across ALL addons (the endpoint stays snappy). */
const OVERALL_TIMEOUT_MS = 12_000;
const MAX_GROUPS = 20;

/** The content fact the downloader needs (same shape as the player session). */
export type DownloaderContentLookup = { identifiers: { imdbId?: string; tmdbId?: string } };

async function defaultLoadContent(mediaType: ContentType, contentId: string): Promise<DownloaderContentLookup> {
  const { getDetail } = await import('$lib/server/content/service');
  const content = await getDetail(mediaType, contentId);
  const identifiers = normalizeContentIdentifiers(content, {
    sourceId: 'mavero-downloader',
    contentId,
    mediaType,
  });
  return { identifiers: { imdbId: identifiers.imdbId, tmdbId: identifiers.tmdbId } };
}

export type ResolveAddonDownloadsDeps = {
  /** Injectable addon loader (tests); defaults to the enabled-addons query. */
  loadAddons?: (client: SupabaseClient<Database>) => Promise<StreamingAddon[]>;
  /** Injectable content lookup (tests); defaults to the content pipeline. */
  loadContent?: (mediaType: ContentType, contentId: string) => Promise<DownloaderContentLookup>;
  fetcher?: typeof fetch;
  dnsResolver?: import('./ssrf').SafeDnsResolver;
  timeoutMs?: number;
  maxBytes?: number;
  overallTimeoutMs?: number;
};

/** Trims the ranked candidate into the safe, presentation-ready view. */
function toStreamView(stream: RankedDownloadStream): AddonDownloadStreamView {
  return {
    url: stream.url,
    quality: stream.quality,
    codec: stream.codec,
    audio: stream.audio,
    ...(stream.audioLanguages?.length ? { audioLanguages: stream.audioLanguages } : {}),
    ...(stream.container ? { container: stream.container } : {}),
    ...(stream.filename ? { filename: stream.filename } : {}),
    ...(stream.title ? { title: stream.title } : {}),
    ...(stream.name ? { name: stream.name } : {}),
    ...(stream.description ? { description: stream.description } : {}),
    ...(stream.sizeBytes !== undefined ? { sizeBytes: stream.sizeBytes } : {}),
    protocol: stream.protocol,
    confidence: stream.confidence,
  };
}

/**
 * Validates the endpoint request shape. Throws a typed INVALID_REQUEST for
 * anything malformed (the endpoint maps it to 400).
 */
function assertValidRequest(request: AddonDownloadRequest): void {
  if (!request.contentId || request.contentId.length > 200) {
    throw new StreamServiceError('INVALID_REQUEST', { message: 'The Mavero Downloader request is invalid.' });
  }
  if (request.mediaType !== 'movie' && request.mediaType !== 'series' && request.mediaType !== 'anime') {
    throw new StreamServiceError('INVALID_REQUEST', { message: 'The Mavero Downloader request is invalid.' });
  }
  if (request.mediaType !== 'movie') {
    const { season, episode } = request;
    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || (season as number) < 1 || (episode as number) < 1) {
      throw new StreamServiceError('INVALID_REQUEST', { message: 'The Mavero Downloader request is invalid.' });
    }
  }
}

/**
 * Resolves the best direct links from EVERY enabled addon for one title.
 * NEVER throws for a per-addon problem — only invalid requests and
 * addon-infrastructure (DB) failures throw.
 */
export async function resolveAddonDownloads(client: SupabaseClient<Database>, request: AddonDownloadRequest, deps: ResolveAddonDownloadsDeps = {}): Promise<AddonDownloadResult> {
  assertValidRequest(request);

  const overallTimeoutMs = deps.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), overallTimeoutMs);

  try {
    let identifiers: { imdbId?: string; tmdbId?: string };
    try {
      ({ identifiers } = await (deps.loadContent ?? defaultLoadContent)(request.mediaType, request.contentId));
    } catch (error) {
      // Content resolution failures are request-level (the title cannot be
      // loaded for ANY addon) — typed, endpoint maps to 503.
      if (error instanceof StreamServiceError) throw error;
      throw new StreamServiceError('INVALID_REQUEST', { message: 'This title could not be loaded for downloading.', cause: error });
    }

    let addons: StreamingAddon[];
    try {
      addons = await (deps.loadAddons ?? loadEnabledAddons)(client);
    } catch (error) {
      throw new StreamServiceError('UNEXPECTED', { cause: error });
    }

    const streamType = stremioStreamTypeFor(request.mediaType);
    const considered = addons.slice(0, MAX_GROUPS);

    const groups = await Promise.all(considered.map(async (addon): Promise<AddonDownloadGroup> => {
      const base = { addonId: addon.id, addonName: addon.name, addonSlug: addon.slug, addonOrdering: addon.ordering };
      const plan = planAddonStreamRequest(addon, streamType, identifiers, request.season, request.episode);
      if (!plan.ok) {
        // The addon cannot resolve this content (no usable id property) —
        // an honest EMPTY, never a failure.
        console.info(`[AddonDownloader] addon skipped addon=${addon.slug} reason=${plan.reason} mediaType=${streamType}`);
        return { ...base, status: 'empty', streams: [] };
      }
      try {
        const body = await fetchStremioStreamResponse(plan.plan.endpointUrl, {
          fetcher: deps.fetcher,
          dnsResolver: deps.dnsResolver,
          timeoutMs: deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
          maxBytes: deps.maxBytes ?? STREAM_MAX_BYTES,
          overallSignal: controller.signal,
        });
        const normalized = normalizeStremioStreamResponse(body);
        if (!normalized.valid) {
          console.warn(`[AddonDownloader] invalid response shape addon=${addon.slug} idProperty=${plan.plan.idProperty} videoId=${plan.plan.videoId}`);
          return { ...base, status: 'failed', streams: [], errorCode: 'INVALID_RESPONSE' };
        }
        const { candidates, dropped } = buildDownloadCandidates(normalized.streams);
        const selected = selectDownloadStreams(candidates, MAX_DOWNLOAD_STREAMS_PER_ADDON);
        console.info(
          `[AddonDownloader] resolved addon=${addon.slug} idProperty=${plan.plan.idProperty} videoId=${plan.plan.videoId} returned=${normalized.streams.length} unsupported=${normalized.unsupported.length} dropped=${Object.entries(dropped).filter(([, count]) => count > 0).map(([reason, count]) => `${reason}:${count}`).join(',') || 'none'} selected=${selected.length}`,
        );
        return {
          ...base,
          status: selected.length ? 'loaded' : 'empty',
          streams: selected.map(toStreamView),
        };
      } catch (error) {
        const code = error instanceof StreamServiceError ? error.code : 'UNEXPECTED';
        console.warn(`[AddonDownloader] fetch failed addon=${addon.slug} reason=${code}`);
        return { ...base, status: 'failed', streams: [], errorCode: code };
      }
    }));

    return {
      groups: groups.sort((a, b) => a.addonOrdering - b.addonOrdering || a.addonName.localeCompare(b.addonName)),
      consideredAddons: addons.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

export { MAX_DOWNLOAD_STREAMS_PER_ADDON };
