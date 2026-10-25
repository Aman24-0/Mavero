// Task 5 (2026-10-15) — Live TV recently-played channels (local store).
//
// A tiny client-side, localStorage-backed recent-channels store following
// the EXISTING Mavero local-persistence convention (see recent-searches.ts):
//
//   * BOUNDED  — at most MAX_RECENT_CHANNELS (12) entries; the oldest
//                entry is evicted on insert.
//   * DEDUPED  — re-playing a channel moves it to the front (most recent
//                first), never duplicates it.
//   * MINIMAL  — only the channel's catalogue ID string is stored (with a
//                bounded length). NO signed media URLs, NO resolver
//                responses, NO tokens, NO credentials, NO EPG data.
//   * SAFE     — all storage access is wrapped (SSR / private-mode /
//                quota failures degrade to no-ops, never throw); values
//                are validated strings.
//   * LOCAL    — stays on the device; nothing is synced or sent to the
//                server. Channel names/logos are NOT persisted — they are
//                resolved against the LIVE catalogue at render time (a
//                removed channel id simply disappears from the row).

const STORAGE_KEY = 'mavero:live-tv-recent-channels';
const MAX_RECENT_CHANNELS = 12;
const MAX_CHANNEL_ID_LENGTH = 120;

export function getRecentChannelIds(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim().slice(0, MAX_CHANNEL_ID_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_RECENT_CHANNELS);
  } catch {
    return [];
  }
}

/**
 * Records a channel play: moves the channel to the FRONT of the recent
 * list (or inserts it), evicting the oldest entry beyond the bound.
 * Returns the updated list so callers can render it synchronously.
 */
export function recordRecentChannel(channelId: string): string[] {
  const normalized = channelId.trim().slice(0, MAX_CHANNEL_ID_LENGTH);
  if (!normalized) return getRecentChannelIds();
  const next = [normalized, ...getRecentChannelIds().filter((entry) => entry !== normalized)].slice(0, MAX_RECENT_CHANNELS);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota — the in-memory list still returns for this
    // session's render; persistence is best-effort by design.
  }
  return next;
}

/** Removes ONE channel from the recent list (per-channel clear action). */
export function removeRecentChannel(channelId: string): string[] {
  const normalized = channelId.trim().slice(0, MAX_CHANNEL_ID_LENGTH);
  const next = getRecentChannelIds().filter((entry) => entry !== normalized);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort — see recordRecentChannel.
  }
  return next;
}

/** Clears the WHOLE recent list (Clear all action). Local history only —
 *  playback is unaffected (the store never touches the playback engine). */
export function clearRecentChannels(): string[] {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort — see recordRecentChannel.
  }
  return [];
}
