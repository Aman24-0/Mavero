import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { ContentType } from '$lib/server/content/types';
import type { ContentIdentifiers, PlaybackProtocol } from '$lib/server/resolver/types';
import { mapAddonRow } from '$lib/server/streaming/addons';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import type { SafeDnsResolver } from './ssrf';
import { fetchStremioStreamResponse, STREAM_MAX_BYTES, STREAM_REQUEST_TIMEOUT_MS } from './stream-fetch';
import { asStreamServiceError, StreamServiceError, type StreamErrorCode } from './stream-errors';
import { normalizeStremioStreamResponse, type NormalizedStreamSubtitle, type StremioStreamQuality, type UnsupportedStremioStream } from './stream-normalize';
import { assertEpisodeScope, planAddonStreamRequest, stremioStreamTypeFor, type AddonSkipReason, type AddonStreamPlan, type StremioAddonStreamPlan, type StremioStreamType, type SupportedStremioIdProperty } from './stream-ids';

/**
 * MAVERO Stremio stream resolver — orchestration (Phase 3).
 *
 * Pipeline (spec): manifest metadata → stream request → HTTP/HLS
 * normalization.
 *
 *   1. Load ENABLED addons (DB, Phase 1/2 model) with a usable status
 *      (`active`/`experimental` — addons default to `experimental`, and
 *      `enabled=true` is already an explicit administrator opt-in).
 *   2. Plan each addon locally (pure): explicit stream capability, media
 *      type, idProperty/idPrefixes compatibility, constructed video ID,
 *      endpoint URL. Incompatible addons are SKIPPED without any network
 *      request (typed diagnostic reasons).
 *   3. Fetch eligible endpoints with BOUNDED concurrency
 *      (`STREAM_RESOLUTION_CONCURRENCY = 4`, spec §7) under a strict
 *      per-request timeout AND an aggregate resolution budget — one slow
 *      addon never blocks the whole resolution (spec §8).
 *   4. Normalize/classify each response (HTTP/HLS-only policy). One addon's
 *      failure — timeout, HTTP error, invalid JSON, malformed shape — never
 *      affects the others (allSettled-style isolation, spec §24).
 *   5. Deduplicate equivalent playable URLs (normalized-URL identity,
 *      first-wins in deterministic order) and return a deterministically
 *      ordered collection (addon ordering → stream order → quality, spec
 *      §22–§23).
 *
 * Failure semantics (spec §25–§26):
 *   * zero playable sources → an EMPTY result, never a thrown error
 *   * per-addon failures are EPHEMERAL in-memory diagnostics only — Phase 3
 *     performs NO database health mutation (manifest health and content
 *     resolution health are different concepts)
 *   * only a resolution-infrastructure failure (the addon DB query itself)
 *     throws a typed `StreamServiceError`
 *
 * Server-only (spec §28): lives under `$lib/server/`, never imported by
 * client code, never exposes manifest URLs or raw addon responses.
 * Caching (spec §27): NONE — stream URLs expire; results are resolved
 * fresh on every call.
 */

export const STREAM_RESOLUTION_CONCURRENCY = 4;
export const STREAM_RESOLUTION_TIMEOUT_MS = 15_000;
/** Upper bound of addons considered per resolution (query-level safety). */
const MAX_ADDONS_PER_RESOLUTION = 50;

export type StremioResolvedStream = {
  addonId: string;
  addonSlug: string;
  addonName: string;
  addonOrdering: number;
  /** Position of the entry inside the addon's `streams` array. */
  streamIndex: number;
  streamName?: string;
  streamTitle?: string;
  url: string;
  protocol: PlaybackProtocol;
  transport: 'http' | 'https';
  mediaType: StremioStreamType;
  /** The Stremio video ID actually requested from THIS addon. */
  videoId: string;
  idProperty: SupportedStremioIdProperty;
  quality: StremioStreamQuality;
  bingeGroup?: string;
  filename?: string;
  videoSize?: number;
  /** Phase 9: addon-supplied stream description (plain text). */
  description?: string;
  /** Phase 9: audio languages derived from ADDON-SUPPLIED labels. */
  audioLanguages?: string[];
  /** Phase 9: container label derived from the addon filename/URL. */
  container?: string;
  /** Phase 9: video codec label derived from ADDON-SUPPLIED text. */
  codec?: string;
  /** Phase 9: addon-provided subtitle tracks (shape-checked). */
  subtitles?: NormalizedStreamSubtitle[];
};

export type StremioUnsupportedStream = UnsupportedStremioStream & { addonId: string; addonName: string };

/** Per-addon diagnostic (in-memory only — never persisted, never exposed to end users). */
export type StremioAddonOutcome =
  | { addonId: string; addonName: string; addonOrdering: number; status: 'ok'; streamCount: number; unsupportedCount: number }
  | { addonId: string; addonName: string; addonOrdering: number; status: 'skipped'; reason: AddonSkipReason }
  | { addonId: string; addonName: string; addonOrdering: number; status: 'failed'; errorCode: StreamErrorCode };

