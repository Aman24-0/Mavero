import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { ContentType } from '$lib/server/content/types';
import { normalizeContentIdentifiers } from '$lib/server/resolver/identifiers';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import type { AudioClass } from '$lib/shared/stream-selection';
import { loadEnabledAddons } from './stream-resolver';
import { planAddonStreamRequest, stremioStreamTypeFor, type AddonSkipReason } from './stream-ids';
import { fetchStremioStreamResponse, STREAM_MAX_BYTES } from './stream-fetch';
import { normalizeStremioStreamResponse } from './stream-normalize';
import { buildDownloadCandidates, selectDownloadStreams, parseRuntimeSeconds, type DownloadRuntimeContext, MAX_DOWNLOAD_STREAMS_PER_ADDON, type DownloadCodec, type DownloadQuality, type RankedDownloadStream } from './download-selection';
import { StreamServiceError, asStreamServiceError, type StreamErrorCode } from './stream-errors';

/**
 * MAVERO Downloader — per-addon direct-link resolution service (Phase 14,
 * Phase 15 progressive + reliability hardening).
 *
 * The server-side engine behind:
 *   * `GET /api/downloader/mavero`              — Phase 14 batch endpoint
 *     (kept for backward compat + the standalone deep-link pages + the
 *     Phase 14 test suite). Resolves EVERY enabled addon in parallel.
 *   * `GET /api/downloader/mavero/tabs`         — Phase 15 list endpoint
 *     (addon tab metadata ONLY, no stream fetches — the UI renders tabs
 *     immediately and fires per-addon resolution independently).
 *   * `GET /api/downloader/mavero/addon`        — Phase 15 per-addon
 *     endpoint (resolves ONE addon with a bounded retry/backoff budget
 *     for transient failures; one addon's failure never contaminates
 *     another addon's already-loaded results).
 *
 * Pipeline (per addon, identical across batch + per-addon paths):
 *   1. plan the addon stream request through the EXISTING id pipeline
 *      (`planAddonStreamRequest` — the same idProperty/idPrefixes logic the
 *      player uses, so a Pipe-shaped manifest resolves identically);
 *   2. fetch ONLY the addon's `/stream/{type}/{id}.json` response through
 *      the EXISTING hardened fetcher (connect-time SSRF guard, bounded
 *      redirects, body cap, timeout) — the returned MEDIA URLS are never
 *      fetched, probed or proxied by Mavero;
 *   3. normalize the raw response through the SHARED stream normalizer
 *      (single source of truth for P2P/externalUrl/header/credential
 *      exclusion — the Phase 14 stream-type-aware rules included);
 *   4. select the ≤ MAX_DOWNLOAD_STREAMS_PER_ADDON best practical direct
 *      links through the downloader-specific policy (`download-selection.ts`).
 *
 * STATE MODEL (task §4/§14 + Phase 15 §3) — five DISTINCT per-addon states:
 *   * `loading`     — the addon request is in flight (initial attempt).
 *   * `retrying`    — a transient failure occurred and the bounded retry
 *                     budget still has attempts left (server-side backoff).
 *   * `loaded`      — the addon responded and ≥1 supported direct link
 *                     survived filtering.
 *   * `empty`       — the addon responded fine but nothing usable remained
 *                     after filtering (NOT a failure — honest zero).
 *   * `unavailable` — the addon REQUEST failed (network/timeout/shape)
 *                     after exhausting the retry budget. A per-link
 *                     problem NEVER produces this state, and this state
 *                     never contaminates other addons.
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

/** Phase 15 state model (task §3): five distinct per-addon states. */
export type AddonDownloadStatus = 'loading' | 'retrying' | 'loaded' | 'empty' | 'unavailable';

/** One addon's downloader result. `status` is the task §4/§15 state model. */
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

/** Per-addon tab metadata (Phase 15 — no stream fetches, no URLs). */
export type AddonDownloadTab = {
  addonId: string;
  addonName: string;
  addonSlug: string;
  addonOrdering: number;
};

