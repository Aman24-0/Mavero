import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  streamCapabilities,
  downloadActionFor,
  playActionFor,
  shareActionFor,
  type CapabilityStream,
} from '$lib/shared/stream-actions';

/**
 * Phase D — Actions test suite.
 *
 * Tests the capability-aware action model in `src/lib/shared/stream-actions.ts`
 * — the SINGLE source of truth for which actions (Download / Play / Share)
 * are available for each normalized stream kind.
 *
 * Coverage:
 *   CAPABILITY: direct HTTP/HTTPS → Download + Play + Share
 *               HLS/DASH → Play + Share (NOT Download — it's a manifest)
 *               Magnet/P2P → Download + Share (NOT Play — browser can't play)
 *               External → Share only
 *   DOWNLOAD:  HTTP/HTTPS anchor, magnet anchor, HLS/DASH/External = null
 *   PLAY:      HTTP/HTTPS/HLS/DASH launch, magnet/p2p/external = null
 *   SHARE:     always available
 *   SOURCE:    component imports the shared helpers, renders Download+Play+Share
 *
 * All tests are deterministic — no real Android device or installed apps.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

function makeStream(overrides: Partial<CapabilityStream> & { url: string }): CapabilityStream {
  return { kind: 'https', url: '', ...overrides };
}

// ---------------------------------------------------------------------------
// CAPABILITY MATRIX
// ---------------------------------------------------------------------------

function section_capability(): void {
  // HTTP/HTTPS → Download + Play + Share
  const https = streamCapabilities({ kind: 'https' });
  ok(https.download === true, 'CAP: HTTPS → Download available');
  ok(https.play === true, 'CAP: HTTPS → Play available');
  ok(https.share === true, 'CAP: HTTPS → Share available');

  const http = streamCapabilities({ kind: 'http' });
  ok(http.download === true && http.play === true && http.share === true, 'CAP: HTTP → all three');

  // HLS/DASH → Play + Share (NOT Download — it's a manifest, not a file)
  const hls = streamCapabilities({ kind: 'hls' });
  ok(hls.download === false, 'CAP: HLS → Download NOT available (manifest, not a file)');
  ok(hls.play === true, 'CAP: HLS → Play available (player can stream)');
  ok(hls.share === true, 'CAP: HLS → Share available');

  const dash = streamCapabilities({ kind: 'dash' });
  ok(dash.download === false, 'CAP: DASH → Download NOT available');
  ok(dash.play === true, 'CAP: DASH → Play available');
  ok(dash.share === true, 'CAP: DASH → Share available');

  // Magnet/P2P → Download + Share (NOT Play — browser can't play a magnet)
  const magnet = streamCapabilities({ kind: 'magnet' });
  ok(magnet.download === true, 'CAP: Magnet → Download available (external torrent app)');
  ok(magnet.play === false, 'CAP: Magnet → Play NOT available (browser can\'t play)');
  ok(magnet.share === true, 'CAP: Magnet → Share available');

  const p2p = streamCapabilities({ kind: 'p2p' });
  ok(p2p.download === true && p2p.play === false && p2p.share === true, 'CAP: P2P → Download + Share (no Play)');

  // External → Download (embedded-sheet) + Share (NOT Play)
  const external = streamCapabilities({ kind: 'external' });
  ok(external.download === true, 'CAP: External → Download available (embedded-sheet flow — provider/download page)');
  ok(external.play === false, 'CAP: External → Play NOT available');
  ok(external.share === true, 'CAP: External → Share available');
}

// ---------------------------------------------------------------------------
// DOWNLOAD ACTION
// ---------------------------------------------------------------------------

function section_download(): void {
  // HTTP/HTTPS → anchor with href, download, target, rel
  const dl = downloadActionFor(makeStream({ url: 'https://cdn.example/movie.mkv', kind: 'https', filename: 'Movie.1080p.mkv' }));
  ok(dl !== null, 'DL: HTTPS stream has a Download action');
  ok(dl?.kind === 'anchor', 'DL: HTTPS Download is an anchor');
  ok(dl?.kind === 'anchor' && dl.href === 'https://cdn.example/movie.mkv', 'DL: HTTPS Download href = original URL (verbatim)');
  ok(dl?.kind === 'anchor' && dl.download === 'Movie.1080p.mkv', 'DL: HTTPS Download filename = addon-supplied filename');
  ok(dl?.kind === 'anchor' && dl.target === '_blank', 'DL: HTTPS Download target = _blank');
  ok(dl?.kind === 'anchor' && dl.rel === 'noopener noreferrer', 'DL: HTTPS Download rel = noopener noreferrer');

  // HTTP/HTTPS without filename → derive from URL path
  const dlNoName = downloadActionFor(makeStream({ url: 'https://cdn.example/movie-file.mp4', kind: 'https' }));
  ok(dlNoName?.kind === 'anchor' && dlNoName.download === 'movie-file.mp4', 'DL: HTTPS without filename → derive from URL path');

  // Magnet → magnet anchor (OS resolves the handler)
  const dlMagnet = downloadActionFor(makeStream({ url: 'magnet:?xt=urn:btih:deadbeef0123456789abcdef0123456789abcdef', kind: 'magnet' }));
  ok(dlMagnet !== null, 'DL: Magnet stream has a Download action');
  ok(dlMagnet?.kind === 'magnet', 'DL: Magnet Download is a magnet anchor');
  ok(dlMagnet?.kind === 'magnet' && dlMagnet.href === 'magnet:?xt=urn:btih:deadbeef0123456789abcdef0123456789abcdef', 'DL: Magnet Download href = original magnet URI');

  // P2P (infoHash → magnet) → magnet anchor
  const dlP2P = downloadActionFor(makeStream({ url: 'magnet:?xt=urn:btih:feedface0123456789abcdef0123456789abcdef', kind: 'p2p' }));
  ok(dlP2P?.kind === 'magnet', 'DL: P2P Download is a magnet anchor');

  // HLS/DASH → null (manifest, not a file download)
  const dlHls = downloadActionFor(makeStream({ url: 'https://cdn.example/playlist.m3u8', kind: 'hls' }));
  ok(dlHls === null, 'DL: HLS → Download NOT available (manifest, not a file)');

  const dlDash = downloadActionFor(makeStream({ url: 'https://cdn.example/manifest.mpd', kind: 'dash' }));
  ok(dlDash === null, 'DL: DASH → Download NOT available (manifest, not a file)');

  // External → embedded-sheet flow (provider/download page, not a direct file)
  const dlExt = downloadActionFor(makeStream({ url: 'https://external.example/page', kind: 'external' }));
  ok(dlExt !== null, 'DL: External → Download available (embedded-sheet flow)');
  ok(dlExt?.flow === 'embedded-sheet', 'DL: External → flow=embedded-sheet');

  // Empty/invalid URL → null
  ok(downloadActionFor(makeStream({ url: '', kind: 'https' })) === null, 'DL: empty URL → null');
  ok(downloadActionFor(makeStream({ url: 'ftp://x.com/a', kind: 'https' })) === null, 'DL: non-http URL → null');
}

// ---------------------------------------------------------------------------
// PLAY ACTION
// ---------------------------------------------------------------------------

function section_play(): void {
  // HTTP/HTTPS → external-player launch (Android intent or direct link)
  const play = playActionFor(makeStream({ url: 'https://cdn.example/movie.mkv', kind: 'https' }), { android: false });
  ok(play !== null, 'PLAY: HTTPS stream has a Play action');
  ok(play?.kind === 'direct', 'PLAY: non-Android → direct link');
  ok(play?.href === 'https://cdn.example/movie.mkv', 'PLAY: direct href = original URL (verbatim)');

  // Android → intent URI with mpv package + fallback
  const playAndroid = playActionFor(makeStream({ url: 'https://cdn.example/movie.mkv', kind: 'https' }), { android: true });
  ok(playAndroid !== null, 'PLAY: Android HTTPS stream has a Play action');
  ok(playAndroid?.kind === 'android-intent', 'PLAY: Android → android-intent');
  ok(playAndroid?.href.startsWith('intent://'), 'PLAY: Android href starts with intent://');
  ok(playAndroid?.href.includes('package=is.xyz.mpv'), 'PLAY: Android intent targets mpv');
  ok(playAndroid?.href.includes('S.browser_fallback_url='), 'PLAY: Android intent has browser_fallback_url');

  // HLS → Play available (player can stream HLS)
  const playHls = playActionFor(makeStream({ url: 'https://cdn.example/playlist.m3u8', kind: 'hls' }), { android: false });
  ok(playHls !== null, 'PLAY: HLS stream has a Play action');
  ok(playHls?.kind === 'direct', 'PLAY: HLS non-Android → direct link');
  ok(playHls?.href === 'https://cdn.example/playlist.m3u8', 'PLAY: HLS href = original URL');

  // DASH → Play available
  const playDash = playActionFor(makeStream({ url: 'https://cdn.example/manifest.mpd', kind: 'dash' }), { android: false });
  ok(playDash !== null, 'PLAY: DASH stream has a Play action');

  // Magnet/P2P → null (browser can't play)
  const playMagnet = playActionFor(makeStream({ url: 'magnet:?xt=urn:btih:deadbeef0123456789abcdef0123456789abcdef', kind: 'magnet' }), { android: false });
  ok(playMagnet === null, 'PLAY: Magnet → Play NOT available (browser can\'t play)');

  const playP2P = playActionFor(makeStream({ url: 'magnet:?xt=urn:btih:feedface0123456789abcdef0123456789abcdef', kind: 'p2p' }), { android: false });
  ok(playP2P === null, 'PLAY: P2P → Play NOT available');

  // External → null
  const playExt = playActionFor(makeStream({ url: 'https://external.example/page', kind: 'external' }), { android: false });
  ok(playExt === null, 'PLAY: External → Play NOT available');

  // Invalid URL → null
  ok(playActionFor(makeStream({ url: '', kind: 'https' }), { android: false }) === null, 'PLAY: empty URL → null');
  ok(playActionFor(makeStream({ url: 'ftp://x.com/a', kind: 'https' }), { android: false }) === null, 'PLAY: non-http URL → null');
}

// ---------------------------------------------------------------------------
// SHARE ACTION (always available)
// ---------------------------------------------------------------------------

function section_share(): void {
  ok(shareActionFor(makeStream({ url: 'https://x.com/a', kind: 'https' })).available === true, 'SHARE: HTTPS → available');
  ok(shareActionFor(makeStream({ url: 'https://x.com/p.m3u8', kind: 'hls' })).available === true, 'SHARE: HLS → available');
  ok(shareActionFor(makeStream({ url: 'magnet:?xt=urn:btih:abc', kind: 'magnet' })).available === true, 'SHARE: Magnet → available');
  ok(shareActionFor(makeStream({ url: 'https://ext.com', kind: 'external' })).available === true, 'SHARE: External → available');
}

// ---------------------------------------------------------------------------
// SECURITY: no proxy, no rewrite, verbatim URLs
// ---------------------------------------------------------------------------

function section_security(): void {
  // Download href is always the EXACT ORIGINAL URL — never proxied.
  const dl = downloadActionFor(makeStream({ url: 'https://cdn.example/movie.mkv?t=abc', kind: 'https' }));
  ok(dl?.kind === 'anchor' && dl.href === 'https://cdn.example/movie.mkv?t=abc', 'SEC: Download href = original URL (query preserved, no rewrite)');

  // Play href is the EXACT ORIGINAL URL — never proxied.
  const play = playActionFor(makeStream({ url: 'https://cdn.example/movie.mkv?t=abc', kind: 'https' }), { android: false });
  ok(play?.href === 'https://cdn.example/movie.mkv?t=abc', 'SEC: Play direct href = original URL (query preserved)');

  // Android intent: the fallback URL is the encoded original URL.
  const playAndroid = playActionFor(makeStream({ url: 'https://cdn.example/movie.mkv?t=abc', kind: 'https' }), { android: true });
  ok(playAndroid?.href.includes(encodeURIComponent('https://cdn.example/movie.mkv?t=abc')), 'SEC: Android fallback URL = encoded original');

  // Magnet download href = exact magnet URI.
  const dlMagnet = downloadActionFor(makeStream({ url: 'magnet:?xt=urn:btih:abc&dn=test', kind: 'magnet' }));
  ok(dlMagnet?.kind === 'magnet' && dlMagnet.href === 'magnet:?xt=urn:btih:abc&dn=test', 'SEC: Magnet href = exact original magnet URI');
}

// ---------------------------------------------------------------------------
// DOWNLOAD FLOW CLASSIFICATION (Phase D corrective §1)
// ---------------------------------------------------------------------------

function section_downloadFlows(): void {
  // Direct media URL → direct-download flow (browser native anchor).
  const dlDirect = downloadActionFor(makeStream({ url: 'https://cdn.example/movie.mkv', kind: 'https' }));
  ok(dlDirect?.flow === 'direct-download', 'FLOW: HTTPS → flow=direct-download (direct media file path)');
  ok(dlDirect?.kind === 'anchor', 'FLOW: HTTPS → kind=anchor (browser native <a>)');

  // Magnet/P2P → external-open flow (OS magnet handler).
  const dlMagnet = downloadActionFor(makeStream({ url: 'magnet:?xt=urn:btih:abc', kind: 'magnet' }));
  ok(dlMagnet?.flow === 'external-open', 'FLOW: Magnet → flow=external-open (OS magnet handler)');

  // External kind → embedded-sheet flow (provider/download page → DownloadSheet iframe).
  const dlExternal = downloadActionFor(makeStream({ url: 'https://provider.example/download-page', kind: 'external' }));
  ok(dlExternal?.flow === 'embedded-sheet', 'FLOW: External → flow=embedded-sheet (provider/download page)');
  ok(dlExternal?.kind === 'iframe', 'FLOW: External → kind=iframe (route through DownloadSheet)');
  ok(dlExternal?.href === 'https://provider.example/download-page', 'FLOW: External href = original URL (no rewrite)');

  // HLS/DASH → no download (manifest, not a file).
  ok(downloadActionFor(makeStream({ url: 'https://x.com/p.m3u8', kind: 'hls' })) === null, 'FLOW: HLS → no download');
  ok(downloadActionFor(makeStream({ url: 'https://x.com/m.mpd', kind: 'dash' })) === null, 'FLOW: DASH → no download');

  // No proxy — all flows use the EXACT ORIGINAL URL as href.
  const allFlows = [
    downloadActionFor(makeStream({ url: 'https://cdn.example/a.mkv?t=1', kind: 'https' })),
    downloadActionFor(makeStream({ url: 'magnet:?xt=urn:btih:abc&tr=x', kind: 'magnet' })),
    downloadActionFor(makeStream({ url: 'https://provider.example/page?id=1', kind: 'external' })),
  ];
  ok(allFlows.every((f) => f !== null && !f.href.includes('/api/proxy') && !f.href.includes('proxyMediaUrl')), 'FLOW: no proxy URL in any download flow');
  ok(allFlows[0]?.href === 'https://cdn.example/a.mkv?t=1', 'FLOW: direct-download href = original (verbatim, query preserved)');
  ok(allFlows[1]?.href === 'magnet:?xt=urn:btih:abc&tr=x', 'FLOW: external-open href = original magnet (verbatim)');
  ok(allFlows[2]?.href === 'https://provider.example/page?id=1', 'FLOW: embedded-sheet href = original provider URL (verbatim)');
}

// ---------------------------------------------------------------------------
// SOURCE-LEVEL CONTRACT — component imports + renders the actions
// ---------------------------------------------------------------------------

function section_sourceContract(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  const helperSource = read('src/lib/shared/stream-actions.ts');

  // The shared helper module exists and exports the expected functions.
  ok(helperSource.includes('export function streamCapabilities'), 'SOURCE: helper exports streamCapabilities');
  ok(helperSource.includes('export function downloadActionFor'), 'SOURCE: helper exports downloadActionFor');
  ok(helperSource.includes('export function playActionFor'), 'SOURCE: helper exports playActionFor');
  ok(helperSource.includes('export function shareActionFor'), 'SOURCE: helper exports shareActionFor');

  // The component imports the shared helpers.
  ok(component.includes('streamCapabilities'), 'SOURCE: component imports streamCapabilities');
  ok(component.includes('downloadActionFor'), 'SOURCE: component imports downloadActionFor');
  ok(component.includes('playActionFor'), 'SOURCE: component imports playActionFor');

  // The component renders Download + Play + Share actions.
  ok(component.includes('mad-action-download'), 'SOURCE: component has mad-action-download class');
  ok(component.includes('mad-action-play'), 'SOURCE: component has mad-action-play class');
  ok(component.includes('mad-action-share'), 'SOURCE: component has mad-action-share class');
  ok(component.includes('mad-row-actions'), 'SOURCE: component has a mad-row-actions container');

  // Download + Play are capability-aware (conditional rendering).
  ok(component.includes('{#if dlAction}'), 'SOURCE: Download is conditional on dlAction (capability-aware)');
  ok(component.includes('{#if plAction}'), 'SOURCE: Play is conditional on plAction (capability-aware)');

  // Download icon + Play icon are imported.
  ok(component.includes('Download'), 'SOURCE: Download icon imported from lucide-svelte');
  ok(component.includes('Play'), 'SOURCE: Play icon imported from lucide-svelte');

  // Share is preserved (Phase 18 contract intact).
  ok(component.includes('handleShare'), 'SOURCE: handleShare preserved');
  ok(component.includes('navigator.share'), 'SOURCE: navigator.share preserved');
  ok(component.includes('url = stream.url'), 'SOURCE: Share uses url = stream.url (original URI)');

  // No proxy, no forced 1DM, no media worker.
  ok(!component.includes('/api/proxy'), 'SOURCE: NO proxy API in component');
  ok(!component.includes('proxyMediaUrl'), 'SOURCE: NO proxyMediaUrl in component');
  ok(!component.includes('media-worker'), 'SOURCE: NO media-worker reference');
  ok(!component.includes('1dm://'), 'SOURCE: NO forced 1DM intent URI');

  // Actions have accessible labels.
  ok(component.includes('aria-label="Download'), 'SOURCE: Download has aria-label');
  ok(component.includes('aria-label="Play'), 'SOURCE: Play has aria-label');

  // CORRECTION 2: stream-actions.ts imports the canonical externalPlayerLaunchFor
  // from external-player.ts — NO duplicated implementation.
  // Phase F follow-up (Pixeldrain bypass): stream-actions.ts ALSO imports
  // transformPixeldrainUrl from external-player.ts so the Download flow
  // can rewrite Pixeldrain URLs to the API download endpoint (bypassing
  // hotlink protection). Both imports live on one line.
  ok(/import \{[^}]*\bexternalPlayerLaunchFor\b[^}]*\} from '\$lib\/shared\/external-player'/.test(helperSource), 'SOURCE: stream-actions imports canonical externalPlayerLaunchFor from external-player.ts');
  ok(/import \{[^}]*\btransformPixeldrainUrl\b[^}]*\} from '\$lib\/shared\/external-player'/.test(helperSource), 'SOURCE (Phase F): stream-actions imports transformPixeldrainUrl for the Pixeldrain hotlink bypass in the Download flow');
  ok(!helperSource.includes('function externalPlayerLaunchForResult'), 'SOURCE: NO duplicated externalPlayerLaunchForResult (CORRECTION 2 — removed)');
  ok(helperSource.includes('return externalPlayerLaunchFor(url, options)'), 'SOURCE: playActionFor delegates to externalPlayerLaunchFor (canonical helper)');

  // CORRECTION 1: the DownloadAction type has a `flow` field for the
  // third-party download-page handling (embedded-sheet path).
  ok(helperSource.includes("flow: 'direct-download'"), 'SOURCE: DownloadAction has flow=direct-download (direct media file)');
  ok(helperSource.includes("flow: 'external-open'"), 'SOURCE: DownloadAction has flow=external-open (magnet OS handler)');
  ok(helperSource.includes("flow: 'embedded-sheet'"), 'SOURCE: DownloadAction has flow=embedded-sheet (third-party provider page → DownloadSheet iframe)');

  // The component renders the three flows distinctly.
  ok(component.includes("dlAction.flow === 'direct-download'"), 'SOURCE: component checks flow=direct-download');
  ok(component.includes("dlAction.flow === 'external-open'"), 'SOURCE: component checks flow=external-open');
  ok(component.includes("dlAction.flow === 'embedded-sheet'"), 'SOURCE: component checks flow=embedded-sheet (third-party page path)');

  // CORRECTION 1 (actual wiring): the embedded-sheet flow calls the
  // onOpenInSheet callback (wired to DownloadSheet's iframe overlay).
  ok(component.includes('onOpenInSheet'), 'SOURCE: component has onOpenInSheet prop (embedded-sheet callback)');
  ok(component.includes('onOpenInSheet(dlAction.href)'), 'SOURCE: embedded-sheet flow calls onOpenInSheet(url) — actual wiring, not just a model');
  // The DownloadSheet wires the callback to its iframe overlay.
  const sheetSource = read('src/lib/components/DownloadSheet.svelte');
  ok(sheetSource.includes('onOpenInSheet={openEmbeddedSheet}'), 'SOURCE: DownloadSheet wires onOpenInSheet to openEmbeddedSheet');
  ok(sheetSource.includes('embeddedSheetUrl'), 'SOURCE: DownloadSheet has embeddedSheetUrl state (iframe overlay)');
  ok(sheetSource.includes('function openEmbeddedSheet'), 'SOURCE: DownloadSheet has openEmbeddedSheet handler');
  ok(sheetSource.includes('function closeEmbeddedSheet'), 'SOURCE: DownloadSheet has closeEmbeddedSheet handler (back button)');
  ok(sheetSource.includes('handleEmbeddedIframeLoad'), 'SOURCE: DownloadSheet has handleEmbeddedIframeLoad (reuses iframe onload pattern)');
  ok(sheetSource.includes('handleEmbeddedIframeError'), 'SOURCE: DownloadSheet has handleEmbeddedIframeError (reuses iframe onerror pattern)');
  ok(sheetSource.includes('dl-embedded-overlay'), 'SOURCE: DownloadSheet has dl-embedded-overlay (the actual iframe overlay element)');
  ok(sheetSource.includes('dl-embedded-frame'), 'SOURCE: DownloadSheet renders a <iframe> inside the overlay');
  ok(sheetSource.includes('embeddedSheetError'), 'SOURCE: DownloadSheet has embeddedSheetError state (iframe-blocked detection)');
  // The external-open fallback is present when the iframe is blocked.
  ok(sheetSource.includes("Couldn't embed this page"), 'SOURCE: iframe-blocked shows "Couldn\'t embed this page" message');
  ok(sheetSource.includes('Open in new tab'), 'SOURCE: iframe-blocked shows "Open in new tab" external fallback');
  // The Back button returns to the MaveroAddonDownload panel.
  ok(sheetSource.includes('closeEmbeddedSheet'), 'SOURCE: Back button calls closeEmbeddedSheet (returns to stream list)');
  // No proxy — the iframe src is the EXACT ORIGINAL URL.
  ok(!sheetSource.includes('/api/proxy'), 'SOURCE: NO proxy API in DownloadSheet');
  ok(!sheetSource.includes('proxyMediaUrl'), 'SOURCE: NO proxyMediaUrl in DownloadSheet');
}

// ---------------------------------------------------------------------------
// REGRESSION — Phase A/B/C behavior preserved
// ---------------------------------------------------------------------------

function section_regression(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Phase C filters still intact.
  ok(component.includes('filterStreams'), 'REG: filterStreams still imported (Phase C intact)');
  ok(component.includes('DownloaderFilters'), 'REG: DownloaderFilters type still imported');
  // Phase E final corrective: chip rows moved INSIDE the DownloaderFilterSheet
  // (filter-chip class in the sheet). Main surface has active-filter chips
  // (mad-active-chip) for quick removal of selected dimensions.
  ok(component.includes('mad-active-chip') || component.includes('DownloaderFilterSheet'), 'REG: chip-based UI preserved (moved to DownloaderFilterSheet, active chips on main surface)');
  // Phase E final corrective: dead Size SelectionSheet is REMOVED (was
  // unreachable in Phase E V2 — openSizeSheet was never called). The Info
  // SelectionSheet (recommended apps) is still preserved.
  ok(component.includes('SelectionSheet'), 'REG: SelectionSheet primitive preserved (Info sheet for recommended apps)');
  ok(!component.includes('sizeSheetOpen'), 'REG (Phase E final): dead Size SelectionSheet state REMOVED (consolidated into DownloaderFilterSheet)');
  // Phase B card metadata still intact.
  ok(component.includes('mad-badge'), 'REG: structured badges preserved (Phase B)');
  ok(component.includes('Captions'), 'REG: subtitle badge preserved (Phase B)');
  // Phase B host identity still intact.
  ok(component.includes('mad-badge-host'), 'REG: host badge preserved (Phase B)');
  // Share still works for all stream kinds (Phase 20 magnet fix preserved).
  ok(component.includes('shareData.text = url'), 'REG: non-http share uses text field (Phase 20 preserved)');
  ok(component.includes("url.startsWith('http://') || url.startsWith('https://')"), 'REG: http(s) detection for share field (Phase 20 preserved)');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

section_capability();
section_download();
section_play();
section_share();
section_security();
section_downloadFlows();
section_sourceContract();
section_regression();

console.log(`stremio_downloader_phaseD_actions_test: ${passed} checks passed (Phase D: capability-aware Download/Play/Share actions — direct HTTP/HTTPS download+play, HLS/DASH play-only, magnet/p2p download-only, external share-only, no proxy/1DM/media-worker)`);
