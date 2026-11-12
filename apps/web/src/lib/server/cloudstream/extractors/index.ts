/**
 * MAVERO CloudStream extractor abstraction + registry (CS-2 — plan §9/§40.6).
 *
 * Extractors are SEPARATE from provider adapters: a provider walks its site
 * to collector URLs; an extractor turns a collector URL into direct stream
 * candidates. Both the Kotlin architecture and this port share extractors
 * across providers (GDFlix is used by Bollyflix AND MoviesDrive; HubCloud
 * by MoviesDrive; V-Cloud by VegaMovies).
 *
 * Security: extractors receive the SAME bounded runtime context as adapters
 * (no raw fetch). Extractor URLs come from untrusted provider pages, so
 * every fetch inside an extractor runs the full SSRF guard — a malicious
 * provider page cannot redirect Mavero at internal infrastructure.
 */

import type { MaveroCloudStreamExtractor, CloudStreamRuntimeContext } from '../types/runtime';
import type { CloudStreamExtractedLink } from '../normalize/links';
import { gdflixExtractor } from './gdflix';
import { hubcloudExtractor } from './hubcloud';
import { fastdlserverExtractor } from './fastdlserver';

/** All registered extractor ports (code-owned; order = matching precedence). */
const EXTRACTORS: readonly MaveroCloudStreamExtractor[] = [
  gdflixExtractor,
  hubcloudExtractor,   // also covers V-Cloud hosts via the vcloud dynamic key
  fastdlserverExtractor,
];

/** Registry lookup by extractor id. */
export function lookupCloudStreamExtractor(id: string): MaveroCloudStreamExtractor | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  return EXTRACTORS.find((extractor) => extractor.id === id) ?? null;
}

/** All registered extractors (read-only view for diagnostics/tests). */
export function listCloudStreamExtractors(): readonly MaveroCloudStreamExtractor[] {
  return EXTRACTORS;
}

/**
 * Finds the extractor responsible for one URL (matching precedence order).
 * Null when no registered extractor handles the host.
 */
export function matchCloudStreamExtractor(url: string): MaveroCloudStreamExtractor | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  return EXTRACTORS.find((extractor) => extractor.matches(url)) ?? null;
}

/**
 * Dispatches one collector URL through its matching extractor. Returns an
 * EMPTY array when no extractor matches (honest unknown — the Kotlin
 * `loadExtractor` would try its global registry; Mavero only runs
 * Mavero-owned ports). Failures inside a registered extractor are caught
 * per-extractor and reported through diagnostics — one broken extractor
 * never throws into the adapter (reliability rule I).
 */
export async function runCloudStreamExtractor(
  url: string,
  ctx: CloudStreamRuntimeContext,
  opts: { adapterId: string; label?: string } = { adapterId: 'runtime' },
): Promise<CloudStreamExtractedLink[]> {
  const extractor = matchCloudStreamExtractor(url);
  if (extractor === null) return [];

  const started = ctx.now();
  let links: CloudStreamExtractedLink[] = [];
  let success = true;
  try {
    links = await extractor.extract(url, ctx);
    return links;
  } catch {
    // Per-extractor failure isolation (plan §20: extractor failure is a
    // category, not a crash). Safe message only — never the raw error.
    success = false;
    return [];
  } finally {
    ctx.diagnostics.record({
      adapterId: opts.adapterId,
      stage: 'extractor',
      durationMs: Math.max(0, ctx.now() - started),
      success,
      ...(success ? {} : { failureCategory: 'EXTRACTOR_FAILED' }),
      extractorId: extractor.id,
      ...(links !== undefined && links.length > 0 ? { resultCount: links.length } : {}),
    });
  }
}

/** Re-exported for consumers that need individual extractor ports. */
export { gdflixExtractor, hubcloudExtractor, fastdlserverExtractor };
