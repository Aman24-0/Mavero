/**
 * Mavеro Live TV HLS stream proxy — Cloudflare Worker.
 *
 * GET  /?u=<absolute url>[&r=<referer>]  → rewritten manifest / proxied segment
 * HEAD /?u=…                              → 200 + Content-Type, empty body
 *   (video players probe with HEAD before fetching; 405 broke them)
 *
 * Same behaviour as the in-app /api/livetv/stream-proxy: https + allowlist only,
 * provider Referer/Origin + desktop-Chrome UA + Sec-Fetch-* on every request,
 * manifest rewrite (segments/keys/variants back through this Worker, carrying
 * the same &r=), Range passthrough, permissive CORS. HLS only.
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
	'access-control-allow-methods': 'GET, HEAD, OPTIONS',
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

/** Best-effort content type for a HEAD probe when the upstream won't answer one. */
function guessContentType(pathname: string): string {
	const path = pathname.toLowerCase();
	if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
	if (path.endsWith('.ts')) return 'video/mp2t';
	if (path.endsWith('.m4s') || path.endsWith('.mp4') || path.endsWith('.m4a')) return 'video/mp4';
	if (path.endsWith('.aac')) return 'audio/aac';
	return 'application/octet-stream';
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
	const proxify = (absUrl: string): string => `${workerOrigin}/?u=${encodeURIComponent(absUrl)}${suffix}`;
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
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return jsonError(405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported.');
		}
		const isHead = request.method === 'HEAD';

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

		// HEAD probe — players check Content-Type before fetching. Always answer
		// 200 with the upstream (or a best-guess) type and an empty body.
		if (isHead) {
			let contentType = guessContentType(target.pathname);
			try {
				const head = await fetch(target.toString(), { method: 'HEAD', headers, redirect: 'follow' });
				const upstreamType = head.headers.get('content-type');
				if (upstreamType) contentType = upstreamType;
			} catch {
				/* keep the guess */
			}
			return new Response(null, {
				status: 200,
				headers: { 'content-type': contentType, 'accept-ranges': 'bytes', ...CORS_HEADERS }
			});
		}

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
