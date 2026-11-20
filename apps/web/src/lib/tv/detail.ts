/**
 * TV detail fetch — STAGE 2 data wiring (widget build only).
 *
 * The detail page loads (/movie, /tv-show, /anime-movie, /anime-series)
 * run server-side on the web; in the .wgt they are stashed and the shared
 * DetailPage component would fall back to the static local stub
 * (getMedia). This module fetches the REAL detail from the deployed
 * production API via /api/tv/content/[type]/[id] — a TV endpoint that
 * returns the page-load shape ({ item: toMediaItem(detail) }) WITH the
 * same adult-content guard and CORS as the other TV endpoints.
 *
 * FAILURE CONTRACT: never throws — undefined on any failure (the page
 * keeps its existing fallback) and the TV status strip surfaces the URL
 * + error.
 */

import type { MediaItem } from '$data/content';
import { TV_API_BASE } from './api-base';
import { showTvStatus } from './status';

export type TvDetailType = 'movie' | 'series' | 'anime';

type TvDetailResponse = { ok?: boolean; item?: MediaItem };

export async function fetchTvDetail(
  type: TvDetailType,
  id: string
): Promise<MediaItem | undefined> {
  const url = `${TV_API_BASE}/api/tv/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
  try {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      });
      if (!response.ok) {
        showTvStatus(`TV data: detail failed (HTTP ${response.status})`, url);
        return undefined;
      }
      const payload = (await response.json()) as TvDetailResponse;
      if (!payload?.ok || !payload.item || typeof payload.item !== 'object') {
        showTvStatus('TV data: detail response was empty', url);
        return undefined;
      }
      return payload.item;
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showTvStatus(`TV data: detail failed (${message})`, url);
    return undefined;
  }
}
