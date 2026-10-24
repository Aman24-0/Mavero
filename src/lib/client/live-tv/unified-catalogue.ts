// ============================================================================
// LT-P6 — Unified Live TV user-facing catalogue & guide client (Live TV only).
//
// The flag-ON data surface of the /live-tv page: it reads the merged,
// exposure-filtered canonical catalogue and the Phase 3 mapping-contract
// guide from the server's bounded endpoints. It is NOT a second registry
// and NOT a second EPG pipeline — the server module (`user-catalogue.ts`)
// serves the EXISTING Phase 1 registry rows and the EXISTING Phase 3 guide
// queries; this module only transports + normalizes + caches.
//
// FLAG GATE (single ownership):
//   Callers first ask `isUnifiedLivetvGateEnabled()` — the ONE flag read
//   exported by the Phase 5 router module (shared implementation + cache).
//   While the flag is FALSE this module is never called and the page runs
//   its untouched legacy path (suite-pinned).
//
// NORMALIZATION (nothing from the network is trusted):
//   * Catalogue rows: non-empty id + name; category/logo carried only when
//     usable (logo must be an http(s) absolute URL); duplicates by id
//     dropped (first wins); unusable rows dropped — never coerced, never
//     fabricated. The result is the EXISTING `LiveTvChannel` model, so the
//     page's search/filter utilities and channel cards work unchanged.
//   * Guide: `now` → `nowPlaying`, `upcoming` → `upNext` + `upcoming` +
//     `schedule` (current first, then deterministic start order) of the
//     EXISTING `LiveTvGuide` model — absolute Unix seconds (the wire's
//     epoch-ms instants converted once, mechanically). The existing guide
//     components render it unchanged.
//
// CACHING (the EXISTING cache.ts conventions — no new state source):
//   * Catalogue: the shared 5-minute TTL/LRU catalogue cache (bounded).
//   * Guide: the shared 30-second TTL/LRU guide cache (bounded).
//   Eligibility itself is NEVER trusted from the cache: playback always
//   re-resolves through the Phase 5 resolve endpoint (no-store, server
//   re-validated), so a cached row can at most linger in the grid for the
//   TTL window — it can never grant playback.
//
// SECURITY:
//   * The ONLY URL fetched is the fixed `/api/livetv/...` path on the
//     app's own origin. No user-controlled upstream URL fetching, no
//     provider hosts, no raw playback URLs (the response carries display
//     metadata only — playback material never crosses this module).
//   * Zero console calls (nothing here can log), no persistence, no
//     analytics (the closed taxonomy is untouched).
//   * Timeouts + abort: same conservative class as the LT-2 client; an
//     aborted call rejects with `LiveTvError { kind: 'aborted' }`.
// ============================================================================

import { LiveTvError } from './errors';
import {
        getCachedLiveTvChannels,
        getCachedLiveTvGuide,
        setCachedLiveTvChannels,
        setCachedLiveTvGuide
} from './cache';
import type { LiveTvChannel, LiveTvChannelSourceOption, LiveTvGuide, LiveTvGuideProgramme } from './types';

/** Conservative metadata timeout (same class as the LT-2 client). */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;

/** Test seam — overrides the request timeout (deterministic suites). */
export function setUnifiedCatalogueTimeoutForTests(ms: number): void {
        requestTimeoutMs = ms;
}

const CATALOGUE_PATH = '/api/livetv/catalogue';
const GUIDE_PATH = '/api/livetv/guide';

/** The catalogue cache key (one merged list; the deterministic-query convention). */
const UNIFIED_CATALOGUE_CACHE_KEY = 'unified:v1';

/**
 * The app's own origin (the ONLY base these fixed paths are ever resolved
 * against). Browser: the real origin. SSR never calls this module (page
 * onMount only); Node tests get a stable placeholder.
 */
function appOrigin(): string {
        return typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost';
}

function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
        return typeof value === 'string' && value.trim().length > 0;
}

