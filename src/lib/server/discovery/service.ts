import { validateProviderEndpoint } from '$lib/server/resolver/safe-url';
import { DiscoveryError, asDiscoveryError } from './errors';
import { genericDiscoveryDetectors } from './detectors';
import { deduplicateCandidates } from './parsing';
import { createDefaultDiscoveryRegistry, resolveCandidateWithRegistry, resolverCandidates } from './registry';
import type { DiscoveryDiagnostics, DiscoveryPage, DiscoveryRegistry, DiscoveryRequest, DiscoveryResult, DiscoveryResolver, MediaCandidate, NormalizedStreamResult } from './types';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_PAGE_CHARS = 1_500_000;
const MAX_CONCURRENCY = 4;

function validatePublicPageUrl(raw: string): string {
  try {
    return validateProviderEndpoint(raw);
  } catch (error) {
    throw new DiscoveryError('BLOCKED_SOURCE', error);
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DiscoveryError('CANCELLED');
}

export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellationHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DiscoveryError('TIMEOUT')), timeoutMs);
  });
  const cancellation = new Promise<never>((_, reject) => {
    cancellationHandler = () => reject(new DiscoveryError('CANCELLED'));
    signal.addEventListener('abort', cancellationHandler, { once: true });
  });
  try {
    return await Promise.race([work, timeout, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancellationHandler) signal.removeEventListener('abort', cancellationHandler);
  }
}

export async function fetchPublicPage(request: DiscoveryRequest, fetcher: typeof fetch = fetch): Promise<DiscoveryPage> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let url = validatePublicPageUrl(request.pageUrl);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await fetcher(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1',
        },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location || redirectCount === 3) throw new DiscoveryError('DISCOVERY_FAILED');
      url = validatePublicPageUrl(new URL(location, url).toString());
    }
    if (response!.status === 404) throw new DiscoveryError('SOURCE_NOT_FOUND');
    if (response!.status === 401 || response!.status === 403) throw new DiscoveryError('BLOCKED_SOURCE');
    if (!response!.ok) throw new DiscoveryError('DISCOVERY_FAILED');
    const contentType = response!.headers.get('content-type') ?? '';
    const html = (await response!.text()).slice(0, MAX_PAGE_CHARS);
    return { url, html, contentType, status: response!.status };
  } catch (error) {
    if (controller.signal.aborted && !request.signal?.aborted) throw new DiscoveryError('TIMEOUT', error);
    if (request.signal?.aborted) throw new DiscoveryError('CANCELLED', error);
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

export function pageFromHtml(pageUrl: string, html: string, contentType = 'text/html', status = 200): DiscoveryPage {
  return { url: validatePublicPageUrl(pageUrl), html: html.slice(0, MAX_PAGE_CHARS), contentType, status };
}

function emptyDiagnostics(pageUrl: string): DiscoveryDiagnostics {
  return { pageUrl, methodsAttempted: [], candidatesFound: 0, resolversAttempted: [], successfulResults: 0, failures: [], durationMs: 0, finalStreamCount: 0 };
}

function deduplicateStreams(streams: NormalizedStreamResult[]): NormalizedStreamResult[] {
  const byUrl = new Map<string, NormalizedStreamResult>();
  for (const stream of streams) {
    const key = stream.url.toLowerCase();
    const existing = byUrl.get(key);
    if (!existing || stream.confidence > existing.confidence) byUrl.set(key, stream);
  }
  return [...byUrl.values()].sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
}

async function runBounded<T>(items: T[], worker: (item: T, index: number) => Promise<void>, maxConcurrency = MAX_CONCURRENCY): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(maxConcurrency, Math.max(items.length, 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) await worker(item, index);
    }
  });
  await Promise.all(workers);
}

export async function resolveDiscoveredPage(page: DiscoveryPage, registry: DiscoveryRegistry = { detectors: genericDiscoveryDetectors, resolvers: createDefaultDiscoveryRegistry().resolvers }, signal = new AbortController().signal): Promise<DiscoveryResult> {
  const startedAt = Date.now();
  const diagnostics = emptyDiagnostics(page.url);
  const candidates: MediaCandidate[] = [];
  for (const detector of registry.detectors) {
    if (detector.enabled === false) continue;
    throwIfAborted(signal);
    const detectorStartedAt = Date.now();
    diagnostics.methodsAttempted.push(detector.method);
    try {
      candidates.push(...detector.detect(page));
    } catch {
      diagnostics.failures.push({ resolverId: detector.id, stage: 'discovery', durationMs: Date.now() - detectorStartedAt, candidateCount: 0, resultCount: 0, errorCode: 'DISCOVERY_FAILED' });
    }
  }
  const uniqueCandidates = deduplicateCandidates(candidates);
  diagnostics.candidatesFound = uniqueCandidates.length;
  const context = { page, candidates: uniqueCandidates, signal };
  const pairs = resolverCandidates(registry, uniqueCandidates, context);
  diagnostics.resolversAttempted = [...new Set(pairs.map((pair) => pair.resolver.id))];
  const results: Array<NormalizedStreamResult | null> = new Array(pairs.length).fill(null);
  await runBounded(pairs, async ({ resolver, candidate }, index) => {
    throwIfAborted(signal);
    const attemptStartedAt = Date.now();
    try {
      const result = await resolveCandidateWithRegistry(resolver, candidate, context, withTimeout);
      if (result) {
        results[index] = result;
        diagnostics.successfulResults += 1;
      }
    } catch (error) {
      const resolverError = asDiscoveryError(error, 'RESOLUTION_FAILED');
      diagnostics.failures.push({ resolverId: resolver.id, stage: 'resolution', durationMs: Date.now() - attemptStartedAt, candidateCount: 1, resultCount: 0, errorCode: resolverError.code });
    }
  });
  const streams = deduplicateStreams(results.filter((result): result is NormalizedStreamResult => Boolean(result)));
  diagnostics.finalStreamCount = streams.length;
  diagnostics.durationMs = Date.now() - startedAt;
  return { streams, diagnostics };
}

export async function discoverPublicPage(request: DiscoveryRequest, registry?: DiscoveryRegistry, fetcher: typeof fetch = fetch): Promise<DiscoveryResult> {
  const signal = request.signal ?? new AbortController().signal;
  const page = await fetchPublicPage(request, fetcher);
  return resolveDiscoveredPage(page, registry, signal);
}
