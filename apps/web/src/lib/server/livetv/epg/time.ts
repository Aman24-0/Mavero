// ============================================================================
// Unified Live TV — Phase 3 EPG timestamp policy (server-only, PURE).
//
// XMLTV programme windows arrive as attribute strings per the XMLTV DTD:
//
//     YYYYMMDDHHMMSS [+-]HHMM [/clumpidx]
//
//   * An EXPLICIT offset is authoritative: the UTC instant is the wall time
//     minus the offset. No timezone database is consulted.
//   * A TIMEZONE-LESS timestamp is interpreted in a CONFIGURED IANA
//     timezone (the EPG source's `config.defaultTimezone`). It is NEVER
//     silently interpreted in the server's local timezone (Phase 3 brief
//     §5). When no default timezone is configured, a timezone-less
//     timestamp is a per-record skip with a typed reason — never a guess.
//   * `clumpidx` (`/N` suffix) is ignored for window purposes (it only
//     marks split showings of one slot) — the window itself is unchanged.
//
// DST RULES (documented, deterministic — brief §5):
//   * Ambiguous local time (fall-back): the EARLIER UTC instant wins (the
//     first occurrence, i.e. the pre-transition/DST-side offset).
//   * Nonexistent local time (spring-forward gap): interpreted with the
//     PRE-transition offset, so the resulting instant lands at/after the
//     gap start (the conventional "post-gap" reading).
//   * Both rules only ever apply to timezone-less timestamps; explicit
//     offsets are mechanical.
//
// VALIDATION (brief §5):
//   * Calendar dates are validated component-wise (no Date() rollover
//     normalization: 2024-02-31 is INVALID, not March 2nd).
//   * Hours 00-23, minutes 00-59, seconds 00-59. Leap second "60" is
//     rejected (skipped) as invalid — documented rule.
//   * Offsets are [+-]HHMM with hours 00-23 and a real-world magnitude cap
//     (±14:00) — anything else is invalid.
//   * The source timezone used to interpret timestamps is a DATA property
//     of the guide; the viewer's local display timezone never feeds this
//     module (display stays in the client's existing pure helpers).
//
// Pure/testable: no live system time, no ambient locale, no I/O. All
// timezone math uses Intl.DateTimeFormat with an explicitly-passed IANA
// timezone (Node ships full ICU; a bogus timezone name throws and is
// validated at the config boundary).
// ============================================================================

/** A typed per-record timestamp failure (the record is skipped, never guessed). */
export type XmltvTimestampErrorReason =
        | 'invalid_format'
        | 'invalid_date'
        | 'invalid_time'
        | 'invalid_offset'
        | 'missing_timezone'
        | 'unknown_timezone';

export class XmltvTimestampError extends Error {
        readonly reason: XmltvTimestampErrorReason;
        constructor(reason: XmltvTimestampErrorReason, message: string) {
                super(message);
                this.name = 'XmltvTimestampError';
                this.reason = reason;
        }
}

const TIMESTAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?(?:\/[0-9]+)?\s*$/;

/** Maximum real-world offset magnitude (±14:00 — Kiribati/Line Islands). */
const MAX_OFFSET_MINUTES = 14 * 60;

function daysInMonth(year: number, month: number): number {
        // month is 1-based; day 0 of the next month = last day of this month.
        return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Validates calendar components WITHOUT rollover normalization. Only real
 * calendar dates pass (2024-02-31 fails; 2024-02-29 passes in leap years).
 */
function validateCalendar(year: number, month: number, day: number): boolean {
        if (year < 1 || year > 9999) return false;
        if (month < 1 || month > 12) return false;
        if (day < 1 || day > daysInMonth(year, month)) return false;
        return true;
}

function tzOffsetAtInstant(tz: string, instantMs: number): number {
        const dtf = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                hour12: false,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
        });
        const parts = dtf.formatToParts(new Date(instantMs));
        const get = (type: string): number => {
                const part = parts.find((p) => p.type === type);
                return part ? Number(part.value) : 0;
        };
        const year = get('year');
        const month = get('month');
        const day = get('day');
        let hour = get('hour');
        if (hour === 24) hour = 0; // some ICU versions emit "24" at midnight
        const minute = get('minute');
        const second = get('second');
        const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
        return Math.round((asUtc - instantMs) / 60_000);
}

/**
 * All offsets (minutes EAST of UTC) the timezone can claim for the given
 * WALL-CLOCK time — an offset counts only when interpreting the wall time
 * with it reproduces the same wall clock in `tz` (a real, existing local
 * time). Usually exactly one; two around a fall-back transition.
 */
function candidateOffsets(tz: string, year: number, month: number, day: number, hour: number, minute: number, second: number): number[] {
        const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
        const candidates = new Set<number>();
        for (const probe of [asUtc - 12 * 3600_000, asUtc, asUtc + 12 * 3600_000]) {
                const offset = tzOffsetAtInstant(tz, probe);
                const instant = asUtc - offset * 60_000;
                if (tzOffsetAtInstant(tz, instant) === offset) candidates.add(offset);
        }
        // Descending: the more-east (smaller-UTC) offset sorts first — the
        // EARLIER UTC instant. The ambiguity rule consumes this order.
        return [...candidates].sort((a, b) => b - a);
}

