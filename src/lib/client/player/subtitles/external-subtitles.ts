/**
 * Player UI V2 (Part 1, Phase 3A) — external (VDRK) subtitle client.
 *
 * Loads the subtitle list for the CURRENT title/episode from the VDRK API
 * (verified live 2026-10-12: `access-control-allow-origin: *` on both list
 * endpoints, `application/json`, empty list = 200 `[]`), validates every
 * entry, and rewrites each track's `file` URL to Mavero's SAME-ORIGIN VTT
 * proxy (the cross-origin <track> load itself is blocked by the browser
 * without a `crossorigin` attribute on the <video>, which must NOT be added —
 * it would break native-HLS providers; see server/subtitles/vdrk.ts).
 *
 * Contracts (all unit-tested):
 *   * Non-blocking: callers fire-and-forget — playback never awaits a list.
 *   * Validation: label = non-empty bounded string; file = HTTPS on the exact
 *     VDRK VTT origin with the exact observed path shapes (movie:
 *     /v1/vtt/movie/{tmdb}/{label}.vtt; tv: /v1/vtt/tv/{tmdb}/{s}/{e}/{label}.vtt).
 *     Anything else is DROPPED — no fabricated tracks, no unvalidated URLs.
 *   * Variants stay individual: entries are keyed by their own file URL, so
 *     "English" / "English2" / "English3" remain separately selectable.
 *   * Dedup by rewritten proxy URL (identical files collapse, distinct
 *     variants never do).
 *   * Bounded caching: LRU of at most 16 media keys, 10-minute TTL, single
 *     in-flight request per key (dedup), 8-second timeout per fetch.
 *   * Stale-response guard: the caller's media key is compared when the
 *     response lands — a superseded lookup never resolves into state.
 *   * Failures resolve to an EMPTY track list with a typed reason — playback
 *     and the native subtitle tracks are untouched.
 */

/** The verified VDRK API origin (subtitle LISTS — browser-direct, CORS open). */
export const VDRK_LIST_ORIGIN = 'https://sub.vdrk.site';
/** The verified VDRK VTT origin (subtitle FILES — only reachable same-origin via the proxy). */
export const VDRK_VTT_ORIGIN = 'https://cache.vdrk.site';

/** Observed list path shapes: /v1/movie/{tmdb} and /v1/tv/{tmdb}/{s}/{e}. */
const VTT_MOVIE_PATH = /^\/v1\/vtt\/movie\/([1-9][0-9]{0,15})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.vtt$/;
const VTT_TV_PATH = /^\/v1\/vtt\/tv\/([1-9][0-9]{0,15})\/([1-9][0-9]{0,7})\/([1-9][0-9]{0,7})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.vtt$/;

export type ExternalSubtitleTrack = {
  /** Same-origin proxy URL for the <track> element. */
  url: string;
  label: string;
};

/**
 * Merges the source's NATIVE subtitle tracks (first, unchanged selection
 * order) with the validated external VDRK tracks, deduped by URL. A native
 * track whose URL equals an external one wins (the external duplicate is
 * dropped) — stream-provided tracks always keep priority.
 */
export function mergeSubtitleTracks<T extends { url: string }>(native: T[] | undefined, external: ExternalSubtitleTrack[]): (T | ExternalSubtitleTrack)[] {
  const merged: (T | ExternalSubtitleTrack)[] = [];
  const seen = new Set<string>();
  for (const track of native ?? []) {
    if (!track?.url || seen.has(track.url)) continue;
    seen.add(track.url);
    merged.push(track);
  }
  for (const track of external) {
    if (!track?.url || seen.has(track.url)) continue;
    seen.add(track.url);
    merged.push(track);
  }
  return merged;
}

export type ExternalSubtitleRequest = {
  kind: 'movie' | 'tv';
  tmdbId: number;
  season?: number;
  episode?: number;
};

export type ExternalSubtitleResult = {
  tracks: ExternalSubtitleTrack[];
  error: 'network' | 'timeout' | 'invalid-response' | null;
};

/**
 * Rewrites a VERIFIED upstream VTT file URL to Mavero's same-origin proxy
 * path. Returns null for anything that is not an HTTPS URL on the exact VDRK
 * VTT origin with the exact observed path shape — the caller drops those
 * entries (no fabricated tracks, no arbitrary URL forwarding).
 */
