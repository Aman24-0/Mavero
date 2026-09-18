/**
 * MAVERO media worker — canonical IP classification (Phase 1, audit MW-2).
 *
 * The worker's previous literal checks missed:
 *   * WHATWG numeric IPv4 forms — decimal `2130706433`, hex `0x7f000001`,
 *     abbreviated `127.1` (all loopback);
 *   * hex-tail IPv4-mapped IPv6 — `::ffff:7f00:1` (loopback, previously
 *     NOT blocked — the audit's end-to-end bypass chain);
 *   * NAT64-embedded IPv4 — `64:ff9b::/96`.
 *
 * These functions implement the SAME canonical parsing/classification
 * approach as the app-side hardened guard
 * (`src/lib/server/streaming/stremio/ssrf.ts` — parseIpv4Literal /
 * expandIpv6 / isBlockedIpv4 / isBlockedIpv6). The worker is a separately
 * deployed package and therefore carries its own copy of the algorithm;
 * a parity test in the main test suite (scripts/phase1_media_worker_hardening_test.ts)
 * executes BOTH implementations against the same adversarial vectors to
 * guarantee the two stacks never drift.
 *
 * Fail-closed: an address whose shape cannot be parsed is BLOCKED.
 */

/** Parses a hostname as an IPv4 address, including WHATWG-style compact
 *  representations (`127.1`, `0x7f000001`, `0177.0.0.1`, `2130706433`).
 *  Returns the 32-bit value, or null when the hostname is not an IPv4
 *  literal. */
export function parseIpv4Literal(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  if (parts[parts.length - 1] === '') return null;
  let value = 0;
  const last = parts.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const part = parts[index];
    if (part === undefined) return null;
    let parsed: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      parsed = parseInt(part.slice(2), 16);
    } else if (part.length > 1 && part.startsWith('0')) {
      if (!/^[0-7]+$/.test(part.slice(1))) return null;
      parsed = parseInt(part.slice(1), 8);
    } else if (/^[0-9]+$/.test(part)) {
      parsed = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    if (index < last) {
      if (parsed > 255) return null;
      value = value * 256 + parsed;
    } else {
      const lastMax = 2 ** (8 * (4 - last)) - 1;
      if (parsed > lastMax) return null;
      value = value * 256 ** (4 - last) + parsed;
    }
  }
  return value >>> 0;
}

/** Strict dotted-quad parser (used for IPv6 dotted tails like `::ffff:1.2.3.4`). */
function parseDottedQuadIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return null;
    const parsed = parseInt(part, 10);
    if (parsed > 255) return null;
    value = value * 256 + parsed;
  }
  return value >>> 0;
}

/** Expands an IPv6 address into its 8 hextets, accepting IPv4-mapped and
 *  NAT64 dotted tails (`::ffff:1.2.3.4`). Returns null for malformed input. */
export function expandIpv6(address: string): number[] | null {
  let addr = address.toLowerCase();
  let dottedTail: number[] | null = null;
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) return null;
    const tailValue = parseDottedQuadIpv4(addr.slice(lastColon + 1));
    if (tailValue === null) return null;
    dottedTail = [(tailValue >>> 16) & 0xffff, tailValue & 0xffff];
    addr = addr.slice(0, lastColon + 1);
    if (addr.endsWith(':') && !addr.endsWith('::')) addr = addr.slice(0, -1);
  }

  const doubleColonCount = (addr.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  if (addr.includes('::')) {
    const [before, after] = addr.split('::');
    head = before ? before.split(':') : [];
    tail = after ? after.split(':') : [];
  } else {
    head = addr.split(':');
    tail = [];
  }

  const missing = 8 - head.length - tail.length - (dottedTail ? 2 : 0);
  if (missing < 0) return null;
  if (!addr.includes('::') && missing !== 0) return null;

  const hextetStrings = [...head, ...Array<string>(missing).fill('0'), ...tail];
  const hextets: number[] = [];
  for (const piece of hextetStrings) {
    if (piece === undefined || !/^[0-9a-f]{1,4}$/.test(piece)) return null;
    hextets.push(parseInt(piece, 16));
  }
  if (dottedTail) {
    const [tailHigh, tailLow] = dottedTail;
    if (tailHigh === undefined || tailLow === undefined) return null;
    hextets.push(tailHigh, tailLow);
  }
  return hextets.length === 8 ? hextets : null;
}

/** RFC1918, loopback, link-local (incl. cloud metadata), CGNAT, multicast, reserved, unspecified. */
export function isBlockedIpv4(value: number): boolean {
  const octets = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  if (octets[0] === 0) return true; // 0.0.0.0/8 "this network" (incl. 0.0.0.0)
  if (octets[0] === 10) return true; // RFC1918 private
  if (octets[0] === 127) return true; // loopback
  if (octets[0] === 169 && octets[1] === 254) return true; // link-local + 169.254.169.254 metadata
  if (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) return true; // RFC1918 private
  if (octets[0] === 192 && octets[1] === 168) return true; // RFC1918 private
  if (octets[0] === 100 && octets[1] !== undefined && octets[1] >= 64 && octets[1] <= 127) return true; // CGNAT 100.64/10
  if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return true; // benchmark 198.18/15
  if (octets[0] !== undefined && octets[0] >= 224) return true; // multicast 224/4 + reserved 240/4 + 255.255.255.255
  return false;
}

/**
 * IPv6 blocked ranges: unspecified, loopback, IPv4-mapped/compatible and
 * NAT64-embedded IPv4 (validated through the IPv4 rules), ULA fc00::/7,
 * link-local fe80::/10, multicast ff00::/8, documentation 2001:db8::/32.
 */
export function isBlockedIpv6(hextets: number[]): boolean {
  const allZero = hextets.every((h) => h === 0);
  if (allZero) return true; // :: unspecified
  if (hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0 && hextets[6] === 0 && hextets[7] === 1) {
    return true; // ::1 loopback
  }
  const embeddedV4 =
    (hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0) &&
    (hextets[5] === 0xffff || hextets[5] === 0); // ::ffff:0:0/96 mapped or ::/96 compatible
  if (embeddedV4 && hextets[6] !== undefined && hextets[7] !== undefined) {
    return isBlockedIpv4(((hextets[6] << 16) >>> 0) + hextets[7]);
  }
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) {
    if (hextets[6] === undefined || hextets[7] === undefined) return true;
    return isBlockedIpv4(((hextets[6] << 16) >>> 0) + hextets[7]); // NAT64 64:ff9b::/96
  }
  if (hextets[0] === undefined) return true;
  if ((hextets[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((hextets[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((hextets[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return true; // documentation 2001:db8::/32
  return false;
}

/** Validates an already-resolved address (DNS answer or literal). Fails closed. */
export function isBlockedIpAddress(address: string): boolean {
  const trimmed = address.toLowerCase();
  if (trimmed.includes(':')) {
    const hextets = expandIpv6(trimmed.replace(/%.*$/, ''));
    return hextets === null ? true : isBlockedIpv6(hextets);
  }
  const value = parseIpv4Literal(trimmed);
  return value === null ? true : isBlockedIpv4(value);
}
