/**
 * Local-timezone date/time formatting (display boundary).
 *
 * Everything uses `Intl.DateTimeFormat(undefined, …)` — the DEVICE's timezone
 * and locale — so a user in India sees IST, one in the UK sees GMT, etc. The
 * app stores and serves UTC ISO strings; these helpers are for DISPLAY only and
 * never touch stored values.
 */

const DEFAULT_DATETIME: Intl.DateTimeFormatOptions = {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit'
};

function toDate(value: string | number | Date | null | undefined): Date | null {
	if (value === null || value === undefined || value === '') return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Full local date+time, e.g. "25/10/2026, 11:21 am". */
export function formatLocalDateTime(
	value: string | number | Date | null | undefined,
	options: Intl.DateTimeFormatOptions = DEFAULT_DATETIME
): string {
	const date = toDate(value);
	return date ? new Intl.DateTimeFormat(undefined, options).format(date) : '—';
}

/** Local date only. */
export function formatLocalDate(
	value: string | number | Date | null | undefined,
	options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' }
): string {
	return formatLocalDateTime(value, options);
}

/** Local time only. */
export function formatLocalTime(
	value: string | number | Date | null | undefined,
	options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
): string {
	return formatLocalDateTime(value, options);
}

/** Local date+time WITH the timezone abbreviation, e.g. "25/10/2026, 11:21 am IST". */
export function formatLocalDateTimeWithZone(
	value: string | number | Date | null | undefined,
	options: Intl.DateTimeFormatOptions = DEFAULT_DATETIME
): string {
	return formatLocalDateTime(value, { ...options, timeZoneName: 'short' });
}
