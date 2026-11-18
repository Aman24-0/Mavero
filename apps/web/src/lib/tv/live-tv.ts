/**
 * TV Live TV availability — STAGE 2 data wiring (widget build only).
 *
 * The /live-tv page's availability guard runs in +page.server.ts, which
 * does NOT exist inside the static-SPA .wgt (data = {} → the page would
 * permanently render the honest unavailable state). This module fetches
 * the EXACT payload the server load returns from the deployed production
 * API (/api/tv/live-tv — same fail-closed semantics, CORS opened
 * server-side) so the TV renders the REAL availability contract:
 * `{ availability: { available, sources }, indianProxyUrl }`.
 *
 * FAILURE CONTRACT: never throws — on any failure the page keeps the
 * fail-closed default (unavailable) and the TV status strip surfaces the
 * URL + error.
 */

import { TV_API_BASE } from './api-base';
import { showTvStatus } from './status';

export type TvLiveTvSource = { id: string; name: string };
export type TvLiveTvAvailability = { available: boolean; sources: TvLiveTvSource[] };
export type TvLiveTvPayload = { availability: TvLiveTvAvailability; indianProxyUrl: string | null };

type TvLiveTvResponse = {
  ok?: boolean;
  availability?: { available?: boolean; sources?: TvLiveTvSource[] };
  indianProxyUrl?: string | null;
};

export async function fetchTvLiveTv(): Promise<TvLiveTvPayload | undefined> {
  const url = `${TV_API_BASE}/api/tv/live-tv`;
  try {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      });
      if (!response.ok) {
        showTvStatus(`TV data: live-tv failed (HTTP ${response.status})`, url);
        return undefined;
      }
      const payload = (await response.json()) as TvLiveTvResponse;
      if (!payload?.ok || !payload.availability) {
        showTvStatus('TV data: live-tv response was empty', url);
        return undefined;
      }
      return {
        availability: {
          available: payload.availability.available === true,
          sources: Array.isArray(payload.availability.sources)
            ? payload.availability.sources.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
            : []
        },
        indianProxyUrl: typeof payload.indianProxyUrl === 'string' ? payload.indianProxyUrl : null
      };
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showTvStatus(`TV data: live-tv failed (${message})`, url);
    return undefined;
  }
}
