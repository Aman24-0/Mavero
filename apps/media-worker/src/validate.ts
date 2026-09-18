/**
 * MAVERO media worker — input URL validation (Phase 11, GOAL B5).
 *
 * The worker downloads media ONLY from URLs that arrive inside a VERIFIED
 * signed compatibility reference. That alone does not make a URL safe to
 * dial: the reference is minted by the MAVERO app, but the worker still
 * independently enforces the SAME playback boundary before any network I/O:
 *
 *   * https-only (plain http input is rejected — the app's boundary
 *     already excludes it, this is defense in depth);
 *   * no credentials in the URL;
 *   * no private / link-local / loopback / unique-local hosts (SSRF);
 *   * every DNS answer re-validated at JOB START (DNS-rebinding defense —
 *     the connect-guard equivalent for the worker's own fetches);
 *   * NO custom request headers are ever accepted or forwarded (the token
 *     format has no header field — structural, not policy).
 *
 * This is NOT a general-purpose fetcher: validate() runs exactly once per
 * job, for exactly the one URL the signature carries.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedIpAddress, isBlockedIpv4, isBlockedIpv6, expandIpv6, parseIpv4Literal } from './ip-guard.js';

export type UrlValidation = { ok: true; url: URL } | { ok: false; code: 'INVALID_URL' | 'BLOCKED_URL' };

/**
 * Phase 1 (audit MW-2): canonical literal-IP classification. The previous
 * hand-rolled checks missed the numeric IPv4 forms (decimal/hex/abbreviated
 * loopback) and the hex-tail IPv4-mapped IPv6 (`::ffff:7f00:1`); the logic
 * now delegates to the canonical `ip-guard.ts` (the same algorithm as the
 * app-side hardened guard — parity-tested) so every embedded/numeric form
 * is classified identically and ambiguous shapes fail closed.
 */
export function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const version = isIP(host);
  if (version === 4) {
    const value = parseIpv4Literal(host);
    return value === null ? true : isBlockedIpv4(value);
  }
  if (version === 6) {
    const normalized = host.replace(/%.*$/, '');
    const hextets = expandIpv6(normalized);
    return hextets === null ? true : isBlockedIpv6(hextets);
  }
  // Not a canonical literal per isIP. WHATWG numeric IPv4 forms that isIP
  // does not recognize (`2130706433`, `0x7f000001`, `127.1`) are decoded by
  // the canonical parser and classified through the same matrix; anything
  // that is NOT an address (a DNS name) is NOT classified here — the DNS
  // sweep (assertResolvablePublicHost) validates every resolved answer.
  const numeric = parseIpv4Literal(host);
  if (numeric !== null) return isBlockedIpv4(numeric);
  if (host.includes(':')) {
    const hextets = expandIpv6(host.replace(/%.*$/, ''));
    return hextets === null ? true : isBlockedIpv6(hextets);
  }
  return false;
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  return isPrivateIpLiteral(host);
}

/** Structural validation — no network I/O. */
export function validateJobUrl(raw: string): UrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: 'INVALID_URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, code: 'BLOCKED_URL' };
  if (parsed.username || parsed.password) return { ok: false, code: 'BLOCKED_URL' };
  if (isPrivateHostname(parsed.hostname)) return { ok: false, code: 'BLOCKED_URL' };
  return { ok: true, url: parsed };
}

/**
 * DNS-resolution validation at job start. EVERY resolved address must be
 * public — a name that resolves to ANY private address is rejected
 * (fail closed), closing the rebinding window between validation and the
 * ffmpeg dial (ffmpeg re-resolves; the sweep + egress isolation in the
 * deployment guide cover the residual risk, and the input URLs are
 * operator-minted references, not client input).
 */
export async function assertResolvablePublicHost(url: URL): Promise<UrlValidation> {
  if (isPrivateIpLiteral(url.hostname)) return { ok: false, code: 'BLOCKED_URL' };
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) return { ok: true, url };
  try {
    const answers = await lookup(url.hostname, { all: true, verbatim: true });
    if (!answers.length) return { ok: false, code: 'BLOCKED_URL' };
    for (const answer of answers) {
      if (isPrivateIpLiteral(answer.address)) return { ok: false, code: 'BLOCKED_URL' };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, code: 'BLOCKED_URL' };
  }
}
