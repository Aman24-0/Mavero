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

console.log(`\n=== livetv Phase 2 M3U parse verification: ${passed} checks PASSED ===`);
