/**
 * Scraper registry — collects all production-ready scrapers so the
 * SSE endpoint can execute them concurrently.
 *
 * DESIGN CONTRACTS (Phase 7):
 *   * Every entry's `extract()` MUST accept `(params, options)` where
 *     `options.signal` is the SSE handler's `AbortSignal` so a client
 *     disconnect cancels in-flight fetches.
 *   * NO production entry calls `dummyExtract()` — that function is
 *     TEST-FIXTURE-ONLY and lives in `types.ts` for isolation.
 *   * Providers that do not have a real extractor return a typed
 *     `UNSUPPORTED` error — they are still registered so the UI can
 *     render them as "Unavailable" rather than silently omitting them.
 */

import * as vidsrc from './vidsrc.js';
import * as vidlink from './vidlink.js';
import * as cineverse from './cineverse.js';
import * as slast from './slast.js';
import type { ExtractParams, ExtractResult } from './types.js';

export type ScraperEntry = {
  name: string;
  extract: (params: ExtractParams, options?: { signal?: AbortSignal }) => Promise<ExtractResult>;
};

export const scrapers: ScraperEntry[] = [
  { name: 'VidSrc', extract: vidsrc.extract },
  { name: 'VidLink', extract: vidlink.extract },
  { name: 'Cineverse', extract: cineverse.extract },
  { name: 'SLast', extract: slast.extract },
];
