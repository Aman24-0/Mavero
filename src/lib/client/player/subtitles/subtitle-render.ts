/**
 * Player subtitle RENDER primitives (focused player fixes, 2026-10 — Issue 1).
 *
 * Pure, side-effect-free helpers behind the custom subtitle overlay. The
 * overlay component consumes these every animation frame; the unit suite
 * exercises the truth tables directly.
 *
 * OFFSET CONVENTION (matches subtitle-preferences.ts, shown in the UI):
 *   positive offset → subtitles appear LATER; negative → EARLIER.
 *   Implemented as displayTime = mediaTime − offset, and a cue is active
 *   while cue.startTime ≤ displayTime < cue.endTime (start inclusive, end
 *   exclusive — the WebVTT timing contract).
 *
 * The function is PURE: it never mutates cues, never caches by identity and
 * can be called any number of times per frame without double-applying the
 * offset (the offset is an input, not accumulated state) — the "no double
 * application across track switches / Off-on toggles" guarantee is
 * structural, not bookkeeping.
 */

/** Minimal cue shape (structural — accepts real TextTrackCue objects). */
export type SubtitleCueLike = { startTime: number; endTime: number; text: string };

/** Media time at which cues encoded at `mediaTime` must be displayed. */
export function subtitleDisplayTime(mediaTime: number, offsetSeconds: number): number {
  const time = Number.isFinite(mediaTime) ? mediaTime : 0;
  const offset = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
  return time - offset;
}

/**
 * The cues active at `displayTime`, in cue order. A cue is active while
 * `startTime ≤ displayTime < endTime`. Zero-length cues (start === end)
 * never render. Tolerates unsorted input (full scan, no early exit) —
 * real TextTrack cue lists are sorted, but correctness beats micro-cost.
 */
export function selectActiveCues(cues: Iterable<SubtitleCueLike> | null | undefined, displayTime: number): SubtitleCueLike[] {
  if (!cues) return [];
  const active: SubtitleCueLike[] = [];
  for (const cue of cues) {
    if (!cue || typeof cue.startTime !== 'number' || typeof cue.endTime !== 'number') continue;
    if (!Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime)) continue;
    if (cue.endTime <= cue.startTime) continue;
    if (cue.startTime <= displayTime && displayTime < cue.endTime) active.push(cue);
  }
  return active;
}

/**
 * Strips WebVTT inline markup from raw cue text for safe plain-text
 * rendering: `<i>`/`<b>`/`<u>`/`<ruby>`/`<v Name>`/`<c.class>` tags and
 * inline timestamps (`<00:00:01.000>`) are removed; the classic HTML
 * entities WebVTT defines are decoded. The result is rendered through
 * Svelte's auto-escaping (never {@html}) — no markup can survive to the DOM.
 */
export function stripCueMarkup(raw: string): string {
  if (typeof raw !== 'string') return '';
  const withoutTags = raw.replace(/<[^>]*>/g, '');
  return withoutTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Display text for the active cues: markup-stripped, whitespace-trimmed
 * per cue, joined with newlines (rendered with `white-space: pre-line`).
 * Empty/blank cues contribute nothing.
 */
export function cueDisplayText(activeCues: SubtitleCueLike[]): string {
  const lines = (activeCues ?? [])
    .map((cue) => stripCueMarkup(typeof cue?.text === 'string' ? cue.text : ''))
    .map((text) => text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim())
    .filter((text) => text.length > 0);
  return lines.join('\n');
}
