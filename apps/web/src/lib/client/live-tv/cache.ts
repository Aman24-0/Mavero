// LT-2 — Live TV short-lived metadata cache (Live TV data layer).
//
// A tiny in-memory module cache modeled on the existing Discover rail cache
// (`src/lib/client/discover/rail-cache.ts`): per-tab module state, TTL +
// bounded LRU, sweep-on-access, no persistence of any kind. It survives
// component remounts within the tab and dies with the tab.
//
// POLICY (LT-2 brief §10, verified against LiveGT docs/LT-0 probes):
//   * CHANNEL CATALOGUE — cached at most 5 minutes (matches the LiveGT list
//     cache window and the plan's "~5 minutes maximum").
//   * GUIDE — cached at most 30 seconds (matches the LiveGT guide cache
//     window; "now playing" data must stay fresh).
//   * PLAYBACK RESOLUTION — NEVER cached. Structurally: this module has no
//     API for it. Signed MPD URLs and ClearKey material live in runtime
//     memory handed straight to the caller and are re-resolved fresh on every
//     playback start (plan §11, decision D6). Nothing here may ever hold
//     them.
//   * DRM — same rule: never cached, never stored.
//
// WHAT THIS IS NOT:
//   * Not a persistent cache — no localStorage, sessionStorage, IndexedDB or
//     Supabase writes (that would be a scope violation for signed data).
//   * Not a generic caching framework — Live TV metadata only.
//
// KEYS:
//   * Catalogue key = the deterministic request query string ('' for the
//     full list, 'q=star', 'category=Sports', ...). Bounded to a handful of
//     recent queries (LRU, 16 entries) so searches cannot grow it unbounded.
//   * Guide key = channel id (bounded to 64 recent channels).
//
// STALENESS:
//   * Every read checks TTL; expired entries are deleted, not returned.
//   * A sweep runs at most once per SWEEP_INTERVAL_MS on access so stale
//     entries never survive indefinitely even if never read again.

import type { LiveTvChannel, LiveTvGuide } from './types';

/** Catalogue TTL — 5 minutes (LiveGT lists cache for 5 minutes upstream). */
export const LIVE_TV_CATALOGUE_TTL_MS = 5 * 60_000;
/** Guide TTL — 30 seconds (LiveGT guides cache for 30 seconds upstream). */
export const LIVE_TV_GUIDE_TTL_MS = 30_000;

const CATALOGUE_MAX_ENTRIES = 16;
const GUIDE_MAX_ENTRIES = 64;
const SWEEP_INTERVAL_MS = 60_000;

type CacheEntry<T> = {
	value: T;
	createdAt: number;
	ttlMs: number;
};

const catalogueCache = new Map<string, CacheEntry<LiveTvChannel[]>>();
const guideCache = new Map<string, CacheEntry<LiveTvGuide>>();
let lastSweepAt = 0;

function maybeSweep(now: number): void {
	if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
	lastSweepAt = now;
	for (const cache of [catalogueCache, guideCache]) {
		for (const [key, entry] of cache) {
			if (now - entry.createdAt > entry.ttlMs) {
				cache.delete(key);
			}
		}
	}
}

function readEntry<T>(cache: Map<string, CacheEntry<T>>, key: string, now: number): T | undefined {
	maybeSweep(now);
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (now - entry.createdAt > entry.ttlMs) {
		cache.delete(key);
		return undefined;
	}
	// LRU: re-insert to refresh insertion order.
	cache.delete(key);
	cache.set(key, entry);
	return entry.value;
}

function writeEntry<T>(
	cache: Map<string, CacheEntry<T>>,
	key: string,
	value: T,
	ttlMs: number,
	now: number,
	maxEntries: number
): void {
	maybeSweep(now);
	cache.delete(key);
	cache.set(key, { value, createdAt: now, ttlMs });
	// Bound: evict the oldest insertion-order key when over the cap.
	while (cache.size > maxEntries) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey === undefined) break;
		cache.delete(oldestKey);
	}
}

/** Read a cached catalogue result. Returns undefined on miss/expiry. */
export function getCachedLiveTvChannels(key: string, now: number = Date.now()): LiveTvChannel[] | undefined {
	return readEntry(catalogueCache, key, now);
}

/** Store a catalogue result (the array is copied, so caller mutations cannot corrupt the cache). */
export function setCachedLiveTvChannels(
	key: string,
	channels: LiveTvChannel[],
	now: number = Date.now()
): void {
	writeEntry(catalogueCache, key, [...channels], LIVE_TV_CATALOGUE_TTL_MS, now, CATALOGUE_MAX_ENTRIES);
}

/** Read a cached guide. Returns undefined on miss/expiry. */
export function getCachedLiveTvGuide(channelId: string, now: number = Date.now()): LiveTvGuide | undefined {
	return readEntry(guideCache, channelId, now);
}

/** Store a guide result. */
export function setCachedLiveTvGuide(channelId: string, guide: LiveTvGuide, now: number = Date.now()): void {
	writeEntry(guideCache, channelId, guide, LIVE_TV_GUIDE_TTL_MS, now, GUIDE_MAX_ENTRIES);
}

/** Evict everything (sign-out / explicit invalidation, mirrors `clearRailCache`). */
export function clearLiveTvCache(): void {
	catalogueCache.clear();
	guideCache.clear();
	lastSweepAt = 0;
}

/** Introspection for tests/debugging. Never returns cached VALUES — only shape. */
export function liveTvCacheStats(): {
	catalogueEntries: number;
	guideEntries: number;
	catalogueTtlMs: number;
	guideTtlMs: number;
	catalogueMaxEntries: number;
	guideMaxEntries: number;
} {
	return {
		catalogueEntries: catalogueCache.size,
		guideEntries: guideCache.size,
		catalogueTtlMs: LIVE_TV_CATALOGUE_TTL_MS,
		guideTtlMs: LIVE_TV_GUIDE_TTL_MS,
		catalogueMaxEntries: CATALOGUE_MAX_ENTRIES,
		guideMaxEntries: GUIDE_MAX_ENTRIES
	};
}

// Test-only exports (rail-cache `__test` convention).
export const __test = {
	forceSweepOnNextRead(): void {
		lastSweepAt = 0;
	},
	peekCatalogueEntry(key: string): CacheEntry<LiveTvChannel[]> | undefined {
		return catalogueCache.get(key);
	},
	peekGuideEntry(channelId: string): CacheEntry<LiveTvGuide> | undefined {
		return guideCache.get(channelId);
	},
	catalogueKeys(): string[] {
		return [...catalogueCache.keys()];
	},
	guideKeys(): string[] {
		return [...guideCache.keys()];
	}
};