/** Only absolute http(s) URLs are usable display material. */
function isUsableDisplayUrl(value: unknown): value is string {
        if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
        try {
                const parsed = new URL(value);
                return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch {
                return false;
        }
}

/** Bounded channel-id gate (mirrors the server's own validation). */
function assertValidChannelId(channelId: string): void {
        if (typeof channelId !== 'string' || channelId.trim().length === 0) {
                throw new LiveTvError('bad_request', { endpoint: 'guide' });
        }
}

// ---------------------------------------------------------------------------
// Request core — timeout + abort + status classification (LT-2 semantics).
// ---------------------------------------------------------------------------

type UnifiedEndpoint = 'catalogue' | 'guide';

async function unifiedFetch(url: URL, endpoint: UnifiedEndpoint, options: { signal?: AbortSignal } = {}): Promise<unknown> {
        const { signal } = options;
        if (signal?.aborted) {
                throw new LiveTvError('aborted', { endpoint });
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
        }, requestTimeoutMs);
        const onExternalAbort = () => controller.abort();
        if (signal) signal.addEventListener('abort', onExternalAbort);
        try {
                const response = await fetch(url, {
                        method: 'GET',
                        signal: controller.signal,
                        headers: { accept: 'application/json' },
                        // Display metadata only — but the unified flag is the owner's
                        // rollback lever and guide "now" answers must stay fresh, so
                        // the browser HTTP cache never replays these responses.
                        cache: 'no-store'
                });
                if (!response.ok) {
                        throw new LiveTvError('network', { endpoint, status: response.status });
                }
                try {
                        return await response.json();
                } catch {
                        throw new LiveTvError('invalid_response', { endpoint });
                }
        } catch (err) {
                if (err instanceof LiveTvError) throw err;
                if (signal?.aborted) throw new LiveTvError('aborted', { endpoint });
                if (timedOut) throw new LiveTvError('timeout', { endpoint });
                throw new LiveTvError('network', { endpoint });
        } finally {
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onExternalAbort);
        }
}

// ---------------------------------------------------------------------------
// Normalizers.
// ---------------------------------------------------------------------------

/** Normalize one catalogue row; null for unusable entries (dropped). */
function normalizeUnifiedChannel(raw: unknown): LiveTvChannel | null {
        if (!isRecord(raw)) return null;
        if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name)) return null;
        const channel: LiveTvChannel = { id: raw.id.trim(), name: raw.name.trim() };
        if (isNonEmptyString(raw.category)) channel.category = raw.category.trim();
        if (isUsableDisplayUrl(raw.logoUrl)) channel.logo = raw.logoUrl;
        // R-1 — the bounded per-source alternatives (preferred first). Every
        // option must carry a usable bounded id + label; unusable/duplicate
        // options are dropped. The switcher gate (≥2) is re-checked here so a
        // malformed or single-option payload can never render the control.
        if (Array.isArray(raw.sources)) {
                const options: LiveTvChannelSourceOption[] = [];
                for (const entry of raw.sources) {
                        if (!isRecord(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.label)) continue;
                        const id = entry.id.trim();
                        const label = entry.label.trim();
                        if (id.length === 0 || id.length > 220 || label.length === 0 || label.length > 200) continue;
                        if (options.some((option) => option.id === id)) continue;
                        options.push({ id, label });
                }
                if (options.length >= 2) channel.sources = options;
        }
        return channel;
}

/**
 * Normalize a `/api/livetv/catalogue` body. Rejects malformed top-level
 * shapes (`invalid_response`); drops malformed/duplicate entries (first id
 * wins). An empty list is a VALID state (the honest empty catalogue).
 */
function normalizeCatalogueList(body: unknown): LiveTvChannel[] {
        if (!isRecord(body) || !Array.isArray(body.channels)) {
                throw new LiveTvError('invalid_response', { endpoint: 'catalogue' });
        }
        const seen = new Set<string>();
        const channels: LiveTvChannel[] = [];
        for (const raw of body.channels) {
                const channel = normalizeUnifiedChannel(raw);
                if (!channel || seen.has(channel.id)) continue;
                seen.add(channel.id);
                channels.push(channel);
        }
        return channels;
}