export function vdrkFileToProxyPath(fileUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.origin.toLowerCase() !== VDRK_VTT_ORIGIN) return null;
  if (parsed.search || parsed.hash) return null;
  const movieMatch = VTT_MOVIE_PATH.exec(parsed.pathname);
  if (movieMatch) {
    return `/api/content/subtitles/vtt/movie/${movieMatch[1]}/${movieMatch[2]}`;
  }
  const tvMatch = VTT_TV_PATH.exec(parsed.pathname);
  if (tvMatch) {
    return `/api/content/subtitles/vtt/tv/${tvMatch[1]}/${tvMatch[2]}/${tvMatch[3]}/${tvMatch[4]}`;
  }
  return null;
}

export type VdrkListEntry = { label: string; file: string };

/**
 * Validates a parsed subtitle-list payload. Returns only the entries whose
 * label and file URL pass the verified contract, each rewritten to the
 * same-origin proxy path, deduped by proxy URL.
 */
export function parseVdrkEntries(raw: unknown): ExternalSubtitleTrack[] {
  if (!Array.isArray(raw)) return [];
  const tracks: ExternalSubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const candidate = entry as { label?: unknown; file?: unknown };
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const file = typeof candidate.file === 'string' ? candidate.file.trim() : '';
    if (!label || label.length > 80) continue;
    if (!file) continue;
    const proxyPath = vdrkFileToProxyPath(file);
    if (!proxyPath) continue;
    if (seen.has(proxyPath)) continue;
    seen.add(proxyPath);
    tracks.push({ url: proxyPath, label });
  }
  return tracks;
}

/** Stable cache/request key for one title or episode. */
export function externalSubtitlesKey(request: ExternalSubtitleRequest): string {
  if (request.kind === 'tv') {
    return `tv:${request.tmdbId}:${request.season ?? 0}:${request.episode ?? 0}`;
  }
  return `movie:${request.tmdbId}`;
}

/** Builds the verified list URL from validated request parts. */
export function buildVdrkListUrl(request: ExternalSubtitleRequest): string | null {
  if (!Number.isSafeInteger(request.tmdbId) || request.tmdbId <= 0) return null;
  if (request.kind === 'tv') {
    if (!Number.isSafeInteger(request.season) || (request.season ?? 0) <= 0) return null;
    if (!Number.isSafeInteger(request.episode) || (request.episode ?? 0) <= 0) return null;
    return `${VDRK_LIST_ORIGIN}/v1/tv/${request.tmdbId}/${request.season}/${request.episode}`;
  }
  return `${VDRK_LIST_ORIGIN}/v1/movie/${request.tmdbId}`;
}

const LIST_TIMEOUT_MS = 8_000;
const CACHE_MAX_KEYS = 16;
const CACHE_TTL_MS = 10 * 60 * 1000;

type CacheEntry = { tracks: ExternalSubtitleTrack[]; expiresAt: number };

export type ExternalSubtitleController = {
  /**
   * Loads (or serves from cache) the external tracks for the request. The
   * `currentKey` is the caller's ACTIVE media key — when the loaded result's
   * key differs (the caller moved to another title/episode meanwhile), the
   * result resolves as superseded-empty so stale tracks can never attach.
   */
  load: (request: ExternalSubtitleRequest, currentKey: string) => Promise<ExternalSubtitleResult & { key: string; superseded: boolean }>;
  /** Test seam: drop all cached lists. */
  clearForTests: () => void;
};

export function createExternalSubtitleController(fetchImpl: typeof fetch = fetch): ExternalSubtitleController {
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ExternalSubtitleResult>>();

  function cacheGet(key: string): CacheEntry | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  async function requestList(request: ExternalSubtitleRequest, key: string): Promise<ExternalSubtitleResult> {
    const url = buildVdrkListUrl(request);
    if (!url) return { tracks: [], error: 'invalid-response' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return { tracks: [], error: 'network' };
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('application/json')) return { tracks: [], error: 'invalid-response' };
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { tracks: [], error: 'invalid-response' };
      }
      // An empty list is a VALID response (verified: unknown ids return 200 []).
      return { tracks: parseVdrkEntries(payload), error: null };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { tracks: [], error: 'timeout' };
      return { tracks: [], error: 'network' };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async load(request, currentKey) {
      const key = externalSubtitlesKey(request);
      const cached = cacheGet(key);
      if (cached) {
        return { tracks: cached.tracks, error: null, key, superseded: key !== currentKey };
      }
      let pending = inFlight.get(key);
      if (!pending) {
        pending = requestList(request, key);
        inFlight.set(key, pending);
        // Bounded growth of the in-flight map even on abandonment.
        void pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
      }
      const result = await pending;
      if (result.error === null) {
        if (cache.size >= CACHE_MAX_KEYS) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { tracks: result.tracks, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      return { ...result, key, superseded: key !== currentKey };
    },
    clearForTests() {
      cache.clear();
      inFlight.clear();
    },
  };
}
