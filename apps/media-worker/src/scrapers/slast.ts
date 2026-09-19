import { dummyExtract, type ExtractParams, type ExtractResult } from './types.js';

/**
 * Phase 2 — SLast dummy scraper.
 * Simulates a network delay and resolves with a mock HLS stream URL.
 */
export function extract(params: ExtractParams): Promise<ExtractResult> {
  void params;
  return dummyExtract('SLast');
}
