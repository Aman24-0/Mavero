/**
 * HLS manifest rewriting for the Live TV stream proxy.
 *
 * Kept in its own module (NOT exported from the +server.ts endpoint) because
 * SvelteKit only allows endpoint exports (GET/POST/… or `_`-prefixed) — a named
 * helper export there fails the build.
 *
 * Every segment line and every URI="…" attribute (#EXT-X-KEY, #EXT-X-MAP,
 * #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, …) is rewritten to route back
 * through the proxy. Relative URIs resolve against the manifest's FINAL url.
 */
import { LIVETV_STREAM_PROXY_PATH } from '$lib/shared/livetv-proxy';

/** Same-origin proxy URL for an absolute media URL. */
function proxify(absUrl: string): string {
	return `${LIVETV_STREAM_PROXY_PATH}?u=${encodeURIComponent(absUrl)}`;
}

export function rewriteHlsManifest(body: string, baseUrl: string): string {
	const base = new URL(baseUrl);
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
