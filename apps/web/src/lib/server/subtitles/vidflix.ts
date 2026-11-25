/**
 * Round 42 (2026-11) — VidFlix external-subtitle server helpers.
 *
 * The VidFlix mbox API (stream.hls.lol) serves its subtitles as .srt files
 * from cacdn.hakunaymatata.com. The browser's <track> element only parses
 * WebVTT, and a cross-origin <track> load would additionally require a
 * crossorigin attribute on the shared <video> element (which would break
 * every native media fetch for hosts that send no ACAO header — the exact
 * problem the VDRK subtitle proxy solved). The files are therefore served
 * SAME-ORIGIN through a narrowly scoped SvelteKit endpoint that ALSO
 * converts SRT → VTT:
 *
 *   GET /api/content/subtitles/vtt/proxy?u=<base64url(absolute https url)>
 *
 * SECURITY CONTRACT (same posture as the VDRK subtitle routes —
 * $lib/server/subtitles/vdrk.ts — NOT a generic proxy):
 *   * The ONLY input is the opaque `u` param: a base64url-encoded,
 *     ABSOLUTE https URL whose decoded host must be EXACTLY
 *     cacdn.hakunaymatata.com (the VidFlix subtitle CDN observed in the
 *     verified API contract). Any other host, scheme, or a malformed
 *     param is rejected with 400 — Mavero never fetches an arbitrary
 *     client-supplied origin.
 *   * No credentials/cookies are forwarded; `redirect: 'error'` forbids
 *     cross-host redirects; responses get a bounded public TTL.
 *   * Bounded fetch: 5-second timeout and a hard 2 MB size cap (streamed
 *     read — oversized upstreams are aborted mid-body, never trusting a
 *     missing/lying content-length to bound memory).
 *   * The body is returned with `text/vtt; charset=utf-8` ONLY: a body
 *     that already starts with WEBVTT passes through as-is; anything else
 *     is converted SRT → VTT (numeric cue indices dropped, the ',' decimal
 *     separator in timestamp lines replaced with '.', "WEBVTT\n\n"
 *     prepended).
 */

/** Observed SRT response cap — real files are ~100 KB; 2 MB is generous. */
const VIDFLIX_SUBTITLE_MAX_BYTES = 2_000_000;
const VIDFLIX_SUBTITLE_TIMEOUT_MS = 5_000;
/** Base64url params never exceed this in practice — bound the input. */
const VIDFLIX_PARAM_MAX_LENGTH = 2_048;
/** The ONLY host this proxy ever fetches (exact match, no subdomains). */
export const VIDFLIX_SUBTITLE_HOST = 'cacdn.hakunaymatata.com';

/** Base64url param alphabet ([A-Za-z0-9_-]). */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** An SRT/VTT timestamp line: "00:00:01,000 --> 00:00:04,000" (hours
 *  optional, ',' or '.' decimal separator, optional positioning text). */
const TIMESTAMP_LINE_PATTERN = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}\s*-->/;

/**
 * Decode + validate the `u` param. Returns the ABSOLUTE https URL to
 * fetch, or null when the param is malformed / not base64url / not https /
 * not the exact allowlisted host.
 */
export function decodeVidflixSubtitleUrl(raw: string | null): string | null {
  if (!raw || raw.length === 0 || raw.length > VIDFLIX_PARAM_MAX_LENGTH) return null;
  if (!BASE64URL_PATTERN.test(raw)) return null;
  let decoded: string;
  try {
    // Node's base64 decoder accepts the unpadded base64url form directly
    // after restoring the standard alphabet.
    decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded || /[\u0000-\u001f]/.test(decoded)) return null;
  let parsed: URL;
  try {
    parsed = new URL(decoded);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  // EXACT host match — no subdomain suffix matching, no path tricks.
  if (parsed.hostname !== VIDFLIX_SUBTITLE_HOST) return null;
  return parsed.toString();
}

/**
 * Convert an SRT body to WebVTT:
 *   * drop the numeric cue indices (a line that is purely digits and is
 *     immediately followed by a timestamp line is an SRT index, not a cue);
 *   * replace the ',' decimal separator in timestamp lines with '.';
 *   * prepend the required "WEBVTT" header.
 * A body that is already VTT-ish (already uses '.') is unchanged by the
 * timestamp rewrite; the header is always (re-)prepended by the caller
 * only when the body does not already start with WEBVTT.
 */
export function srtToWebVtt(input: string): string {
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (/^\d+$/.test(line.trim()) && TIMESTAMP_LINE_PATTERN.test(next)) continue;
    if (TIMESTAMP_LINE_PATTERN.test(line)) {
      out.push(line.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2'));
    } else {
      out.push(line);
    }
  }
  return `WEBVTT\n\n${out.join('\n').replace(/^[ \t]*\n+/, '')}`;
}

/** True when the body already carries a WEBVTT header (BOM/whitespace
 *  tolerant) — passed through as-is, no conversion. */
export function isWebVttBody(text: string): boolean {
  return /^WEBVTT/.test(text.replace(/^\uFEFF/, '').trimStart());
}

export type VidflixSubtitleResult =
  | { ok: true; text: string }
  | { ok: false; status: 502 | 504 };

/**
 * Fetch one already-validated upstream subtitle URL. Bounded: 5s timeout,
 * `redirect: 'error'` (no cross-host redirects), streamed 2 MB size cap.
 */
export async function fetchVidflixSubtitleText(upstreamUrl: string): Promise<VidflixSubtitleResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VIDFLIX_SUBTITLE_TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'text/vtt, application/x-subrip, text/plain, */*' },
    });
    if (!upstream.ok) return { ok: false, status: 502 };
    const declaredLength = Number.parseInt(upstream.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > VIDFLIX_SUBTITLE_MAX_BYTES) return { ok: false, status: 502 };

    // Streamed bounded read: abort mid-body when the cap is exceeded
    // (never trusting a missing/lying content-length to bound memory).
    const body = upstream.body;
    if (!body) return { ok: false, status: 502 };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > VIDFLIX_SUBTITLE_MAX_BYTES) {
          try { await reader.cancel(); } catch { /* already aborted */ }
          return { ok: false, status: 502 };
        }
        chunks.push(value);
      }
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(concatChunks(chunks, received));
    return { ok: true, text };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, status: 504 };
    return { ok: false, status: 502 };
  } finally {
    clearTimeout(timeout);
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
