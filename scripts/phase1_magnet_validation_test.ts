import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeStremioStreamResponseForDownloader } from '$lib/server/streaming/stremio/stream-normalize-downloader';
import { isValidBtih, isMagnetUri } from '$lib/server/streaming/stremio/stream-normalize-downloader';

/**
 * Phase 1 (audit SEC-011 / STM-08) — magnet validation.
 *
 * Problem: downloader normalization accepted arbitrary short strings as
 * magnet-like infoHash/magnet input — `"deadbeef"` became the "valid
 * magnet" `magnet:?xt=urn:btih:deadbeef`, a garbage `magnetUri: "hello"`
 * was classified as a magnet stream and surfaced in the UI (Share text).
 *
 * Fix: a magnet is classified as such ONLY in the legitimate BitTorrent
 * form — `magnet:?...xt=urn:btih:<HASH>` with a real btih (40 hex or 32
 * base32). Valid Stremio magnet streams are preserved VERBATIM for
 * sharing; malformed/garbage values are rejected (fall through to the next
 * candidate URI or count malformed) instead of being presented as magnets.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const VALID_HEX = 'deadbeef0123456789abcdef0123456789abcdef'; // 40 hex
const VALID_BASE32 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaazm'.slice(0, 32); // 32 base32 chars
assert.ok(/^[a-z2-7]{32}$/.test(VALID_BASE32), 'base32 fixture sanity');

function normalizeEntry(entry: Record<string, unknown>) {
  const result = normalizeStremioStreamResponseForDownloader({ streams: [entry] });
  return result.entries[0] ?? null;
}

// ============================================================
// 1. Pure classification — btih + magnet form
// ============================================================

assert.equal(isValidBtih(VALID_HEX), true, '40-hex is a valid btih');
assert.equal(isValidBtih(VALID_BASE32), true, '32-base32 is a valid btih');
assert.equal(isValidBtih('deadbeef'), false, '8-hex placeholder is NOT a valid btih');
assert.equal(isValidBtih('abc123def'), false, '9-char placeholder is NOT a valid btih');
assert.equal(isValidBtih('hash0'), false, 'word garbage is NOT a valid btih');
assert.equal(isValidBtih('0zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), false, 'invalid base32 symbol (0/1/8/9) rejected');
assert.equal(isValidBtih('gzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), true, 'letters are legitimate base32 symbols (A-Z + 2-7)');
assert.equal(isValidBtih(`${VALID_HEX}0`), false, '41 chars rejected');
ok(true, '1. btih classification: 40-hex / 32-base32 only (placeholders and garbage rejected)');

assert.equal(isMagnetUri(`magnet:?xt=urn:btih:${VALID_HEX}`), true, 'canonical magnet accepted');
assert.equal(isMagnetUri(`magnet:?dn=Movie&xt=urn:btih:${VALID_HEX}&tr=udp%3A%2F%2Ftracker`), true, 'xt NOT first is still accepted (valid Stremio form)');
assert.equal(isMagnetUri(`magnet:?xt=urn:btih:${VALID_HEX.toUpperCase()}`), true, 'case-insensitive hash');
assert.equal(isMagnetUri('magnet:?xt=urn:btih:deadbeef'), false, 'short hash rejected');
assert.equal(isMagnetUri('magnet:?dn=only-name'), false, 'magnet without xt rejected');
assert.equal(isMagnetUri('magnet:?xt=urn:sha1:ABCDEF'), false, 'non-btih urn rejected');
assert.equal(isMagnetUri('hello'), false, 'arbitrary string rejected');
assert.equal(isMagnetUri(`magnet:?xt=urn:btih:${VALID_HEX}&${'x'.repeat(2100)}`), false, 'oversized magnet rejected');
ok(true, '2. magnet classification: btih form required, param order flexible, bounds enforced');

// ============================================================
// 2. Behavioral — normalization outcomes
// ============================================================

// 2a. VALID infoHash → magnet representation preserved (existing contract).
{
  const entry = normalizeEntry({ name: 'torrent', infoHash: VALID_HEX, sources: ['udp://tracker.example:1337'] });
  assert.ok(entry, 'infoHash-only entry preserved');
  assert.equal(entry?.kind, 'p2p', 'infoHash-only classifies as p2p');
  assert.equal(entry?.url, `magnet:?xt=urn:btih:${VALID_HEX}&dn=torrent&tr=udp%3A%2F%2Ftracker.example%3A1337`, 'constructed magnet is the legitimate btih form');
  ok(true, '2a. valid infoHash-only stream → legitimate magnet URI (Stremio contract preserved)');
}

// 2b. VALID magnet URI → EXACT original preserved for sharing.
{
  const original = `magnet:?xt=urn:btih:${VALID_HEX}&dn=My%20Movie&tr=udp%3A%2F%2Ftracker.example%3A1337`;
  const entry = normalizeEntry({ name: 'magnet stream', magnetUri: original });
  assert.ok(entry);
  assert.equal(entry?.kind, 'magnet', 'valid magnet classified as magnet');
  assert.equal(entry?.url, original, 'the EXACT original magnet URI is preserved (sharing unchanged)');
  ok(true, '2b. valid magnet stream preserved verbatim (sharing contract intact)');
}

// 2c. GARBAGE magnetUri → NOT presented as a magnet.
{
  for (const garbage of ['hello', 'magnet:?dn=no-hash', 'magnet:?xt=urn:btih:deadbeef', 'magnet:plain-text']) {
    const entry = normalizeEntry({ name: 'bad', magnetUri: garbage });
    assert.ok(entry === null || entry.kind !== 'magnet', `garbage magnetUri must not surface as magnet: "${garbage}"`);
    assert.ok(entry === null || entry.url !== garbage, `garbage URI must not be the surfaced url: "${garbage}"`);
  }
  ok(true, '2c. garbage magnetUri values rejected/unsupported (never presented as valid magnets)');
}

// 2d. GARBAGE infoHash → not turned into a magnet.
{
  const entry = normalizeEntry({ name: 'bad hash', infoHash: 'deadbeef', sources: ['udp://tracker.example:1337'] });
  assert.ok(entry === null || (entry.kind !== 'magnet' && entry.kind !== 'p2p'), 'garbage infoHash must not become a magnet/p2p entry');
  const nothing = normalizeEntry({ name: 'bad hash only', infoHash: 'deadbeef' });
  assert.equal(nothing, null, 'garbage infoHash alone counts malformed (not a magnet)');
  ok(true, '2d. garbage infoHash values no longer become magnets (counted malformed instead)');
}

// 2e. Garbage magnet-LOOKING url + valid infoHash → falls back to the legit infoHash magnet.
{
  const entry = normalizeEntry({ name: 'fallback', url: 'magnet:?xt=urn:btih:garbage', infoHash: VALID_HEX });
  assert.ok(entry);
  assert.equal(entry?.url, `magnet:?xt=urn:btih:${VALID_HEX}&dn=fallback`, 'the garbage magnet url is skipped; the VALID infoHash magnet wins');
  ok(true, '2e. magnet-url form validation with graceful fallback to the legitimate infoHash');
}

// 2f. Upper-case / mixed-case valid infoHash is lowercased into the magnet.
{
  const upper = VALID_HEX.toUpperCase();
  const entry = normalizeEntry({ name: 'case', infoHash: upper });
  assert.equal(entry?.url, `magnet:?xt=urn:btih:${VALID_HEX}&dn=case`, 'mixed-case valid hash accepted and canonicalized');
  ok(true, '2f. case handling: valid mixed-case hash accepted, canonical form produced');
}

// ============================================================
// 3. Static — the validators guard every magnet entry path
// ============================================================

{
  const source = read('src/lib/server/streaming/stremio/stream-normalize-downloader.ts');
  assert.match(source, /const infoHash = typeof infoHashRaw === 'string' && infoHashRaw\.length > 0 && infoHashRaw\.length <= 200 && isValidBtih\(infoHashRaw\.toLowerCase\(\)\)/, 'infoHash gated on the btih form');
  assert.match(source, /magnetUriRaw\.length <= MAGNET_URI_MAX_LENGTH && isMagnetUri\(magnetUriRaw\)/, 'magnetUri gated on the magnet form');
  assert.match(source, /rawUrl\.toLowerCase\(\)\.startsWith\('magnet:'\) && isMagnetUri\(rawUrl\)/, 'magnet-form url gated on the magnet form');
  ok(true, '3. all three magnet entry paths (magnetUri / magnet url / infoHash) are gated');
}

console.log(`phase1_magnet_validation_test: ${passed} checks passed (magnet classification tightened, valid Stremio magnets preserved)`);
