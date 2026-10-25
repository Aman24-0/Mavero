// ============================================================================
// Live TV HLS stream proxy — GET /api/livetv/stream-proxy?u=<absolute url>
//
// Fetches an HLS manifest or media segment SERVER-SIDE and returns it to the
// browser, working around CDNs that block cross-origin browser requests
// (CORS / 403). For a manifest it REWRITES every segment, key and variant URI
// so they also travel back through this proxy.
//
// SECURITY (this is a proxy — treat it like one):
//   * https + absolute only; no credentials; length-bounded.
//   * Origin ALLOWLIST (shared with the client): only the CDN suffixes in
//     $lib/shared/livetv-proxy are ever fetched — this is NOT an open relay.
//   * SSRF guard: the shared `assertSafeManifestUrl` (numeric IP forms, IPv6
//     mapped, metadata hosts) + `assertSafeManifestDestination` (DNS resolution
//     against blocked ranges) run for the FIRST hop AND every redirect hop.
//   * Redirects are followed MANUALLY (max 3) with each hop re-validated, so a
//     CDN cannot bounce us onto an internal address.
//   * Rate-limited per identity.
//   * Range requests are forwarded so segment seeking works (206 passthrough).
//
// SCOPE: HLS only. DASH is not proxied.
// ============================================================================

import type { RequestHandler } from './$types';
import {
	checkRateLimit,
	clientIdentity,
	RATE_LIMITED_ERROR_CODE,
	RATE_LIMITED_MESSAGE
} from '$lib/server/http/rate-limit';
import { assertSafeManifestUrl, assertSafeManifestDestination } from '$lib/server/streaming/stremio/ssrf';
import { isLivetvProxyHost } from '$lib/shared/livetv-proxy';
import { rewriteHlsManifest } from '$lib/server/livetv/hls-manifest';

const MAX_URL_LENGTH = 2048;
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const CORS_HEADERS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-expose-headers': 'content-range, content-length, accept-ranges',
	'cache-control': 'no-store'
};

function jsonError(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}


/** Validate one hop: https + allowlisted host + SSRF guard. Null = reject. */
async function safeHop(raw: string): Promise<URL | null> {
	let url: URL;
	try {
		url = assertSafeManifestUrl(raw);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	if (!isLivetvProxyHost(url.hostname)) return null;
	try {
		await assertSafeManifestDestination(url);
	} catch {
		return null;
	}
	return url;
}

export const GET: RequestHandler = async ({ request, url, locals }) => {
	const verdict = checkRateLimit('livetvStreamProxy', clientIdentity(request.headers, locals.user?.id));
	if (!verdict.allowed) {
		return new Response(
			JSON.stringify({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }),
			{ status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(verdict.retryAfterSeconds) } }
		);
	}

	const raw = url.searchParams.get('u') ?? '';
	if (!raw || raw.length > MAX_URL_LENGTH) {
		return jsonError(400, 'INVALID_REQUEST', 'A valid media URL is required.');
	}

	const first = await safeHop(raw);
	if (!first) return jsonError(403, 'URL_NOT_ALLOWED', 'This media host is not allowed.');

	// Headers a CDN may require to stop 403-ing. The browser's Referer/Origin are
	// forwarded when present (some CDNs check them); otherwise we present the
	// media origin, which is the common "same-origin Referer" requirement.
	const upstreamHeaders: Record<string, string> = {
		referer: request.headers.get('referer') ?? `${first.origin}/`,
		origin: request.headers.get('origin') ?? first.origin,
		'user-agent': request.headers.get('user-agent') ?? 'Mozilla/5.0'
	};
	const range = request.headers.get('range');
	if (range) upstreamHeaders.range = range;
	const accept = request.headers.get('accept');
	if (accept) upstreamHeaders.accept = accept;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

	let response: Response;
	let finalUrl: URL = first;
	try {
		let current: URL = first;
		let res: Response | null = null;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
			res = await fetch(current.toString(), {
				headers: upstreamHeaders,
				redirect: 'manual',
				signal: controller.signal
			});
			if (res.status >= 300 && res.status < 400) {
				const location = res.headers.get('location');
				if (!location) break;
				let nextRaw: string;
				try {
					nextRaw = new URL(location, current).toString();
				} catch {
					break;
				}
				const next = await safeHop(nextRaw);
				if (!next) {
					clearTimeout(timer);
					return jsonError(403, 'URL_NOT_ALLOWED', 'The media host redirected to a disallowed location.');
				}
				current = next;
				continue;
			}
			break;
		}
		if (!res) {
			clearTimeout(timer);
			return jsonError(502, 'UPSTREAM_UNREACHABLE', 'The media host did not respond.');
		}
		response = res;
		finalUrl = current;
	} catch {
		clearTimeout(timer);
		return jsonError(502, 'UPSTREAM_UNREACHABLE', 'The media host could not be reached.');
	}
	clearTimeout(timer);

	const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
	const isManifest = contentType.includes('mpegurl') || finalUrl.pathname.toLowerCase().endsWith('.m3u8');

	if (isManifest) {
		if (!response.ok) {
			// Surface the upstream failure to hls.js (it will fail the candidate).
			return new Response(null, { status: response.status, headers: { ...CORS_HEADERS } });
		}
		const text = await response.text();
		return new Response(rewriteHlsManifest(text, finalUrl.toString()), {
			status: 200,
			headers: { 'content-type': 'application/vnd.apple.mpegurl', ...CORS_HEADERS }
		});
	}

	// Segment / key / init — stream through, preserving status (incl. 206) and
	// range-related headers so seeking works.
	const headers = new Headers(CORS_HEADERS);
	for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
		const value = response.headers.get(name);
		if (value) headers.set(name, value);
	}
	return new Response(response.body, { status: response.status, headers });
};
