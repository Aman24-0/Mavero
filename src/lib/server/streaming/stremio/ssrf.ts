import { isIP } from 'node:net';
import dnsPromises from 'node:dns/promises';
import { ManifestServiceError } from './errors';

/**
 * MAVERO Stremio manifest service — SSRF-safe destination guard (Phase 2).
 *
 * A dedicated, independently testable, SERVER-ONLY security utility. The
 * repository's existing `resolver/safe-url.ts` guard is https-only and
 * string-based (no DNS resolution, no numeric IP-literal forms, limited IPv6
 * coverage); the manifest fetcher needs broader coverage, so the Phase 2
 * spec authorizes this dedicated utility instead of scattering checks.
 *
 * Validation happens in two stages, and BOTH run for every request AND every
 * redirect hop (spec §5):
 *
 *   1. `assertSafeManifestUrl` — synchronous, no I/O:
 *        - absolute http(s) URL only, no credentials, no whitespace, <= 2048
 *        - hostname blocklist (localhost variants, internal/mDNS/metadata)
 *        - IP-literal rejection (IPv4 incl. hex/octal/decimal compact forms,
 *          IPv6 incl. IPv4-mapped and NAT64-embedded addresses)
 *   2. `assertSafeManifestDestination` — asynchronous:
 *        - DNS-resolves non-literal hostnames and validates EVERY returned
 *          address against the same blocked ranges (catches DNS names that
 *          resolve into private networks and cloud metadata endpoints).
 *
 * Known residual risk (documented in docs/addon-worklog.md): DNS rebinding
 * has a TOCTOU window between the pre-flight resolution and the actual
 * connect, because Node's global fetch cannot pin a validated IP. The
 * pre-flight check runs immediately before connect and the fetch carries no
 * credentials; full pinning would require a custom undici dispatcher
 * (future hardening).
 */

const MANIFEST_URL_MAX_LENGTH = 2048;

/** Hostnames that must never be fetched by the manifest service. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'broadcasthost',
  // Cloud metadata endpoints (AWS/GCP/Azure-style). GCP also publishes the
  // short `metadata.goog` name.
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
]);

/** Internal-use DNS suffixes that must never be fetched. */
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'] as const;

/**
 * Normalizes a URL hostname for safety checks: lowercases, strips one
 * trailing dot (`localhost.` is a legal spelling of `localhost`), and strips
 * IPv6 brackets. Mirrors the normalization in `resolver/safe-url.ts`.
 */
export function normalizeGuardedHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * Parses a hostname as an IPv4 address, including WHATWG-style compact
 * representations (`127.1`, `0x7f000001`, `0177.0.0.1`, `2130706433`).
 * Returns the 32-bit value, or null when the hostname is not an IPv4
 * literal. WHATWG's rules are mirrored: any part before the last must fit in
 * one octet; the last part fills the remaining octets; hex/octal forms are
 * recognized; a failed numeric parse means "not a literal" (a DNS name).
 */
export function parseIpv4Literal(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  if (parts[parts.length - 1] === '') return null;
  let value = 0;
  const last = parts.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const part = parts[index];
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

/**
 * Expands an IPv6 address into its 8 hextets, accepting IPv4-mapped and
 * NAT64 dotted tails (`::ffff:1.2.3.4`). Returns null for malformed input.
 */
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
    // The stripped address now ends with ':' (e.g. '::ffff:') — drop that
    // single trailing colon so the '::' split below behaves normally.
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
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    hextets.push(parseInt(piece, 16));
  }
  if (dottedTail) hextets.push(dottedTail[0], dottedTail[1]);
  return hextets.length === 8 ? hextets : null;
}

