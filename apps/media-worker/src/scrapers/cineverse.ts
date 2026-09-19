import type { ExtractError, ExtractParams, ExtractResult } from './types.js';

/**
 * Cineverse extractor — NOT IMPLEMENTED.
 *
 * This provider does not have a real extraction adapter yet. Rather
 * than fake a successful extraction with a Mux test stream (which
 * would lie to the UI), this adapter ALWAYS rejects with a typed
 * `UNSUPPORTED` error. The frontend renders the provider card as
 * "Unavailable" rather than "Ready".
 *
 * When a real Cineverse extraction flow is added, replace this body
 * with the real fetch + parse pipeline (mirror `vidsrc.ts`).
 */

const PROVIDER = 'Cineverse';

export function extract(_params: ExtractParams): Promise<ExtractResult> {
  return Promise.reject({
    provider: PROVIDER,
    category: 'UNSUPPORTED',
    error: 'Cineverse extraction is not implemented',
  } satisfies ExtractError);
}
