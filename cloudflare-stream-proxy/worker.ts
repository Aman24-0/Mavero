/**
 * Mavеro Live TV HLS/DASH stream proxy — Cloudflare Worker.
 *
 * GET  /?u=<absolute url>[&r=<referer>]  → rewritten manifest / proxied segment
 * HEAD /?u=…                              → 200 + Content-Type, empty body
 * OPTIONS /?u=…                           → 200 OK (CORS preflight)
 *
 * Same behaviour as the in-app /api/livetv/stream-proxy: https + allowlist only,
 * provider Referer/Origin + desktop-Chrome UA + Sec-Fetch-* on every request,
 * manifest rewrite (segments/keys/variants back through this Worker, carrying
 * the same &r=), Range passthrough, permissive CORS. HLS + DASH (.mpd).
 *
 * 2026-10 round 6:
 *   * CORS preflight (OPTIONS) returns 200 with permissive headers.
 *   * Per-CDN Referer/Origin mapping: Jio → jio.com, Hotstar → hotstar.com,
 *     Sony → sonyliv.com (NOT premiumplugx — the CDNs check the provider
 *     site's origin, not the aggregator's).
 *   * Range header forwarded for video seeking.
 *   * DASH (.mpd) manifests are rewritten (BaseURL + segment URLs proxied).
 */

// 2026-10 round 13 — DirectStream VOD scraper: added cloudnestra.com (the
// vidsrc stream CDN) with Referer: https://cloudnestra.com/ (verified by
// @definisi/vidsrc-scraper + CinePro reference implementations). The
// existing manifest rewriter + &r= passthrough handles the rest — no new
// Worker logic, just config entries.
// 2026-10 round 14 — added stellarconductornexus.com (another vidsrc stream
// CDN observed in production). Same Referer as cloudnestra (the prorcp
// page's origin is cloudnestra.com; the CDN domains rotate).
// 2026-10 round 15 — added vidsrc.sh (the embed front domain). The scraper
// routes its embed/rcp/prorcp fetches through the Worker to bypass
// Cloudflare's 403 on Netlify's AWS egress IPs. The Worker's edge IPs are
// not on Cloudflare's blocklist. vidsrc.sh uses no special Referer (the
// scraper sets the embed origin as the Referer per hop).
const ALLOWED_HOST_SUFFIXES = ['hotstar.com', 'slivcdn.com', 'jio.com', 'jiocinema.com', 'premiumplugx.com', 'catbox.moe', 'cloudnestra.com', 'stellarconductornexus.com', 'vidsrc.sh', 'vidsrc.to', 'vidsrc.net', 'vidsrc.xyz', 'vidsrc.in', 'vsembed.ru'];

const REFERER_BY_HOST: ReadonlyArray<{ suffix: string; referer: string }> = [
        { suffix: 'slivcdn.com', referer: 'https://www.sonyliv.com/' },
        { suffix: 'hotstar.com', referer: 'https://www.hotstar.com/' },
        { suffix: 'jio.com', referer: 'https://www.jio.com/' },
        { suffix: 'jiocinema.com', referer: 'https://www.jiocinema.com/' },
        { suffix: 'premiumplugx.com', referer: 'https://premiumplugx.com/' },
        { suffix: 'cloudnestra.com', referer: 'https://cloudnestra.com/' },
        { suffix: 'stellarconductornexus.com', referer: 'https://cloudnestra.com/' }
];

const BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CORS_HEADERS: Record<string, string> = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': '*',
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
        if (path.endsWith('.mpd')) return 'application/dash+xml';
        if (path.endsWith('.ts')) return 'video/mp2t';
        if (path.endsWith('.m4s') || path.endsWith('.mp4') || path.endsWith('.m4a')) return 'video/mp4';
        if (path.endsWith('.aac')) return 'audio/aac';
        // 2026-10 round 10 — Task 3: handle redirected .mp4 URLs that may
        // not have an extension (e.g. catbox.moe /<id>.mp4).
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

/**
 * 2026-10 round 6 — Task 2: DASH (.mpd) manifest rewriter.
 *
 * Rewrites <BaseURL>, <SegmentTemplate media="...">, <SegmentTemplate
 * initialization="...">, and <SegmentList media="..."> URLs so they
 * route through this Worker. DASH manifests are XML; we use regex
 * (not a DOM parser) because the Worker runtime has no DOM API and
 * the MPD format is well-structured enough for targeted regex
 * replacement.
 */