export type StremioStreamResolutionRequest = {
  mediaType: ContentType;
  identifiers: Pick<ContentIdentifiers, 'imdbId' | 'tmdbId'>;
  season?: number;
  episode?: number;
};

export type StremioStreamResolution = {
  /** Stremio endpoint type actually used (`anime` content resolves as series). */
  mediaType: StremioStreamType;
  requestedMediaType: ContentType;
  season?: number;
  episode?: number;
  /** Playable, deduplicated, deterministically ordered HTTP/HLS sources. */
  sources: StremioResolvedStream[];
  /** Excluded entries with typed reasons (in-memory diagnostics). */
  unsupported: StremioUnsupportedStream[];
  diagnostics: StremioAddonOutcome[];
  consideredAddons: number;
  elapsedMs: number;
};

export type StremioStreamResolverDeps = {
  fetcher?: typeof fetch;
  dnsResolver?: SafeDnsResolver;
  /** Per-addon stream request timeout. Default 10s. */
  timeoutMs?: number;
  /** Per-response byte cap. Default 512 KiB. */
  maxBytes?: number;
  /** Bounded concurrency. Default 4 (spec §7). */
  concurrency?: number;
  /** Aggregate resolution budget. Default 15s (spec §8). */
  overallTimeoutMs?: number;
  /** Injectable addon loader (tests); defaults to the enabled-addons DB query. */
  loadAddons?: (client: SupabaseClient<Database>) => Promise<StreamingAddon[]>;
};

type StreamingClient = SupabaseClient<Database>;

/**
 * Loads ENABLED addons with a usable status, deterministically ordered
 * (ordering → name). Status policy: `active` and `experimental` are usable —
 * addons are created with the `experimental` default and `enabled=true` is
 * already the administrator's explicit opt-in; `disabled`, `maintenance` and
 * `unavailable` never resolve.
 *
 * Phase 10: exported — the progressive addon-session service reuses the
 * EXACT same eligibility query (no second policy can drift apart).
 */
export async function loadEnabledAddons(client: StreamingClient): Promise<StreamingAddon[]> {
  const { data, error } = await client
    .from('streaming_addons')
    .select('*')
    .eq('enabled', true)
    .in('status', ['active', 'experimental'])
    .order('ordering', { ascending: true })
    .order('name', { ascending: true })
    .limit(MAX_ADDONS_PER_RESOLUTION);
  if (error) throw error;
  return (data ?? []).map((row) => mapAddonRow(row as Parameters<typeof mapAddonRow>[0]));
}

/** Runs an async worker over items with a bounded number of in-flight tasks. */
async function mapWithBoundedConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Canonical playable-URL identity for deduplication (spec §22): scheme +
 * lowercased host + default-port-stripped authority + path + query. Two
 * URLs that differ only in hostname case or explicit default port are the
 * same stream; anything else stays distinct (never merged by title/quality).
 */
function canonicalStreamKey(stream: StremioResolvedStream): string {
  try {
    const parsed = new URL(stream.url);
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return stream.url;
  }
}

/** First-wins dedupe over an already deterministically ordered list. */
function deduplicateStreams(sources: StremioResolvedStream[]): StremioResolvedStream[] {
  const seen = new Set<string>();
  const result: StremioResolvedStream[] = [];
  for (const stream of sources) {
    const key = canonicalStreamKey(stream);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(stream);
  }
  return result;
}

type AddonFetchOutcome =
  | { addon: StreamingAddon; plan: StremioAddonStreamPlan; status: 'ok'; streams: ReturnType<typeof normalizeStremioStreamResponse>['streams']; unsupported: UnsupportedStremioStream[] }
  | { addon: StreamingAddon; plan: StremioAddonStreamPlan; status: 'failed'; errorCode: StreamErrorCode; streams: []; unsupported: [] };

/**
 * Resolves playable HTTP/HLS streams for one media item from all eligible
 * enabled Stremio addons. NEVER throws because an individual addon failed —
 * only a resolution-infrastructure failure (the addon DB query) or an
 * invalid request shape (series without season/episode) throws.
 */
