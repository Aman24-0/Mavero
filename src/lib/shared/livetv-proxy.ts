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
export const LIVETV_PROXY_HOST_SUFFIXES: readonly string[] = ['hotstar.com', 'slivcdn.com'];

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
export function livetvStreamProxyUrl(absUrl: string): string {
	return `${LIVETV_STREAM_PROXY_PATH}?u=${encodeURIComponent(absUrl)}`;
}
