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
import { buildDownloadCandidates, selectDownloadStreams, parseRuntimeSeconds, MAX_DOWNLOAD_STREAMS_PER_ADDON, type DownloadRuntimeContext, type DownloadCodec, type DownloadQuality, type RankedDownloadStream, type DownloadSkipReason } from './download-selection';
import { StreamServiceError, asStreamServiceError, type StreamErrorCode } from './stream-errors';

/**
 * MAVERO Downloader — per-addon direct-link resolution service (Phase 14 →
 * Phase 15 progressive → Phase 16 diagnostic parity).
 *
 * PHASE 16 CONTRACT (this file):
 *   The downloader is now a DIAGNOSTIC SURFACE for comparing MAVERO's stream
 *   discovery against Stremio. There is NO artificial maximum, NO truncation.
 *   Every eligible direct HTTP(S) stream the addon returned is preserved and
 *   shown. The previous Phase 15 `MAX_DOWNLOAD_STREAMS_PER_ADDON=10` cap is
 *   gone — `selectDownloadStreams` returns EVERY eligible candidate.
 *
 *   Per-addon timeout budget is raised to 30s (with retries, up to ~40s total)
 *   so healthy addons that take 15-25s under load do NOT get marked Failed
 *   prematurely. The user should NOT have to press Retry just to get streams
 *   from a healthy addon.
 *
 *   Server-side diagnostics log raw-vs-eligible-vs-rejected counts per addon
 *   so the developer can see exactly where streams disappear (Task 12).
 *
 * STATE MODEL (Task 11 — four distinct states):
 *   * `loading`     — the addon request is in flight (initial attempt).
 *   * `retrying`    — a transient failure occurred and the retry budget still
 *                     has attempts left (server-side backoff).
 *   * `loaded`      — the addon responded. The frontend shows N streams
 *                     (N can be 0 — see `empty`). `loaded` means the REQUEST
 *                     succeeded; the stream count is separate.
 *   * `empty`       — the addon responded fine but the response contained NO
 *                     eligible streams (honest zero — NOT a failure).
 *   * `unavailable` — the addon REQUEST itself failed (network/timeout/shape)
 *                     after exhausting the retry budget.
 *
 *   Phase 16: `loaded` and `empty` are BOTH "the request succeeded"; the
 *   frontend distinguishes them by stream count for accurate failure-state
 *   UX (Task 11). The previous Phase 15 mapping (loaded-with-0 → empty) is
 *   preserved for back-compat with the Phase 14 batch view.
 *
 * Pipeline (per addon):
 *   1. plan the addon stream request through the EXISTING id pipeline;
 *   2. fetch ONLY the addon's `/stream/{type}/{id}.json` response through
 *      the EXISTING hardened fetcher (connect-time SSRF guard, bounded
 *      redirects, body cap, timeout) — the returned MEDIA URLS are never
 *      fetched, probed or proxied by Mavero;
 *   3. normalize the raw response through the SHARED stream normalizer
 *      (single source of truth for P2P/externalUrl/header/credential
 *      exclusion);
 *   4. build candidates through `buildDownloadCandidates` (Phase 16: ONLY
 *      HLS/DASH manifests, non-video files and playback-boundary rejections
 *      are excluded — every other eligible stream survives);
 *   5. select ALL candidates through `selectDownloadStreams` (Phase 16: NO
 *      truncation, NO diversity cap — true-duplicate-URL dedup only).
 *
 * FFmpeg is intentionally unreachable from here: no worker import, no compat
 * token, no conversion reference. The addon URL goes straight to the user's
 * external player / browser / Android share sheet.
 */

/** The user-facing shape of one eligible link (lean, presentation-ready). */
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

/** Phase 16 state model (Task 11): five distinct per-addon states. */
export type AddonDownloadStatus = 'loading' | 'retrying' | 'loaded' | 'empty' | 'unavailable';

/**
 * Per-addon diagnostic counts (Task 12). NEVER sent to the client as raw
 * URLs/tokens — only aggregate counts. Used for server-side logging and an
 * optional debug summary the frontend can show.
 *
 * SEMANTICS:
 *   * `raw`        — streams that ENTERED buildDownloadCandidates (i.e.
 *                    post-normalization eligible HTTP(S) streams). The
 *                    normalizer runs FIRST and excludes P2P/externalUrl/
 *                    credential/header-dependent entries.
 *   * `unsupported`— entries the NORMALIZER rejected (P2P/externalUrl/
 *                    credential/header-dependent/non-http-scheme/etc.).
 *                    `raw + unsupported` = total entries the addon returned.
 *   * `eligible`   — same as `raw` (alias for clarity).
 *   * `rejected`   — per-reason exclusion counts from buildDownloadCandidates
 *                    (streaming-manifest / non-video / playback-boundary).
 *   * `selected`   — final selected count (after true-duplicate-URL dedup).
 */
