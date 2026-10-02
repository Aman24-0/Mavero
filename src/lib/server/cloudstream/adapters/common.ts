/**
 * MAVERO CloudStream adapter shared utilities (CS-2).
 *
 * Common helpers for the three provider ports (Bollyflix / MoviesDrive /
 * VegaMovies): search-result matching by normalized title + year, the
 * sidexfee `?id=` bypass port (Bollyflix), and Kotlin-parity helpers.
 * All network access goes through the runtime context — never raw fetch.
 */

import type { CloudStreamRuntimeContext } from '../types/runtime';
import { fetchCloudStreamRedirect } from '../security/http';

// ---------------------------------------------------------------------------
// Title matching
// ---------------------------------------------------------------------------

/** Normalizes a title for fuzzy matching: lowercase, alphanumeric only. */
export function normalizeTitleForMatch(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/download\s*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Extracts a 4-digit year from free text. */
export function extractYear(text: string): number | undefined {
  const match = /\b(19\d{2}|20\d{2})\b/.exec(text ?? '');
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

export type CandidateMatch = {
  href: string;
  title: string;
  year?: number;
  score: number;
};

/**
 * Ranks search candidates against the requested title/year (best first).
 * Scoring (deterministic):
 *   * +100 exact normalized-title equality,
 *   * +60 requested title is a prefix of the candidate title,
 *   * +30 candidate title contains the requested title,
 *   * +25 year matches (when both known), −40 year mismatch,
 *   * +0..10 token-overlap ratio tiebreaker.
 * Candidates scoring ≤ 0 are dropped (honest no-match over false matches).
 */
export function rankCandidates(
  requested: { title: string; year?: number },
  candidates: Array<{ title: string; href: string }>,
  maxResults = 20,
): CandidateMatch[] {
  const needle = normalizeTitleForMatch(requested.title);
  if (!needle) return [];
  const needleTokens = new Set(needle.split(' ').filter(Boolean));

  const scored: CandidateMatch[] = [];
  // Bounded fan-out: only the first maxResults candidates are considered.
  for (const candidate of candidates.slice(0, maxResults)) {
    const haystackRaw = candidate.title ?? '';
    const haystack = normalizeTitleForMatch(haystackRaw);
    if (!haystack || !candidate.href) continue;

    let score = 0;
    if (haystack === needle) score += 100;
    else if (haystack.startsWith(`${needle} `)) score += 60;
    else if (haystack.includes(needle)) score += 30;
    else {
      // Token overlap: every needle token present in the candidate.
      const haystackTokens = new Set(haystack.split(' ').filter(Boolean));
      let hits = 0;
      for (const token of needleTokens) if (haystackTokens.has(token)) hits += 1;
      const ratio = needleTokens.size > 0 ? hits / needleTokens.size : 0;
      if (ratio < 0.5) continue; // not a plausible match
      score += Math.round(ratio * 10);
    }

    const candidateYear = extractYear(haystackRaw);
    if (requested.year !== undefined && candidateYear !== undefined) {
      score += candidateYear === requested.year ? 25 : -40;
    }

    if (score > 0) {
      scored.push({ href: candidate.href, title: haystackRaw.trim(), ...(candidateYear !== undefined ? { year: candidateYear } : {}), score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.href.localeCompare(b.href));
  return scored.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Bollyflix sidexfee bypass port (Kotlin `bypass(id)`)
// ---------------------------------------------------------------------------

const SIDEXFEE_BASE = 'https://web.sidexfee.com';

/**
 * Port of the Bollyflix `bypass(id)`: GET `web.sidexfee.com/?id=<id>` as
 * TEXT, extract `link":"…"` from the (JSON-ish) document, un-escape the
 * slashes, then base64-decode. Returns null on any failure — the caller
 * skips that source button (Kotlin parity: `bypass` returns '' on failure).
 */
export async function sidexfeeBypass(id: string, ctx: CloudStreamRuntimeContext): Promise<string | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) return null;
  try {
    const page = await ctx.fetchHtml(`${SIDEXFEE_BASE}/?id=${encodeURIComponent(id)}`);
    const match = /link":"([^"]+)"/.exec(page.html);
    if (!match?.[1]) return null;
    const escaped = match[1].replace(/\\\//g, '/');
    try {
      const decoded = Buffer.from(escaped, 'base64').toString('utf8').trim();
      if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
      return null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kotlin-parity micro helpers
// ---------------------------------------------------------------------------

/** Kotlin `getBaseUrl` port. */
export function baseUrlOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

/** Kotlin `fixUrl` port: resolves a possibly-relative link onto a domain. */
export function fixUrl(url: string, domain: string): string {
  if (url.startsWith('http')) return url;
  if (url.length === 0) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${domain}${url}`;
  return `${domain}/${url}`;
}

/** Kotlin `(?:Season |S)(\d+)` season regex port. */
export function parseSeasonNumber(text: string | null | undefined): number | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const match = /(?:Season |S)(\d+)/i.exec(text);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

/** Joins a possibly-relative link onto a base (never double-concatenates). */
export function joinUrl(base: string, link: string): string {
  if (link.startsWith('http://') || link.startsWith('https://')) return link;
  if (link.startsWith('/')) return `${base}${link}`;
  return `${base}/${link}`;
}

/** Re-exported for adapter ports that probe redirects directly. */
export { fetchCloudStreamRedirect };

// ---------------------------------------------------------------------------
// Failure classification (thrown network errors → closed vocabulary)
// ---------------------------------------------------------------------------

import type { CloudStreamResolutionFailure } from '../types/runtime';

/**
 * Translates a thrown fetch-layer error into the closed failure vocabulary.
 * BLOCKED_URL keeps its category (SSRF guard — diagnostics-critical); TIMEOUT
 * keeps its category; every other network/HTTP/shape error maps to
 * LOAD_FAILED with a SAFE message (never internals, plan §20).
 */
export function classifyNetworkFailure(error: unknown): CloudStreamResolutionFailure {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'BLOCKED_URL') {
    return { category: 'BLOCKED_URL', message: 'A provider destination was rejected by the network policy.' };
  }
  if (code === 'TIMEOUT') {
    return { category: 'TIMEOUT', message: 'The provider request exceeded its deadline.' };
  }
  return { category: 'LOAD_FAILED', message: 'The provider page could not be loaded.' };
}
