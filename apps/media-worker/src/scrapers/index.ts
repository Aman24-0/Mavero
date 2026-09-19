/**
 * Phase 2 — Scraper registry.
 *
 * Collects all scraper modules so the SSE endpoint can execute them
 * concurrently. Each entry has a display name (matching the frontend
 * provider card names) and an extract function.
 */

import * as vidsrc from './vidsrc.js';
import * as vidlink from './vidlink.js';
import * as cineverse from './cineverse.js';
import * as slast from './slast.js';
import type { ExtractParams, ExtractResult } from './types.js';

export type ScraperEntry = {
  name: string;
  extract: (params: ExtractParams) => Promise<ExtractResult>;
};

export const scrapers: ScraperEntry[] = [
  { name: 'VidSrc', extract: vidsrc.extract },
  { name: 'VidLink', extract: vidlink.extract },
  { name: 'Cineverse', extract: cineverse.extract },
  { name: 'SLast', extract: slast.extract },
];
