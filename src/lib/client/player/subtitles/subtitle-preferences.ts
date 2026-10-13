/**
 * Player subtitle preferences (focused player fixes, 2026-10 — Issues 1+2).
 *
 * A small, VERSIONED local preference store for the subtitle settings
 * surface (text size, vertical position, sync offset, text colour, border
 * style). There was NO existing player-subtitle preference mechanism (the
 * audit found none), so this defines the contract — deliberately following
 * the established `recent-searches.ts` conventions:
 *
 *   * VERSIONED — the storage key carries the version (`…:v1`); payloads
 *     with a foreign/missing version are discarded and defaults apply.
 *   * SAFE — all storage access is wrapped (SSR / private-mode / quota
 *     failures degrade to no-ops, never throw); every field is validated
 *     and clamped into its bounded range; unknown fields are dropped.
 *   * LOCAL — stays on the device; nothing is synced or sent to the server.
 *   * NO MIGRATION — plain localStorage, no database involvement (per the
 *     task constraint: no DB migration solely for this feature).
 *
 * OFFSET CONVENTION (displayed in the settings UI verbatim):
 *   A POSITIVE offset DELAYS the subtitles (they appear LATER than encoded);
 *   a NEGATIVE offset shows them EARLIER. Zero is perfect sync. Applied at
 *   RENDER time only — upstream VTT files are never modified.
 */

export const SUBTITLE_PREFERENCES_VERSION = 1;
export const SUBTITLE_PREFERENCES_STORAGE_KEY = 'mavero:player:subtitles:v1';

export type SubtitleBorderStyle = 'none' | 'outline' | 'shadow' | 'box';
export type SubtitleColorKey = 'white' | 'yellow' | 'cyan' | 'green' | 'pink';

export type SubtitlePreferences = {
  /** Text size multiplier. 1 = default. */
  sizeScale: number;
  /** Vertical position, 0 = bottom (default) … 100 = top. */
  position: number;
  /** Sync offset in seconds. Positive = subtitles appear LATER. */
  offsetSeconds: number;
  /** Text colour preset key. */
  color: SubtitleColorKey;
  /** Text border/box style. */
  borderStyle: SubtitleBorderStyle;
};

export const SUBTITLE_SIZE_SCALE = { min: 0.7, max: 1.6, step: 0.1 } as const;
export const SUBTITLE_POSITION = { min: 0, max: 100, step: 5 } as const;
/** Offset bounds + step. −10…+10 s in 0.5 s steps covers real-world desync. */
export const SUBTITLE_OFFSET = { min: -10, max: 10, step: 0.5 } as const;

/** Colour presets — fixed allowlist (no free-form colour injection). */
export const SUBTITLE_COLOR_PRESETS: ReadonlyArray<{ key: SubtitleColorKey; label: string; hex: string }> = [
  { key: 'white', label: 'White', hex: '#ffffff' },
  { key: 'yellow', label: 'Yellow', hex: '#ffd54f' },
  { key: 'cyan', label: 'Cyan', hex: '#80deea' },
  { key: 'green', label: 'Green', hex: '#a5d6a7' },
  { key: 'pink', label: 'Pink', hex: '#f8bbd0' },
];

export const DEFAULT_SUBTITLE_PREFERENCES: SubtitlePreferences = {
  sizeScale: 1,
  position: 0,
  offsetSeconds: 0,
  color: 'white',
  borderStyle: 'outline',
};

const BORDER_STYLES: ReadonlyArray<SubtitleBorderStyle> = ['none', 'outline', 'shadow', 'box'];
const COLOR_KEYS: ReadonlyArray<SubtitleColorKey> = ['white', 'yellow', 'cyan', 'green', 'pink'];

