// MAVERO — Shared hosting duration parser (focused Vidara/Abyss audit fix, 2026-10).
//
// Pure, side-effect-free helpers that map a provider-side duration value
// into a DB-safe `duration_seconds` integer.
//
// ROOT CAUSE being fixed (verified by audit):
//   The previous `coerceNumber()` used `parseInt(value, 10)`. For Vidara's
//   documented `video_length: "00:01:30"` shape, `parseInt("00:01:30", 10)`
//   returns `0`. That violates the database CHECK constraint
//   `media_assets_duration_seconds_check CHECK (duration_seconds IS NULL OR
//   (duration_seconds > 0 AND duration_seconds <= 86400 * 7))` — the insert
//   (linkAsset) and update (sync) paths both wrote the 0 through, causing
//   the reported "media_assets_duration_seconds_check" failure when
//   linking Black Clover episodes.
//
// The DB constraint is INTENTIONAL and stays — we fix the value at the
// provider-normalization boundary so every persistence path is safe.

/** Maximum allowed duration in seconds (7 days — matches the DB CHECK constraint). */
export const MAX_DURATION_SECONDS = 86400 * 7; // 604_800

/**
 * Parse a provider-side duration value into a DB-safe `duration_seconds`
 * integer, or `null` when the value is unknown/invalid.
 *
 * Accepted input shapes (provider-agnostic — both Vidara and Abyss use
 * variations of these):
 *   * `number` — already-seconds. Negative or zero → `null`. > MAX → `null`.
 *   * `"123"` — numeric string. Same number rules.
 *   * `"00:01:30"` — `HH:MM:SS`. Parsed as hours*3600 + minutes*60 + seconds.
 *   * `"01:30"`   — `MM:SS`. Parsed as minutes*60 + seconds.
 *   * `"1h 23m"`, `"90s"` — best-effort not supported; intentionally return
 *     `null` rather than guess. (Vidara/Abyss do not return these shapes
 *     per the verified API contracts.)
 *
 * Rules (DB-safe):
 *   * `null` / `undefined` / `""` / whitespace-only → `null` (unknown).
 *   * `0` (number or `"0"`) → `null` (the DB CHECK rejects 0; the audit
 *     confirmed `parseInt("00:01:30") === 0` was the bug).
 *   * Negative numbers → `null` (the DB CHECK rejects negatives).
 *   * `NaN` / `Infinity` / non-finite → `null`.
 *   * Values > MAX_DURATION_SECONDS → `null` (the DB CHECK rejects them;
 *     a value over 7 days is almost certainly a parse mistake, not a real
 *     media file duration).
 *   * `HH:MM:SS` with `MM` or `SS` > 59 → `null` (invalid time shape).
 *   * The result is always an integer (seconds are integers in the DB
 *     schema — `integer` column).
 *
 * Pure function — no side effects, no I/O, no env. Unit-testable in
 * isolation. Same function is used by both Vidara + Abyss normalization.
 */
export function parseDurationSeconds(value: unknown): number | null {
  if (value == null) return null;

  // String inputs: try `HH:MM:SS` / `MM:SS` first, then numeric-string.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // `HH:MM:SS` or `MM:SS` — at most 2 colons.
    const colonCount = (trimmed.match(/:/g) ?? []).length;
    if (colonCount === 1 || colonCount === 2) {
      const parts = trimmed.split(':').map((p) => p.trim());
      if (parts.some((p) => !/^\d+$/.test(p))) return null; // every part must be all-digits
      const nums = parts.map((p) => Number.parseInt(p, 10));
      let hours: number, minutes: number, seconds: number;
      if (nums.length === 3) {
        // HH:MM:SS — hours can be any value, but minutes + seconds must be < 60.
        [hours, minutes, seconds] = nums;
        if (minutes > 59 || seconds > 59) return null; // invalid time shape
      } else {
        // MM:SS — minutes can be any value (a 90-minute video is valid);
        // seconds must be < 60.
        hours = 0;
        [minutes, seconds] = nums;
        if (seconds > 59) return null; // invalid time shape
      }
      const total = hours * 3600 + minutes * 60 + seconds;
      return sanitizeSeconds(total);
    }

    // Plain numeric string like "123" or " 90 ".
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number.parseInt(trimmed, 10);
      return sanitizeSeconds(n);
    }

    // Any other string shape (e.g. "1h 23m", "90s", "abc") → unknown.
    return null;
  }

  // Number inputs.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Floor to integer seconds (provider may report 90.5s for a 1m30s clip).
    return sanitizeSeconds(Math.floor(value));
  }

  // Any other type (boolean, object, array) → unknown.
  return null;
}

/**
 * Internal: enforce the DB CHECK constraints on a parsed numeric seconds
 * value. Returns `null` for values that would violate the CHECK (zero,
 * negative, or over the 7-day cap). Otherwise returns the integer.
 */
function sanitizeSeconds(seconds: number): number | null {
  if (!Number.isFinite(seconds)) return null;
  if (seconds <= 0) return null; // DB CHECK: duration_seconds > 0
  if (seconds > MAX_DURATION_SECONDS) return null; // DB CHECK: duration_seconds <= 86400 * 7
  return Math.floor(seconds); // integer column
}
