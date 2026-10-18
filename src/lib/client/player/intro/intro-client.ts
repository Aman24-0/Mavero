/**
 * Player UI V2 (Part 1, Phase 3B) — Skip Intro lookup on top of TheIntroDB.
 *
 * Uses the version-matched `theintrodb` package (installed: 4.0.0 — API v4;
 * sources of truth: https://theintrodb.org/openapi.yaml (v4.0.0), the npm
 * client's docs/migration-v3-to-v4.md, and the shipped type declarations):
 *   * `createIntroDbClient()` + typed `getMedia()` — read-only, NO API key
 *     (never a shared key; Mavero never submits timestamps).
 *   * API v4 identity is TVDB: every response is keyed by `tvdbId` and
 *     `tmdbId` is deliberately absent from responses. Mavero KEEPS addressing
 *     by `tmdbId` because its catalog is TMDB-backed and carries no TVDB ids;
 *     v4 still accepts `tmdbId` and resolves it server-side (priority
 *     `tvdbId` → `tmdbId` → `imdbId`; for TV that resolution includes the
 *     season/episode mapping from the TMDB numbering — OpenAPI "/media →
 *     Addressing the media"). Movie lookups resolve the TMDB movie identity;
 *     episode lookups keep Mavero's actual TMDB season/episode numbers.
 *   * NO `mapping` parameter: `mapping` declares a TVDB episode order
 *     (default/official/dvd/alternate/absolute/regional) for numbers actually
 *     sourced from such an order. Mavero's season/episode are its own TMDB
 *     catalog numbers — TMDB numbering is not a media-server display order,
 *     and relabeling it as one would guess a coordinate space; the
 *     `tmdb_id` resolution path converts TMDB coordinates server-side.
 *   * `getMedia()` returns a DISCRIMINATED UNION in v4: `kind: 'media'` (the
 *     grouped skip timestamps), `kind: 'versions'` (release-version list —
 *     only when `listVersions` is sent, which Mavero never does), and
 *     `kind: 'episodes'` (per-episode submission counts — the API's fallback
 *     when the media has no submissions). Only `kind: 'media'` carries
 *     segment arrays; the other shapes are verified emptiness, NOT errors.
 *   * TV includes the actual season and episode; `durationMs` is passed ONLY
 *     when a trustworthy ACTUAL playback duration is known (the media
 *     element's duration — never the catalog runtime) so the API can pick the
 *     closest matching release version.
 *   * The API returns timestamps in MILLISECONDS (`NormalizedSegmentTimestamp`:
 *     `startMs` ≥ 0, `endMs` number | null where null = "to media end").
 *     Conversion to seconds happens ONLY at the boundary where Mavero's seek
 *     API needs seconds (validated segments below).
 *
 * Resilience contracts (all unit-tested):
 *   * Strictly optional: any failure (network, timeout, rate limit, malformed
 *     response, missing data) resolves to NO segments — playback is never
 *     blocked and no error UI is shown.
 *   * Validation rejects invalid ranges before they can drive UI: negative /
 *     non-finite values, reversed ranges (start ≥ end), and null ends (no
 *     seek target — discarded rather than guessed); when the actual duration
 *     is known, segments starting beyond it (+5 s tolerance) or ending beyond
 *     it (+5 s tolerance) are rejected as clearly out of range.
 *   * Multiple intro segments are preserved (no single-segment assumption);
 *     the shell picks the segment containing the playhead.
 *   * Bounded caching: LRU ≤ 24 media keys, 30-minute TTL, ONE in-flight
 *     request per key (dedup), 8-second timeout, 5-minute negative backoff
 *     after any failure, and a bounded re-fetch (≤ 2 per key) when the actual
 *     duration turns out to differ materially from the first lookup's.
 *   * Stale-response guard: results are compared against the caller's current
 *     media key when they land — a superseded lookup never drives the UI.
 */

import { createIntroDbClient, TheIntroDbApiError, TheIntroDbResponseValidationError, TheIntroDbValidationError } from 'theintrodb';
import type { FetchLike, NormalizedSegmentTimestamp } from 'theintrodb';

/** A validated, shell-ready intro segment (seconds — the player seek unit). */
export type IntroSegment = {
  startSec: number;
  endSec: number;
};