function clampRange(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Validates an untrusted parsed payload into a full preference object.
 * Every field is independent: a bad `color` never discards a valid `size`.
 * Unknown/absent fields fall back to their defaults (never nulls).
 */
export function sanitizeSubtitlePreferences(raw: unknown): SubtitlePreferences {
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const sizeScale = clampRange(source.sizeScale, SUBTITLE_SIZE_SCALE.min, SUBTITLE_SIZE_SCALE.max, DEFAULT_SUBTITLE_PREFERENCES.sizeScale);
  const position = clampRange(source.position, SUBTITLE_POSITION.min, SUBTITLE_POSITION.max, DEFAULT_SUBTITLE_PREFERENCES.position);
  const offsetSeconds = clampRange(source.offsetSeconds, SUBTITLE_OFFSET.min, SUBTITLE_OFFSET.max, DEFAULT_SUBTITLE_PREFERENCES.offsetSeconds);
  const color = COLOR_KEYS.includes(source.color as SubtitleColorKey) ? (source.color as SubtitleColorKey) : DEFAULT_SUBTITLE_PREFERENCES.color;
  const borderStyle = BORDER_STYLES.includes(source.borderStyle as SubtitleBorderStyle) ? (source.borderStyle as SubtitleBorderStyle) : DEFAULT_SUBTITLE_PREFERENCES.borderStyle;
  return {
    // Round to the canonical precision so persisted values stay stable.
    sizeScale: Math.round(sizeScale * 100) / 100,
    position: Math.round(position),
    offsetSeconds: Math.round(offsetSeconds * 10) / 10,
    color,
    borderStyle,
  };
}

/**
 * Loads the saved preferences. Any problem (SSR, disabled storage, corrupt
 * JSON, foreign version) degrades to the DEFAULTS — never throws.
 */
export function loadSubtitlePreferences(storage?: { getItem(key: string): string | null }): SubtitlePreferences {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    if (!store) return { ...DEFAULT_SUBTITLE_PREFERENCES };
    const raw = store.getItem(SUBTITLE_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SUBTITLE_PREFERENCES };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_SUBTITLE_PREFERENCES };
    if ((parsed as Record<string, unknown>).version !== SUBTITLE_PREFERENCES_VERSION) return { ...DEFAULT_SUBTITLE_PREFERENCES };
    return sanitizeSubtitlePreferences(parsed);
  } catch {
    return { ...DEFAULT_SUBTITLE_PREFERENCES };
  }
}

/**
 * Persists the preferences. Failures (quota, private mode) are swallowed —
 * the in-memory session keeps working with the same values.
 */
export function saveSubtitlePreferences(prefs: SubtitlePreferences, storage?: { setItem(key: string, value: string): void }): void {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    if (!store) return;
    const clean = sanitizeSubtitlePreferences(prefs);
    store.setItem(SUBTITLE_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: SUBTITLE_PREFERENCES_VERSION, ...clean }));
  } catch {
    /* storage unavailable — session values remain */
  }
}

/** Steps the offset by one increment in the given direction, clamped. */
export function stepSubtitleOffset(current: number, direction: 1 | -1): number {
  const raw = current + direction * SUBTITLE_OFFSET.step;
  const clamped = Math.min(SUBTITLE_OFFSET.max, Math.max(SUBTITLE_OFFSET.min, raw));
  return Math.round(clamped * 10) / 10;
}

/** Steps the size scale by one increment in the given direction, clamped. */
export function stepSubtitleSize(current: number, direction: 1 | -1): number {
  const raw = current + direction * SUBTITLE_SIZE_SCALE.step;
  const clamped = Math.min(SUBTITLE_SIZE_SCALE.max, Math.max(SUBTITLE_SIZE_SCALE.min, raw));
  return Math.round(clamped * 100) / 100;
}

/**
 * Formats the sync offset for display: `-2.0s`, `0.0s`, `+2.0s` (the task's
 * exact example shapes). Positive carries the explicit `+` so the delay
 * direction is readable at a glance.
 */
export function formatSubtitleOffset(seconds: number): string {
  const safe = Number.isFinite(seconds) ? seconds : 0;
  if (safe === 0) return '0.0s';
  const rounded = Math.round(safe * 10) / 10;
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded).toFixed(1)}s`;
}
