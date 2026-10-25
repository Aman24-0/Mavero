/**
 * HLS manifest rewriting for the Live TV stream proxy.
 *
 * Kept in its own module (NOT exported from the +server.ts endpoint) because
 * SvelteKit only allows endpoint exports (GET/POST/… or `_`-prefixed).
 *
 * Every segment line and every URI="…" attribute (#EXT-X-KEY, #EXT-X-MAP,
 * #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, …) is rewritten to route back
 * through the proxy. Relative URIs resolve against the manifest's FINAL url.
 *
 * `referer` (when supplied) is embedded on EVERY rewritten URI as `&r=…` so the
 * SEGMENT requests replay the exact Referer that made the manifest load — some
 * CDNs 403 segments that arrive with a different (or same-origin) Referer.
 */
import { LIVETV_STREAM_PROXY_PATH } from '$lib/shared/livetv-proxy';

export function rewriteHlsManifest(body: string, baseUrl: string, referer?: string | null): string {
	const base = new URL(baseUrl);
	const suffix = referer ? `&r=${encodeURIComponent(referer)}` : '';
	const proxify = (absUrl: string): string =>
		`${LIVETV_STREAM_PROXY_PATH}?u=${encodeURIComponent(absUrl)}${suffix}`;

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
