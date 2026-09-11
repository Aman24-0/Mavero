/**
 * MAVERO HLS signal detection (Phase 11, GOAL A).
 *
 * Phase 10's protocol detection depended on `pathname.endsWith('.m3u8')`.
 * Real signed addon HLS URLs frequently do NOT end in `.m3u8`:
 *
 *     https://host/path/file.m3u8?token=…          (query after the file)
 *     https://host/path/playlist?file=file.m3u8    (reference in the query)
 *     https://host/path/stream?id=…&format=m3u8    (format parameter)
 *     https://host/get_manifest?...#file.m3u8      (reference in the hash)
 *
 * Such URLs were normalized as protocol `unknown`, which:
 *   * denied them the "HLS" presentation label, and — much worse —
 *   * routed them to the native `<video src>` path on browsers without
 *     native HLS (every Chromium/Android browser), where they CANNOT play.
 * A legitimate HLS stream that used to play therefore degraded into a
 * "may not play"/unknown card and a guaranteed playback error — the
 * Phase 11 live-reported "HLS links no longer appear/play" regression.
 *
 * The detection pipeline uses ONLY safe, already-supplied signals — it
 * NEVER performs a network request to inspect Content-Type:
 *
 *   1. explicit Stremio/addon metadata indicating HLS (addon-supplied text
 *      carrying an unambiguous HLS/m3u8/mpegurl token);
 *   2. the URL pathname ending in `.m3u8`;
 *   3. a legitimate `.m3u8`/`format=m3u8`-style reference inside the URL
 *      query or hash;
 *   4. addon name/title/description/filename carrying an explicit HLS
 *      signal (handled by the caller passing addon text);
 *   5. otherwise: unknown (never guessed from unrelated words).
 *
 * Pure module: no DOM, no network, no imports — shared by the server
 * protocol classifier and the client engine routing so the two sides can
 * never disagree about what counts as HLS.
 */

/**
 * Unambiguous HLS tokens (lowercase). A token match requires a word-ish
 * boundary: "m3u8" inside "playlist.m3u8" matches; "hls" inside "shelso"
 * does not. Deliberately NARROW — ordinary words never become an HLS
 * signal ("thriller", "hlsr"… are ignored).
 */
const HLS_TOKENS: readonly string[] = ['hls', 'm3u8', 'mpegurl', 'x-mpegurl', 'vnd.apple.mpegurl'];

/**
 * Query/hash parameter VALUES that explicitly declare an m3u8 format
 * (`format=m3u8`, `type=m3u8`, `ext=m3u8`). The parameter NAME is not
 * restricted — addons use a zoo of names (format/f/ext/type/extension/
 * playlist_format/…) and a false positive would require the value to be
 * exactly an HLS token anyway.
 */
const HLS_FORMAT_VALUES: ReadonlySet<string> = new Set(['m3u8', 'mpegurl', 'x-mpegurl', 'vnd.apple.mpegurl']);

/** True when `token` appears in `text` at a word-ish boundary. */
function containsHlsToken(text: string): boolean {
  const lowered = text.toLowerCase();
  return HLS_TOKENS.some((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(lowered);
  });
}

/**
 * True when the URL itself carries a legitimate HLS reference beyond the
 * pathname: a `.m3u8` (or mpegurl-style) reference inside the QUERY string
 * or the HASH. The pathname is checked separately (priority 2).
 */
export function urlCarriesHlsReference(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  // Query string: any parameter VALUE equal to an HLS format token
  // (`format=m3u8`), or any query value/path segment that references a
  // `.m3u8` file (`file=file.m3u8`, `playlist=.../index.m3u8`).
  const query = parsed.search.slice(1);
  if (query) {
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      const value = eq >= 0 ? pair.slice(eq + 1) : pair;
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        // keep the raw value — decoding must never throw
      }
      const normalized = decoded.trim().toLowerCase();
      if (HLS_FORMAT_VALUES.has(normalized)) return true;
      if (/\.m3u8(?:$|[&\s])/i.test(normalized) || normalized.endsWith('.m3u8')) return true;
    }
  }

  // Hash: `#file.m3u8`-style references (some signed packagers place the
  // playlist name in the fragment).
  const hash = parsed.hash.slice(1);
  if (hash) {
    let decoded = hash;
    try {
      decoded = decodeURIComponent(hash);
    } catch {
      // keep the raw value
    }
    if (decoded.trim().toLowerCase().endsWith('.m3u8')) return true;
  }
  return false;
}

/** True when the URL PATHNAME ends with `.m3u8` (case-insensitive). */
export function urlPathIsM3u8(raw: string): boolean {
  try {
    return new URL(raw).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

/**
 * Addon-supplied text fields that may explicitly indicate HLS. Only text
 * the ADDON itself wrote is eligible — never derived metadata, never the
 * content title, never the addon display name (Phase 9/11 no-invention
 * rules). Passing no text simply skips this signal level.
 */
export type HlsMetadataSignals = {
  name?: string;
  title?: string;
  description?: string;
  filename?: string;
};

/**
 * The addon-supplied metadata signal (priority 1/4): true only when one of
 * the addon's OWN text fields carries an unambiguous HLS token. This is
 * metadata the addon deliberately wrote — "HLS" in a stream title or an
 * `.m3u8` filename is a real protocol statement, not a guess.
 */
export function metadataCarriesHlsSignal(metadata: HlsMetadataSignals | undefined): boolean {
  if (!metadata) return false;
  for (const text of [metadata.name, metadata.title, metadata.description, metadata.filename]) {
    if (typeof text === 'string' && text && containsHlsToken(text)) return true;
  }
  return false;
}

/**
 * The FULL detection pipeline (GOAL A priorities 1→4). Returns true when a
 * legitimate HLS signal exists. Priority:
 *   1+4. explicit addon metadata (checked FIRST — it is the strongest,
 *        deliberate signal and covers extensionless signed URLs);
 *   2.   pathname `.m3u8`;
 *   3.   query/hash `.m3u8`/format reference;
 *   (5. otherwise false — "unknown", never a guess).
 */
export function hasLegitimateHlsSignal(raw: string, metadata?: HlsMetadataSignals): boolean {
  if (metadataCarriesHlsSignal(metadata)) return true;
  if (urlPathIsM3u8(raw)) return true;
  return urlCarriesHlsReference(raw);
}
