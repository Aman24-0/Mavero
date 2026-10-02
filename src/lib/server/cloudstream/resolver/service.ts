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

        if (isEpisode) {
          if (adapter.resolveEpisode === undefined) {
            result = { links: [], failure: { category: 'UNSUPPORTED', message: 'This adapter does not support episode resolution.' } };
          } else {
            result = await adapter.resolveEpisode(
              { ...baseRequest, season: request.season!, episode: request.episode! },
              ctx,
            );
          }
        } else {
          if (!adapter.supports.movie) {
            result = { links: [], failure: { category: 'UNSUPPORTED', message: 'This adapter does not support movie resolution.' } };
          } else {
            result = await adapter.resolveMovie(baseRequest, ctx);
          }
        }

        // Defensive normalization: a thrown-but-caught adapter still yields
        // its diagnostics via the context sink.
        diagnostics.push(...ctx.diagnostics.events());
      } catch (error) {
        const deadlineAborted = perAdapterController.signal.aborted;
        const classified = classifyThrown(error, deadlineAborted);
        result = { links: [], failure: classified };
      } finally {
        clearTimeout(perAdapterTimer);
        overallController.signal.removeEventListener('abort', propagate);
      }

      const links = dedupeCloudStreamLinks(
        (result.links ?? []).map((link) => ({ ...link, provider: adapter.id })),
      );

      groups.push({
        adapterId: adapter.id,
        adapterName: adapter.displayName,
        status: groupStatusOf(result),
        links,
        ...(result.failure !== undefined && links.length === 0 ? { failure: result.failure } : {}),
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
  }

  return {
    groups,
    diagnostics,
    durationMs: Math.max(0, now() - startedAt),
  };
}
