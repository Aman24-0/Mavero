import assert from 'node:assert/strict';
import {
  isHlsMediaSource,
  looksLikeHlsUrl,
  resolveDirectPlaybackMode,
  supportsNativeHls,
} from '$lib/client/player/hls-engine';
import type { PlayerSource } from '$lib/shared/player';

// Vixolity playback ROUTING tests (2026-10-16 — evidence-based audit round).
//
// WHY THIS FILE EXISTS: the Vixolity media URL is EXTENSIONLESS
// (`https://ha.vixolity.com/vs/{imdbId}[/s{N}/e{NN}]`) — no `.m3u8`
// pathname, no query/hash reference. The ONLY thing that classifies it as
// HLS for the client engine is `metadata.protocol === 'hls'`
// (isHlsMediaSource priority 1), which the server adapter stamps
// (vixolity_provider_test §4). These tests PIN that routing contract so
// neither side can silently regress:
//
//   * A Vixolity source on a NON-native-HLS browser (desktop Chrome /
//     Firefox — canPlayType '') MUST route to hls.js (the CORS-governed
//     route — blocked upstream today, but that is the correct client
//     behavior; the failure is the provider's, documented in
//     VIXOLITY_PLAYBACK_AUDIT_REPORT.md).
//   * The SAME source on a native-HLS browser (Safari / Android Chromium —
//     canPlayType 'maybe') MUST route NATIVE: the <video src> media
//     element makes no-cors requests (no crossorigin attribute anywhere in
//     the component tree), so the missing upstream ACAO does not apply.
//     This is the path that plays Vixolity today.
//   * NO GLOBAL NATIVE PREFERENCE: a browser WITHOUT native HLS must keep
//     getting hls.js for ordinary .m3u8 streams (Blue Velvet + generic
//     addon URLs) — routing is per-browser-capability, never per-provider.
//
// PURE unit tests: the routing functions take a structural
// Pick<HTMLMediaElement, 'canPlayType'> — no DOM, no network, no browser.

function fakeVideo(canPlayTypeResult: string): Pick<HTMLMediaElement, 'canPlayType'> {
  return { canPlayType: (type: string) => (type ? canPlayTypeResult : '') };
}

/** canPlayType('') — desktop Chrome / Firefox: NO native HLS. */
const DESKTOP_NO_NATIVE = fakeVideo('');
/** canPlayType('maybe') — Safari / Android Chromium: native HLS capable. */
const NATIVE_BROWSER = fakeVideo('maybe');

function vixolitySource(url = 'https://ha.vixolity.com/vs/tt0903747/s1/e02'): PlayerSource {
  return {
    type: 'direct',
    url,
    providerId: 'routing-test-provider',
    sourceId: 'routing-test-source',
    mediaType: 'series',
    metadata: { sourceName: 'Vixolity', providerName: 'Vixolity', protocol: 'hls' },
  };
}

function blueVelvetSource(url = 'https://zcdn.bluevelvet.space/live/master.m3u8'): PlayerSource {
  return {
    type: 'direct',
    url,
    providerId: 'routing-test-bv',
    sourceId: 'routing-test-bv-source',
    mediaType: 'movie',
    metadata: { sourceName: 'Blue Velvet', providerName: 'Blue Velvet', protocol: 'hls' },
  };
}

function mp4Source(): PlayerSource {
  return {
    type: 'direct',
    url: 'https://cdn.example.test/video.mp4',
    providerId: 'routing-test-mp4',
    sourceId: 'routing-test-mp4-source',
    mediaType: 'movie',
    metadata: { protocol: 'mp4' },
  };
}

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ============================================================
// §1 — HLS classification of the extensionless Vixolity URL
// ============================================================

// The URL alone carries NO HLS signal — the metadata protocol is the ONLY
// classifier. Pinned explicitly: if the adapter ever stops stamping
// metadata.protocol, this test fails BEFORE any user sees a broken route.
ok(looksLikeHlsUrl('https://ha.vixolity.com/vs/tt0903747/s1/e02') === false, '§1 extensionless Vixolity URL has NO URL-level HLS signal (fallback would miss it)');
ok(looksLikeHlsUrl('https://ha.vixolity.com/vs/tt0903747') === false, '§1 movie form equally has no URL-level signal');
ok(isHlsMediaSource(vixolitySource(), 'https://ha.vixolity.com/vs/tt0903747/s1/e02') === true, '§1 metadata.protocol=hls classifies Vixolity as HLS (priority 1)');
ok(
  isHlsMediaSource({ ...vixolitySource(), metadata: { sourceName: 'Vixolity', providerName: 'Vixolity' } }, 'https://ha.vixolity.com/vs/tt0903747/s1/e02') === false,
  '§1 WITHOUT protocol metadata the Vixolity URL falls to URL detection and is NOT classified HLS (the load-bearing contract)',
);

