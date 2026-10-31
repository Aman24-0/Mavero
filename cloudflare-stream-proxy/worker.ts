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
 *   * Per-CDN Referer/Origin mapping: Jio → jioplus2plugx.lovable.app (the
 *     official provider site the stream is embedded on — the CDN checks the
 *     EMBEDDING page's origin, not the brand domain), Hotstar → hotstar.com,
 *     Sony → sonyliv.com.
 *   * Range header forwarded for video seeking.
 *   * DASH (.mpd) manifests are rewritten (BaseURL + segment URLs proxied).
 *
 * 2026-11 round 34 — JIO ORIGIN/REFERER SPOOF: Jio's CDN 403s requests whose
 * Origin/Referer is NOT the official provider site. The provider site
 * (jioplus2plugx.lovable.app) sends `Origin: https://jioplus2plugx.lovable.app`
 * and `Referer: https://jioplus2plugx.lovable.app/` — the Worker now sends
 * exactly those on every jio.com request (REFERER_BY_HOST + ORIGIN_BY_HOST).
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
// 2026-10 round 18 — PURGED vidsrc.sh/to/net/xyz/in + vsembed.ru + 2embed.cc
// (the old 3-hop scraper is gone). Added vidsrc.party (the new API domain —
// the manifest is served from here) + cookiebakers23blog.xyz + cno.to (CDN
// domains that appear in the base64-encoded segment URLs inside the
// manifest). The Referer for vidsrc.party is itself; for the CDNs it's
// vidsrc.party (the segment proxy runs on vidsrc.party, but if the Worker
// ever fetches a raw CDN URL, it sends vidsrc.party as the Referer).
const ALLOWED_HOST_SUFFIXES = ['hotstar.com', 'slivcdn.com', 'jio.com', 'jiocinema.com', 'premiumplugx.com', 'catbox.moe', 'cloudnestra.com', 'stellarconductornexus.com', 'vidsrc.party', 'cookiebakers23blog.xyz', 'cno.to', 'vidcore.org'];

const REFERER_BY_HOST: ReadonlyArray<{ suffix: string; referer: string }> = [
        { suffix: 'slivcdn.com', referer: 'https://www.sonyliv.com/' },
        { suffix: 'hotstar.com', referer: 'https://www.hotstar.com/' },
        // 2026-11 round 34 — the OFFICIAL provider site's Referer (with the
        // trailing slash, exactly as the site's own player sends it).
        { suffix: 'jio.com', referer: 'https://jioplus2plugx.lovable.app/' },
        { suffix: 'jiocinema.com', referer: 'https://www.jiocinema.com/' },
        { suffix: 'premiumplugx.com', referer: 'https://premiumplugx.com/' },
        { suffix: 'cloudnestra.com', referer: 'https://cloudnestra.com/' },
        { suffix: 'stellarconductornexus.com', referer: 'https://cloudnestra.com/' },
        { suffix: 'vidsrc.party', referer: 'https://vidsrc.party/' },
        { suffix: 'cookiebakers23blog.xyz', referer: 'https://vidsrc.party/' },
        { suffix: 'cno.to', referer: 'https://vidsrc.party/' },
        { suffix: 'vidcore.org', referer: 'https://vidcore.org/' }
];

/**
 * 2026-11 round 34 — explicit per-host Origin overrides. Jio's CDN checks the
 * Origin header against the official provider site's origin (no trailing
 * slash — exactly as a browser sends it). When a host has an entry here it
 * WINS over the Referer-derived origin; hosts without an entry keep the old
 * behaviour (Origin = Referer minus the trailing slash).
 */
const ORIGIN_BY_HOST: ReadonlyArray<{ suffix: string; origin: string }> = [
        { suffix: 'jio.com', origin: 'https://jioplus2plugx.lovable.app' }
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

/** The explicit Origin override for a host (round 34), or null. */
function originFor(hostname: string): string | null {
        const host = hostname.toLowerCase().replace(/\.$/, '');
        for (const entry of ORIGIN_BY_HOST) {
                if (host === entry.suffix || host.endsWith(`.${entry.suffix}`)) return entry.origin;
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
                // Round 34 — the explicit per-host Origin map wins (Jio's CDN
                // validates Origin against the provider site's exact origin);
                // everything else keeps the Referer-derived fallback.
                const origin = originFor(target.hostname)
                        ?? (requiredReferer ? requiredReferer.replace(/\/$/, '') : target.origin);

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
                // 2026-10 round 23 — detect API paths (e.g. vidsrc.party/api/play/...)
                // and send AJAX headers (Accept: application/json, sec-fetch-dest: empty)
                // instead of document-navigation headers. Cloudflare's bot detection
                // treats API calls differently from page navigations.
                const isApiPath = pathLower.includes('/api/');
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
                        : isApiPath
                        ? {
                                referer,
                                origin,
                                'user-agent': BROWSER_UA,
                                accept: 'application/json, text/plain, */*',
                                'accept-language': 'en-US,en;q=0.9',
                                'accept-encoding': 'gzip, deflate, br',
                                'sec-fetch-dest': 'empty',
                                'sec-fetch-mode': 'cors',
                                'sec-fetch-site': 'same-site'
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

                // 2026-10 round 29 — forward the x-livetv-cookie header as the
                // Cookie header to the upstream CDN. Browsers can't set the
                // Cookie header directly, so the client passes it as
                // x-livetv-cookie and the Worker translates it. Used by Jio CDN
                // streams that require the __hdnea__ session cookie. Set BEFORE
                // the HEAD probe so availability probes see the same DRM
                // identity as the real GET.
                const livetvCookie = request.headers.get('x-livetv-cookie');
                if (livetvCookie) headers.cookie = livetvCookie;

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

                // 2026-10 round 16 — 10s hard timeout on the upstream fetch.
                // If VidSrc/2embed takes longer than 10s, abort and return a
                // 504 Gateway Timeout so the scraper can fall back fast
                // (instead of hanging until the Worker's own runtime limit).
                const UPSTREAM_TIMEOUT_MS = 10_000;
                let upstream: Response;
                try {
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
                        try {
                                upstream = await fetch(target.toString(), { headers, redirect: 'follow', signal: controller.signal });
                        } finally {
                                clearTimeout(timer);
                        }
                } catch (error) {
                        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
                                return jsonError(504, 'GATEWAY_TIMEOUT', `The upstream took longer than ${UPSTREAM_TIMEOUT_MS}ms to respond.`);
                        }
                        return jsonError(502, 'UPSTREAM_UNREACHABLE', 'The media host could not be reached.');
                }

                // 2026-10 round 10 — Task 3: handle 404 (stream offline / expired link).
                // Return a clear JSON error so the player can show a helpful message.
                // 2026-10 round 32 — DEBUGGING: log the exact upstream status so Jio
                // DRM failures are diagnosable via `wrangler tail` (403 = cookie/
                // Origin rejected, 401 = token expired, 404 = stream gone). Host +
                // path only — the query string (signed token) is NEVER logged.
                if (!upstream.ok) {
                        console.error(`[stream-proxy] upstream HTTP ${upstream.status} for ${target.host}${target.pathname}${livetvCookie ? ' (drm cookie attached)' : ' (no drm cookie)'}`);
                }
                if (upstream.status === 404) {
                        return jsonError(404, 'STREAM_NOT_FOUND', 'This stream is currently offline or the link has expired.');
                }
                // 2026-10 round 10 — Task 3: handle 410 Gone (expired).
                if (upstream.status === 410) {
                        return jsonError(410, 'STREAM_EXPIRED', 'This stream link has expired.');
                }

                const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
                // pathLower is already declared above (round 15 document-header
                // block) — reuse it here for manifest detection.
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
