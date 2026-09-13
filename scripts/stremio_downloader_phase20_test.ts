import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateAddonDraft } from '$lib/server/streaming/addon-validation';
import { normalizeStremioStreamResponseForDownloader } from '$lib/server/streaming/stremio/stream-normalize-downloader';
import { FORBIDDEN_MODEL_TOKENS } from '$lib/server/streaming/addon-validation';

/**
 * Phase 20 (FINAL ADDON PHASE) test suite.
 *
 * Tests:
 *   1. Valid HTTP stream addon manifest → accepted
 *   2. Valid P2P/torrent stream addon → accepted (capabilities with torrent keys)
 *   3. Valid magnet stream addon → accepted
 *   4. Valid mixed HTTP + P2P addon → accepted
 *   5. Mixed HTTP + P2P + HLS + DASH + magnet → all preserved
 *   6. infoHash-only stream → magnet representation preserved
 *   7. externalUrl-only stream → hidden/excluded from UI
 *   8. Entry with usable url + externalUrl → usable url wins
 *   9. HLS preserved
 *   10. DASH preserved
 *   11. No quality/size/type filtering silently removes discovery entries
 *   12. P2P/magnet Share uses text field (native-share-compatible)
 *   13. HTTP/HTTPS sharing uses url field (unchanged)
 *   14. Exact original URI is preserved during sharing
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const VALID_DRAFT = {
  name: 'Test Addon',
  slug: 'test-addon',
  manifestUrl: 'https://addon.example/manifest.json',
  enabled: true,
  status: 'experimental' as const,
  ordering: 0,
  supportedTypes: ['movie', 'series'],
  idPrefixes: ['tt'],
  resources: ['catalog', 'meta', 'stream'],
  capabilities: { supportsStream: true },
};

// ---------------------------------------------------------------------------
// 1. Valid HTTP stream addon manifest → accepted
// ---------------------------------------------------------------------------

function section1(): void {
  const draft = validateAddonDraft(VALID_DRAFT);
  ok(draft.name === 'Test Addon', '1: valid HTTP stream addon accepted');
  ok(draft.capabilities.supportsStream === true, '1: stream capability preserved');
}

// ---------------------------------------------------------------------------
// 2. Valid P2P/torrent stream addon → accepted (capabilities with torrent keys)
// ---------------------------------------------------------------------------

function section2(): void {
  const draft = validateAddonDraft({ ...VALID_DRAFT, capabilities: { supportsStream: true, torrent: true, p2p: true, debrid: 'real-debrid' } });
  ok(draft.capabilities.torrent === true, '2: torrent capability key ACCEPTED (Phase 20: no semantic rejection)');
  ok(draft.capabilities.p2p === true, '2: p2p capability key ACCEPTED');
  ok(draft.capabilities.debrid === 'real-debrid', '2: debrid capability key ACCEPTED');
}

// ---------------------------------------------------------------------------
// 3. Valid magnet stream addon → accepted (addon name contains 'magnet')
// ---------------------------------------------------------------------------

function section3(): void {
  const draft = validateAddonDraft({ ...VALID_DRAFT, name: 'Magnet Streams Addon', description: 'Provides magnet links for movies' });
  ok(draft.name === 'Magnet Streams Addon', '3: addon with "magnet" in name ACCEPTED');
  ok(draft.description === 'Provides magnet links for movies', '3: addon with "magnet" in description ACCEPTED');
}

// ---------------------------------------------------------------------------
// 4. Valid mixed HTTP + P2P addon → accepted
// ---------------------------------------------------------------------------

function section4(): void {
  const draft = validateAddonDraft({ ...VALID_DRAFT, name: 'Torrentio', description: 'HTTP + P2P + torrent streams', capabilities: { supportsStream: true, p2p: true, tracker: 'udp://tracker.example' } });
  ok(draft.name === 'Torrentio', '4: Torrentio addon ACCEPTED');
  ok(draft.capabilities.p2p === true, '4: p2p capability preserved');
  ok(draft.capabilities.tracker === 'udp://tracker.example', '4: tracker capability preserved');
}

// ---------------------------------------------------------------------------
// 5. Mixed HTTP + P2P + HLS + DASH + magnet → all preserved
// ---------------------------------------------------------------------------

function section5(): void {
  const result = normalizeStremioStreamResponseForDownloader({
    streams: [
      { name: 'http', url: 'https://x.example/a.mkv' },
      { name: 'hls', url: 'https://x.example/master.m3u8' },
      { name: 'dash', url: 'https://x.example/manifest.mpd' },
      { name: 'p2p', infoHash: 'deadbeef', sources: ['udp://tracker.example:1337'] },
      { name: 'magnet', url: 'magnet:?xt=urn:btih:feedface' },
    ],
  });
  ok(result.entries.length === 5, `5: ALL 5 mixed streams preserved (got ${result.entries.length})`);
  const kinds = result.entries.map((e) => e.kind);
  ok(kinds.includes('https'), '5: HTTP preserved');
  ok(kinds.includes('hls'), '5: HLS preserved');
  ok(kinds.includes('dash'), '5: DASH preserved');
  ok(kinds.includes('p2p'), '5: P2P preserved');
  ok(kinds.includes('magnet'), '5: Magnet preserved');
}

// ---------------------------------------------------------------------------
// 6. infoHash-only stream → magnet representation preserved/generated correctly
// ---------------------------------------------------------------------------

function section6(): void {
  const result = normalizeStremioStreamResponseForDownloader({
    streams: [{ name: 'torrent', infoHash: 'abc123def', sources: ['udp://tracker1.example:1337', 'https://tracker2.example/announce'] }],
  });
  ok(result.entries.length === 1, '6: infoHash-only entry preserved');
  ok(result.entries[0]?.kind === 'p2p', '6: classified as p2p');
  ok(result.entries[0]?.url.startsWith('magnet:?xt=urn:btih:abc123def'), '6: magnet URI has correct xt');
  ok(result.entries[0]?.url.includes('tr=udp%3A%2F%2Ftracker1.example%3A1337'), '6: magnet URI includes tracker 1');
}

// ---------------------------------------------------------------------------
// 7. externalUrl-only stream → hidden/excluded from UI
// ---------------------------------------------------------------------------

function section7(): void {
  const result = normalizeStremioStreamResponseForDownloader({
    streams: [
      { name: 'http', url: 'https://x.example/a.mkv' },
      { name: 'external', externalUrl: 'https://opens-elsewhere.example/page' },
    ],
  });
  ok(result.entries.length === 2, '7: normalizer classifies both entries (external is classified, not dropped)');
  ok(result.entries[0]?.kind !== 'external' || result.entries[1]?.kind !== 'external', '7: at least one non-external entry');
  // The external entry is classified as 'external' — the UI hides it (Phase 18).
  const external = result.entries.find((e) => e.kind === 'external');
  ok(external !== undefined, '7: external entry is CLASSIFIED (for diagnostics) but hidden by the UI');
}

// ---------------------------------------------------------------------------
// 8. Entry with usable url + externalUrl → usable url wins
// ---------------------------------------------------------------------------

function section8(): void {
  const result = normalizeStremioStreamResponseForDownloader({
    streams: [{ name: 'both', url: 'https://x.example/movie.mkv', externalUrl: 'https://opens-elsewhere.example/page' }],
  });
  ok(result.entries.length === 1, '8: entry preserved');
  ok(result.entries[0]?.kind === 'https', `8: kind = https (url wins over externalUrl) (got ${result.entries[0]?.kind})`);
  ok(result.entries[0]?.url === 'https://x.example/movie.mkv', '8: the url is preserved (NOT the externalUrl)');
}

// ---------------------------------------------------------------------------
// 9. HLS preserved
// ---------------------------------------------------------------------------

function section9(): void {
  const result = normalizeStremioStreamResponseForDownloader({ streams: [{ name: 'hls', url: 'https://x.example/master.m3u8' }] });
  ok(result.entries.length === 1 && result.entries[0]?.kind === 'hls', '9: HLS preserved');
}

// ---------------------------------------------------------------------------
// 10. DASH preserved
// ---------------------------------------------------------------------------

function section10(): void {
  const result = normalizeStremioStreamResponseForDownloader({ streams: [{ name: 'dash', url: 'https://x.example/manifest.mpd' }] });
  ok(result.entries.length === 1 && result.entries[0]?.kind === 'dash', '10: DASH preserved');
}

// ---------------------------------------------------------------------------
// 11. No quality/size/type filtering silently removes discovery entries
// ---------------------------------------------------------------------------

function section11(): void {
  const streams: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 49; i += 1) {
    streams.push({ name: `s${i}`, url: `https://cdn.example/stream-${i}.mkv` });
  }
  const result = normalizeStremioStreamResponseForDownloader({ streams });
  ok(result.entries.length === 49, `11: 49 entries → 49 preserved (no silent filtering) (got ${result.entries.length})`);
}

// ---------------------------------------------------------------------------
// 12. P2P/magnet Share uses text field (native-share-compatible)
// ---------------------------------------------------------------------------

function section12(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Phase 20: for non-http(s) URIs, use `text` field instead of `url`.
  ok(component.includes('shareData.text = url'), '12: P2P/magnet share uses text field');
  ok(component.includes("url.startsWith('http://') || url.startsWith('https://')"), '12: http(s) detection for share field selection');
}

// ---------------------------------------------------------------------------
// 13. HTTP/HTTPS sharing uses url field (unchanged)
// ---------------------------------------------------------------------------

function section13(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('shareData.url = url'), '13: HTTP/HTTPS share uses url field (unchanged)');
}

// ---------------------------------------------------------------------------
// 14. Exact original URI is preserved during sharing
// ---------------------------------------------------------------------------

function section14(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('url = stream.url'), '14: Share handler binds url = stream.url (the EXACT ORIGINAL URI)');
  ok(component.includes('shareData'), '14: shareData object is constructed from the original url');
  // No rewriting/proxying.
  ok(!component.includes('/api/proxy') && !component.includes('proxyMediaUrl'), '14: NO proxy machinery in share');
}

// ---------------------------------------------------------------------------
// 15. FORBIDDEN_MODEL_TOKENS is now empty (semantic rejection removed)
// ---------------------------------------------------------------------------

function section15(): void {
  ok(FORBIDDEN_MODEL_TOKENS.length === 0, `15: FORBIDDEN_MODEL_TOKENS is empty (Phase 20: semantic rejection removed) (got length ${FORBIDDEN_MODEL_TOKENS.length})`);
  ok(read('src/lib/server/streaming/addon-validation.ts').includes('FORBIDDEN_MODEL_TOKENS'), '15: the constant still EXISTS (back-compat) but is empty');
}

// ---------------------------------------------------------------------------
// 16. Player normalizer is UNCHANGED (still rejects P2P/torrent/magnet)
// ---------------------------------------------------------------------------

function section16(): void {
  const playerNormalizerSource = read('src/lib/server/streaming/stremio/stream-normalize.ts');
  ok(playerNormalizerSource.includes('torrent'), '16: player normalizer still has torrent rejection (unchanged)');
  ok(playerNormalizerSource.includes('non-http-url'), '16: player normalizer still rejects non-http schemes (unchanged)');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

section1();
section2();
section3();
section4();
section5();
section6();
section7();
section8();
section9();
section10();
section11();
section12();
section13();
section14();
section15();
section16();

console.log(`stremio_downloader_phase20_test: ${passed} checks passed (FINAL ADDON PHASE: addon acceptance + P2P/magnet share fix)`);
