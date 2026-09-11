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

export type UrlValidation = { ok: true; url: URL } | { ok: false; code: 'INVALID_URL' | 'BLOCKED_URL' };

export function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const version = isIP(host);
  if (version === 4) {
    if (/^127(?:\.[0-9]{1,3}){3}$/.test(host)) return true;
    if (/^10(?:\.[0-9]{1,3}){3}$/.test(host)) return true;
    if (/^192\.168(?:\.[0-9]{1,3}){2}$/.test(host)) return true;
    const private172 = host.match(/^172\.(\d{1,3})(?:\.[0-9]{1,3}){2}$/);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
    if (/^169\.254(?:\.[0-9]{1,3}){2}$/.test(host)) return true;
    if (/^0(?:\.[0-9]{1,3}){3}$/.test(host)) return true;
    if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.[0-9]{1,3}){2}$/.test(host)) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    const normalized = host.replace(/%.*$/, '');
    if (normalized === '::1' || normalized === '::') return true;
    if (/^f[cd]/.test(normalized)) return true; // unique-local fc00::/7
    if (/^fe[89ab]/.test(normalized)) return true; // link-local fe80::/10
    if (normalized.startsWith('::ffff:')) {
      const v4 = normalized.slice(7);
      return isIP(v4) === 4 ? isPrivateIpLiteral(v4) : false;
    }
    return false;
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
