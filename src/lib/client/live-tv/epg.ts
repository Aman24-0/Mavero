// LT-4 — Live TV EPG/display helpers (pure, UI-facing).
//
// PURE functions only: no network, no engine access, no browser globals, no
// side effects. They exist so the /live-tv page and its components stay thin
// and so the LT-4 suite can behaviorally test the display decisions that are
// easy to get wrong (current-programme determination, live-edge math, logo
// fallbacks) without rendering anything.
//
// TIMEZONE CONTRACT (LT-4 brief §14, LT-2 types.ts):
//   LiveGT guide timestamps are Unix SECONDS — absolute instants with no
//   timezone attached. Current-programme determination therefore compares
//   against `Date.now()/1000` (also an absolute instant): no browser-local
//   assumption is ever baked into the DATA decision, and no LiveGT display
//   string is parsed for logic.
//   `formatGuideClock` renders an absolute instant in the VIEWER's locale /
//   timezone — a rendering choice, like every EPG; it never feeds logic.
//   The provider display strings (startDisplay/stopDisplay) are carried but
//   intentionally NOT used for any decision (LT-2 observed them as
//   undocumented; generatedAt is likewise unreliable and never read here).
//
// NO FABRICATION RULES (LT-4 brief §12/§14):
//   * nowPlaying comes from the provider when present; the fallback scans the
//     actual schedule by timestamp. When neither yields a programme, null is
//     returned — a current programme is never invented.
//   * A missing logo degrades to initials; initials are never invented from
//     anything but the channel's actual name.

import type { LiveTvGuide, LiveTvGuideProgramme } from './types';

/**
 * The programme currently on air, derived from ACTUAL guide data only.
 *
 * Resolution order (documented, deterministic):
 *   1. `guide.nowPlaying` — the provider's own statement, authoritative.
 *   2. Otherwise the first schedule entry whose [start, stop) window contains
 *      `nowSeconds` (an unambiguous time-window determination; ties impossible
 *      with well-formed data — first match wins).
 *   3. Otherwise null. Never fabricated.
 */
export function determineCurrentProgramme(
        guide: LiveTvGuide | null,
        nowSeconds: number
): LiveTvGuideProgramme | null {
        if (!guide || !Number.isFinite(nowSeconds)) return null;
        if (guide.nowPlaying) return guide.nowPlaying;
        const schedule = Array.isArray(guide.schedule) ? guide.schedule : [];
        for (const programme of schedule) {
                if (!programme) continue;
                const start = programme.startSeconds;
                const stop = programme.stopSeconds;
                if (typeof start !== 'number' || typeof stop !== 'number') continue;
                if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
                if (nowSeconds >= start && nowSeconds < stop) return programme;
        }
        return null;
}

/** Where a programme sits relative to `nowSeconds` (used for list markers). */
export function programmeStatusAt(
        programme: LiveTvGuideProgramme,
        nowSeconds: number
): 'past' | 'current' | 'future' {
        if (!Number.isFinite(nowSeconds)) return 'future';
        if (nowSeconds >= programme.stopSeconds) return 'past';
        if (nowSeconds < programme.startSeconds) return 'future';
        return 'current';
}

/**
 * Render a guide timestamp as a local wall-clock time (e.g. "9:30 PM").
 *
 * The input is an absolute Unix-seconds instant; the output is a VIEWER-local
 * rendering (every EPG does this). `hour12` follows the viewer's locale.
 * Invalid inputs return an em dash — never a fabricated time.
 */
export function formatGuideClock(unixSeconds: number): string {
        if (!Number.isFinite(unixSeconds)) return '—';
        const ms = unixSeconds * 1000;
        if (!Number.isFinite(ms)) return '—';
        try {
                return new Date(ms).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit'
                });
        } catch {
                return '—';
        }
}

/**
 * Render a guide timestamp as a compact date + wall-clock (e.g. "Oct 7, 9:30 PM").
 * Used by the schedule list on days other than today; invalid → em dash.
 */
export function formatGuideDateTime(unixSeconds: number): string {
        if (!Number.isFinite(unixSeconds)) return '—';
        const ms = unixSeconds * 1000;
        if (!Number.isFinite(ms)) return '—';
        try {
                return new Date(ms).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit'
                });
        } catch {
                return '—';
        }
}

/** True when the programme's window starts on the same local calendar day as `nowSeconds`. */
export function programmeIsToday(programme: LiveTvGuideProgramme, nowSeconds: number): boolean {
        if (!Number.isFinite(nowSeconds)) return false;
        const a = new Date(programme.startSeconds * 1000);
        const b = new Date(nowSeconds * 1000);
        return (
                a.getFullYear() === b.getFullYear() &&
                a.getMonth() === b.getMonth() &&
                a.getDate() === b.getDate()
        );
}

/**
 * Live-edge position for the player UI.
 *
 * `atLiveEdge` — the playhead is within `atEdgeThresholdSeconds` of the live
 * window end (or there is no window at all). `behindSeconds` — how far behind
 * live the playhead is, null when at the edge or when no honest number exists.
 * Never invented: no seek range → atLiveEdge true, behindSeconds null.
 */
export function describeLivePosition(
        seekRange: { start: number; end: number } | null,
        currentTime: number,
        atEdgeThresholdSeconds = 12
): { atLiveEdge: boolean; behindSeconds: number | null } {
        if (!seekRange) return { atLiveEdge: true, behindSeconds: null };
        const end = seekRange.end;
        if (!Number.isFinite(end)) return { atLiveEdge: true, behindSeconds: null };
        const time = Number.isFinite(currentTime) ? currentTime : 0;
        const behind = Math.max(0, end - time);
        if (behind <= atEdgeThresholdSeconds) return { atLiveEdge: true, behindSeconds: null };
        return { atLiveEdge: false, behindSeconds: behind };
}

/** Human "behind live" label (e.g. "1m 12s behind live"); null when at the edge. */
export function formatBehindLive(behindSeconds: number | null): string | null {
        if (behindSeconds === null || !Number.isFinite(behindSeconds) || behindSeconds <= 0) return null;
        const total = Math.round(behindSeconds);
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        if (minutes <= 0) return `${seconds}s behind live`;
        if (minutes >= 60) {
                const hours = Math.floor(minutes / 60);
                const rem = minutes % 60;
                return rem > 0 ? `${hours}h ${rem}m behind live` : `${hours}h behind live`;
        }
        return seconds > 0 ? `${minutes}m ${seconds}s behind live` : `${minutes}m behind live`;
}

/**
 * Initials for the no-logo fallback — derived ONLY from the channel's actual
 * name (first letters of the first two words, uppercased). Empty/garbage
 * names yield "TV" so the fallback surface is never blank; nothing else is
 * invented.
 */
export function channelInitials(name: string): string {
        const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) return 'TV';
        const first = words[0]?.[0] ?? '';
        const second = words.length > 1 ? (words[1]?.[0] ?? '') : '';
        const initials = `${first}${second}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
        return initials.length > 0 ? initials.slice(0, 2) : 'TV';
}

/**
 * Guide "as of" note — the LT-4 UI never relies on `generatedAt` (LT-2 proved
 * it arrives as an undocumented display string; only a finite number ever
 * populates `generatedAtSeconds`). This helper only formats that field when it
 * is actually present; callers render nothing otherwise.
 */
export function formatGuideGeneratedAt(guide: LiveTvGuide | null): string | null {
        if (!guide || typeof guide.generatedAtSeconds !== 'number') return null;
        if (!Number.isFinite(guide.generatedAtSeconds)) return null;
        return formatGuideDateTime(guide.generatedAtSeconds);
}