/** Normalize one guide programme row; null for unusable entries (dropped). */
function normalizeGuideProgramme(raw: unknown): LiveTvGuideProgramme | null {
        if (!isRecord(raw)) return null;
        if (!isNonEmptyString(raw.title)) return null;
        if (typeof raw.startMs !== 'number' || !Number.isFinite(raw.startMs)) return null;
        if (typeof raw.endMs !== 'number' || !Number.isFinite(raw.endMs)) return null;
        // Mechanically absolute: epoch ms → Unix seconds (the established
        // client-side guide unit). A non-positive window is dropped.
        const startSeconds = raw.startMs / 1000;
        const stopSeconds = raw.endMs / 1000;
        if (stopSeconds <= startSeconds) return null;
        const programme: LiveTvGuideProgramme = { title: raw.title.trim(), startSeconds, stopSeconds };
        if (isNonEmptyString(raw.description)) programme.description = raw.description;
        if (isNonEmptyString(raw.category)) programme.category = raw.category;
        if (isUsableDisplayUrl(raw.iconUrl)) programme.image = raw.iconUrl;
        return programme;
}

/**
 * Normalize a `/api/livetv/guide` body into the EXISTING `LiveTvGuide`
 * model. Empty/unmatched guide data is a VALID state (nowPlaying null,
 * empty arrays) — never an error, never fabricated.
 */
function normalizeUnifiedGuide(body: unknown, channelId: string): LiveTvGuide {
        if (!isRecord(body)) {
                throw new LiveTvError('invalid_response', { endpoint: 'guide', channelId });
        }
        const now = normalizeGuideProgramme(body.now);
        const upcoming: LiveTvGuideProgramme[] = [];
        if (body.upcoming !== undefined && body.upcoming !== null) {
                if (!Array.isArray(body.upcoming)) {
                        throw new LiveTvError('invalid_response', { endpoint: 'guide', channelId });
                }
                for (const entry of body.upcoming) {
                        const programme = normalizeGuideProgramme(entry);
                        if (programme) upcoming.push(programme);
                }
        }
        // Deterministic start order (the server already orders; this is
        // defense in depth for the existing start-sorted guide list).
        upcoming.sort((a, b) => a.startSeconds - b.startSeconds);
        const guide: LiveTvGuide = {
                channelId,
                nowPlaying: now,
                upNext: upcoming[0] ?? null,
                upcoming,
                // The guide sheet's single continuous list: the current
                // programme first (marked "On air" by its real window), then
                // the upcoming ones.
                schedule: now ? [now, ...upcoming] : [...upcoming]
        };
        return guide;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Retrieve the merged, exposure-filtered canonical catalogue.
 *
 * Call ONLY when the shared flag gate is active. Cached up to 5 minutes
 * (the EXISTING catalogue cache conventions); pass `forceRefetch: true` to
 * bypass. Eligibility is never granted from the cache — playback always
 * re-resolves through the Phase 5 resolve endpoint.
 */
export async function getUnifiedLivetvCatalogue(options: { signal?: AbortSignal; forceRefetch?: boolean } = {}): Promise<LiveTvChannel[]> {
        if (options.signal?.aborted) {
                throw new LiveTvError('aborted', { endpoint: 'catalogue' });
        }
        if (!options.forceRefetch) {
                const cached = getCachedLiveTvChannels(UNIFIED_CATALOGUE_CACHE_KEY);
                if (cached) return cached;
        }
        const body = await unifiedFetch(new URL(CATALOGUE_PATH, appOrigin()), 'catalogue', { signal: options.signal });
        const channels = normalizeCatalogueList(body);
        setCachedLiveTvChannels(UNIFIED_CATALOGUE_CACHE_KEY, channels);
        return channels;
}

/**
 * Retrieve the Now/Next guide for one canonical channel through the
 * ESTABLISHED Phase 3 mapping contract (served by the bounded endpoint —
 * the browser never fetches or parses XMLTV). Cached up to 30 seconds (the
 * EXISTING guide cache conventions). Missing/unmatched guide data is the
 * honest empty guide — never an error, never fabricated.
 */
export async function getUnifiedLivetvGuide(channelId: string, options: { signal?: AbortSignal; forceRefetch?: boolean } = {}): Promise<LiveTvGuide> {
        assertValidChannelId(channelId);
        if (options.signal?.aborted) {
                throw new LiveTvError('aborted', { endpoint: 'guide' });
        }
        if (!options.forceRefetch) {
                const cached = getCachedLiveTvGuide(channelId);
                if (cached) return cached;
        }
        const url = new URL(GUIDE_PATH, appOrigin());
        url.searchParams.set('channelId', channelId);
        const body = await unifiedFetch(url, 'guide', { signal: options.signal });
        const guide = normalizeUnifiedGuide(body, channelId);
        setCachedLiveTvGuide(channelId, guide);
        return guide;
}
