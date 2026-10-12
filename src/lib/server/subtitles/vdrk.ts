/**
 * Player UI V2 (Part 1, Phase 3A) — VDRK external-subtitle server helpers.
 *
 * The VDRK subtitle CDN (verified live 2026-10-12) serves WebVTT files with
 * `content-type: text/vtt; charset=utf-8` and an OPEN CORS policy
 * (`access-control-allow-origin: *`). A cross-origin `<track>` load however
 * requires the media element to carry a `crossorigin` attribute (verified in
 * Chromium: "Unsafe attempt to load URL … Domains, protocols and ports must
 * match"), and adding `crossorigin` to Mavero's shared <video> element would
 * put NATIVE media fetches into CORS mode too — breaking Blue Velvet
 * (and every other provider whose media host does not echo ACAO) on
 * native-HLS browsers. The VTT files are therefore served SAME-ORIGIN through
 * a narrowly scoped SvelteKit endpoint.
 *
 * SECURITY CONTRACT (no generic proxy):
 *   * The endpoints accept ONLY path segments (never a client-supplied URL).
 *     Each segment is validated against a strict pattern and the upstream URL
 *     is REBUILT server-side from the validated parts:
 *       movie → https://cache.vdrk.site/v1/vtt/movie/{tmdb}/{label}.vtt
 *       tv    → https://cache.vdrk.site/v1/vtt/tv/{tmdb}/{season}/{episode}/{label}.vtt
 *   * TMDB ids are 1–16 digit positive integers without leading zeros;
 *     season/episode are positive integers; labels are short alphanumeric
 *     tokens (dots/dashes/underscores allowed, never empty, never a
 *     traversal — the pattern rejects `/` and `%` outright).
 *   * Upstream responses are forwarded only with a text/vtt content-type,
 *     under an 8-second timeout and a hard 2 MB size cap (streamed read —
 *     oversized upstreams are aborted mid-body).
 *   * No credentials/cookies are forwarded; responses get a bounded public
 *     TTL; a small in-process TTL cache (bounded entries) absorbs repeat
 *     selections without unbounded growth.
 */

export const VDRK_VTT_ORIGIN = 'https://cache.vdrk.site';

/** Observed VTT response cap — real files are ~50 KB; 2 MB is generous. */
const VTT_MAX_BYTES = 2_000_000;
const VTT_FETCH_TIMEOUT_MS = 8_000;
const CACHE_MAX_ENTRIES = 48;
const CACHE_TTL_MS = 30 * 60 * 1000;

/** TMDB ids: positive decimal integers, no leading zeros (canonical form). */
const TMDB_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/** Subtitle label tokens observed from the API ("English2", "Brazilian4"). */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateTmdbIdParam(raw: string): number | null {
  if (!TMDB_ID_PATTERN.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function validatePositiveIntParam(raw: string): number | null {
  if (!/^[1-9][0-9]{0,7}$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function validateLabelParam(raw: string): string | null {
  return LABEL_PATTERN.test(raw) ? raw : null;
}

/** Builds the ONLY upstream URL shape this module ever fetches. */
export function buildUpstreamVttUrl(kind: 'movie' | 'tv', tmdbId: number, label: string, season?: number, episode?: number): string {
  const base = `${VDRK_VTT_ORIGIN}/v1/vtt/${kind}/${tmdbId}`;
  const path = kind === 'tv'
    ? `${base}/${season}/${episode}/${encodeURIComponent(label)}.vtt`
    : `${base}/${encodeURIComponent(label)}.vtt`;
  return path;
}

type CacheEntry = { text: string; expiresAt: number };
const vttCache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null {
  const entry = vttCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    vttCache.delete(key);
    return null;
  }
  // Refresh recency (insertion-order LRU behavior for bounded growth).
  vttCache.delete(key);
  vttCache.set(key, entry);
  return entry.text;
}

function cacheSet(key: string, text: string): void {
  if (vttCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = vttCache.keys().next().value;
    if (oldest !== undefined) vttCache.delete(oldest);
  }
  vttCache.set(key, { text, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test seam: clear the in-process VTT cache. */
export function clearVttCacheForTests(): void {
  vttCache.clear();
}

export type UpstreamVttResult =
  | { ok: true; text: string; fromCache: boolean }
  | { ok: false; status: 400 | 502 | 503 | 504 };

/**
 * Fetches (or caches) the upstream VTT for an already-validated upstream URL.
 * Bounded: timeout, streamed size cap, text/vtt content-type enforcement.
 */
export async function fetchUpstreamVttText(upstreamUrl: string): Promise<UpstreamVttResult> {
  const cached = cacheGet(upstreamUrl);
  if (cached !== null) return { ok: true, text: cached, fromCache: true };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VTT_FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'text/vtt,*/*' },
    });
    if (!upstream.ok) return { ok: false, status: 502 };
    const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/vtt')) return { ok: false, status: 502 };
    const declaredLength = Number.parseInt(upstream.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > VTT_MAX_BYTES) return { ok: false, status: 502 };

    // Streamed bounded read: abort mid-body when the cap is exceeded (never
    // trusting a missing/lying content-length to bound memory).
    const body = upstream.body;
    if (!body) return { ok: false, status: 502 };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > VTT_MAX_BYTES) {
          try { await reader.cancel(); } catch { /* already aborted */ }
          return { ok: false, status: 502 };
        }
        chunks.push(value);
      }
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(concatChunks(chunks, received));
    cacheSet(upstreamUrl, text);
    return { ok: true, text, fromCache: false };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, status: 504 };
    return { ok: false, status: 502 };
  } finally {
    clearTimeout(timeout);
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
