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
 * SCOPE: HLS ONLY. DASH manifests are not rewritten (too complex/risky for the
 * Netlify function limits); DASH-only channels fall back to an honest message.
 *
 * SECURITY: the allowlist below is the primary control that keeps this from
 * becoming an open proxy/relay. Add a suffix here ONLY for a CDN you intend to
 * proxy. The server also applies the shared SSRF guard (no private IPs, https
 * only) and re-validates every redirect hop.
 */

/** The proxy endpoint path (same-origin, served by the SvelteKit app). */
export const LIVETV_STREAM_PROXY_PATH = '/api/livetv/stream-proxy';

/** CDN host suffixes whose HLS playback must go through the proxy. */
export const LIVETV_PROXY_HOST_SUFFIXES: readonly string[] = ['hotstar.com', 'slivcdn.com', 'jio.com'];

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
 * Per-CDN Referer/Origin the upstream REQUIRES. Several IPTV CDNs 403 both the
 * browser and a same-origin Referer — they want the PROVIDER site's origin.
 * Keyed by CDN host suffix so a new source only needs an entry here (the
 * "dynamic Referer mapping" — no code changes per source).
 */
export const LIVETV_PROXY_REFERER_BY_HOST: ReadonlyArray<{ suffix: string; referer: string }> = [
	{ suffix: 'slivcdn.com', referer: 'https://premiumplugx.com/' },
	{ suffix: 'hotstar.com', referer: 'https://premiumplugx.com/' },
	{ suffix: 'jio.com', referer: 'https://www.jio.com/' }
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