function rewriteDashManifest(body: string, baseUrl: string, workerOrigin: string, referer: string | null): string {
        const base = new URL(baseUrl);
        const suffix = referer ? `&r=${encodeURIComponent(referer)}` : '';
        const proxify = (absUrl: string): string => `${workerOrigin}/?u=${encodeURIComponent(absUrl)}${suffix}`;

        // Rewrite <BaseURL>...</BaseURL>
        let result = body.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (match, url: string) => {
                try {
                        return `<BaseURL>${proxify(new URL(url.trim(), base).toString())}</BaseURL>`;
                } catch {
                        return match;
                }
        });

        // Rewrite media="..." and initialization="..." attributes in
        // <SegmentTemplate> and <SegmentList> elements.
        result = result.replace(/\b(media|initialization|sourceURL)="([^"]+)"/g, (match, attr: string, url: string) => {
                try {
                        return `${attr}="${proxify(new URL(url.trim(), base).toString())}"`;
                } catch {
                        return match;
                }
        });

        return result;
}

export default {
        async fetch(request: Request): Promise<Response> {
                // 2026-10 round 6 — CORS preflight: return 200 OK with permissive
                // headers so the browser's CORS check passes before the actual
                // GET/HEAD request. The previous 204 was sometimes rejected by
                // strict CDN CORS policies that expect 200.
                if (request.method === 'OPTIONS') {
                        return new Response(null, { status: 200, headers: CORS_HEADERS });
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

                // 2026-10 round 15 — DirectStream scraper fallback: the scraper
                // routes its embed/rcp/prorcp HTML page fetches through this
                // Worker to bypass Cloudflare's 403 on Netlify's AWS egress IPs.
                // For HTML pages, send document-navigation headers (sec-fetch-dest:
                // document, sec-fetch-mode: navigate) — Cloudflare's bot detection
                // 403s requests with sec-fetch-dest: video to an HTML page.
                const pathLower = target.pathname.toLowerCase();
                const isMediaPath = pathLower.endsWith('.m3u8') || pathLower.endsWith('.m3u') || pathLower.endsWith('.mpd')
                        || pathLower.endsWith('.ts') || pathLower.endsWith('.m4s') || pathLower.endsWith('.mp4')
                        || pathLower.endsWith('.m4a') || pathLower.endsWith('.aac');
                const headers: Record<string, string> = isMediaPath
                        ? {
                                referer,
                                origin,
                                'user-agent': BROWSER_UA,
                                accept: '*/*',
                                'accept-language': 'en-US,en;q=0.9',
                                'sec-fetch-dest': 'video',
                                'sec-fetch-mode': 'cors',
                                'sec-fetch-site': 'cross-site'
                        }
                        : {
                                referer,
                                origin,
                                'user-agent': BROWSER_UA,
                                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                                'accept-language': 'en-US,en;q=0.9',
                                'accept-encoding': 'gzip, deflate, br',
                                'sec-fetch-dest': 'document',
                                'sec-fetch-mode': 'navigate',
                                'sec-fetch-site': 'same-origin',
                                'sec-fetch-user': '?1',
                                'upgrade-insecure-requests': '1'
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

                // 2026-10 round 10 — Task 3: handle 404 (stream offline / expired link).
                // Return a clear JSON error so the player can show a helpful message.
                if (upstream.status === 404) {
                        return jsonError(404, 'STREAM_NOT_FOUND', 'This stream is currently offline or the link has expired.');
                }
                // 2026-10 round 10 — Task 3: handle 410 Gone (expired).
                if (upstream.status === 410) {
                        return jsonError(410, 'STREAM_EXPIRED', 'This stream link has expired.');
                }

                const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
                const pathLower = target.pathname.toLowerCase();
                const isHlsManifest = contentType.includes('mpegurl') || pathLower.endsWith('.m3u8');
                const isDashManifest = contentType.includes('dash') || pathLower.endsWith('.mpd') || (contentType.includes('xml') && upstream.ok && (await upstream.clone().text().catch(() => '')).includes('<MPD'));

                // 2026-10 round 6 — Task 2: DASH (.mpd) manifest rewriting.
                if (isDashManifest) {
                        if (!upstream.ok) {
                                return new Response(null, { status: upstream.status, headers: CORS_HEADERS });
                        }
                        const text = await upstream.text();
                        return new Response(rewriteDashManifest(text, target.toString(), url.origin, referer), {
                                status: 200,
                                headers: { 'content-type': 'application/dash+xml', ...CORS_HEADERS }
                        });
                }

                if (isHlsManifest) {
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