/**
 * Validates an IANA timezone name for the CONFIG boundary (EPG source
 * config). Throws when the runtime cannot interpret the name — the caller
 * converts this into a typed config validation failure.
 */
export function assertValidIanaTimezone(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.length > 64) throw new Error('Timezone must be 1-64 characters.');
        try {
                new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
        } catch {
                throw new Error(`Timezone "${trimmed.slice(0, 64)}" is not a valid IANA timezone.`);
        }
        return trimmed;
}

export type ParsedXmltvInstant = {
        /** Absolute UTC instant (epoch milliseconds). */
        epochMs: number;
        /** How the instant was derived (diagnostics/provenance only). */
        resolvedWith: 'explicit_offset' | 'default_timezone';
};

/**
 * Parses ONE XMLTV timestamp attribute into an absolute UTC instant.
 * Throws `XmltvTimestampError` with a typed reason — the caller decides
 * per-record skipping (a bad timestamp never fails the whole document).
 *
 * @param raw             the attribute value verbatim (e.g. "20240115083000 +0530" or "20240115083000/2")
 * @param defaultTimezone the configured IANA timezone for timezone-less values (null = reject them)
 */
export function parseXmltvTimestamp(raw: string, defaultTimezone: string | null): ParsedXmltvInstant {
        if (typeof raw !== 'string') throw new XmltvTimestampError('invalid_format', 'Timestamp is not a string.');
        const match = TIMESTAMP_PATTERN.exec(raw.trim());
        if (!match) throw new XmltvTimestampError('invalid_format', 'Timestamp does not match the XMLTV YYYYMMDDHHMMSS[±HHMM][/N] pattern.');

        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = Number(match[6]);
        const offsetSign = match[7];
        const offsetHours = match[8] !== undefined ? Number(match[8]) : null;
        const offsetMinutes = match[9] !== undefined ? Number(match[9]) : null;

        if (!validateCalendar(year, month, day)) throw new XmltvTimestampError('invalid_date', 'Timestamp calendar date does not exist.');
        if (hour > 23 || minute > 59 || second > 59) throw new XmltvTimestampError('invalid_time', 'Timestamp time component is out of range (leap seconds are not representable).');

        const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);

        if (offsetSign && offsetHours !== null && offsetMinutes !== null) {
                if (offsetHours > 23 || offsetMinutes > 59) throw new XmltvTimestampError('invalid_offset', 'Timestamp UTC offset component is out of range.');
                const magnitudeMinutes = offsetHours * 60 + offsetMinutes;
                if (magnitudeMinutes > MAX_OFFSET_MINUTES) throw new XmltvTimestampError('invalid_offset', 'Timestamp UTC offset exceeds the real-world maximum.');
                const offsetMinutesEast = (offsetSign === '+' ? 1 : -1) * magnitudeMinutes;
                return { epochMs: wallUtcMs - offsetMinutesEast * 60_000, resolvedWith: 'explicit_offset' };
        }

        if (!defaultTimezone) {
                throw new XmltvTimestampError('missing_timezone', 'Timestamp carries no UTC offset and the guide source has no configured default timezone.');
        }

        // Timezone-less → interpret in the CONFIGURED IANA timezone.
        let offsets: number[];
        try {
                offsets = candidateOffsets(defaultTimezone, year, month, day, hour, minute, second);
        } catch {
                throw new XmltvTimestampError('unknown_timezone', 'The configured default timezone could not be interpreted.');
        }
        if (offsets.length === 0) {
                // Nonexistent wall time (spring-forward gap): the documented
                // PRE-transition rule — use the offset in effect shortly before
                // the transition so the instant lands at/after the gap start.
                const preTransition = tzOffsetAtInstant(defaultTimezone, Date.UTC(year, month - 1, day, hour, minute, second) - 3 * 3600_000);
                return { epochMs: wallUtcMs - preTransition * 60_000, resolvedWith: 'default_timezone' };
        }
        // Ambiguous (fall-back): candidates sort more-east first — the FIRST
        // candidate is the EARLIER UTC instant (DST side). Documented rule:
        // the first occurrence wins.
        return { epochMs: wallUtcMs - offsets[0]! * 60_000, resolvedWith: 'default_timezone' };
}

/**
 * Formats an instant as the XMLTV timestamp shape (tests + fixtures only —
 * ingestion never synthesizes timestamps from thin air; this exists so the
 * suites can build deterministic window strings).
 */
export function formatXmltvTimestamp(epochMs: number, offsetMinutes = 0): string {
        const shifted = new Date(epochMs + offsetMinutes * 60_000);
        const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
        const sign = offsetMinutes < 0 ? '-' : '+';
        const magnitude = Math.abs(offsetMinutes);
        const offset = `${sign}${pad(Math.floor(magnitude / 60))}${pad(magnitude % 60)}`;
        return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())} ${offset}`;
}
