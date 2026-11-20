/**
 * Live TV HLS stream-proxy contract — SHARED by the server proxy endpoint and
 * the client router so the allowlist and the URL shape can never drift.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some provider CDNs (e.g. `*.hotstar.com`, `*.slivcdn.com`) block cross-origin
 * browser requests — either via CORS ("No 'Access-Control-Allow-Origin'") or by
 * 403-ing the browser outright. HLS playback for those hosts therefore routes
 * through `/api/livetv/stream-proxy`, which fetches the manifest + segments
 * SERVER-SIDE (SSRF-guarded, origin-allowlisted) and rewrites the manifest so
 * every segment/key/variant URI also travels through the proxy.
 *
 * SCOPE: HLS + DASH (.mpd). 2026-10 round 6: DASH manifests are now
 * rewritten by the Cloudflare Worker proxy (BaseURL + segment URLs).
 * The in-app SvelteKit proxy endpoint handles HLS; DASH goes through
 * the Worker when PUBLIC_STREAM_PROXY_URL is set.
 *
 * SECURITY: the allowlist below is the primary control that keeps this from
 * becoming an open proxy/relay. Add a suffix here ONLY for a CDN you intend to
 * proxy. The server also applies the shared SSRF guard (no private IPs, https
 * only) and re-validates every redirect hop.
 */

/** The proxy endpoint path (same-origin, served by the SvelteKit app). */
export const LIVETV_STREAM_PROXY_PATH = '/api/livetv/stream-proxy';

/** CDN host suffixes whose HLS/DASH playback must go through the proxy. */
export const LIVETV_PROXY_HOST_SUFFIXES: readonly string[] = ['hotstar.com', 'slivcdn.com', 'jio.com', 'jiocinema.com', 'premiumplugx.com', 'cloudnestra.com', 'stellarconductornexus.com', 'vidsrc.party', 'cookiebakers23blog.xyz', 'cno.to', 'vidcore.org'];

/** True when `hostname` is (or is a subdomain of) an allowlisted proxy CDN. */
export function isLivetvProxyHost(hostname: string): boolean {
        const host = hostname.toLowerCase().replace(/\.$/, '');
        return LIVETV_PROXY_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when an absolute URL's host must be proxied. Safe on malformed input. */
export function isLivetvProxyUrl(rawUrl: string): boolean {
        try {
                return isLivetvProxyHost(new URL(rawUrl).hostname);
        } catch {
                return false;
        }
}

/** The same-origin proxy URL for an absolute media URL. */
export function livetvStreamProxyUrl(absUrl: string, base = ''): string {
        const root = base ? `${base.replace(/\/+$/, '')}/` : LIVETV_STREAM_PROXY_PATH;
        return `${root}?u=${encodeURIComponent(absUrl)}`;
}

/**
 * 2026-11 round 36 — the stream format an absolute URL's PATH extension
 * establishes (the M3U adapter's own rule: format is NEVER invented). The
 * Indian-proxy manifest URL adds the matching extension so the player picks
 * the right parser and the proxy answers with the right Content-Type.
 */
export function livetvStreamFormatForUrl(rawUrl: string): 'dash' | 'hls' | null {
        try {
                const pathname = new URL(rawUrl).pathname.toLowerCase();
                if (pathname.endsWith('.mpd')) return 'dash';
                if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u')) return 'hls';
                return null;
        } catch {
                return null;
        }
}

/**
 * 2026-11 round 36 — the STANDALONE INDIAN PROXY contract
 * (indian-proxy/server.js in the repo root — a Node/Express service deployed
 * on an Indian VPS or Render.com). Jio's CDNs 451 every non-Indian egress IP
 * (the Cloudflare Worker's included) — a geo-block NO header spoofing can
 * fix; the stream must LEAVE the internet from an IP Jio accepts.
 *
 * Unlike the Worker's generic `?u=` passthrough, the Indian proxy is
 * PLAYLIST-AWARE: it syncs the Jio M3U every 5 hours (the `__hdnea__`
 * cookies expire every 6), injects the per-channel Cookie/User-Agent/Referer
 * server-side and REWRITES DASH/HLS manifests back onto itself
 * (`/api/ch/:id/dash/…`, `/api/ch/:id/u/<b64>`). The app hands it the
 * channel's EXACT playlist URL (`?u=`) and the format extension; a URL the
 * proxy has not synced falls through to its generic rewriting passthrough.
 */
export function indianProxyManifestUrl(absUrl: string, base: string, format: 'dash' | 'hls' | null): string {
        const root = base.replace(/\/+$/, '');
        const ext = format === 'dash' ? '.mpd' : format === 'hls' ? '.m3u8' : '';
        return `${root}/api/ch/by-url/manifest${ext}?u=${encodeURIComponent(absUrl)}`;
}

/**
 * 2026-11 round 35 — CDN host suffixes that GEO-BLOCK every non-Indian
 * egress IP with `451 Unavailable For Legal Reasons` (Jio). A geo-block is
 * an IP-classification decision — NO Referer/Origin spoofing can fix it; the
 * stream needs a proxy that egresses from India (`PUBLIC_INDIAN_PROXY_URL`).
 * The playback router uses this to fail a Jio candidate FAST with an honest
 * message instead of burning the startup watchdog on a guaranteed 451.
 */
export const LIVETV_GEOBLOCKED_HOST_SUFFIXES: readonly string[] = ['jio.com', 'jiocinema.com'];

/** True when `hostname` is (or is a subdomain of) a geo-blocked (India-only) CDN. */
export function isLivetvGeoblockedHost(hostname: string): boolean {
        const host = hostname.toLowerCase().replace(/\.$/, '');
        return LIVETV_GEOBLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when an absolute URL's host is geo-blocked (India-only). Safe on malformed input. */
export function isLivetvGeoblockedUrl(rawUrl: string): boolean {
        try {
                return isLivetvGeoblockedHost(new URL(rawUrl).hostname);
        } catch {
                return false;
        }
}

/**
 * Per-CDN Referer/Origin the upstream REQUIRES. Several IPTV CDNs 403 both the
 * browser and a same-origin Referer — they want the PROVIDER site's origin.
 * Keyed by CDN host suffix so a new source only needs an entry here (the
 * "dynamic Referer mapping" — no code changes per source).
 */
export const LIVETV_PROXY_REFERER_BY_HOST: ReadonlyArray<{ suffix: string; referer: string }> = [
        { suffix: 'slivcdn.com', referer: 'https://www.sonyliv.com/' },
        { suffix: 'hotstar.com', referer: 'https://www.hotstar.com/' },
        // 2026-11 round 34 — Jio's CDN 403s any other Origin/Referer: the
        // official provider site sends Origin https://jioplus2plugx.lovable.app
        // + Referer https://jioplus2plugx.lovable.app/ — spoof exactly those
        // (the in-app proxy derives Origin from this value by stripping the
        // trailing slash; the Cloudflare Worker carries the same entry).
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

/** The required Referer for a host (provider origin), or null. */
export function livetvProxyRefererFor(hostname: string): string | null {
        const host = hostname.toLowerCase().replace(/\.$/, '');
        for (const entry of LIVETV_PROXY_REFERER_BY_HOST) {
                if (host === entry.suffix || host.endsWith(`.${entry.suffix}`)) return entry.referer;
        }
        return null;
}

/** A standard desktop Chrome User-Agent (CDNs frequently block non-browser UAs). */
export const LIVETV_PROXY_BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
