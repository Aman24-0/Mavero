// LT-2 — LiveGT V1 API client (Live TV data layer, DATA/API ONLY).
//
// This module is the single integration point with the LiveGT V1 public API
// (https://livetgtv.lovable.app/docs). LT-3 (Shaka DASH/ClearKey player) and
// LT-4 (Live TV UI) consume ONLY this surface — they must never build LiveGT
// URLs themselves.
//
// ARCHITECTURE (live-tv-plan.md §4/§8/§9, decisions D3/D6):
//   * DIRECT browser requests — LiveGT serves `access-control-allow-origin: *`
//     (verified LT-0), so no Mavero/Netlify proxy exists or is needed.
//   * Catalogue/guide responses are normalized into the types in `types.ts`
//     before reaching callers; raw LiveGT objects never spread into the UI.
//   * Playback resolution is ALWAYS fresh: `resolveLiveTvPlayback()` performs
//     a network request on every call and its result is handed straight to
//     the caller in runtime memory. It is never cached, never persisted.
//
// SECURITY (plan §15, LT-2 brief §14):
//   * The ONLY upstream URLs ever fetched are built here from the constant
//     base URL + fixed V1 paths. No user-controlled upstream URL fetching.
//   * Channel ids are `encodeURIComponent`-escaped into the path; query
//     params go through `URLSearchParams` — no raw string concatenation.
//   * No API keys, no Supabase usage, no proxy URLs, no logging of any kind
//     (this module contains zero `console` calls — signed URLs and ClearKey
//     material can never be logged from here).
//   * Error messages come from the fixed safe table in `errors.ts`.
//
// REQUEST LIFECYCLE (LT-2 brief §12/§13):
//   * Every function accepts an optional AbortSignal so LT-3/LT-4 can cancel
//     stale requests (fast channel switching). An aborted call rejects with
//     `LiveTvError { kind: 'aborted' }` — callers ignore or rethrow.
//   * Every request has a conservative internal timeout (Live TV metadata
//     only — no app-wide timeout system). A timed-out request rejects with
//     `kind: 'timeout'`.
//   * No retries here. Bounded recovery is LT-3's job (plan §11).
//
// CACHING (via `cache.ts`):
//   * Catalogue: up to 5 minutes, keyed by the deterministic query string.
//   * Guide: up to 30 seconds, keyed by channel id.
//   * Playback resolution + DRM: never cached (see above).
//
// BASE URL:
//   `LIVEGT_V1_BASE_URL` is the single constant. LiveGT V1 is a public,
//   keyless, CORS-open API, so no environment variable is introduced (the
//   project has no public-runtime-config convention that fits, and the plan
//   forbids scattering the hostname). Only V1 paths exist here — the V2
//   catalogue is out of scope and must never be called.
//
// SSR:
//   Like `hls-engine.ts`, this module has no top-level browser globals or
//   side effects, so importing it during SSR is safe. It is designed for
//   direct BROWSER requests (CORS is a browser concern; the upstream CDN is
//   India-georestricted — plan §3).

import { LiveTvError, liveTvErrorKindForStatus } from './errors';
import {
	getCachedLiveTvChannels,
	getCachedLiveTvGuide,
	setCachedLiveTvChannels,
	setCachedLiveTvGuide
} from './cache';
import type {
	LiveTvChannel,
	LiveTvChannelsOptions,
	LiveTvDrm,
	LiveTvGuide,
	LiveTvGuideOptions,
	LiveTvGuideProgramme,
	LiveTvPlaybackOptions,
	LiveTvPlaybackResolution,
	LiveTvPlaybackSource,
	LiveTvSearchOptions
} from './types';

/** The single LiveGT V1 base URL (public API — see header note). */
export const LIVEGT_V1_BASE_URL = 'https://livetgtv.lovable.app';

const CHANNELS_PATH = '/api/public/channels';
const CHANNEL_PATH_PREFIX = '/api/public/channels/';
const GUIDE_PATH_PREFIX = '/api/public/guide/';

/** Conservative metadata timeout (catalogue is the largest payload). */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;

