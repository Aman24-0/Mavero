/**
 * MAVERO CloudStream extractor — fastdlserver port (CS-2).
 *
 * Faithful port of the verified Kotlin `fastdlserver` extractor
 * (Bollyflix `Extractors.kt`): a fastdlserver link is a single redirect
 * hop — GET without following redirects, read the Location header, then
 * dispatch the destination through the extractor registry (in Kotlin:
 * `loadExtractor(location, …)`).
 *
 * In Mavero the re-dispatch goes through the runtime context's extractor
 * dispatch (`ctx.runExtractor`), which only ever invokes Mavero-owned
 * extractor ports — an unknown destination host yields an honest empty
 * result. The Location destination is SSRF-guarded before any fetch (a
 * malicious provider page cannot use this hop to reach internal
 * infrastructure). Recursion is bounded: a fastdlserver destination is
 * refused (real chains are single-hop).
 */

import type { MaveroCloudStreamExtractor, CloudStreamRuntimeContext } from '../types/runtime';
import type { CloudStreamExtractedLink } from '../normalize/links';

const FASTDLSERVER_ID = 'fastdlserver';

export const fastdlserverExtractor: MaveroCloudStreamExtractor = {
  id: FASTDLSERVER_ID,
  displayName: 'fastdlserver',
  matches(url: string): boolean {
    return /fastdlserver\./i.test(url);
  },

  async extract(url: string, ctx: CloudStreamRuntimeContext): Promise<CloudStreamExtractedLink[]> {
    const probe = await ctx.fetchRedirect(url);
    const location = probe.location ?? probe.headerValue ?? '';
    if (typeof location !== 'string' || location.length === 0) return [];
    // Bounded recursion: never follow a fastdlserver → fastdlserver hop.
    if (/fastdlserver\./i.test(location)) return [];
    // Kotlin parity: loadExtractor(location) — re-dispatch through the
    // Mavero-owned registry; unmatched hosts return [] immediately.
    const dispatched = await ctx.runExtractor(location);
    // Attribute the links to the fastdlserver hop so diagnostics can trace
    // the chain (sourceName keeps the downstream extractor's identity).
    return dispatched.map((link) => ({ ...link, extractor: link.extractor ?? FASTDLSERVER_ID }));
  },
};