export type IntroMediaRequest = {
  kind: 'movie' | 'tv';
  tmdbId: number;
  season?: number;
  episode?: number;
  /** Actual playback duration in seconds when known; null/undefined otherwise. */
  durationSec?: number | null;
};

/**
 * Validates the API's normalized intro timestamps against the media and
 * converts them to seconds. Pure; unit-tested truth table.
 */
export function validateIntroSegments(intro: NormalizedSegmentTimestamp[] | undefined, durationSec: number | null | undefined): IntroSegment[] {
  if (!Array.isArray(intro)) return [];
  const segments: IntroSegment[] = [];
  for (const segment of intro) {
    if (!segment || typeof segment !== 'object') continue;
    const { startMs, endMs } = segment;
    if (typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0) continue;
    // A null end ("runs to media end") is meaningless for a skip action —
    // there is no valid seek target. Discard rather than invent one.
    if (typeof endMs !== 'number' || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue; // reversed or empty range
    const startSec = Math.round(startMs) / 1000;
    const endSec = Math.round(endMs) / 1000;
    if (durationSec !== null && durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0) {
      const toleranceSec = 5;
      if (startSec >= durationSec + toleranceSec) continue; // starts after the media ends
      if (endSec > durationSec + toleranceSec) continue; // ends clearly out of range
    }
    segments.push({ startSec, endSec });
  }
  return segments;
}

function introCacheKey(request: IntroMediaRequest): string {
  return request.kind === 'tv'
    ? `tv:${request.tmdbId}:${request.season ?? 0}:${request.episode ?? 0}`
    : `movie:${request.tmdbId}`;
}

/**
 * Player V2 remaining fixes (2026-10): public key helper so the SHELL can
 * compare results against the CONTROLLER's key space. The shell previously
 * passed its `mediaLookupKey` (`series:236235:2:1` / `movie:24428::`) as the
 * caller's current key while the controller computes `tv:…` / `movie:…` —
 * the two never matched, so EVERY result was treated as superseded and
 * dropped (Skip Intro could never appear). The shell now passes
 * `introRequestKey(request)` and keeps its own mediaLookupKey guard for
 * staleness across title/episode switches.
 */
export function introRequestKey(request: IntroMediaRequest): string {
  return introCacheKey(request);
}

const LOOKUP_TIMEOUT_MS = 8_000;
const CACHE_MAX_KEYS = 24;
const CACHE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
/** Re-fetch budget when the actual duration differs materially from the first lookup. */
const DURATION_REFETCH_BUDGET = 2;
/** Material duration difference (ms) that justifies a re-lookup. */
const DURATION_REFETCH_DELTA_MS = 120_000;

type CacheEntry = {
  segments: IntroSegment[];
  expiresAt: number;
  requestedDurationMs: number | null;
  refetchCount: number;
};

export type IntroLookupResult = {
  segments: IntroSegment[];
  key: string;
  superseded: boolean;
  /** True when no data existed (distinct from a failed lookup for tests). */
  empty: boolean;
  /**
   * Player V2 corrections (Phase 2C): typed failure kind for honest
   * diagnostics — a title WITHOUT intro data ('no-data') must be
   * distinguishable from a request that FAILED (api/timeout/invalid/network).
   * Null on cached/negative-backoff/success paths that carry segments or
   * verified emptiness.
   */
  errorKind: 'api' | 'timeout' | 'invalid' | 'network' | null;
};

export type IntroLookup = {
  getIntroSegments: (request: IntroMediaRequest, currentKey: string) => Promise<IntroLookupResult>;
  clearForTests: () => void;
};

export function createIntroLookup(fetchImpl: typeof fetch = fetch): IntroLookup {
  // The package's minimal FetchLike declares `signal?: unknown`; the platform
  // fetch needs a real AbortSignal — this adapter is the single narrowing
  // point between the two signatures.
  const packageFetch: FetchLike = async (input, init) => {
    const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
    return fetchImpl(String(input), {
      method: init?.method,
      headers: init?.headers as HeadersInit | undefined,
      body: init?.body,
      signal,
    });
  };
  const client = createIntroDbClient({ fetch: packageFetch });
  const cache = new Map<string, CacheEntry>();
  const negativeUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<Omit<IntroLookupResult, 'superseded'>>>();

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

  async function requestSegments(request: IntroMediaRequest, key: string): Promise<Omit<IntroLookupResult, 'superseded'>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
      // v4 answers with a discriminated union (`MediaResponse`); narrow on
      // `kind` before reading any segment array.
      const response = await client.getMedia(
        {
          tmdbId: request.tmdbId,
          ...(request.kind === 'tv' ? { season: request.season, episode: request.episode } : {}),
          ...(Number.isFinite(request.durationSec) && (request.durationSec ?? 0) > 0
            ? { durationMs: Math.round((request.durationSec as number) * 1000) }
            : {}),
        },
        { signal: controller.signal },
      );
      // Only `kind: 'media'` carries the grouped timestamp arrays. The
      // `kind: 'episodes'` fallback (HTTP 200 with per-episode submission
      // counts when the media has no submissions) and `kind: 'versions'`
      // (requires `listVersions: true`, never sent here) carry NO skip
      // timestamps — both are verified emptiness, not failures.
      const segments = response.kind === 'media'
        ? validateIntroSegments(response.intro, request.durationSec ?? null)
        : [];
      return { segments, key, empty: segments.length === 0, errorKind: null };
    } catch (error) {
      // All failure classes degrade to "no skip button" — never an error UI:
      //   * TheIntroDbValidationError / ResponseValidationError → malformed
      //     input or response → 'invalid';
      //   * TheIntroDbApiError (with parsed rateLimit metadata when present)
      //     → non-2xx incl. 429 → 'api';
      //   * AbortError → the 8s timeout → 'timeout';
      //   * anything else → network-layer failure → 'network'.
      // The typed kind feeds the shell's honest feature-state diagnostics.
      const errorKind: NonNullable<IntroLookupResult['errorKind']> = error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : error instanceof TheIntroDbApiError
          ? 'api'
          : error instanceof TheIntroDbResponseValidationError || error instanceof TheIntroDbValidationError
            ? 'invalid'
            : 'network';
      void TheIntroDbApiError;
      void TheIntroDbResponseValidationError;
      void TheIntroDbValidationError;
      return { segments: [], key, empty: true, errorKind };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getIntroSegments(request, currentKey) {
      const key = introCacheKey(request);
      const negative = negativeUntil.get(key);
      if (negative && negative > Date.now()) {
        return { segments: [], key, superseded: key !== currentKey, empty: true, errorKind: null };
      }
      const cached = cacheGet(key);
      if (cached) {
        // Material duration change with re-fetch budget left → look again so
        // the API can select the closest matching version.
        const requestedDurationMs = Number.isFinite(request.durationSec) && (request.durationSec ?? 0) > 0
          ? Math.round((request.durationSec as number) * 1000)
          : null;
        const materiallyDifferent = requestedDurationMs !== null
          && cached.requestedDurationMs !== null
          && Math.abs(requestedDurationMs - cached.requestedDurationMs) >= DURATION_REFETCH_DELTA_MS;
        if (materiallyDifferent && cached.refetchCount < DURATION_REFETCH_BUDGET) {
          cached.refetchCount += 1;
          cached.requestedDurationMs = requestedDurationMs;
        } else {
          return { segments: cached.segments, key, superseded: key !== currentKey, empty: cached.segments.length === 0, errorKind: null };
        }
      }
      let pending = inFlight.get(key);
      if (!pending) {
        pending = requestSegments(request, key);
        inFlight.set(key, pending);
        void pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
      }
      const result = await pending;
      const superseded = key !== currentKey;
      if (key !== currentKey) return { ...result, segments: [], superseded: true };
      if (result.segments.length > 0) {
        if (cache.size >= CACHE_MAX_KEYS) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, {
          segments: result.segments,
          expiresAt: Date.now() + CACHE_TTL_MS,
          requestedDurationMs: Number.isFinite(request.durationSec) && (request.durationSec ?? 0) > 0
            ? Math.round((request.durationSec as number) * 1000)
            : null,
          refetchCount: 0,
        });
      } else {
        // Missing data and failures both back off — repeated lookups while
        // playing must not hammer the API.
        negativeUntil.set(key, Date.now() + NEGATIVE_TTL_MS);
      }
      return { ...result, superseded };
    },
    clearForTests() {
      cache.clear();
      negativeUntil.clear();
      inFlight.clear();
    },
  };
}