/** RFC1918, loopback, link-local (incl. cloud metadata), CGNAT, multicast, reserved, unspecified. */
export function isBlockedIpv4(value: number): boolean {
  const octets = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  if (octets[0] === 0) return true; // 0.0.0.0/8 "this network" (incl. 0.0.0.0)
  if (octets[0] === 10) return true; // RFC1918 private
  if (octets[0] === 127) return true; // loopback
  if (octets[0] === 169 && octets[1] === 254) return true; // link-local + 169.254.169.254 metadata
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true; // RFC1918 private
  if (octets[0] === 192 && octets[1] === 168) return true; // RFC1918 private
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true; // CGNAT 100.64/10
  if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return true; // benchmark 198.18/15
  if (octets[0] >= 224) return true; // multicast 224/4 + reserved 240/4 + 255.255.255.255
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
  if (embeddedV4) {
    return isBlockedIpv4(((hextets[6] << 16) >>> 0) + hextets[7]);
  }
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) {
    return isBlockedIpv4(((hextets[6] << 16) >>> 0) + hextets[7]); // NAT64 64:ff9b::/96
  }
  if ((hextets[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((hextets[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((hextets[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return true; // documentation 2001:db8::/32
  return false;
}

/** Validates an already-resolved address (DNS answer or literal). Fails closed. */
export function isBlockedIpAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const value = parseIpv4Literal(address);
    return value === null ? true : isBlockedIpv4(value);
  }
  if (kind === 6) {
    const hextets = expandIpv6(address.toLowerCase());
    return hextets === null ? true : isBlockedIpv6(hextets);
  }
  return true; // unknown address shape → fail closed
}

function isBlockedManifestHostname(normalizedHost: string): boolean {
  if (BLOCKED_HOSTNAMES.has(normalizedHost)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalizedHost.endsWith(suffix));
}

/**
 * Synchronous, I/O-free destination validation. Returns the parsed URL on
 * success. Throws `INVALID_URL` for malformed input and `BLOCKED_URL` for
 * structurally-valid input that points at a forbidden destination.
 */
export function assertSafeManifestUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new ManifestServiceError('INVALID_URL', { message: 'The addon manifest URL is required.' });
  if (trimmed.length > MANIFEST_URL_MAX_LENGTH) throw new ManifestServiceError('INVALID_URL', { message: `The addon manifest URL must be ${MANIFEST_URL_MAX_LENGTH} characters or fewer.` });
  if (/\s/.test(trimmed)) throw new ManifestServiceError('INVALID_URL', { message: 'The addon manifest URL must not contain whitespace or newlines.' });
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ManifestServiceError('INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ManifestServiceError('INVALID_URL', { message: 'The addon manifest URL must use http or https.' });
  if (url.username || url.password) throw new ManifestServiceError('INVALID_URL', { message: 'The addon manifest URL must not contain credentials.' });
  const host = normalizeGuardedHostname(url.hostname);
  if (!host) throw new ManifestServiceError('INVALID_URL', { message: 'The addon manifest URL must include a hostname.' });

  if (host.includes(':')) {
    // IPv6 literal — WHATWG already validated the shape inside brackets.
    const hextets = expandIpv6(host);
    if (hextets === null) throw new ManifestServiceError('INVALID_URL');
    if (isBlockedIpv6(hextets)) throw new ManifestServiceError('BLOCKED_URL');
  } else {
    // IPv4 literal (any WHATWG numeric form) or a DNS name.
    const ipv4 = parseIpv4Literal(host);
    if (ipv4 !== null) {
      if (isBlockedIpv4(ipv4)) throw new ManifestServiceError('BLOCKED_URL');
    } else if (isBlockedManifestHostname(host)) {
      throw new ManifestServiceError('BLOCKED_URL');
    }
  }
  return url;
}

/** Injectable DNS resolver so tests never hit the real network. */
export type SafeDnsResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export const systemDnsResolver: SafeDnsResolver = (hostname) => dnsPromises.lookup(hostname, { all: true, verbatim: true });

function isIpLiteralHost(normalizedHost: string): boolean {
  if (normalizedHost.includes(':')) return true;
  return isIP(normalizedHost) === 4 || parseIpv4Literal(normalizedHost) !== null;
}

/**
 * Asynchronous stage: for DNS names, resolves the host and validates EVERY
 * returned address (spec §3 — "DNS names resolving to private IPs"). IP
 * literals were already validated synchronously and skip resolution. Runs
 * before every request and after every redirect.
 */
export async function assertSafeManifestDestination(url: URL, resolver: SafeDnsResolver = systemDnsResolver): Promise<void> {
  const host = normalizeGuardedHostname(url.hostname);
  if (isIpLiteralHost(host)) return;
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  try {
    addresses = await resolver(host);
  } catch {
    throw new ManifestServiceError('NETWORK', { message: 'The manifest host could not be resolved.' });
  }
  if (!addresses.length) throw new ManifestServiceError('NETWORK', { message: 'The manifest host could not be resolved.' });
  for (const entry of addresses) {
    if (isBlockedIpAddress(entry.address)) {
      throw new ManifestServiceError('BLOCKED_URL', { message: 'The manifest host resolves to a network location that is not allowed.' });
    }
  }
}