type LiveTvEndpoint = 'channels' | 'channel' | 'guide';

// ---------------------------------------------------------------------------
// Small validation helpers (nothing from the network is trusted).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/** Only absolute http(s) URLs are usable playback sources. */
function isUsableUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0) return false;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:';
	} catch {
		return false;
	}
}

/**
 * Client-side channel-id gate: a non-empty string. Deliberately NOT stricter
 * (LiveGT ids are numeric strings today, but that is not hardcoded) —
 * well-formed-but-unknown ids go to the API and get its REAL 404 (observed
 * behavior preserved, LT-0 finding).
 */
function assertValidChannelId(channelId: string, endpoint: LiveTvEndpoint): void {
	if (typeof channelId !== 'string' || channelId.trim().length === 0) {
		throw new LiveTvError('bad_request', { endpoint });
	}
}

// ---------------------------------------------------------------------------
// Request core — timeout + abort + status classification.
// ---------------------------------------------------------------------------

/**
 * GET a LiveGT V1 endpoint and return the parsed JSON as `unknown`.
 *
 * Timeout/abort/network failures are classified into `LiveTvError` kinds.
 * HTTP error bodies are intentionally never read or propagated.
 */
async function liveTvFetch(
	url: URL,
	endpoint: LiveTvEndpoint,
	options: { channelId?: string; signal?: AbortSignal } = {}
): Promise<unknown> {
	const { channelId, signal } = options;
	if (signal?.aborted) {
		throw new LiveTvError('aborted', { endpoint, channelId });
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
			headers: { accept: 'application/json' }
		});
		const statusKind = liveTvErrorKindForStatus(response.status);
		if (statusKind) {
			throw new LiveTvError(statusKind, { endpoint, channelId, status: response.status });
		}
		try {
			return await response.json();
		} catch {
			throw new LiveTvError('invalid_response', { endpoint, channelId });
		}
	} catch (err) {
		if (err instanceof LiveTvError) throw err;
		// Caller abort wins over every other classification.
		if (signal?.aborted) throw new LiveTvError('aborted', { endpoint, channelId });
		if (timedOut) throw new LiveTvError('timeout', { endpoint, channelId });
		throw new LiveTvError('network', { endpoint, channelId });
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener('abort', onExternalAbort);
	}
}

// ---------------------------------------------------------------------------
// Normalizers — wire JSON → stable internal models.
// ---------------------------------------------------------------------------

/**
 * Normalize one catalogue/resolution channel object. Returns null for entries
 * without a usable id + name (dropped — never faked into valid channels).
 * `embed`/`watch` wire fields are intentionally never read.
 */
function normalizeChannelEntry(raw: unknown): LiveTvChannel | null {
	if (!isRecord(raw)) return null;
	if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name)) return null;
	const channel: LiveTvChannel = { id: raw.id, name: raw.name };
	if (isNonEmptyString(raw.category)) channel.category = raw.category;
	if (isNonEmptyString(raw.logo)) channel.logo = raw.logo;
	return channel;
}

/**
 * Normalize a `/channels` response body. Rejects malformed top-level shapes
 * (`invalid_response`); drops malformed/duplicate entries (first id wins).
 * The wire `count` field is ignored — the array is the source of truth.
 */
function normalizeChannelList(body: unknown): LiveTvChannel[] {
	if (!isRecord(body) || !Array.isArray(body.channels)) {
		throw new LiveTvError('invalid_response', { endpoint: 'channels' });
	}
	const seen = new Set<string>();
	const channels: LiveTvChannel[] = [];
	for (const raw of body.channels) {
		const channel = normalizeChannelEntry(raw);
		if (!channel || seen.has(channel.id)) continue;
		seen.add(channel.id);
		channels.push(channel);
	}
	return channels;
}

/**
 * Normalize the `sources` array of a resolution response. Non-array →
 * `invalid_response`. Entries that are not absolute http(s) URLs are dropped
 * (never repaired, never invented fallbacks — `embed`/`watch` are NOT used).
 * An empty result is the caller's signal to raise `no_playback_source`.
 */