export async function resolveStremioStreams(client: StreamingClient, request: StremioStreamResolutionRequest, deps: StremioStreamResolverDeps = {}): Promise<StremioStreamResolution> {
  const startedAt = Date.now();
  const concurrency = Math.max(1, deps.concurrency ?? STREAM_RESOLUTION_CONCURRENCY);
  const overallTimeoutMs = deps.overallTimeoutMs ?? STREAM_RESOLUTION_TIMEOUT_MS;
  const streamType = stremioStreamTypeFor(request.mediaType);
  assertEpisodeScope(streamType, request.season, request.episode);

  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), overallTimeoutMs);
  try {
    let addons: StreamingAddon[];
    try {
      addons = await (deps.loadAddons ?? loadEnabledAddons)(client);
    } catch (error) {
      throw new StreamServiceError('UNEXPECTED', { cause: error });
    }

    // Local, request-free eligibility planning — incompatible addons are
    // never called (spec §3–§6).
    const plans: Array<{ addon: StreamingAddon; plan: Extract<AddonStreamPlan, { ok: true }>['plan'] }> = [];
    const diagnostics: StremioAddonOutcome[] = [];
    for (const addon of addons) {
      const plan = planAddonStreamRequest(addon, streamType, request.identifiers, request.season, request.episode);
      if (plan.ok) plans.push({ addon, plan: plan.plan });
      else diagnostics.push({ addonId: addon.id, addonName: addon.name, addonOrdering: addon.ordering, status: 'skipped', reason: plan.reason });
    }

    // Bounded parallel resolution with per-addon failure isolation
    // (spec §7, §24) — every outcome is captured, none propagates.
    const outcomes = await mapWithBoundedConcurrency(plans, concurrency, async ({ addon, plan }): Promise<AddonFetchOutcome> => {
      try {
        const body = await fetchStremioStreamResponse(plan.endpointUrl, {
          fetcher: deps.fetcher,
          dnsResolver: deps.dnsResolver,
          timeoutMs: deps.timeoutMs ?? STREAM_REQUEST_TIMEOUT_MS,
          maxBytes: deps.maxBytes ?? STREAM_MAX_BYTES,
          overallSignal: overallController.signal,
        });
        const normalized = normalizeStremioStreamResponse(body);
        if (!normalized.valid) {
          return { addon, plan, status: 'failed', errorCode: 'INVALID_RESPONSE', streams: [], unsupported: [] };
        }
        return { addon, plan, status: 'ok', streams: normalized.streams, unsupported: normalized.unsupported };
      } catch (error) {
        const serviceError = asStreamServiceError(error);
        if (serviceError.code === 'UNEXPECTED') {
          // Diagnostic detail stays in server logs only (repo convention).
          console.warn('[StremioStreams] unexpected addon stream failure', serviceError.code);
        }
        return { addon, plan, status: 'failed', errorCode: serviceError.code, streams: [], unsupported: [] };
      }
    });

    const sources: StremioResolvedStream[] = [];
    const unsupported: StremioUnsupportedStream[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'ok') {
        diagnostics.push({
          addonId: outcome.addon.id,
          addonName: outcome.addon.name,
          addonOrdering: outcome.addon.ordering,
          status: 'ok',
          streamCount: outcome.streams.length,
          unsupportedCount: outcome.unsupported.length,
        });
        for (const stream of outcome.streams) {
          sources.push({
            addonId: outcome.addon.id,
            addonSlug: outcome.addon.slug,
            addonName: outcome.addon.name,
            addonOrdering: outcome.addon.ordering,
            streamIndex: stream.index,
            streamName: stream.name,
            streamTitle: stream.title,
            url: stream.url,
            protocol: stream.protocol,
            transport: stream.transport,
            mediaType: streamType,
            videoId: outcome.plan.videoId,
            idProperty: outcome.plan.idProperty,
            quality: stream.quality,
            bingeGroup: stream.bingeGroup,
            filename: stream.filename,
            videoSize: stream.videoSize,
            ...(stream.description ? { description: stream.description } : {}),
            ...(stream.audioLanguages ? { audioLanguages: stream.audioLanguages } : {}),
            ...(stream.container ? { container: stream.container } : {}),
            ...(stream.codec ? { codec: stream.codec } : {}),
            ...(stream.subtitles ? { subtitles: stream.subtitles } : {}),
          });
        }
        for (const entry of outcome.unsupported) {
          unsupported.push({ ...entry, addonId: outcome.addon.id, addonName: outcome.addon.name });
        }
      } else {
        diagnostics.push({ addonId: outcome.addon.id, addonName: outcome.addon.name, addonOrdering: outcome.addon.ordering, status: 'failed', errorCode: outcome.errorCode });
      }
    }

    // Deterministic ordering (spec §23): addon ordering → addon name →
    // stream order → quality height. Collected AFTER all resolution, so a
    // fast/slow addon can never reorder the result.
    sources.sort(
      (a, b) =>
        a.addonOrdering - b.addonOrdering ||
        a.addonName.localeCompare(b.addonName) ||
        a.streamIndex - b.streamIndex ||
        (b.quality.height ?? 0) - (a.quality.height ?? 0),
    );

    return {
      mediaType: streamType,
      requestedMediaType: request.mediaType,
      ...(request.season !== undefined ? { season: request.season } : {}),
      ...(request.episode !== undefined ? { episode: request.episode } : {}),
      sources: deduplicateStreams(sources),
      unsupported,
      diagnostics,
      consideredAddons: addons.length,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(overallTimer);
  }
}