export type AddonDownloadTabsResult = {
  tabs: AddonDownloadTab[];
  /** Enabled addons CONSIDERED (the tab baseline — includes ineligible ones). */
  consideredAddons: number;
};

/** Phase 15 per-addon resolution result (task §3 state model). */
export type SingleAddonDownloadResult = {
  addonId: string;
  addonName: string;
  addonSlug: string;
  addonOrdering: number;
  status: AddonDownloadStatus;
  streams: AddonDownloadStreamView[];
  /** Present when status = 'unavailable' (closed error vocabulary). */
  errorCode?: StreamErrorCode;
  /** How many retry attempts were made (0 = first-attempt success). */
  attempts?: number;
};

/** Per-request timeout for ONE addon stream endpoint (smaller than the player's — downloads are opportunistic). */
const DOWNLOAD_TIMEOUT_MS = 9_000;
/** Aggregate budget across ALL addons (the batch endpoint stays snappy). */
const OVERALL_TIMEOUT_MS = 12_000;
const MAX_GROUPS = 20;

/** Phase 15 retry/backoff budget (task §3). */
const MAX_RETRY_ATTEMPTS = 2; // 1 initial + 2 retries = 3 total attempts
const INITIAL_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 2_000;

/**
 * Transient error codes that qualify for a retry (task §3). HTTP 4xx,
 * INVALID_RESPONSE, INVALID_JSON and BLOCKED_URL are NOT transient — the
 * addon is genuinely broken or unreachable, retrying wastes the budget.
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<StreamErrorCode> = new Set<StreamErrorCode>([
  'TIMEOUT',
  'NETWORK',
  'HTTP_ERROR', // 5xx is often transient; the fetcher maps all non-2xx to HTTP_ERROR
]);

/** The content fact the downloader needs (same shape as the player session). */
export type DownloaderContentLookup = {
  identifiers: { imdbId?: string; tmdbId?: string };
  /** Phase 15 (task §10): optional content runtime, for size/runtime sanity. */
  runtimeSeconds?: number;
};

