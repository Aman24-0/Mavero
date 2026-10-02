/**
 * MAVERO CloudStream resolution orchestrator (CS-2 — plan §40.4/§40.6).
 *
 * The DB-FREE bounded orchestrator over adapter instances. Given a media
 * request + a set of adapter ids it resolves every adapter with:
 *   * bounded concurrency (≤4, matching the Stremio ADDON_CONCURRENCY),
 *   * a per-adapter deadline (30s budget, clamped by the overall deadline),
 *   * allSettled isolation — one failing/timing-out provider NEVER destroys
 *     the successful providers' results (reliability rule: Provider A
 *     timeout + Provider B success + Provider C extractor failure → the
 *     result still contains Provider B),
 *   * per-adapter diagnostics (durations, failure categories, counts).
 *
 * CS-3 will layer the `/api/downloader/mavero2*` endpoints + DB
 * enabled-extension selection on top of this orchestrator. This module
 * stays free of DB/API/UI concerns so the runtime is deterministically
 * testable (plan §40.6: "resolver/service.ts realized in CS-2 as the
 * DB-free bounded orchestrator").
 */

import type {
  CloudStreamDiagnosticEvent,
  CloudStreamFailureCategory,
  CloudStreamLinkResult,
  CloudStreamResolutionGroup,
  CloudStreamResolutionRequest,
  CloudStreamResolutionResult,
  MaveroCloudStreamAdapter,
} from '../types/runtime';
import { lookupCloudStreamAdapterInstance } from '../adapters/registry';
import { createCloudStreamRuntimeContext } from '../runtime/context';
import { dedupeCloudStreamLinks } from '../normalize/links';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';

/** Bounded parallel adapter resolution (plan §10.5; ADDON_CONCURRENCY parity). */
export const CLOUDSTREAM_ADAPTER_CONCURRENCY = 4;
/** Per-adapter timeout budget (matches the Stremio downloader budget). */
export const CLOUDSTREAM_ADAPTER_TIMEOUT_MS = 30_000;
/** Overall budget across all adapters (OVERALL_TIMEOUT_MS parity). */
export const CLOUDSTREAM_RESOLUTION_TIMEOUT_MS = 40_000;

export type CloudStreamResolverDeps = {
  /** Injectable fetcher (tests never touch the real network). */
  fetcher?: typeof fetch;
  /** Injectable DNS resolver (tests). */
  dnsResolver?: SafeDnsResolver;
  /** Per-adapter timeout override (tests). */
  adapterTimeoutMs?: number;
  /** Overall timeout override (tests). */
  overallTimeoutMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /**
   * External cancellation (Permanent Adapter Plan Phase 1): the API layer
   * forwards the client's request signal here — an abandoned request aborts
   * the overall controller exactly like the overall timer does.
   */
  signal?: AbortSignal;
};

/** Manifold bounded-concurrency map (exported for deterministic tests). */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

/** Classifies a thrown error against the deadline. */
function classifyThrown(
  error: unknown,
  deadlineAborted: boolean,
): { category: CloudStreamFailureCategory; message: string } {
  if (deadlineAborted) return { category: 'TIMEOUT', message: 'The provider resolution exceeded its deadline.' };
  return { category: 'UNEXPECTED', message: 'The provider resolution failed unexpectedly.' };
}

