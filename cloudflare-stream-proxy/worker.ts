/**
 * Mavеro Live TV HLS stream proxy — Cloudflare Worker.
 *
 * Drop-in replacement for the SvelteKit /api/livetv/stream-proxy endpoint, for
 * when the CDN has blacklisted Netlify's AWS data-centre IPs (Sony 403 /
 * Hotstar Akamai 475). Runs on Cloudflare's edge, so the origin IP is not the
 * one the CDN blocked.
 *
 * Behaviour is identical to the in-app proxy:
 *   GET /?u=<absolute url>[&r=<referer>]
 *   - https + allowlisted host only (NOT an open proxy)
 *   - provider Referer/Origin per CDN + desktop-Chrome UA + Sec-Fetch-* headers
 *     on EVERY request (manifest AND segments)
 *   - rewrites the HLS manifest so every segment/key/variant URI points back to
 *     this Worker, carrying the same &r= Referer
 *   - Range passthrough (206) for segments
 *   - permissive CORS so the browser can fetch it cross-origin
 *
 * SCOPE: HLS only. DASH is not proxied.
 */

const ALLOWED_HOST_SUFFIXES = ['hotstar.com', 'slivcdn.com'];

const REFERER_BY_HOST: ReadonlyArray<{ suffix: string; referer: string }> = [
	{ suffix: 'slivcdn.com', referer: 'https://premiumplugx.com/' },
	{ suffix: 'hotstar.com', referer: 'https://premiumplugx.com/' }
];

const BROWSER_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CORS_HEADERS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'access-control-expose-headers': 'content-range, content-length, accept-ranges',
	'cache-control': 'no-store'
};

const MAX_URL_LENGTH = 2048;

function isAllowedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function refererFor(hostname: string): string | null {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	for (const entry of REFERER_BY_HOST) {
		if (host === entry.suffix || host.endsWith(`.${entry.suffix}`)) return entry.referer;
	}
	return null;
}

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
		headers: { 'content-type': 'application/json', ...CORS_HEADERS }
	});
}

function rewriteManifest(body: string, baseUrl: string, workerOrigin: string, referer: string | null): string {
	const base = new URL(baseUrl);
	const suffix = referer ? `&r=${encodeURIComponent(referer)}` : '';
	const proxify = (absUrl: string): string =>
		`${workerOrigin}/?u=${encodeURIComponent(absUrl)}${suffix}`;
	const out: string[] = [];
	for (const rawLine of body.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (line.length === 0) {
			out.push(line);
			continue;
		}
		if (line.startsWith('#')) {
			out.push(
				line.replace(/URI="([^"]+)"/g, (match, uri: string) => {
					try {
						return `URI="${proxify(new URL(uri, base).toString())}"`;
					} catch {
						return match;
					}
				})
			);
			continue;
		}
		try {
			out.push(proxify(new URL(line.trim(), base).toString()));
		} catch {
			out.push(line);
		}
	}
	return out.join('\n');
}

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}
		if (request.method !== 'GET') {
			return jsonError(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported.');
		}

		const url = new URL(request.url);
		const raw = url.searchParams.get('u') ?? '';
		if (!raw || raw.length > MAX_URL_LENGTH) {
			return jsonError(400, 'INVALID_REQUEST', 'A valid media URL is required.');
		}

		let target: URL;
		try {
			target = new URL(raw);
		} catch {
			return jsonError(400, 'INVALID_REQUEST', 'The media URL is malformed.');
		}
		if (target.protocol !== 'https:' || target.username || target.password) {
			return jsonError(403, 'URL_NOT_ALLOWED', 'Only https media URLs are allowed.');
		}
		if (!isAllowedHost(target.hostname)) {
			return jsonError(403, 'URL_NOT_ALLOWED', 'This media host is not allowed.');
		}

		const requiredReferer = safeReferer(url.searchParams.get('r')) ?? refererFor(target.hostname);
		const referer = requiredReferer ?? `${target.origin}/`;
		const origin = requiredReferer ? requiredReferer.replace(/\/$/, '') : target.origin;

		const headers: Record<string, string> = {
			referer,
			origin,
			'user-agent': BROWSER_UA,
			accept: '*/*',
			'accept-language': 'en-US,en;q=0.9',
			'sec-fetch-dest': 'video',
			'sec-fetch-mode': 'cors',
			'sec-fetch-site': 'cross-site'
		};
		const range = request.headers.get('range');
		if (range) headers.range = range;

		let upstream: Response;
		try {
			upstream = await fetch(target.toString(), { headers, redirect: 'follow' });
		} catch {
			return jsonError(502, 'UPSTREAM_UNREACHABLE', 'The media host could not be reached.');
		}

		const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
		const isManifest = contentType.includes('mpegurl') || target.pathname.toLowerCase().endsWith('.m3u8');

		if (isManifest) {
			if (!upstream.ok) {
				return new Response(null, { status: upstream.status, headers: CORS_HEADERS });
			}
			const text = await upstream.text();
			return new Response(rewriteManifest(text, target.toString(), url.origin, referer), {
				status: 200,
				headers: { 'content-type': 'application/vnd.apple.mpegurl', ...CORS_HEADERS }
			});
		}

		const out = new Headers(CORS_HEADERS);
		for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
			const value = upstream.headers.get(name);
			if (value) out.set(name, value);
		}
		return new Response(upstream.body, { status: upstream.status, headers: out });
	}
};