async function defaultLoadContent(mediaType: ContentType, contentId: string): Promise<DownloaderContentLookup> {
  const { getDetail } = await import('$lib/server/content/service');
  const content = await getDetail(mediaType, contentId);
  const identifiers = normalizeContentIdentifiers(content, {
    sourceId: 'mavero-downloader',
    contentId,
    mediaType,
  });
  return {
    identifiers: { imdbId: identifiers.imdbId, tmdbId: identifiers.tmdbId },
    ...(content.runtime ? { runtimeSeconds: parseRuntimeSeconds(content.runtime) } : {}),
  };
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

/** Phase 15 per-addon deps (adds retry budget + single-addon loader). */
export type ResolveSingleAddonDeps = ResolveAddonDownloadsDeps & {
  /** Injectable single-addon loader (tests); defaults to a fresh DB lookup. */
  loadAddonById?: (client: SupabaseClient<Database>, id: string) => Promise<StreamingAddon | null>;
  /** Override the retry budget (default MAX_RETRY_ATTEMPTS). */
  maxRetries?: number;
  /** Override the initial backoff (default INITIAL_BACKOFF_MS). */
  initialBackoffMs?: number;
  /** Override the backoff cap (default MAX_BACKOFF_MS). */
  maxBackoffMs?: number;
  /** Override the retry budget's per-attempt timeout (default DOWNLOAD_TIMEOUT_MS). */
  retryTimeoutMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
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

/** Builds the per-addon base identity (no streams, no status). */
function addonBase(addon: StreamingAddon) {
  return {
    addonId: addon.id,
    addonName: addon.name,
    addonSlug: addon.slug,
    addonOrdering: addon.ordering,
  };
}

/** Builds a runtime context for the selection engine from the content lookup. */
function runtimeContextOf(lookup: DownloaderContentLookup): DownloadRuntimeContext {
  return lookup.runtimeSeconds !== undefined ? { runtimeSeconds: lookup.runtimeSeconds } : {};
}

/**
 * Resolves ONE addon's streams — single attempt (no retry). Shared by the
 * batch endpoint and the per-addon retry loop. NEVER throws for addon-level
 * problems — returns a typed SingleAddonDownloadResult.
 *
 * `attempt` is 1-indexed for diagnostics.
 */
async function resolveAddonOnce(
  addon: StreamingAddon,
  plan: Extract<ReturnType<typeof planAddonStreamRequest>, { ok: true }>['plan'],
  streamType: ReturnType<typeof stremioStreamTypeFor>,
  runtimeContext: DownloadRuntimeContext,
  attempt: number,
  deps: ResolveSingleAddonDeps,
): Promise<{ status: AddonDownloadStatus; streams: AddonDownloadStreamView[]; errorCode?: StreamErrorCode; diagnostics: string }> {
  try {
    const body = await fetchStremioStreamResponse(plan.endpointUrl, {
      fetcher: deps.fetcher,
      dnsResolver: deps.dnsResolver,
      timeoutMs: deps.retryTimeoutMs ?? deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
      maxBytes: deps.maxBytes ?? STREAM_MAX_BYTES,
    });
    const normalized = normalizeStremioStreamResponse(body);
    if (!normalized.valid) {
      console.warn(`[AddonDownloader] invalid response shape addon=${addon.slug} idProperty=${plan.idProperty} videoId=${plan.videoId} attempt=${attempt}`);
      return { status: 'unavailable', streams: [], errorCode: 'INVALID_RESPONSE', diagnostics: `invalid-response attempt=${attempt}` };
    }
    const { candidates, dropped } = buildDownloadCandidates(normalized.streams, runtimeContext);
    const selected = selectDownloadStreams(candidates, MAX_DOWNLOAD_STREAMS_PER_ADDON);
    const dropSummary = Object.entries(dropped).filter(([, count]) => count > 0).map(([reason, count]) => `${reason}:${count}`).join(',') || 'none';
    console.info(
      `[AddonDownloader] resolved addon=${addon.slug} idProperty=${plan.idProperty} videoId=${plan.videoId} attempt=${attempt} returned=${normalized.streams.length} unsupported=${normalized.unsupported.length} dropped=${dropSummary} selected=${selected.length}`,
    );
    return {
      status: selected.length ? 'loaded' : 'empty',
      streams: selected.map(toStreamView),
      diagnostics: `ok attempt=${attempt} selected=${selected.length}`,
    };
  } catch (error) {
    const serviceError = asStreamServiceError(error);
    console.warn(`[AddonDownloader] fetch failed addon=${addon.slug} attempt=${attempt} reason=${serviceError.code}`);
    return { status: 'unavailable', streams: [], errorCode: serviceError.code, diagnostics: `failed attempt=${attempt} code=${serviceError.code}` };
  }
}

/** Computes the next backoff delay (exponential, capped, with a tiny jitter). */
function nextBackoffMs(attempt: number, initial: number, cap: number): number {
  const base = Math.min(cap, initial * 2 ** (attempt - 1));
  // Deterministic jitter (±10%) — keeps tests stable while avoiding request storms.
  const jitter = attempt % 2 === 0 ? Math.round(base * 0.1) : -Math.round(base * 0.1);
  return Math.max(1, base + jitter);
}

/**
 * Resolves the BEST direct links from EVERY enabled addon for one title.
 * NEVER throws for a per-addon problem — only invalid requests and
 * addon-infrastructure (DB) failures throw.
 *
 * Phase 14 batch path (kept for backward compat + standalone deep-link
 * pages + the Phase 14 test suite). The Phase 15 progressive path uses
 * `listAddonDownloadTargets` + `resolveSingleAddonDownload` instead.
 */
export async function resolveAddonDownloads(client: SupabaseClient<Database>, request: AddonDownloadRequest, deps: ResolveAddonDownloadsDeps = {}): Promise<AddonDownloadResult> {
  assertValidRequest(request);

  const overallTimeoutMs = deps.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), overallTimeoutMs);

  try {
    let lookup: DownloaderContentLookup;
    try {
      lookup = await (deps.loadContent ?? defaultLoadContent)(request.mediaType, request.contentId);
    } catch (error) {
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
    const runtimeContext = runtimeContextOf(lookup);

    const groups = await Promise.all(considered.map(async (addon): Promise<AddonDownloadGroup> => {
      const base = addonBase(addon);
      const plan = planAddonStreamRequest(addon, streamType, lookup.identifiers, request.season, request.episode);
      if (!plan.ok) {
        console.info(`[AddonDownloader] addon skipped addon=${addon.slug} reason=${plan.reason} mediaType=${streamType}`);
        return { ...base, status: 'empty', streams: [] };
      }
      const result = await resolveAddonOnce(addon, plan.plan, streamType, runtimeContext, 1, deps);
      // Map the Phase 15 state model back to the Phase 14 batch view
      // (loaded → loaded; empty → empty; unavailable → failed).
      if (result.status === 'unavailable') {
        return { ...base, status: 'failed', streams: [], errorCode: result.errorCode };
      }
      if (result.status === 'empty') {
        return { ...base, status: 'empty', streams: [] };
      }
      return { ...base, status: 'loaded', streams: result.streams };
    }));

    return {
      groups: groups.sort((a, b) => a.addonOrdering - b.addonOrdering || a.addonName.localeCompare(b.addonName)),
      consideredAddons: addons.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Phase 15 (task §1): lists the addon tabs for ONE title — NO stream
 * fetches. The UI renders the tabs immediately in `loading` state and
 * fires `resolveSingleAddonDownload` for each tab independently.
 *
 * Returns the addon metadata ONLY (id/name/slug/ordering). No manifest
 * URLs, no stream data, no configuration. NEVER throws for addon-eligibility
 * — ineligible addons are simply omitted from the tab list.
 */
export async function listAddonDownloadTargets(client: SupabaseClient<Database>, request: AddonDownloadRequest, deps: ResolveAddonDownloadsDeps = {}): Promise<AddonDownloadTabsResult> {
  assertValidRequest(request);

  let lookup: DownloaderContentLookup;
  try {
    lookup = await (deps.loadContent ?? defaultLoadContent)(request.mediaType, request.contentId);
  } catch (error) {
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
  const tabs: AddonDownloadTab[] = [];
  for (const addon of addons.slice(0, MAX_GROUPS)) {
    const plan = planAddonStreamRequest(addon, streamType, lookup.identifiers, request.season, request.episode);
    if (!plan.ok) {
      console.info(`[AddonDownloader] tab skipped addon=${addon.slug} reason=${plan.reason} mediaType=${streamType}`);
      continue;
    }
    tabs.push({
      addonId: addon.id,
      addonName: addon.name,
      addonSlug: addon.slug,
      addonOrdering: addon.ordering,
    });
  }
  return {
    tabs: tabs.sort((a, b) => a.addonOrdering - b.addonOrdering || a.addonName.localeCompare(b.addonName)),
    consideredAddons: addons.length,
  };
}

/** Loads a single enabled addon by id (default implementation). */
async function defaultLoadAddonById(client: SupabaseClient<Database>, id: string): Promise<StreamingAddon | null> {
  const { mapAddonRow } = await import('$lib/server/streaming/addons');
  const { data, error } = await client
    .from('streaming_addons')
    .select('*')
    .eq('id', id)
    .eq('enabled', true)
    .in('status', ['active', 'experimental'])
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return mapAddonRow(row as Parameters<typeof mapAddonRow>[0]);
}

/**
 * Phase 15 (task §1/§2/§3): resolves ONE addon with a bounded retry/backoff
 * budget for transient failures. The single source of truth for the
 * per-addon progressive flow.
 *
 * Retry policy (task §3):
 *   * Transient errors (TIMEOUT, NETWORK, HTTP_ERROR) trigger a retry.
 *   * Non-transient errors (INVALID_RESPONSE, INVALID_JSON, BLOCKED_URL,
 *     INVALID_URL, INVALID_REQUEST, TOO_LARGE, UNEXPECTED) do NOT retry —
 *     the addon is genuinely broken or the request is malformed.
 *   * Max MAX_RETRY_ATTEMPTS retries (3 total attempts) with exponential
 *     backoff (INITIAL_BACKOFF_MS → MAX_BACKOFF_MS, capped).
 *   * No infinite retry, no request storms.
 *
 * NEVER throws for addon-level problems — returns a typed
 * SingleAddonDownloadResult with status='unavailable' and the closed error
 * code. Throws only for infrastructure failures (DB outage) or invalid
 * request shape.
 */
export async function resolveSingleAddonDownload(client: SupabaseClient<Database>, request: AddonDownloadRequest, addonId: string, deps: ResolveSingleAddonDeps = {}): Promise<SingleAddonDownloadResult> {
  assertValidRequest(request);

  let lookup: DownloaderContentLookup;
  try {
    lookup = await (deps.loadContent ?? defaultLoadContent)(request.mediaType, request.contentId);
  } catch (error) {
    if (error instanceof StreamServiceError) throw error;
    throw new StreamServiceError('INVALID_REQUEST', { message: 'This title could not be loaded for downloading.', cause: error });
  }

  let addon: StreamingAddon | null;
  try {
    addon = await (deps.loadAddonById ?? defaultLoadAddonById)(client, addonId);
  } catch (error) {
    throw new StreamServiceError('UNEXPECTED', { cause: error });
  }

  const fallbackDisplay = { addonId, addonName: `Addon ${addonId.slice(0, 8)}`, addonSlug: addonId, addonOrdering: Number.MAX_SAFE_INTEGER };
  if (!addon) {
    return { ...fallbackDisplay, status: 'unavailable', streams: [], errorCode: 'UNEXPECTED', attempts: 0 };
  }

  const base = addonBase(addon);
  const streamType = stremioStreamTypeFor(request.mediaType);
  const plan = planAddonStreamRequest(addon, streamType, lookup.identifiers, request.season, request.episode);
  if (!plan.ok) {
    console.info(`[AddonDownloader] single-addon skipped addon=${addon.slug} reason=${plan.reason} mediaType=${streamType}`);
    // Ineligible addon = honest empty (not a failure). The plan rejected it
    // before any network call — id property / prefix / capability mismatch.
    return { ...base, status: 'empty', streams: [], attempts: 0 };
  }

  const maxRetries = deps.maxRetries ?? MAX_RETRY_ATTEMPTS;
  const initialBackoff = deps.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const maxBackoff = deps.maxBackoffMs ?? MAX_BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runtimeContext = runtimeContextOf(lookup);

  let lastErrorCode: StreamErrorCode | undefined;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attempts = attempt;
    const result = await resolveAddonOnce(addon, plan.plan, streamType, runtimeContext, attempt, deps);
    // Success or non-transient failure → return immediately.
    if (result.status !== 'unavailable') {
      return { ...base, status: result.status, streams: result.streams, attempts };
    }
    lastErrorCode = result.errorCode;
    const isTransient = result.errorCode !== undefined && RETRYABLE_ERROR_CODES.has(result.errorCode);
    if (!isTransient || attempt > maxRetries) {
      break;
    }
    // Transient failure with retries remaining → backoff and retry.
    console.info(`[AddonDownloader] retrying addon=${addon.slug} attempt=${attempt + 1}/${maxRetries + 1} after backoff`);
    await sleep(nextBackoffMs(attempt, initialBackoff, maxBackoff));
  }

  return { ...base, status: 'unavailable', streams: [], errorCode: lastErrorCode ?? 'UNEXPECTED', attempts };
}

export { MAX_DOWNLOAD_STREAMS_PER_ADDON };