function normalizeSources(raw: unknown, channelId: string): LiveTvPlaybackSource[] {
	if (!Array.isArray(raw)) {
		throw new LiveTvError('invalid_response', { endpoint: 'channel', channelId });
	}
	const sources: LiveTvPlaybackSource[] = [];
	for (const entry of raw) {
		if (isUsableUrl(entry)) sources.push({ url: entry });
	}
	return sources;
}

/**
 * Normalize the `drm` object of a resolution response. Absent → null.
 * Unknown DRM type → `unsupported_drm` (NEVER silently treated as ClearKey).
 * ClearKey with missing/empty keyId or key → `invalid_response`.
 * Values are transported as-is — never logged, never persisted.
 */
function normalizeDrm(raw: unknown, channelId: string): LiveTvDrm | null {
	if (raw === undefined || raw === null) return null;
	if (!isRecord(raw)) {
		throw new LiveTvError('invalid_response', { endpoint: 'channel', channelId });
	}
	if (typeof raw.type === 'string' && raw.type !== 'clearkey') {
		throw new LiveTvError('unsupported_drm', { endpoint: 'channel', channelId });
	}
	if (raw.type !== 'clearkey' || !isNonEmptyString(raw.keyId) || !isNonEmptyString(raw.key)) {
		throw new LiveTvError('invalid_response', { endpoint: 'channel', channelId });
	}
	return { type: 'clearkey', keyId: raw.keyId, key: raw.key };
}

/** Normalize one programme object; null when it fails validation (dropped). */
function normalizeProgramme(raw: unknown): LiveTvGuideProgramme | null {
	if (!isRecord(raw)) return null;
	if (!isNonEmptyString(raw.title)) return null;
	if (typeof raw.start !== 'number' || !Number.isFinite(raw.start)) return null;
	if (typeof raw.stop !== 'number' || !Number.isFinite(raw.stop)) return null;
	const programme: LiveTvGuideProgramme = {
		title: raw.title,
		startSeconds: raw.start,
		stopSeconds: raw.stop
	};
	if (isNonEmptyString(raw.desc)) programme.description = raw.desc;
	if (isNonEmptyString(raw.category)) programme.category = raw.category;
	if (isNonEmptyString(raw.image)) programme.image = raw.image;
	if (isNonEmptyString(raw.startTime)) programme.startDisplay = raw.startTime;
	if (isNonEmptyString(raw.stopTime)) programme.stopDisplay = raw.stopTime;
	return programme;
}

/** nowPlaying/upNext slots: absent/null → null; malformed → null (documented degradation). */
function normalizeProgrammeSlot(raw: unknown): LiveTvGuideProgramme | null {
	if (raw === undefined || raw === null) return null;
	return normalizeProgramme(raw);
}

/** upcoming/guide arrays: absent → []; wrong type → invalid_response; malformed entries dropped. */
function normalizeProgrammeArray(raw: unknown, channelId: string): LiveTvGuideProgramme[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new LiveTvError('invalid_response', { endpoint: 'guide', channelId });
	}
	const programmes: LiveTvGuideProgramme[] = [];
	for (const entry of raw) {
		const programme = normalizeProgramme(entry);
		if (programme) programmes.push(programme);
	}
	return programmes;
}

/**
 * Normalize a `/guide/{id}` response body. Empty schedules (null programmes,
 * empty arrays) are VALID and normalize to an empty guide — never an error.
 */
