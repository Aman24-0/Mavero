// ============================================================
// UPCOMING — v2 pagination cursor (transport metadata ONLY).
//
// THE INVARIANT: the cursor NEVER carries UpcomingItem payloads.
// The previous architecture serialized full `UpcomingItem[]` pending
// events into the URL, which made the cursor grow with every enriched
// overflow event and broke pagination for series/anime/all (oversized
// requests). The v2 cursor is a compact continuation token:
//
//   { v: 2, fp: "<filter fingerprint>", sn: "<stream id>",
//     m: <movie candidate position>, x: <snapshot offset> }
//
//   - v   cursor schema version (2) — old cursors are rejected,
//         never silently converted into a fresh page-1 request.
//   - fp  filter fingerprint (month/year/type/language/region +
//         policy/query version constants). A cursor can never be
//         reused for different filters.
//   - sn  stream identity (content hash of the materialized result
//         the position refers to). Detects re-materialized/changed
//         upstream data so an offset can never slice a different
//         stream silently.
//   - m   movie-mode position: number of candidates fully consumed
//         from the deterministic chronological movie stream.
//   - x   snapshot-mode position: number of items already returned
//         from the materialized series/anime/all snapshot.
//
// The position state lives on the SERVER (existing source-level
// caches materialize the full normalized results); the browser only
// ever carries this token back. Serialized size stays in the ~60-90
// character range no matter how many hundreds of events exist.
// ============================================================

// Cursor schema version. Bumping rejects every pre-existing cursor.
export const UPCOMING_CURSOR_VERSION = 2;

export type UpcomingCursorV2 = {
  version: 2;
  fingerprint: string;
  streamId: string;
  movieCandidateIndex: number;
  snapshotOffset: number;
};

export type UpcomingCursorErrorReason =
  | 'malformed'
  | 'version'
  | 'shape'
  | 'filter-mismatch'
  | 'stale';

// A cursor problem is NEVER silently absorbed: the API maps these to
// structured error responses (400 INVALID_CURSOR / 409 CURSOR_STALE /
// 409 CURSOR_FILTER_MISMATCH) and the frontend restarts through the
// explicit deterministic mechanism — no silent restart from zero, no
// silently duplicated data.
export class UpcomingCursorError extends Error {
  readonly reason: UpcomingCursorErrorReason;

  constructor(reason: UpcomingCursorErrorReason, message: string) {
    super(message);
    this.name = 'UpcomingCursorError';
    this.reason = reason;
  }
}

// cyrb53 — fast 53-bit string hash. Deterministic across processes and
// restarts (pure string hashing, no crypto randomness), so a cursor
// created by one server instance validates on another.
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const toToken = (n: number): string => n.toString(36);

// Compact wire shape (short keys keep the URL payload minimal).
type WireCursor = {
  v: number;
  fp: string;
  sn: string;
  m: number;
  x: number;
};

const TOKEN_RE = /^[a-z0-9]{1,32}$/;

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1e9;
}

export type ParsedUpcomingCursor =
  | { ok: true; cursor: UpcomingCursorV2 }
  | { ok: false; reason: UpcomingCursorErrorReason };

/**
 * Strictly parse a serialized cursor. Returns a structured failure for
 * EVERY problem (unparseable JSON, wrong version, wrong shape, bad
 * numbers) — callers must never fall back to a fresh page-1 cursor.
 * An absent cursor (null / undefined / empty string) is page 1.
 */
export function parseUpcomingCursor(raw: string | null | undefined): ParsedUpcomingCursor {
  if (raw === null || raw === undefined || raw === '') {
    return {
      ok: true,
      cursor: { version: 2, fingerprint: '', streamId: '', movieCandidateIndex: 0, snapshotOffset: 0 }
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(raw));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { ok: false, reason: 'malformed' };
  }
  const wire = decoded as Partial<WireCursor>;
  if (wire.v !== UPCOMING_CURSOR_VERSION) {
    // Unknown/legacy cursor versions are rejected explicitly (the
    // frontend restarts deterministically) — never silently reset.
    return { ok: false, reason: 'version' };
  }
  if (typeof wire.fp !== 'string' || !TOKEN_RE.test(wire.fp)) return { ok: false, reason: 'shape' };
  if (typeof wire.sn !== 'string' || !TOKEN_RE.test(wire.sn)) return { ok: false, reason: 'shape' };
  if (!isNonNegativeInt(wire.m) || !isNonNegativeInt(wire.x)) return { ok: false, reason: 'shape' };
  return {
    ok: true,
    cursor: {
      version: 2,
      fingerprint: wire.fp,
      streamId: wire.sn,
      movieCandidateIndex: wire.m,
      snapshotOffset: wire.x
    }
  };
}

/**
 * Serialize a cursor to its compact URL-safe form.
 */
export function serializeUpcomingCursor(cursor: UpcomingCursorV2): string {
  const wire: WireCursor = {
    v: cursor.version,
    fp: cursor.fingerprint,
    sn: cursor.streamId,
    m: cursor.movieCandidateIndex,
    x: cursor.snapshotOffset
  };
  return encodeURIComponent(JSON.stringify(wire));
}

/**
 * Filter fingerprint: binds a cursor to EXACTLY one
 * month/year/type/language/region/policy-version combination. The
 * policy/query version constants ride inside the fingerprint so a
 * policy bump invalidates outstanding cursors instead of serving
 * stale-era pages.
 */
export function computeUpcomingFilterFingerprint(
  filters: { month: number; year: number; type: string; language: string },
  region: string,
  policyKeys: string[]
): string {
  const identity = JSON.stringify([UPCOMING_CURSOR_VERSION, filters.month, filters.year, filters.type, filters.language, region, [...policyKeys].sort().join('|')]);
  return toToken(cyrb53(identity));
}

/**
 * Stream identity: content hash of a materialized item stream (length +
 * stride-sampled event IDs + last ID). Two materializations of the SAME
 * upstream data hash identically (harmless), while any real content
 * change re-keys the stream so a stale offset can never slice silently
 * into a different result set.
 */
export function computeStreamId(length: number, sampledIds: string[]): string {
  return toToken(cyrb53(`${length}|${sampledIds.join('|')}`));
}

/**
 * Sample event IDs from a stream for the identity hash: stride-sampled
 * entries plus the final entry — small, deterministic, and sensitive to
 * insertion/removal anywhere in the stream.
 */
export function sampleStreamIds(ids: string[], sampleCount = 12): string[] {
  const stride = Math.max(1, Math.floor(ids.length / Math.max(1, sampleCount)));
  const sampled: string[] = [];
  for (let i = 0; i < ids.length; i += stride) sampled.push(ids[i]);
  if (ids.length > 0) sampled.push(ids[ids.length - 1]);
  return sampled;
}