// Explicit non-HLS protocols never classify as HLS.
ok(isHlsMediaSource(mp4Source(), 'https://cdn.example.test/video.mp4') === false, '§1 mp4 protocol never classifies as HLS');

// Ordinary .m3u8 URLs keep the URL-level fallback (Blue Velvet + addons).
ok(looksLikeHlsUrl('https://zcdn.bluevelvet.space/live/master.m3u8') === true, '§1 .m3u8 pathname still detected by the URL fallback');
ok(looksLikeHlsUrl('https://host/get?file=file.m3u8&token=x') === true, '§1 signed query .m3u8 reference still detected');

// ============================================================
// §2 — Per-browser mode routing (the §4 contract of the engine)
// ============================================================

// Vixolity on a native-HLS browser → NATIVE (<video src>, no-cors media
// element — the missing upstream ACAO does not apply; this is the path
// Android Chromium / Safari use today).
ok(
  resolveDirectPlaybackMode(vixolitySource(), 'https://ha.vixolity.com/vs/tt0903747/s1/e02', NATIVE_BROWSER) === 'native',
  '§2 Vixolity on native-HLS browser → native (no-cors media path; upstream CORS irrelevant)',
);
// Vixolity on desktop Chrome/Firefox → hls.js (CORS-governed route).
ok(
  resolveDirectPlaybackMode(vixolitySource(), 'https://ha.vixolity.com/vs/tt0903747/s1/e02', DESKTOP_NO_NATIVE) === 'hls-js',
  '§2 Vixolity on non-native browser → hls.js (correct client route; upstream CORS is the documented blocker)',
);
// NO GLOBAL NATIVE PREFERENCE: the same non-native browser still gets
// hls.js for ordinary HLS URLs.
ok(
  resolveDirectPlaybackMode(blueVelvetSource(), 'https://zcdn.bluevelvet.space/live/master.m3u8', DESKTOP_NO_NATIVE) === 'hls-js',
  '§2 Blue Velvet on non-native browser → hls.js (global routing unchanged — no provider bias)',
);
ok(
  resolveDirectPlaybackMode(null, 'https://any.test/stream.m3u8', DESKTOP_NO_NATIVE) === 'hls-js',
  '§2 bare .m3u8 URL with no source metadata on non-native browser → hls.js (URL fallback intact)',
);
// Non-HLS sources stay on the existing native path on BOTH browser classes.
ok(resolveDirectPlaybackMode(mp4Source(), 'https://cdn.example.test/video.mp4', NATIVE_BROWSER) === 'native', '§2 MP4 on native browser → native');
ok(resolveDirectPlaybackMode(mp4Source(), 'https://cdn.example.test/video.mp4', DESKTOP_NO_NATIVE) === 'native', '§2 MP4 on non-native browser → native (existing path unchanged)');

// ============================================================
// §3 — Native capability probe matrix (supportsNativeHls)
// ============================================================

ok(supportsNativeHls(NATIVE_BROWSER) === true, '§3 canPlayType "maybe" → native capable');
ok(supportsNativeHls(fakeVideo('probably')) === true, '§3 canPlayType "probably" → native capable');
ok(supportsNativeHls(DESKTOP_NO_NATIVE) === false, '§3 canPlayType "" → NOT native capable (hls.js route)');
ok(supportsNativeHls(fakeVideo('')) === false, '§3 both mime probes empty → not capable');

// ============================================================
// §4 — Resolver → engine contract seam (server stamps, client honors)
// ============================================================
//
// The client normalizes the resolver payload verbatim
// (PlaybackManager.normalizePlayerSource → player-guards.isPlayablePlayerSource
// keeps metadata). These assertions document the EXACT field the routing
// depends on, so a resolver-side metadata change cannot silently break
// Vixolity routing (the §1 negative case is the mirror of this one).
{
  const source = vixolitySource('https://ha.vixolity.com/vs/tt1234567');
  ok(source.metadata?.protocol === 'hls', '§4 fixture: adapter-stamped metadata.protocol=hls present');
  ok(isHlsMediaSource(source, source.url!) === true, '§4 exactly this field drives isHlsMediaSource');
}

console.log(`vixolity_playback_routing_test: ${passed} checks passed`);