/** Links an external cancellation into a controller (Phase 1). */
function linkExternalSignal(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/** Translates a resolve result into a group status. */
function groupStatusOf(result: CloudStreamLinkResult): CloudStreamResolutionGroup['status'] {
  if (result.failure !== undefined && result.links.length === 0) return 'failed';
  return result.links.length > 0 ? 'loaded' : 'empty';
}

/**
 * Resolves one media request across the given adapter ids.
 *
 * Unknown adapter ids are reported as failed groups with the UNSUPPORTED
 * category (honest visibility — CS-3 filters by registry compatibility
 * before calling, so this is a defensive path).
 */
export async function resolveCloudStream(
  request: CloudStreamResolutionRequest,
  deps: CloudStreamResolverDeps = {},
): Promise<CloudStreamResolutionResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const overallTimeoutMs = deps.overallTimeoutMs ?? CLOUDSTREAM_RESOLUTION_TIMEOUT_MS;
  const adapterTimeoutMs = deps.adapterTimeoutMs ?? CLOUDSTREAM_ADAPTER_TIMEOUT_MS;

  // Overall deadline controller.
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), overallTimeoutMs);
  // Phase 1: external cancellation (the API layer's client-disconnect signal)
  // aborts the SAME controller — client abandonment stops server work.
  const unlinkExternal = linkExternalSignal(deps.signal, overallController);

  // De-duplicate adapter ids while preserving order.
  const requestedIds: string[] = [];
  const seenIds = new Set<string>();
  for (const rawId of Array.isArray(request.adapterIds) ? request.adapterIds : []) {
    if (typeof rawId !== 'string' || rawId.length === 0) continue;
    const instance = lookupCloudStreamAdapterInstance(rawId);
    const canonicalId = instance !== null ? instance.id : rawId;
    const key = canonicalId.toLowerCase();
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    requestedIds.push(canonicalId);
  }

  const groups: CloudStreamResolutionGroup[] = [];
  const diagnostics: CloudStreamDiagnosticEvent[] = [];

  try {
    await mapBounded(requestedIds, CLOUDSTREAM_ADAPTER_CONCURRENCY, async (adapterId) => {
      const adapter = lookupCloudStreamAdapterInstance(adapterId);
      if (adapter === null) {
        groups.push({
          adapterId,
          adapterName: adapterId,
          status: 'failed',
          links: [],
          failure: { category: 'UNSUPPORTED', message: 'No Mavero adapter is registered for this extension.' },
        });
        diagnostics.push({
          adapterId,
          stage: 'resolve',
          durationMs: 0,
          success: false,
          failureCategory: 'UNSUPPORTED',
        });
        return;
      }

      // Per-adapter deadline: overall budget clamped by the per-adapter budget.
      const perAdapterController = new AbortController();
      const perAdapterTimer = setTimeout(() => perAdapterController.abort(), adapterTimeoutMs);
      const propagate = () => perAdapterController.abort();
      if (overallController.signal.aborted) perAdapterController.abort();
      else overallController.signal.addEventListener('abort', propagate, { once: true });

      // Permanent Adapter Plan Phase 1 (RC-3 fix): the per-adapter deadline
      // is a PROMISE RACE, not just an abort signal. The worker settles at
      // the deadline EVEN IF adapter code never observes the signal — no
      // code path can make the request wait past its budget. The losing
      // adapter promise is signal-aborted (every runtime fetch observes the
      // deadline after the F1/F2 signal fixes) and settles promptly; the
      // race subscription keeps its eventual rejection handled (never an
      // unhandled rejection).
      const deadlineRejected = Symbol('cloudstream-adapter-deadline');
      const deadlinePromise = new Promise<never>((_, reject) => {
        if (perAdapterController.signal.aborted) {
          reject(deadlineRejected);
          return;
        }
        perAdapterController.signal.addEventListener('abort', () => reject(deadlineRejected), { once: true });
      });

      const adapterStarted = now();
      let result: CloudStreamLinkResult;
      try {
        const ctx = createCloudStreamRuntimeContext({
          adapterId: adapter.id,
          signal: perAdapterController.signal,
          ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
          ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        });

        const isEpisode = request.season !== undefined && request.episode !== undefined;
        const baseRequest = {
          tmdbId: request.media.tmdbId,
          title: request.media.title,
          ...(request.media.year !== undefined ? { year: request.media.year } : {}),
          deadline: perAdapterController.signal,
        };

        const unsupported = (message: string): CloudStreamLinkResult =>
          ({ links: [], failure: { category: 'UNSUPPORTED', message } });
        let adapterPromise: Promise<CloudStreamLinkResult>;
        if (isEpisode) {
          adapterPromise = adapter.resolveEpisode === undefined
            ? Promise.resolve(unsupported('This adapter does not support episode resolution.'))
            : adapter.resolveEpisode(
                { ...baseRequest, season: request.season!, episode: request.episode! },
                ctx,
              );
        } else {
          adapterPromise = !adapter.supports.movie
            ? Promise.resolve(unsupported('This adapter does not support movie resolution.'))
            : adapter.resolveMovie(baseRequest, ctx);
        }

        try {
          result = await Promise.race([adapterPromise, deadlinePromise]);
          // Defensive normalization: a thrown-but-caught adapter still yields
          // its diagnostics via the context sink.
          diagnostics.push(...ctx.diagnostics.events());
        } catch (error) {
          const deadlineAborted = perAdapterController.signal.aborted;
          const classified = classifyThrown(error, deadlineAborted);
          result = { links: [], failure: classified };
        }
      } catch (error) {
        const deadlineAborted = perAdapterController.signal.aborted;
        const classified = classifyThrown(error, deadlineAborted);
        result = { links: [], failure: classified };
      } finally {
        clearTimeout(perAdapterTimer);
        overallController.signal.removeEventListener('abort', propagate);
      }

      const linkResult = result;
      const links = dedupeCloudStreamLinks(
        (linkResult.links ?? []).map((link) => ({ ...link, provider: adapter.id })),
      );

      groups.push({
        adapterId: adapter.id,
        adapterName: adapter.displayName,
        status: groupStatusOf(result),
        links,
        ...(result.failure !== undefined && links.length === 0 ? { failure: result.failure } : {}),
        ...(linkResult.matchedTitle !== undefined && linkResult.matchedTitle.length > 0
          ? { matchedTitle: linkResult.matchedTitle }
          : {}),
      });

      diagnostics.push({
        adapterId: adapter.id,
        stage: 'resolve',
        durationMs: Math.max(0, now() - adapterStarted),
        success: result.failure === undefined || links.length > 0,
        ...(result.failure !== undefined ? { failureCategory: result.failure.category } : {}),
        ...(links.length > 0 ? { resultCount: links.length } : {}),
      });
    });
  } finally {
    clearTimeout(overallTimer);
    unlinkExternal();
  }

  return {
    groups,
    diagnostics,
    durationMs: Math.max(0, now() - startedAt),
  };
}
