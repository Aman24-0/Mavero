// MAVERO — Recent searches (Search page, Explorer redesign Change 4).
//
// A tiny client-side, localStorage-backed recent-search store. This is
// the FIRST search-history system in the app (the audit found no
// existing one), so it defines the contract rather than duplicating
// anything:
//
//   * BOUNDED  — at most MAX_RECENT_SEARCHES (8) entries; the oldest
//                entry is evicted on insert.
//   * DEDUPED  — re-running a query moves it to the front (most recent
//                first), never duplicates it.
//   * SAFE     — all storage access is wrapped (SSR / private-mode /
//                quota failures degrade to no-ops, never throw); values
//                are validated strings and truncated to a sane length.
//   * LOCAL    — stays on the device; nothing is synced or sent to the
//                server (search queries themselves already go to the
//                existing /api/content/search endpoint unchanged).

const STORAGE_KEY = 'mavero:recent-searches';
const MAX_RECENT_SEARCHES = 8;
const MAX_QUERY_LENGTH = 80;

export function getRecentSearches(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().slice(0, MAX_QUERY_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

export function recordRecentSearch(query: string): string[] {
  const normalized = query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!normalized) return getRecentSearches();
  const next = [normalized, ...getRecentSearches().filter((entry) => entry !== normalized)].slice(0, MAX_RECENT_SEARCHES);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota — the in-memory list still returns for this
    // session's render; persistence is best-effort by design.
  }
  return next;
}

export function removeRecentSearch(query: string): string[] {
  const normalized = query.trim().slice(0, MAX_QUERY_LENGTH);
  const next = getRecentSearches().filter((entry) => entry !== normalized);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort — see recordRecentSearch.
  }
  return next;
}