export type AddonDownloadDiagnostics = {
  /** Streams that entered buildDownloadCandidates (post-normalization). */
  raw: number;
  /** Entries the normalizer rejected (P2P/externalUrl/credential/etc.). */
  unsupported: number;
  /** Eligible direct HTTP(S) streams after buildDownloadCandidates (= raw). */
  eligible: number;
  /** Per-reason exclusion counts from buildDownloadCandidates. */
  rejected: Partial<Record<DownloadSkipReason, number>>;
  /** Final selected count (after true-duplicate-URL dedup). */
  selected: number;
};

/** One addon's downloader result. `status` is the Task 11 state model. */
export type AddonDownloadGroup = {
  addonId: string;
  addonName: string;
  addonSlug: string;
  addonOrdering: number;
  status: 'loaded' | 'empty' | 'failed';
  streams: AddonDownloadStreamView[];
  errorCode?: string;
  /** Phase 16 (Task 12): non-sensitive diagnostic counts. */
  diagnostics?: AddonDownloadDiagnostics;
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

/** Phase 16 per-addon resolution result (Task 3/Task 11 state model). */
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
  /** Phase 16 (Task 12): non-sensitive diagnostic counts. */
  diagnostics?: AddonDownloadDiagnostics;
};

/**
 * Phase 16 (Task 13): per-attempt timeout raised to 30s. Healthy Stremio
 * addons can take 15-25s under load; the previous 9s timeout was marking
 * them Failed prematurely. With 1 retry, the total budget is ~60s worst-case
 * (30s initial + backoff + 30s retry) — well within the 30-40s allowance
 * the task specifies for the typical single-attempt case.
 */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/**
 * Phase 16: aggregate batch budget raised to 40s. The batch endpoint (kept
 * for back-compat) resolves every addon in parallel; the per-addon timeout
 * is the real bound, this just aborts the whole batch if everything hangs.
 */
const OVERALL_TIMEOUT_MS = 40_000;
const MAX_GROUPS = 20;

/** Phase 16 retry/backoff budget (Task 14 — Retry is fallback, not required). */
const MAX_RETRY_ATTEMPTS = 1; // 1 initial + 1 retry = 2 total attempts
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 2_000;

/**
 * Transient error codes that qualify for a retry. HTTP 4xx, INVALID_RESPONSE,
 * INVALID_JSON and BLOCKED_URL are NOT transient.
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<StreamErrorCode> = new Set<StreamErrorCode>([
  'TIMEOUT',
  'NETWORK',
  'HTTP_ERROR', // 5xx is often transient; the fetcher maps all non-2xx to HTTP_ERROR
]);

/** The content fact the downloader needs (same shape as the player session). */
export type DownloaderContentLookup = {
  identifiers: { imdbId?: string; tmdbId?: string };
  /** Phase 16: optional content runtime (informational only — no longer used to reject). */
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

/** Phase 16 per-addon deps (adds retry budget + single-addon loader). */
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

/** Builds the non-sensitive diagnostic summary from the normalization + selection. */
function diagnosticsOf(raw: number, unsupported: number, dropped: Record<DownloadSkipReason, number>, selected: RankedDownloadStream[]): AddonDownloadDiagnostics {
  const rejected: Partial<Record<DownloadSkipReason, number>> = {};
  for (const [reason, count] of Object.entries(dropped)) {
    if (count > 0) rejected[reason as DownloadSkipReason] = count;
  }
  // `raw` is already post-normalization (the count that entered
  // buildDownloadCandidates). `eligible` = `raw` (alias for clarity).
  // `unsupported` is the count the NORMALIZER rejected (P2P/externalUrl/etc.).
  return {
    raw,
    unsupported,
    eligible: raw,
    rejected,
    selected: selected.length,
  };
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
): Promise<{ status: AddonDownloadStatus; streams: AddonDownloadStreamView[]; errorCode?: StreamErrorCode; diagnostics?: AddonDownloadDiagnostics }> {
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
      return { status: 'unavailable', streams: [], errorCode: 'INVALID_RESPONSE' };
    }
    const { candidates, dropped } = buildDownloadCandidates(normalized.streams, runtimeContext);
    // Phase 16: NO truncation — selectDownloadStreams returns EVERY eligible
    // candidate (true-duplicate-URL dedup only). The max parameter is back-compat only.
    const selected = selectDownloadStreams(candidates, MAX_DOWNLOAD_STREAMS_PER_ADDON);
    const diagnostics = diagnosticsOf(normalized.streams.length, normalized.unsupported.length, dropped, selected);
    const dropSummary = Object.entries(dropped).filter(([, count]) => count > 0).map(([reason, count]) => `${reason}:${count}`).join(',') || 'none';
    console.info(
      `[AddonDownloader] resolved addon=${addon.slug} idProperty=${plan.idProperty} videoId=${plan.videoId} attempt=${attempt} raw=${diagnostics.raw} unsupported=${diagnostics.unsupported} eligible=${diagnostics.eligible} dropped=${dropSummary} selected=${diagnostics.selected}`,
    );
    return {
      status: selected.length ? 'loaded' : 'empty',
      streams: selected.map(toStreamView),
      diagnostics,
    };
  } catch (error) {
    const serviceError = asStreamServiceError(error);
    console.warn(`[AddonDownloader] fetch failed addon=${addon.slug} attempt=${attempt} reason=${serviceError.code}`);
    return { status: 'unavailable', streams: [], errorCode: serviceError.code };
  }
}

