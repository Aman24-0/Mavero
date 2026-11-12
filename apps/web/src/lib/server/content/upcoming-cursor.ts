// ============================================================
// UPCOMING — v3 pagination cursor (transport metadata ONLY).
//
// THE INVARIANT: the cursor NEVER carries UpcomingItem payloads.
// The previous architecture serialized full `UpcomingItem[]` pending
// events into the URL, which made the cursor grow with every enriched
// overflow event and broke pagination for series/anime/all (oversized
// requests). The v2 cursor replaced that with a compact continuation
// token. The v3 cursor (F7-B) carries the SAME compact shape but is
// keyed on the new startDate/30-day-window identity instead of the
// legacy month/year identity. A v2 cursor is REJECTED by the v3
// parser (`reason: 'version'`) so an old cursor can never be
// silently re-interpreted against the new fingerprint semantics.
//
//   { v: 3, fp: "<filter fingerprint>", sn: "<stream id>",
//     m: <movie candidate position>, x: <snapshot offset> }
//
//   - v   cursor schema version (3) — old cursors (v1, v2) are
//         rejected, never silently converted into a fresh page-1
//         request.
//   - fp  filter fingerprint (startDate/type/language/region +
//         policy/query version constants). A cursor can never be
//         reused for different filters (different startDate, type,
//         language, region or policy version).
//   - sn  stream identity (a FULL deterministic digest of the
//         pagination-relevant stream the position refers to — every
//         event contributes its ID plus its timestamp/date, in stream
//         order). Detects re-materialized/changed upstream data so an
//         offset can never slice a different stream silently.
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
// F7-B: bumped 2 -> 3 to invalidate every v2 cursor whose fingerprint
// was keyed on month/year (a v2 cursor would otherwise silently
// validate against a v3 startDate fingerprint that never matches).
export const UPCOMING_CURSOR_VERSION = 3;

export type UpcomingCursorV3 = {
  version: 3;
  fingerprint: string;
  streamId: string;
  movieCandidateIndex: number;
  snapshotOffset: number;
};

// Back-compat alias for callers/tests that still reference the v2 type
// name. The runtime shape is identical; only the version constant and
// the fingerprint semantics differ.
export type UpcomingCursorV2 = UpcomingCursorV3;

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
      cursor: { version: 3, fingerprint: '', streamId: '', movieCandidateIndex: 0, snapshotOffset: 0 }
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
    // Unknown/legacy cursor versions (v1, v2) are rejected explicitly
    // (the frontend restarts deterministically) — never silently reset.
    return { ok: false, reason: 'version' };
  }
  if (typeof wire.fp !== 'string' || !TOKEN_RE.test(wire.fp)) return { ok: false, reason: 'shape' };
  if (typeof wire.sn !== 'string' || !TOKEN_RE.test(wire.sn)) return { ok: false, reason: 'shape' };
  if (!isNonNegativeInt(wire.m) || !isNonNegativeInt(wire.x)) return { ok: false, reason: 'shape' };
  return {
    ok: true,
    cursor: {
      version: 3,
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
 * startDate/type/language/region/policy-version combination. The
 * policy/query version constants ride inside the fingerprint so a
 * policy bump invalidates outstanding cursors instead of serving
 * stale-era pages. F7-B: the legacy month/year dimensions are GONE;
 * startDate (YYYY-MM-DD) is the sole date identity. A cursor issued
 * for startDate=2026-09-27 MUST be rejected when re-presented with
 * startDate=2026-09-28 (different identity → different fingerprint).
 */
export function computeUpcomingFilterFingerprint(
  filters: { startDate: string; type: string; language: string },
  region: string,
  policyKeys: string[]
): string {
  const identity = JSON.stringify([UPCOMING_CURSOR_VERSION, filters.startDate, filters.type, filters.language, region, [...policyKeys].sort().join('|')]);
  return toToken(cyrb53(identity));
}

/**
 * Stream identity: a FULL deterministic digest of the pagination-
 * relevant stream. The caller feeds ONE compact identity entry per
 * event, IN STREAM ORDER — for normalized Upcoming items `id@timestamp`
 * (the event's chronological sort key), for movie candidates
 * `movie-id@release_date` (the candidate's sort key). NOTHING is
 * sampled: every event participates, so insertion, deletion,
 * replacement, ID changes, timestamp/date changes, and reordering
 * ANYWHERE in the stream (first, middle, or final entry) all change the
 * digest and invalidate outstanding cursors. cyrb53 remains sufficient
 * precisely because the COMPLETE identity is fed in — no cryptographic
 * hash is needed for a cache-validation token, and the result stays one
 * compact base-36 token regardless of stream size (a 10,000-event
 * stream hashes to the same ~11-character token as a 3-event one).
 *
 * Determinism: pure string hashing with no randomness and no clock, so
 * the same stream hashes identically across calls, restarts, and server
 * instances, and the empty stream hashes to a stable constant (a clean
 * end never falsely reports stale).
 */
export function computeStreamId(entries: string[]): string {
  // The length prefix keeps even degenerate inputs (empty stream) keyed
  // by size; entries are ordered, so ordering changes re-key the hash.
  return toToken(cyrb53(`${entries.length}|${entries.join('|')}`));
}
