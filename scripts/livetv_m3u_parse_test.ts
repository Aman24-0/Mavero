/**
 * UNIFIED LIVE TV — Phase 2 M3U/M3U8 playlist parser verification (pure).
 *
 * Covers the Phase 2 brief §4 requirements:
 *   §1  valid parsing — ordinary #EXTM3U/#EXTINF entries, attribute
 *       preservation (tvg-id/tvg-name/tvg-logo/group-title), display names,
 *       stream URL + established format, bounded non-sensitive metadata.
 *   §2  attribute robustness — quoted/unquoted values, optional attributes,
 *       common ordering variations, titles containing commas, #EXTGRP.
 *   §3  malformed-line isolation — broken lines never crash the playlist;
 *       per-entry diagnostics; parse continues.
 *   §4  bounds — entry cap, line-length cap, parse deadline, missing header.
 *   §5  URL validation/classification — https-only, no credentials,
 *       extension-only format establishment, NO invented formats, no web
 *       pages treated as manifests.
 *   §6  identity + dedup — tvg-id identity, deterministic URL-hash identity,
 *       duplicate URLs deduped, same-tvg-id multi-endpoint accumulation,
 *       display names NEVER used for identity.
 *   §7  hostile input safety — control characters, BOM, CRLF, huge playlists
 *       (cap enforcement), never treated as executable code/HTML.
 *
 * NO network, NO database.
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import {
  parseM3UPlaylist,
  classifyM3UStreamUrl,
  parseM3UAttributes,
  splitExtinfLine,
  m3uIdentityForUrl,
  normalizeM3ULogoUrl,
  m3uPlaylistAdapter,
  M3U_MAX_ENTRIES
} from '../src/lib/server/livetv/adapters/m3u';
import { LivetvAdapterError } from '../src/lib/server/livetv/adapters/types';

// ============================================================
console.log('§1 valid parsing');
// ============================================================
{
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="news.one" tvg-name="News One Raw" tvg-logo="https://cdn.example/news.png" group-title="News",News One',
    'https://cdn.example/live/news.m3u8',
    '#EXTINF:-1 tvg-id="sports.hd" tvg-logo="https://cdn.example/sports.png" group-title="Sports",Sports HD',
    'https://cdn.example/live/sports.mpd'
  ].join('\n');
  const result = parseM3UPlaylist(playlist);
  ok(result.channels.length === 2, '§1.1 both entries normalized');
  const news = result.channels[0]!;
  ok(news.sourceChannelId === 'news.one' && news.tvgId === 'news.one', '§1.2 tvg-id preserved as identity');
  ok(news.name === 'News One', '§1.3 display name is the EXTINF title (not tvg-name)');
  ok(news.logoUrl === 'https://cdn.example/news.png', '§1.4 tvg-logo preserved');
  ok(news.category === 'News', '§1.5 group-title preserved as category');
  ok(news.metadata['tvgName'] === 'News One Raw', '§1.6 tvg-name preserved as provenance metadata');
  ok(news.endpoints.length === 1 && news.endpoints[0]!.endpointKind === 'direct_stream' && news.endpoints[0]!.streamFormat === 'hls', '§1.7 .m3u8 classified as hls direct_stream');
  ok(result.channels[1]!.endpoints[0]!.streamFormat === 'dash', '§1.8 .mpd classified as dash direct_stream');
  ok(result.diagnostics.discoveredCount === 2 && result.diagnostics.skippedCount === 0, '§1.9 clean diagnostics for a clean playlist');
}

// ============================================================
console.log('§2 attribute robustness');
// ============================================================
{
  const attrs = parseM3UAttributes('tvg-id="a b" tvg-name=Bare group-title="Movies, Films" catchup="append"');
  ok(attrs.values.get('tvg-id') === 'a b', '§2.1 quoted value with space parsed');
  ok(attrs.values.get('tvg-name') === 'Bare', '§2.2 unquoted value parsed');
  ok(attrs.values.get('group-title') === 'Movies, Films', '§2.3 comma inside quotes preserved');
  ok(attrs.values.get('catchup') === 'append', '§2.4 unknown attribute captured');
  ok(attrs.malformedAttributeCount === 0, '§2.5 well-formed attributes produce no malformed count');
}
{
  const attrs = parseM3UAttributes('x= tvg-id="quoted"');
  ok(attrs.malformedAttributeCount >= 1, '§2.6 a bare token without = is counted malformed');
  ok(attrs.values.get('tvg-id') === 'quoted', '§2.7 parsing continues after a malformed attribute');
}
{
  const split = splitExtinfLine('-1 tvg-id="x,y",Title, with, commas');
  ok(split!.info === '-1 tvg-id="x,y"' && split!.title === 'Title, with, commas', '§2.8 the FIRST unquoted comma splits info from title');
}
{
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1,Simple',
    'https://cdn.example/a.m3u8',
    '#EXTM3U-duplicate-ignored',
    '#EXTGRP: fallback group',
    '#EXTINF:0 tvg-id="g.one",Grouped',
    'https://cdn.example/g.m3u8',
    '#EXTINF:-1 group-title="Override",Explicit',
    'https://cdn.example/o.m3u8'
  ].join('\n');
  const result = parseM3UPlaylist(playlist);
  const grouped = result.channels.find((c) => c.sourceChannelId === 'g.one')!;
  ok(grouped.category === 'fallback group', '§2.9 #EXTGRP provides the category when no group-title exists');
  const explicit = result.channels.find((c) => c.name === 'Explicit')!;
  ok(explicit.category === 'Override', '§2.10 explicit group-title wins over #EXTGRP for the next entry');
}
{
  // CRLF + BOM + leading blank lines + trailing whitespace lines.
  const playlist = '\uFEFF#EXTM3U\r\n\r\n#EXTINF:-1 tvg-id="crlf.one",CRLF Chan\r\nhttps://cdn.example/crlf.m3u8\r\n\r\n   \r\n';
  const result = parseM3UPlaylist(playlist);
  ok(result.channels.length === 1 && result.channels[0]!.sourceChannelId === 'crlf.one', '§2.11 BOM + CRLF + blank lines tolerated');
}

// ============================================================
console.log('§3 malformed-line isolation');
// ============================================================
{
  const playlist = [
    '#EXTM3U',
    '#EXTINFbroken no colon',
    '#EXTINF:-1 tvg-id="good.one",Good',
    'https://cdn.example/good.m3u8',
    '#EXTINF:-1,No Url Follows',
    '#EXTINF:-1 tvg-id="also.good",Also Good',
    'https://cdn.example/also.m3u8',
    '#EXTINF:-1',
    'https://cdn.example/noname.m3u8',
    '#EXTINF:-1 tvg-id="t.air",Trail',
    'https://cdn.example/trailing.m3u8',
    '#EXTINF:-1 tvg-id="never.finished",Dangling'
  ].join('\n');
  const result = parseM3UPlaylist(playlist);
  ok(result.channels.length === 3, '§3.1 valid entries survive malformed neighbors');
  ok(result.diagnostics.discoveredCount === 3, '§3.2 discovered count reflects successes');
  ok(result.diagnostics.skippedCount === 4, '§3.3 each malformed entry skipped exactly once (broken pending + No-Url + noname + dangling)');
  const reasons = result.diagnostics.entryErrors.map((e) => e.reason).sort();
  ok(JSON.stringify(reasons) === JSON.stringify(['missing_name', 'missing_stream_url', 'missing_stream_url', 'missing_stream_url']), '§3.4 typed per-entry reasons');
  ok(!!result.diagnostics.entryErrors, '§3.5 structured diagnostics exist');
}

// ============================================================
console.log('§4 bounds and policy failures (whole-source, typed)');
// ============================================================
{
  // Entry cap.
  const lines = ['#EXTM3U'];
  for (let i = 0; i <= M3U_MAX_ENTRIES; i += 1) {
    lines.push(`#EXTINF:-1 tvg-id="cap.${i}",Chan ${i}`, `https://cdn.example/${i}.m3u8`);
  }
  let capError: unknown = null;
  try {
    parseM3UPlaylist(lines.join('\n'));
  } catch (error) {
    capError = error;
  }
  ok(capError instanceof LivetvAdapterError && capError.kind === 'entry_cap_exceeded', '§4.1 entry cap fails the source with a typed error (never partial ingestion)');
}
{
  // Pathological line length.
  const huge = 'x'.repeat(100_000);
  const playlist = ['#EXTM3U', `#EXTINF:-1 tvg-id="${huge}",Big`, 'https://cdn.example/big.m3u8'].join('\n');
  const result = parseM3UPlaylist(playlist, { maxLineLength: 64_000 });
  ok(result.channels.length === 0, '§4.2a over-long line is unusable — no entry ingested, playlist does not crash');
  ok(result.diagnostics.skippedCount === 2 && result.diagnostics.skippedReasons['line_too_long'] === 1 && result.diagnostics.skippedReasons['orphan_stream_url'] === 1, '§4.2b the over-long EXTINF is skipped as line_too_long; its stranded URL becomes an orphan (no crash)');
}
{
  // Parse deadline.
  const lines = ['#EXTM3U'];
  for (let i = 0; i < 5000; i += 1) {
    lines.push(`#EXTINF:-1 tvg-id="d.${i}",D ${i}`, `https://cdn.example/d${i}.m3u8`);
  }
  let deadlineError: unknown = null;
  let fakeNow = 0;
  try {
    parseM3UPlaylist(lines.join('\n'), { parseDeadlineMs: 5, now: () => (fakeNow += 1000) });
  } catch (error) {
    deadlineError = error;
  }
  ok(deadlineError instanceof LivetvAdapterError && deadlineError.kind === 'parse_deadline_exceeded', '§4.3 exceeded parse deadline fails the source with a typed error');
}
{
  // Missing #EXTM3U header.
  for (const bad of ['#EXTINF:-1,No Header\nhttps://cdn.example/x.m3u8', 'https://cdn.example/bare.m3u8']) {
    let headerError: unknown = null;
    try {
      parseM3UPlaylist(bad);
    } catch (error) {
      headerError = error;
    }
    ok(headerError instanceof LivetvAdapterError && headerError.kind === 'parse_failed', '§4.4 missing header rejected (strict #EXTM3U enforcement)');
  }
}
{
  // Cancellation between lines.
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  try {
    parseM3UPlaylist('#EXTM3U\n#EXTINF:-1,X\nhttps://cdn.example/x.m3u8', { signal: controller.signal });
  } catch (error) {
    cancelled = error instanceof LivetvAdapterError && error.kind === 'cancelled';
  }
  ok(cancelled, '§4.5 cancellation honored mid-parse');
}

// ============================================================
console.log('§5 URL validation + conservative classification');
// ============================================================
{
  ok(classifyM3UStreamUrl('https://cdn.example/live/stream.m3u8?token=abc').ok === true, '§5.1 .m3u8 with query classified hls (query ignored)');
  ok(classifyM3UStreamUrl('https://cdn.example/live/stream.M3U8').ok === true, '§5.2 uppercase extension classified (path lowercased)');
  ok(classifyM3UStreamUrl('https://cdn.example/live/stream.MPD').ok === true, '§5.3 uppercase .mpd classified dash');
  const page = classifyM3UStreamUrl('https://cdn.example/embed/143');
  ok(page.ok === false && page.reason === 'unknown_stream_format', '§5.4 an embed/player page is NEVER treated as a manifest');
  const html = classifyM3UStreamUrl('https://cdn.example/watch.html');
  ok(html.ok === false && html.reason === 'unknown_stream_format', '§5.5 .html never a manifest');
  const http = classifyM3UStreamUrl('http://cdn.example/live.m3u8');
  ok(http.ok === false && http.reason === 'non_https_stream_url', '§5.6 http:// rejected (https-only policy)');
  const creds = classifyM3UStreamUrl('https://user:pass@cdn.example/live.m3u8');
  ok(creds.ok === false && creds.reason === 'url_credentials_rejected', '§5.7 credentials in URL rejected');
  const queryHint = classifyM3UStreamUrl('https://cdn.example/play?id=1&type=m3u8');
  ok(queryHint.ok === false && queryHint.reason === 'unknown_stream_format', '§5.8 query-param format hints NOT trusted (no invented formats)');
  const extless = classifyM3UStreamUrl('https://cdn.example/stream');
  ok(extless.ok === false && extless.reason === 'unknown_stream_format', '§5.9 extensionless URLs skipped, not guessed');
  const long = classifyM3UStreamUrl(`https://cdn.example/${'a'.repeat(3000)}.m3u8`);
  ok(long.ok === false && long.reason === 'url_too_long', '§5.10 over-long URL rejected');
  const ftp = classifyM3UStreamUrl('ftp://cdn.example/live.m3u8');
  ok(ftp.ok === false && ftp.reason === 'non_https_stream_url', '§5.11 non-http(s) scheme rejected');
  ok(m3uIdentityForUrl('https://a.example/1.m3u8') === m3uIdentityForUrl('https://a.example/1.m3u8'), '§5.12 URL identity deterministic');
  ok(m3uIdentityForUrl('https://a.example/1.m3u8') !== m3uIdentityForUrl('https://a.example/2.m3u8'), '§5.13 distinct URLs → distinct identities');
}

// ============================================================
console.log('§6 identity + dedup semantics');
// ============================================================
{
  // Same tvg-id, two URLs → ONE entry with TWO endpoints (ordered).
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="dual.one" tvg-logo="https://cdn.example/one.png",Dual One',
    'https://cdn.example/dual-a.m3u8',
    '#EXTINF:-1 tvg-id="dual.one",Dual One (backup)',
    'https://cdn.example/dual-b.m3u8',
    '#EXTINF:-1 tvg-id="dual.one",Dual One (backup again)',
    'https://cdn.example/dual-a.m3u8'
  ].join('\n');
  const result = parseM3UPlaylist(playlist);
  ok(result.channels.length === 1, '§6.1 same tvg-id stays ONE source entry');
  const dual = result.channels[0]!;
  ok(dual.endpoints.length === 2, '§6.2 distinct URLs become additional typed endpoints');
  ok(dual.endpoints[0]!.url === 'https://cdn.example/dual-a.m3u8' && dual.endpoints[1]!.url === 'https://cdn.example/dual-b.m3u8', '§6.3 endpoint order deterministic (appearance order)');
  ok(dual.endpoints[1]!.ordering === 1, '§6.4 endpoint ordering index assigned');
  ok(dual.name === 'Dual One', '§6.5 first name wins (no rename churn)');
  ok(result.diagnostics.skippedCount === 1 && result.diagnostics.skippedReasons['duplicate_channel_id'] === 1, '§6.6 exact duplicate URL skipped with a reason');
  ok(dual.logoUrl === 'https://cdn.example/one.png', '§6.7 provenance from the first occurrence preserved');
}
{
  // Identical display names, different tvg-ids → separate entries (name NEVER identity).
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="src.a",Example News',
    'https://cdn.example/a.m3u8',
    '#EXTINF:-1 tvg-id="src.b",Example News',
    'https://cdn.example/b.m3u8'
  ].join('\n');
  const result = parseM3UPlaylist(playlist);
  ok(result.channels.length === 2, '§6.8 identical display names NEVER merge (no name-only dedup)');
}
{
  // No tvg-id → deterministic URL-hash identity, stable across runs.
  const playlist = '#EXTM3U\n#EXTINF:-1,No Id\nhttps://cdn.example/noid.m3u8';
  const first = parseM3UPlaylist(playlist).channels[0]!;
  const second = parseM3UPlaylist(playlist).channels[0]!;
  ok(first.sourceChannelId === second.sourceChannelId && first.sourceChannelId.startsWith('m3u-'), '§6.9 URL-hash identity stable across refreshes');
}

// ============================================================
console.log('§7 hostile-input safety');
// ============================================================
{
  // Control characters in attributes/names never enter the model — the
  // entry is conservatively skipped with a typed reason (nothing stored).
  const playlist = '#EXTM3U\n#EXTINF:-1 tvg-id="bad\x01id" tvg-name="na\x07me",Tit\x1ble\nhttps://cdn.example/bad.m3u8';
  const result = parseM3UPlaylist(playlist);
  ok(result.channels.length === 0, '§7.1 a hostile-name entry is never ingested');
  ok(result.diagnostics.skippedCount === 1 && result.diagnostics.entryErrors[0]!.reason === 'missing_name', '§7.2 hostile display metadata → typed missing_name skip');
  const serialized = JSON.stringify(result);
  ok(!serialized.includes('\x01') && !serialized.includes('\x07') && !serialized.includes('\x1b'), '§7.3 control characters never persisted anywhere in the result');
}
{
  // A hostile tvg-id alone (valid title) degrades to URL identity; the
  // attribute is dropped but the channel survives.
  const playlist = '#EXTM3U\n#EXTINF:-1 tvg-id="bad\x01id",Valid Title\nhttps://cdn.example/bad.m3u8';
  const result = parseM3UPlaylist(playlist);
  const bad = result.channels[0]!;
  ok(bad.sourceChannelId.startsWith('m3u-') && bad.tvgId === null, '§7.4 hostile tvg-id degrades to URL-hash identity; attribute never stored');
}
{
  // Directive lines with credential-looking payloads are ignored, never stored.
  const playlist = '#EXTM3U\n#EXTVLCOPT:http-user-agent=SECRET-AGENT\n#KODIPROP:inputstream=SECRET\n#EXTINF:-1 tvg-id="safe.one",Safe\nhttps://cdn.example/safe.m3u8';
  const result = parseM3UPlaylist(playlist);
  const safe = result.channels[0]!;
  ok(result.channels.length === 1, '§7.5 directives do not break parsing');
  const serialized = JSON.stringify(safe);
  ok(!serialized.includes('SECRET-AGENT') && !serialized.includes('SECRET'), '§7.6 directive payloads (potential credentials) never persisted');
}
{
  // Over-long tvg-id degrades to URL identity; the attribute is dropped.
  const playlist = `#EXTM3U\n#EXTINF:-1 tvg-id="${'t'.repeat(250)}",Too Long Id\nhttps://cdn.example/tl.m3u8`;
  const result = parseM3UPlaylist(playlist);
  ok(result.channels.length === 1 && result.channels[0]!.sourceChannelId.startsWith('m3u-') && result.channels[0]!.tvgId === null, '§7.7 over-long tvg-id degrades safely');
}
{
  // Orphan URL lines are counted, never ingested.
  const result = parseM3UPlaylist('#EXTM3U\nhttps://cdn.example/orphan.m3u8\n#EXTINF:-1 tvg-id="ok.one",Ok\nhttps://cdn.example/ok.m3u8');
  ok(result.channels.length === 1 && result.diagnostics.skippedReasons['orphan_stream_url'] === 1, '§7.8 orphan stream URL counted and skipped');
}
{
  // Metadata stays bounded: >8 extra attributes are truncated.
  const attrPairs = Array.from({ length: 30 }, (_, i) => `xattr${i}="v${i}"`).join(' ');
  const playlist = `#EXTM3U\n#EXTINF:-1 ${attrPairs} tvg-id="attrs.one",Attrs\nhttps://cdn.example/attrs.m3u8`;
  const result = parseM3UPlaylist(playlist);
  const meta = JSON.stringify(result.channels[0]!.metadata);
  ok(result.channels.length === 1, '§7.9 attribute-heavy entry parses');
  ok(!meta.includes('xattr29'), '§7.10 extra-attribute preservation is bounded');
}

// ============================================================
console.log('§8 R-0 — adapter run: the playlist URL is body-validated, not extension-validated');
// ============================================================
{
  const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
  const RUN_SOURCE = { id: 'src-1', slug: 'acme', sourceType: 'm3u_playlist' as const, config: { playlistUrl: 'https://provider.example/get_playlist.php?username=u&password=p&type=m3u_plus' } };

  // 8.1-8.3 — a PHP endpoint with a query string is a VALID playlist URL as
  // long as the fetched BODY is a valid #EXTM3U playlist (the owner's real
  // provider shape). The URL extension never mattered.
  const phpOk = await m3uPlaylistAdapter.run(RUN_SOURCE, {
    fetcher: async () => new Response('#EXTM3U\n#EXTINF:-1 tvg-id="a.one" tvg-name="Alpha" tvg-logo="https://cdn.example/a.png" group-title="News",Alpha One\nhttps://cdn.example/live/a.m3u8?token=x', { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }),
    dnsResolver: PUBLIC_DNS
  });
  ok(phpOk.channels.length === 1 && phpOk.channels[0]!.sourceChannelId === 'a.one', '§8.1 a query-string (PHP) playlist URL fetches and parses end-to-end via the adapter');
  ok(phpOk.channels[0]!.name === 'Alpha One' && phpOk.channels[0]!.category === 'News' && phpOk.channels[0]!.logoUrl === 'https://cdn.example/a.png', '§8.2 EXTINF metadata (name/group-title/tvg-logo) is preserved through the run');
  ok(phpOk.channels[0]!.endpoints[0]!.streamFormat === 'hls' && phpOk.channels[0]!.endpoints[0]!.url === 'https://cdn.example/live/a.m3u8?token=x', '§8.3 the entry\u2019s own stream URL is independently classified (query string kept, format from the path)');

  // 8.4 — the fetch-level HTML gate: an HTML document (the PHP endpoint
  // answering with a login page) fails SAFELY with a typed error.
  let htmlError: unknown = null;
  try {
    await m3uPlaylistAdapter.run(RUN_SOURCE, {
      fetcher: async () => new Response('<html><body><h1>Sign in</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      dnsResolver: PUBLIC_DNS
    });
  } catch (error) {
    htmlError = error;
  }
  ok(htmlError instanceof LivetvAdapterError && htmlError.kind === 'unsupported_media_type', '§8.4 an HTML body fails safely (unsupported_media_type, never a fake empty playlist)');

  // 8.5 — an HTML-shaped body WITHOUT the html content-type still fails at
  // the parser (the #EXTM3U header gate — body validation is independent of
  // any content-type claim).
  let parseError: unknown = null;
  try {
    await m3uPlaylistAdapter.run(RUN_SOURCE, {
      fetcher: async () => new Response('<html><body>not a playlist</body></html>', { status: 200, headers: { 'content-type': 'text/plain' } }),
      dnsResolver: PUBLIC_DNS
    });
  } catch (error) {
    parseError = error;
  }
  ok(parseError instanceof LivetvAdapterError && parseError.kind === 'parse_failed', '§8.5 a non-playlist body fails the #EXTM3U header gate (parse_failed, content-type alone is never trusted)');

  // 8.6-8.7 — malformed entries inside an otherwise valid playlist stay
  // isolated: bounded diagnostics, the valid entries survive.
  const mixed = await m3uPlaylistAdapter.run(RUN_SOURCE, {
    fetcher: async () => new Response([
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="good.one",Good\nhttps://cdn.example/good.m3u8',
      '#EXTINF:-1 tvg-id="bad.one",Bad\nhttps://cdn.example/player.php?id=1',
      '#EXTINF:-1,NoUrl',
      '#EXTINF:-1 tvg-id="good.two",Also Good\nhttps://cdn.example/two.mpd'
    ].join('\n'), { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }),
    dnsResolver: PUBLIC_DNS
  });
  ok(mixed.channels.length === 2 && mixed.channels[0]!.sourceChannelId === 'good.one' && mixed.channels[1]!.sourceChannelId === 'good.two', '§8.6 malformed entries never crash an otherwise valid playlist (per-entry isolation)');
  ok(mixed.diagnostics.skippedCount === 2 && JSON.stringify(mixed.diagnostics.skippedReasons) === JSON.stringify({ unknown_stream_format: 1, missing_stream_url: 1 }), '§8.7 skipped entries carry bounded, static reasons (no URLs in diagnostics)');
  ok(mixed.diagnostics.entryErrors.every((entryError) => !entryError.reason.includes('http')), '§8.8 per-entry diagnostics carry static reasons only (never signed material or URLs)');
}

// ============================================================
console.log('§9 R-2 — relative stream URLs are resolved against the playlist base URL');
// ============================================================
{
  // 9.1 — relative URL with NO base: rejected (preserves pre-R-2 behavior).
  const noBase = classifyM3UStreamUrl('stream.m3u8');
  ok(noBase.ok === false && noBase.reason === 'invalid_stream_url', '§9.1 a relative URL with no base is rejected as invalid_stream_url (no invented host)');

  // 9.2 — relative URL WITH a valid https base: resolved and classified.
  const resolved = classifyM3UStreamUrl('stream.m3u8', 'https://provider.example/playlist.php?playlist=1');
  ok(resolved.ok === true && resolved.value.streamFormat === 'hls', '§9.2 a relative .m3u8 resolves against the playlist base URL');
  ok(resolved.value.url === 'https://provider.example/stream.m3u8', '§9.3 the resolved URL is the absolute https URL (query string of the base is dropped per RFC 3986)');

  // 9.3 — root-relative URL resolves against the base origin.
  const rootRel = classifyM3UStreamUrl('/live/channel.m3u8?token=abc', 'https://provider.example/path/playlist.php?id=1');
  ok(rootRel.ok === true && rootRel.value.url === 'https://provider.example/live/channel.m3u8?token=abc', '§9.4 root-relative URL keeps the base origin + its own path/query');

  // 9.4 — relative URL with .mpd extension resolves to dash.
  const relDash = classifyM3UStreamUrl('./dash/stream.mpd', 'https://provider.example/playlist.php');
  ok(relDash.ok === true && relDash.value.streamFormat === 'dash', '§9.5 relative .mpd resolves to dash');

  // 9.5 — relative URL resolving to a NON-https base is rejected (a base
  // protocol downgrade can never smuggle a non-https stream through).
  const httpBase = classifyM3UStreamUrl('stream.m3u8', 'http://provider.example/playlist.php');
  ok(httpBase.ok === false && httpBase.reason === 'invalid_stream_url', '§9.6 a non-https base is treated as no base (relative URL still rejected)');

  // 9.6 — base with credentials is rejected as a base (credentials never
  // leak into per-entry stream URLs through base resolution).
  const credsBase = classifyM3UStreamUrl('stream.m3u8', 'https://user:pass@provider.example/playlist.php');
  ok(credsBase.ok === false && credsBase.reason === 'invalid_stream_url', '§9.7 a base with credentials is treated as no base (no credential leakage)');

  // 9.7 — absolute URLs continue to work when a base is supplied (base is
  // ignored for absolute inputs — `new URL(abs, base)` returns abs).
  const abs = classifyM3UStreamUrl('https://cdn.example/live/news.m3u8?token=x', 'https://provider.example/playlist.php');
  ok(abs.ok === true && abs.value.url === 'https://cdn.example/live/news.m3u8?token=x', '§9.8 absolute URLs are unaffected by the presence of a base');

  // 9.8 — relative URL resolving to a NON-media path extension is still
  // rejected with `unknown_stream_format` (no format invented).
  const relUnknown = classifyM3UStreamUrl('player.html?id=1', 'https://provider.example/playlist.php');
  ok(relUnknown.ok === false && relUnknown.reason === 'unknown_stream_format', '§9.9 relative URL resolving to .html still rejected (no invented format)');

  // 9.9 — a relative URL with control characters is still rejected.
  const relCtl = classifyM3UStreamUrl('stream\x01.m3u8', 'https://provider.example/playlist.php');
  ok(relCtl.ok === false && relCtl.reason === 'invalid_stream_url', '§9.10 relative URL with control chars rejected');

  // 9.10 — the full parse flow with a base resolves a playlist of relative
  // URLs end-to-end (the production regression: 146 entries skipped with
  // `invalid_stream_url` because no base was supplied).
  const playlistBody = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="rel.1" tvg-name="Rel One" tvg-logo="https://cdn.example/one.png" group-title="News",Rel One',
    'stream/one.m3u8?token=abc',
    '#EXTINF:-1 tvg-id="rel.2" tvg-name="Rel Two",Rel Two',
    '/live/two.m3u8',
    '#EXTINF:-1 tvg-id="rel.3",Rel Three',
    './dash/three.mpd',
    '#EXTINF:-1 tvg-id="rel.4",Bad Ext',
    'player.html?id=4'
  ].join('\n');
  const result = parseM3UPlaylist(playlistBody, { playlistBaseUrl: 'https://provider.example/htt/hot.php?playlist=1' });
  ok(result.channels.length === 3, '§9.11 a PHP-style playlist of relative URLs ingests 3/4 entries (the .html one is rejected)');
  ok(result.channels[0]!.sourceChannelId === 'rel.1' && result.channels[0]!.endpoints[0]!.url === 'https://provider.example/htt/stream/one.m3u8?token=abc', '§9.12 first entry resolved against the base path');
  ok(result.channels[1]!.sourceChannelId === 'rel.2' && result.channels[1]!.endpoints[0]!.url === 'https://provider.example/live/two.m3u8', '§9.13 root-relative entry resolved against the base origin');
  ok(result.channels[2]!.sourceChannelId === 'rel.3' && result.channels[2]!.endpoints[0]!.streamFormat === 'dash', '§9.14 ./-relative .mpd resolved and classified dash');
  ok(result.diagnostics.skippedCount === 1 && result.diagnostics.skippedReasons['unknown_stream_format'] === 1, '§9.15 the .html entry skipped with the static unknown_stream_format reason');

  // 9.11 — same playlist with NO base: 0 entries (the pre-R-2 regression).
  const noBaseResult = parseM3UPlaylist(playlistBody);
  ok(noBaseResult.channels.length === 0, '§9.16 the same playlist without a base ingests zero entries (the documented regression)');
  ok(noBaseResult.diagnostics.skippedCount === 4 && noBaseResult.diagnostics.skippedReasons['invalid_stream_url'] === 4, '§9.17 all four entries skipped with invalid_stream_url (relative URLs cannot parse without a base)');

  // 9.12 — diagnostics NEVER carry the resolved URL (no signed material).
  // The diagnostics object carries only static counts and reason strings —
  // never a URL or query parameter. (The channels array carries the resolved
  // https URL by design — that is the entry's stream URL, not diagnostics.)
  const serializedDiag = JSON.stringify(result.diagnostics);
  ok(!serializedDiag.includes('token=abc'), '§9.18 resolved URLs (with tokens) never appear in diagnostics');
  ok(!serializedDiag.includes('provider.example'), '§9.19 the upstream origin never appears in diagnostics (only static reason codes)');
}

// ============================================================
console.log('§10 R-2 — adapter run: relative stream URLs resolve via the fetched final URL');
// ============================================================
{
  const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
  const RUN_SOURCE = { id: 'src-1', slug: 'acme', sourceType: 'm3u_playlist' as const, config: { playlistUrl: 'https://provider.example/htt/hot.php?playlist=1' } };

  // 10.1 — the adapter passes the FETCHED final URL (post-redirect) as the
  // base. A playlist body of relative URLs now ingests correctly.
  const run = await m3uPlaylistAdapter.run(RUN_SOURCE, {
    fetcher: async () => new Response([
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="hot.1" tvg-name="Hot One" tvg-logo="https://cdn.example/hot.png" group-title="Hot",Hot One',
      'stream/hot.m3u8?sig=abc',
      '#EXTINF:-1 tvg-id="hot.2",Hot Two',
      '/live/hot2.m3u8'
    ].join('\n'), { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }),
    dnsResolver: PUBLIC_DNS
  });
  ok(run.channels.length === 2, '§10.1 a PHP-endpoint playlist of relative URLs ingests both entries through the adapter run');
  ok(run.channels[0]!.sourceChannelId === 'hot.1' && run.channels[0]!.endpoints[0]!.url === 'https://provider.example/htt/stream/hot.m3u8?sig=abc', '§10.2 the first relative URL resolved against the fetched playlist URL');
  ok(run.channels[1]!.sourceChannelId === 'hot.2' && run.channels[1]!.endpoints[0]!.url === 'https://provider.example/live/hot2.m3u8', '§10.3 a root-relative URL resolved against the origin');
  ok(run.channels[0]!.endpoints[0]!.streamFormat === 'hls', '§10.4 the resolved URL is classified hls by its path extension');

  // 10.2 — diagnostics remain safe (no resolved URL or query string surfaces).
  const serialized = JSON.stringify(run.diagnostics);
  ok(!serialized.includes('sig='), '§10.5 the resolved URL query string never appears in diagnostics');
  ok(!serialized.includes('provider.example'), '§10.6 the upstream origin never appears in diagnostics (only static reason codes)');
}

// ============================================================
console.log('§11 R-3 — tvg-logo normalization (Issue 6: Sony missing logos)');
// ============================================================
{
  // 11.1 — https:// logos pass through unchanged.
  ok(normalizeM3ULogoUrl('https://cdn.example/logo.png') === 'https://cdn.example/logo.png', '§11.1 an https logo URL passes through unchanged');

  // 11.2 — R-5: http:// logos are REJECTED (no unverified http→https upgrade).
  // The DB requires https; the upgrade was unverified (the CDN may not support https).
  ok(normalizeM3ULogoUrl('http://cdn.example/logo.png') === null, '§11.2 R-5: an http logo URL is REJECTED (no unverified http→https upgrade — the CDN may not support https)');

  // 11.2b — R-5: relative logo URLs are resolved against the playlist base URL.
  ok(normalizeM3ULogoUrl('/logos/sony.png', 'https://provider.example/playlist.php') === 'https://provider.example/logos/sony.png', '§11.2b R-5: a relative logo URL resolves against the playlist base URL');
  ok(normalizeM3ULogoUrl('logos/sony.png', 'https://provider.example/playlist.php') === 'https://provider.example/logos/sony.png', '§11.2c R-5: a relative logo URL (no leading slash) resolves against the base path');

  // 11.3 — protocol-relative URLs are REJECTED (the DB requires absolute https).
  ok(normalizeM3ULogoUrl('//cdn.example/logo.png') === null, '§11.3 a protocol-relative logo URL is rejected (the DB requires absolute https)');

  // 11.4 — relative URLs are REJECTED.
  ok(normalizeM3ULogoUrl('/logo.png') === null, '§11.4 a relative logo URL is rejected (no invented host)');
  ok(normalizeM3ULogoUrl('logo.png') === null, '§11.5 a bare-filename logo URL is rejected (no invented host)');

  // 11.6 — non-http(s) schemes are REJECTED.
  ok(normalizeM3ULogoUrl('ftp://cdn.example/logo.png') === null, '§11.6 an ftp logo URL is rejected (non-http(s))');
  ok(normalizeM3ULogoUrl('data:image/png;base64,abc') === null, '§11.7 a data: logo URL is rejected (non-http(s))');

  // 11.7 — control characters and whitespace are REJECTED.
  ok(normalizeM3ULogoUrl('https://cdn.example/logo\x01.png') === null, '§11.8 a logo URL with a control character is rejected');
  ok(normalizeM3ULogoUrl('https://cdn.example/ logo.png') === null, '§11.9 a logo URL with whitespace is rejected');

  // 11.8 — credentials in the URL are REJECTED.
  ok(normalizeM3ULogoUrl('https://user:pass@cdn.example/logo.png') === null, '§11.10 a logo URL with credentials is rejected');

  // 11.9 — empty/null/undefined → null (no logo).
  ok(normalizeM3ULogoUrl('') === null, '§11.11 an empty logo URL returns null');
  ok(normalizeM3ULogoUrl(null) === null, '§11.12 a null logo URL returns null');
  ok(normalizeM3ULogoUrl(undefined) === null, '§11.13 an undefined logo URL returns null');
  ok(normalizeM3ULogoUrl(123) === null, '§11.14 a non-string logo URL returns null');

  // 11.10 — over-long URLs are REJECTED.
  ok(normalizeM3ULogoUrl(`https://cdn.example/${'a'.repeat(3000)}.png`) === null, '§11.15 an over-long logo URL is rejected');

  // 11.11 — R-5: the parser REJECTS http tvg-logo (no unverified upgrade).
  // A relative tvg-logo is resolved against the playlist base URL.
  const playlist = '#EXTM3U\n#EXTINF:-1 tvg-id="logo.1" tvg-logo="/logos/legacy.png",Logo Test\nhttps://cdn.example/stream.m3u8';
  const result = parseM3UPlaylist(playlist, { playlistBaseUrl: 'https://provider.example/playlist.php' });
  ok(result.channels.length === 1 && result.channels[0]!.logoUrl === 'https://provider.example/logos/legacy.png', '§11.16 R-5: the parser resolves a relative tvg-logo against the playlist base URL end-to-end');

  // 11.11b — R-5: an http tvg-logo is REJECTED (no unverified upgrade).
  const httpLogoPlaylist = '#EXTM3U\n#EXTINF:-1 tvg-id="httplogo.1" tvg-logo="http://cdn.example/legacy.png",HTTP Logo\nhttps://cdn.example/stream.m3u8';
  const httpLogoResult = parseM3UPlaylist(httpLogoPlaylist);
  ok(httpLogoResult.channels.length === 1 && httpLogoResult.channels[0]!.logoUrl === null, '§11.16b R-5: an http tvg-logo is REJECTED (no unverified http→https upgrade — the CDN may not support https)');

  // 11.12 — a playlist with NO tvg-logo → logoUrl is null (honest, no fabrication).
  const noLogoPlaylist = '#EXTM3U\n#EXTINF:-1 tvg-id="nologo.1",No Logo\nhttps://cdn.example/stream.m3u8';
  const noLogoResult = parseM3UPlaylist(noLogoPlaylist);
  ok(noLogoResult.channels.length === 1 && noLogoResult.channels[0]!.logoUrl === null, '§11.17 a playlist with no tvg-logo → logoUrl is null (honest, no fabrication)');
}

// ============================================================
console.log('§12 R-8 — Pipe-delimited stream URLs (JioHotstar/Akindi format)');
// ============================================================
{
  // 12.1 — A pipe-delimited URL with spaces in the pipe section is accepted.
  // This is the JioHotstar format: https://...m3u8?|cookie=...&user-agent=...Plugx(Android/15)
  const pipeUrl = 'https://jcevents.hotstar.com/bpk-tv/abc/JioHotstar/abc.m3u8?|cookie=hdntl=exp=123~acl=%2f*~id=abc~data=hdntl~hmac=abc&referer=https://www.hotstar.com/&origin=https://www.hotstar.com&user-agent=Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)';
  const result = classifyM3UStreamUrl(pipeUrl);
  ok(result.ok === true, '§12.1 a pipe-delimited URL with spaces in the pipe section is accepted (R-8 fix)');
  if (result.ok) {
    ok(result.value.streamFormat === 'hls', '§12.2 the stream format is HLS (.m3u8 in the HTTP path)');
    ok(!result.value.url.includes('|'), '§12.3 the stored URL does NOT include the pipe section (DB constraint requires no whitespace)');
    ok(!result.value.url.includes('Premium Plugx'), '§12.4 the stored URL does NOT include the space-containing user-agent');
    ok(result.value.url.startsWith('https://jcevents.hotstar.com'), '§12.5 the stored URL is the real HTTP URL');
  }

  // 12.2 — A pipe-delimited DASH URL (Akindi format).
  const dashPipeUrl = 'https://jiotvpllive.cdn.jio.com/bpk-tv/ZeeTVHD_BTS/WDVLive/index.mpd?__hdnea__=st=123~exp=456~acl=/bpk-tv/ZeeTVHD_BTS/WDVLive/*~hmac=abc|cookie=__hdnea__=st=123~exp=456~acl=/bpk-tv/ZeeTVHD_BTS/WDVLive/*~hmac=abc&User-Agent=plaYtv%2F7.1.3%20(Linux%3BAndroid%2013)';
  const dashResult = classifyM3UStreamUrl(dashPipeUrl);
  ok(dashResult.ok === true, '§12.6 a pipe-delimited DASH URL is accepted (Akindi format)');
  if (dashResult.ok) {
    ok(dashResult.value.streamFormat === 'dash', '§12.7 the stream format is DASH (.mpd in the HTTP path)');
    ok(!dashResult.value.url.includes('|'), '§12.8 the stored URL does NOT include the pipe section');
  }

  // 12.3 — A URL without a pipe still works (no regression).
  const plainUrl = 'https://cdn.example/live/stream.m3u8';
  const plainResult = classifyM3UStreamUrl(plainUrl);
  ok(plainResult.ok === true && plainResult.value.streamFormat === 'hls', '§12.9 a plain URL without a pipe still works (no regression)');

  // 12.4 — A URL with whitespace in the HTTP part (before the pipe) is still rejected.
  const badUrl = 'https://cdn.example/live stream.m3u8|cookie=abc';
  const badResult = classifyM3UStreamUrl(badUrl);
  ok(badResult.ok === false && badResult.reason === 'invalid_stream_url', '§12.10 a URL with whitespace in the HTTP part is still rejected');

  // 12.5 — End-to-end: a JioHotstar-style playlist with pipe URLs and spaces.
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-name="STAR SPORTS 2 Hindi HD" tvg-logo="https://i.ibb.co/abc.jpg" group-title="Sports", STAR SPORTS 2 Hindi HD',
    '#EXTVLCOPT:http-user-agent=Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)',
    '#EXTHTTP:{"Origin":"https://www.hotstar.com","Referer":"https://www.hotstar.com/","Cookie":"hdntl=exp=123~acl=%2f*~id=abc~data=hdntl~hmac=abc"}',
    'https://jcevents.hotstar.com/bpk-tv/abc/JioHotstar/abc.m3u8?|cookie=hdntl=exp=123~acl=%2f*~id=abc~data=hdntl~hmac=abc&referer=https://www.hotstar.com/&origin=https://www.hotstar.com&user-agent=Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)'
  ].join('\n');
  const parseResult = parseM3UPlaylist(playlist);
  ok(parseResult.channels.length === 1, '§12.11 a JioHotstar-style playlist with pipe URLs and spaces parses successfully (R-8 fix)');
  ok(parseResult.channels[0]!.endpoints[0]!.streamFormat === 'hls', '§12.12 the channel is classified as HLS');
  ok(!parseResult.channels[0]!.endpoints[0]!.url.includes('|'), '§12.13 the stored endpoint URL does NOT include the pipe section');
  ok(parseResult.diagnostics.skippedCount === 0, '§12.14 zero entries skipped (the pipe-URL whitespace bug is fixed)');
  ok(parseResult.channels[0]!.logoUrl === 'https://i.ibb.co/abc.jpg', '§12.15 the tvg-logo is preserved');
}

console.log(`\n=== livetv Phase 2 M3U parse verification: ${passed} checks PASSED ===`);