/** Computes the next backoff delay (exponential, capped, with a tiny jitter). */
function nextBackoffMs(attempt: number, initial: number, cap: number): number {
  const base = Math.min(cap, initial * 2 ** (attempt - 1));
  const jitter = attempt % 2 === 0 ? Math.round(base * 0.1) : -Math.round(base * 0.1);
  return Math.max(1, base + jitter);
}

/**
 * Resolves the BEST direct links from EVERY enabled addon for one title.
 * NEVER throws for a per-addon problem — only invalid requests and
 * addon-infrastructure (DB) failures throw.
 *
 * Phase 14 batch path (kept for backward compat + standalone deep-link
 * pages + the Phase 14 test suite). The Phase 15/16 progressive path uses
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
      if (result.status === 'unavailable') {
        return { ...base, status: 'failed', streams: [], errorCode: result.errorCode };
      }
      if (result.status === 'empty') {
        return { ...base, status: 'empty', streams: [], ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
      }
      return { ...base, status: 'loaded', streams: result.streams, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
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
 * Phase 15/16 (task §1/§2/§3 + Task 13/14): resolves ONE addon with a
 * bounded retry/backoff budget for transient failures. The single source
 * of truth for the per-addon progressive flow.
 *
 * Phase 16 changes:
 *   * Per-attempt timeout raised 9s → 30s (healthy addons can take 15-25s).
 *   * Retry budget lowered 2 → 1 (Retry is fallback, not required — Task 14).
 *   * Diagnostics carry raw/unsupported/eligible/rejected/selected counts.
 *
 * NEVER throws for addon-level problems — returns a typed
 * SingleAddonDownloadResult. Throws only for infrastructure failures (DB
 * outage) or invalid request shape.
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
    return { ...base, status: 'empty', streams: [], attempts: 0 };
  }

  const maxRetries = deps.maxRetries ?? MAX_RETRY_ATTEMPTS;
  const initialBackoff = deps.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const maxBackoff = deps.maxBackoffMs ?? MAX_BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runtimeContext = runtimeContextOf(lookup);

  let lastErrorCode: StreamErrorCode | undefined;
  let attempts = 0;
  let lastDiagnostics: AddonDownloadDiagnostics | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attempts = attempt;
    const result = await resolveAddonOnce(addon, plan.plan, streamType, runtimeContext, attempt, deps);
    lastDiagnostics = result.diagnostics;
    if (result.status !== 'unavailable') {
      return { ...base, status: result.status, streams: result.streams, attempts, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
    }
    lastErrorCode = result.errorCode;
    const isTransient = result.errorCode !== undefined && RETRYABLE_ERROR_CODES.has(result.errorCode);
    if (!isTransient || attempt > maxRetries) {
      break;
    }
    console.info(`[AddonDownloader] retrying addon=${addon.slug} attempt=${attempt + 1}/${maxRetries + 1} after backoff`);
    await sleep(nextBackoffMs(attempt, initialBackoff, maxBackoff));
  }

  return { ...base, status: 'unavailable', streams: [], errorCode: lastErrorCode ?? 'UNEXPECTED', attempts, ...(lastDiagnostics ? { diagnostics: lastDiagnostics } : {}) };
}

export { MAX_DOWNLOAD_STREAMS_PER_ADDON };