function normalizeGuide(body: unknown, channelId: string): LiveTvGuide {
	if (!isRecord(body)) {
		throw new LiveTvError('invalid_response', { endpoint: 'guide', channelId });
	}
	const guide: LiveTvGuide = {
		channelId,
		nowPlaying: normalizeProgrammeSlot(body.nowPlaying),
		upNext: normalizeProgrammeSlot(body.upNext),
		upcoming: normalizeProgrammeArray(body.upcoming, channelId),
		schedule: normalizeProgrammeArray(body.guide, channelId)
	};
	if (typeof body.generatedAt === 'number' && Number.isFinite(body.generatedAt)) {
		guide.generatedAtSeconds = body.generatedAt;
	}
	return guide;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Retrieve the LiveGT V1 channel catalogue.
 *
 * Remote category filtering is supported via the documented `?category=`
 * param. The result is cached up to 5 minutes (per query key); pass
 * `forceRefetch: true` to bypass. Returns a normalized `LiveTvChannel[]`
 * (possibly empty — an empty catalogue is a valid state).
 */
export async function getLiveTvChannels(options: LiveTvChannelsOptions = {}): Promise<LiveTvChannel[]> {
	if (options.signal?.aborted) {
		throw new LiveTvError('aborted', { endpoint: 'channels' });
	}
	const url = new URL(CHANNELS_PATH, LIVEGT_V1_BASE_URL);
	const category = options.category?.trim();
	if (category) url.searchParams.set('category', category);
	const cacheKey = url.searchParams.toString();
	if (!options.forceRefetch) {
		const cached = getCachedLiveTvChannels(cacheKey);
		if (cached) return cached;
	}
	const body = await liveTvFetch(url, 'channels', { signal: options.signal });
	const channels = normalizeChannelList(body);
	setCachedLiveTvChannels(cacheKey, channels);
	return channels;
}

/**
 * Remote search over the LiveGT V1 catalogue using the documented `?q=`
 * (name search) param. An empty/whitespace query delegates to the full
 * catalogue (`getLiveTvChannels`) instead of issuing a pointless request.
 * Results are cached briefly under their own key, like the catalogue.
 *
 * The future UI decides between this and LOCAL filtering
 * (`filterLiveTvChannelsByQuery`) — the plan prefers local filtering of the
 * short-lived catalogue where practical (plan §8); debounce in the UI.
 */
export async function searchLiveTvChannels(
	query: string,
	options: LiveTvSearchOptions = {}
): Promise<LiveTvChannel[]> {
	const trimmed = query.trim();
	if (!trimmed) {
		return getLiveTvChannels({ signal: options.signal, forceRefetch: options.forceRefetch });
	}
	if (options.signal?.aborted) {
		throw new LiveTvError('aborted', { endpoint: 'channels' });
	}
	const url = new URL(CHANNELS_PATH, LIVEGT_V1_BASE_URL);
	url.searchParams.set('q', trimmed);
	const cacheKey = url.searchParams.toString();
	if (!options.forceRefetch) {
		const cached = getCachedLiveTvChannels(cacheKey);
		if (cached) return cached;
	}
	const body = await liveTvFetch(url, 'channels', { signal: options.signal });
	const channels = normalizeChannelList(body);
	setCachedLiveTvChannels(cacheKey, channels);
	return channels;
}

/**
 * Resolve FRESH playback data for one channel — the contract LT-3's player
 * consumes (`{ channel, sources, drm }`).
 *
 * Every call performs a network request: signed MPD URLs and ClearKey values
 * are short-lived, so nothing about a resolution is ever cached or persisted
 * (plan §11, decision D6). The result exists in runtime memory only.
 *
 * Failure modes (`LiveTvError.kind`):
 *   `bad_request`        — client-side rejected (empty/non-string) channel id
 *   `not_found`          — HTTP 404 (the OBSERVED behavior for unknown AND
 *                          malformed ids; never remapped to 400)
 *   `no_playback_source` — response had zero usable http(s) sources
 *   `unsupported_drm`    — DRM present with an unknown type
 *   `invalid_response`   — malformed body / non-array sources / broken DRM
 *   `network`/`timeout`/`aborted`/`server`/`rate_limited` — transport
 *
 * Validation order: sources first (structural), then DRM (policy).
 */
export async function resolveLiveTvPlayback(
	channelId: string,
	options: LiveTvPlaybackOptions = {}
): Promise<LiveTvPlaybackResolution> {
	assertValidChannelId(channelId, 'channel');
	const url = new URL(`${CHANNEL_PATH_PREFIX}${encodeURIComponent(channelId)}`, LIVEGT_V1_BASE_URL);
	const body = await liveTvFetch(url, 'channel', { channelId, signal: options.signal });
	if (!isRecord(body)) {
		throw new LiveTvError('invalid_response', { endpoint: 'channel', channelId });
	}
	if (!isNonEmptyString(body.name)) {
		throw new LiveTvError('invalid_response', { endpoint: 'channel', channelId });
	}
	// Identity is caller-owned: the requested id is canonical.
	const channel: LiveTvChannel = { id: channelId, name: body.name };
	if (isNonEmptyString(body.category)) channel.category = body.category;
	if (isNonEmptyString(body.logo)) channel.logo = body.logo;
	const sources = normalizeSources(body.sources, channelId);
	if (sources.length === 0) {
		throw new LiveTvError('no_playback_source', { endpoint: 'channel', channelId });
	}
	const drm = normalizeDrm(body.drm, channelId);
	return { channel, sources, drm };
}

/**
 * Retrieve the programme guide for one channel. Cached up to 30 seconds per
 * channel; `forceRefetch: true` bypasses. An empty schedule is a VALID empty
 * guide, never an error (plan §12). Timestamps stay Unix seconds
 * (`startSeconds`/`stopSeconds` — see `types.ts`).
 */
export async function getLiveTvGuide(channelId: string, options: LiveTvGuideOptions = {}): Promise<LiveTvGuide> {
	assertValidChannelId(channelId, 'guide');
	if (options.signal?.aborted) {
		throw new LiveTvError('aborted', { endpoint: 'guide', channelId });
	}
	if (!options.forceRefetch) {
		const cached = getCachedLiveTvGuide(channelId);
		if (cached) return cached;
	}
	const url = new URL(`${GUIDE_PATH_PREFIX}${encodeURIComponent(channelId)}`, LIVEGT_V1_BASE_URL);
	const body = await liveTvFetch(url, 'guide', { channelId, signal: options.signal });
	const guide = normalizeGuide(body, channelId);
	setCachedLiveTvGuide(channelId, guide);
	return guide;
}

// ---------------------------------------------------------------------------
// Local catalogue utilities (pure — no network, no cache).
// ---------------------------------------------------------------------------

/**
 * Derive the unique category list from catalogue data (never hardcoded,
 * plan §8). Categories are trimmed; empty/missing categories are ignored.
 * Ordering is STABLE first-appearance order (deterministic for a given
 * catalogue; the UI may re-sort alphabetically if it prefers).
 */
export function extractLiveTvCategories(channels: readonly LiveTvChannel[]): string[] {
	const seen = new Set<string>();
	const categories: string[] = [];
	for (const channel of channels) {
		const category = channel.category?.trim();
		if (!category || seen.has(category)) continue;
		seen.add(category);
		categories.push(category);
	}
	return categories;
}

/**
 * Local category filter (case-insensitive exact match on trimmed values).
 * An empty/whitespace category is a no-op and returns every channel.
 */
export function filterLiveTvChannelsByCategory(
	channels: readonly LiveTvChannel[],
	category: string
): LiveTvChannel[] {
	const wanted = category.trim().toLowerCase();
	if (!wanted) return [...channels];
	return channels.filter((channel) => (channel.category ?? '').trim().toLowerCase() === wanted);
}

/**
 * Local name search (case-insensitive substring), mirroring the documented
 * remote `?q=` semantics. An empty/whitespace query returns every channel.
 */
export function filterLiveTvChannelsByQuery(
	channels: readonly LiveTvChannel[],
	query: string
): LiveTvChannel[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...channels];
	return channels.filter((channel) => channel.name.toLowerCase().includes(needle));
}

// Test-only exports (rail-cache `__test` convention).
export const __test = {
	getRequestTimeoutMs(): number {
		return requestTimeoutMs;
	},
	/** Override the request timeout for deterministic tests (>0 only). */
	setRequestTimeoutForTests(ms: number): void {
		if (ms > 0) requestTimeoutMs = ms;
	},
	resetRequestTimeout(): void {
		requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
	}
};
