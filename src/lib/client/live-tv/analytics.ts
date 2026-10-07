// LT-5 — Live TV analytics adapter (page-owned, safe payloads ONLY).
//
// This module is the SINGLE place Live TV events enter Mavero's existing
// analytics system (the Phase 1 dispatcher — src/lib/client/analytics/
// dispatcher.ts — queueing to /api/events). It exists to make the payload
// contract STRUCTURAL instead of conventional: every event is constructed
// here from typed, non-sensitive inputs, so no caller can accidentally
// attach playback material to an event.
//
// PAYLOAD SECURITY CONTRACT (LT-5 brief §8, live-tv-plan.md §14):
//   ALLOWED (and nothing else):
//     * content_id  — the LiveGT channel id (a safe catalogue identifier)
//     * metadata.reason        — 'initial' | 'switch' | 'retry' | 'manual'
//     * metadata.category      — the channel's category string (catalogue data)
//     * metadata.error_kind    — a normalized error kind from the FIXED
//                                LT-2/LT-3 tables ('server', 'not_found',
//                                'manifest_load_failed', ...) — never a raw
//                                error message, never a Shaka payload
//     * metadata.action        — 'enter' | 'exit' (fullscreen)
//   FORBIDDEN by construction (there is no code path that could send them):
//     signed MPD URLs, ClearKey keyId/key values, DRM configuration, raw
//     LiveGT response bodies, raw Shaka error objects, stack traces,
//     playback source arrays, query strings, user free-text.
//
// PRIVACY (LT-5 brief §9): no new identifiers, no cookies, no storage, no
// fingerprinting, no session replay. The dispatcher's existing anonymous-id
// model is reused as-is; Live TV adds nothing to it.
//
// RELIABILITY (LT-5 brief §9): track() is a synchronous queue push that
// no-ops when analytics is disabled — it can never block or fail playback,
// channel selection, resolution or guide loading. This module never throws
// (every function is a fire-and-forget call into the dispatcher).
//
// EVENT TAXONOMY (mirrored by the DB CHECK constraint in
// supabase/migrations/20261103000000_live_tv_analytics_events.sql and
// ANALYTICS_EVENT_NAMES in src/lib/shared/analytics-taxonomy.ts):
//   live_tv_open            — page mount
//   live_tv_channel_select  — first selection / retry (metadata.reason)
//   live_tv_channel_switch  — different channel selected while one was active
//   live_tv_play            — session actually reached playback (first time)
//   live_tv_pause           — user paused an active session
//   live_tv_error           — playback failed (metadata.error_kind)
//   live_tv_fullscreen      — user entered/exited fullscreen (metadata.action)
//
// High-frequency telemetry (timeupdate, buffering ticks, seek positions) is
// deliberately NOT part of this taxonomy.

import { track } from '$lib/client/analytics/dispatcher';
import type { LiveTvChannel } from './types';
import { LiveTvError } from './errors';
import { LiveTvPlaybackError } from './player-errors';

/** Why a channel selection happened (mirrors the VOD provider_selected convention). */
export type LiveTvSelectReason = 'initial' | 'switch' | 'retry';

/** Bounded metadata value whitelist (the only keys Live TV ever sends). */
type LiveTvEventMetadata = {
  reason?: LiveTvSelectReason;
  category?: string;
  error_kind?: string;
  action?: 'enter' | 'exit';
};

/**
 * Normalize an unknown error to its SAFE machine kind for analytics.
 *
 * Only the typed LT-2/LT-3 error classes carry a kind, and every kind comes
 * from a fixed closed union — low cardinality by construction. Unknown
 * errors collapse to 'unknown' (a literal): no message, no name, no stack,
 * no upstream payload is EVER read.
 */
export function liveTvErrorKindForAnalytics(err: unknown): string {
  if (err instanceof LiveTvError) return err.kind;
  if (err instanceof LiveTvPlaybackError) return err.kind;
  return 'unknown';
}

/** Truncate + sanity-gate a catalogue category value (defensive; catalogue data is already validated). */
function safeCategoryValue(category: string | undefined): string | undefined {
  if (typeof category !== 'string') return undefined;
  const trimmed = category.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 64);
}

/** Build the metadata object with only whitelisted keys present. */
function metadata(meta: LiveTvEventMetadata): { metadata?: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  if (meta.reason !== undefined) out.reason = meta.reason;
  const category = safeCategoryValue(meta.category);
  if (category !== undefined) out.category = category;
  if (meta.error_kind !== undefined) out.error_kind = meta.error_kind.slice(0, 64);
  if (meta.action !== undefined) out.action = meta.action;
  return Object.keys(out).length > 0 ? { metadata: out } : {};
}

/** The /live-tv page was opened (page mount). */
export function trackLiveTvOpen(): void {
  track('live_tv_open');
}

/**
 * A channel selection started a fresh playback flow.
 * `reason` distinguishes the first selection, a retry of the same channel
 * and a switch away from an already-active channel.
 */
export function trackLiveTvChannelAction(
  channel: LiveTvChannel,
  reason: LiveTvSelectReason
): void {
  const eventName = reason === 'switch' ? 'live_tv_channel_switch' : 'live_tv_channel_select';
  track(eventName, {
    content_id: channel.id,
    ...metadata({ reason, category: channel.category })
  });
}

/** A playback session actually reached the playing state (first time per session). */
export function trackLiveTvPlay(channelId: string): void {
  track('live_tv_play', { content_id: channelId });
}

/** The user paused an active session (user action only, never a system pause). */
export function trackLiveTvPause(channelId: string): void {
  track('live_tv_pause', { content_id: channelId });
}

/**
 * A playback flow failed. `err` is normalized to its safe machine kind —
 * only the fixed LT-2/LT-3 kinds (or 'unknown') are ever transmitted.
 */
export function trackLiveTvError(channelId: string | null, err: unknown): void {
  track('live_tv_error', {
    ...(channelId !== null ? { content_id: channelId } : {}),
    ...metadata({ error_kind: liveTvErrorKindForAnalytics(err) })
  });
}

/** The user entered or exited fullscreen on the player surface. */
export function trackLiveTvFullscreen(channelId: string | null, action: 'enter' | 'exit'): void {
  track('live_tv_fullscreen', {
    ...(channelId !== null ? { content_id: channelId } : {}),
    ...metadata({ action })
  });
}
