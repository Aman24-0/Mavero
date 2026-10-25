// ============================================================================
// Live TV HLS stream proxy — GET /api/livetv/stream-proxy?u=<absolute url>[&r=<referer>]
//
// Fetches an HLS manifest or media segment SERVER-SIDE and returns it to the
// browser, working around CDNs that block cross-origin browser requests
// (CORS / 403 / Akamai 475 bot protection). For a manifest it REWRITES every
// segment, key and variant URI so they also travel back through this proxy,
// carrying the SAME Referer (&r=) that loaded the manifest.
//
// BROWSER MIMICRY (applied to EVERY request — manifest AND segments):
//   * Referer/Origin = the PROVIDER origin (per-CDN map), replayed on segments
//     via &r= so a CDN that 403s a same-origin Referer still sees the right one.
//   * A standard desktop-Chrome User-Agent.
//   * Sec-Fetch-* / Accept / Accept-Language — Akamai (Hotstar) 475s requests
//     that look scripted; these match a cross-origin media fetch from a page.
//   * Cookie passthrough: cookies the CDN sets on the manifest are replayed on
//     segment requests (best-effort, per instance — see the jar below).
//
// SECURITY (this is a proxy — treat it like one):
//   * https + absolute only; no credentials; length-bounded.
//   * Origin ALLOWLIST (shared with the client) — NOT an open relay.
//   * SSRF guard (assertSafeManifestUrl + assertSafeManifestDestination) on the
//     first hop AND every manually-followed redirect hop (max 3).
//   * Rate-limited per identity. Range forwarded (206 passthrough).
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
import { isLivetvProxyHost, livetvProxyRefererFor, LIVETV_PROXY_BROWSER_UA } from '$lib/shared/livetv-proxy';
import { rewriteHlsManifest } from '$lib/server/livetv/hls-manifest';

const MAX_URL_LENGTH = 2048;
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_COOKIE_HOSTS = 200;

const CORS_HEADERS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-expose-headers': 'content-range, content-length, accept-ranges',
	'cache-control': 'no-store'
};

// ---------------------------------------------------------------------------
// Cookie jar (best-effort, per function instance). CDNs such as Akamai hand out
// a session cookie on the manifest and expect it back on every segment. Keyed by
// the CDN host. Bounded; LRU-ish eviction. Not a guarantee (instances are not
// shared), but it is what a stateless proxy can do.
// ---------------------------------------------------------------------------
const cookieJar = new Map<string, Map<string, string>>();

function rememberCookies(host: string, response: Response): void {
	let setCookies: string[] = [];
	const headers = response.headers as Headers & { getSetCookie?: () => string[] };
	if (typeof headers.getSetCookie === 'function') {
		setCookies = headers.getSetCookie();
	} else {
		const raw = response.headers.get('set-cookie');
		if (raw) setCookies = [raw];
	}
	if (setCookies.length === 0) return;
	const jar = cookieJar.get(host) ?? new Map<string, string>();
	for (const sc of setCookies) {
		const firstPair = sc.split(';')[0] ?? '';
		const eq = firstPair.indexOf('=');
		if (eq > 0) jar.set(firstPair.slice(0, eq).trim(), firstPair.slice(eq + 1).trim());
	}
	cookieJar.set(host, jar);
	if (cookieJar.size > MAX_COOKIE_HOSTS) {
		const oldest = cookieJar.keys().next().value;
		if (oldest !== undefined) cookieJar.delete(oldest);
	}
}

function cookieHeaderFor(host: string): string | null {
	const jar = cookieJar.get(host);
	if (!jar || jar.size === 0) return null;
	return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Validate the optional `r` (Referer) param — http(s) only, no creds, bounded. */
function safeReferer(raw: string | null): string | null {
	if (!raw || raw.length > 512) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		if (url.username || url.password) return null;
		return url.toString();
	} catch {
		return null;
	}
}

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

	// Referer/Origin: prefer the replayed `r` (set by the rewriter on segments),
	// then the per-CDN provider mapping, then the client's own, then the media
	// origin. This guarantees segments get the SAME Referer that loaded the
	// manifest — the fix for "manifest loads but segments 403".
	const requiredReferer = safeReferer(url.searchParams.get('r')) ?? livetvProxyRefererFor(first.hostname);
	const referer = requiredReferer ?? request.headers.get('referer') ?? `${first.origin}/`;
	const origin = requiredReferer ? requiredReferer.replace(/\/$/, '') : (request.headers.get('origin') ?? first.origin);

	const upstreamHeaders: Record<string, string> = {
		referer,
		origin,
		'user-agent': LIVETV_PROXY_BROWSER_UA,
		accept: '*/*',
		'accept-language': 'en-US,en;q=0.9',
		// Browser fetch-metadata — Akamai 475s requests that look scripted.
		'sec-fetch-dest': 'video',
		'sec-fetch-mode': 'cors',
		'sec-fetch-site': 'cross-site'
	};
	const range = request.headers.get('range');
	if (range) upstreamHeaders.range = range;
	const cookie = cookieHeaderFor(first.hostname);
	if (cookie) upstreamHeaders.cookie = cookie;

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
			rememberCookies(current.hostname, res);
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
			return new Response(null, { status: response.status, headers: { ...CORS_HEADERS } });
		}
		const text = await response.text();
		// Embed the SAME referer on every rewritten URI so segments replay it.
		return new Response(rewriteHlsManifest(text, finalUrl.toString(), referer), {
			status: 200,
			headers: { 'content-type': 'application/vnd.apple.mpegurl', ...CORS_HEADERS }
		});
	}

	const headers = new Headers(CORS_HEADERS);
	for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
		const value = response.headers.get(name);
		if (value) headers.set(name, value);
	}
	return new Response(response.body, { status: response.status, headers });
};
