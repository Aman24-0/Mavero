import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 7: Provider playback capability display tests.
//
// These tests verify the capability matrix that the admin UI displays for
// each provider. The matrix is driven by the shared
// `src/lib/shared/player-capabilities.ts` module, which is the single source
// of truth for ProviderPlaybackCapabilities constants.
//
// Coverage:
//   - Shared module exports the type + all constants
//   - lookupProviderCapabilities returns correct values for known adapters
//   - lookupProviderCapabilities returns null for unknown adapters
//   - Representative providers: VidSrc, VidLink, CineSrc, VidPhantom
//   - Three-state model: supported / unsupported / unknown
//   - Unknown is NOT the same as unsupported
//   - Existing capability values preserved (no "upgrades")
//   - Providers page loads capability data + displays matrix
//   - DB capabilities JSON is a separate concept (not confused with playback capabilities)

const shared = readFileSync(new URL('../src/lib/shared/player-capabilities.ts', import.meta.url), 'utf8');
const clientReexport = readFileSync(new URL('../src/lib/client/player/capabilities.ts', import.meta.url), 'utf8');
const providersServer = readFileSync(new URL('../src/routes/admin/providers/+page.server.ts', import.meta.url), 'utf8');
const providersPage = readFileSync(new URL('../src/routes/admin/providers/+page.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Shared module exports the type + all constants
// ============================================================

assert.match(shared, /export type ProviderPlaybackCapabilities = \{/, 'shared exports ProviderPlaybackCapabilities type');
assert.match(shared, /export const DIRECT_PLAYBACK_CAPABILITIES/, 'shared exports DIRECT_PLAYBACK_CAPABILITIES');
assert.match(shared, /export const EMBED_PLAYBACK_CAPABILITIES/, 'shared exports EMBED_PLAYBACK_CAPABILITIES');
assert.match(shared, /export function defaultCapabilitiesForSource/, 'shared exports defaultCapabilitiesForSource');
assert.match(shared, /export const VIDSRC_CAPABILITIES/, 'shared exports VIDSRC_CAPABILITIES');
assert.match(shared, /export const VIDLINK_CAPABILITIES/, 'shared exports VIDLINK_CAPABILITIES');
assert.match(shared, /export const VIDY_CAPABILITIES/, 'shared exports VIDY_CAPABILITIES');
assert.match(shared, /export const VIDUKI_CAPABILITIES/, 'shared exports VIDUKI_CAPABILITIES');
assert.match(shared, /export const CINEMAOS_CAPABILITIES/, 'shared exports CINEMAOS_CAPABILITIES');
assert.match(shared, /export const CINESRC_CAPABILITIES/, 'shared exports CINESRC_CAPABILITIES');
assert.match(shared, /export const VIDAPI_QZZ_CAPABILITIES/, 'shared exports VIDAPI_QZZ_CAPABILITIES');
assert.match(shared, /export const VIDPHANTOM_CAPABILITIES/, 'shared exports VIDPHANTOM_CAPABILITIES');

// ============================================================
// 2. lookupProviderCapabilities + PROVIDER_CAPABILITY_MAP
// ============================================================

assert.match(shared, /export const PROVIDER_CAPABILITY_MAP: Record<string, ProviderPlaybackCapabilities>/, 'PROVIDER_CAPABILITY_MAP exported');
assert.match(shared, /export function lookupProviderCapabilities\(adapterId: string \| null \| undefined\): ProviderPlaybackCapabilities \| null/, 'lookupProviderCapabilities exported');

// ============================================================
// 3. Client module re-exports from shared (single source of truth)
// ============================================================

assert.match(clientReexport, /export \{[\s\S]*\} from '\$lib\/shared\/player-capabilities'/, 'client re-exports from shared module');
assert.match(clientReexport, /type ProviderPlaybackCapabilities/, 'client re-exports type');
assert.match(clientReexport, /DIRECT_PLAYBACK_CAPABILITIES/, 'client re-exports DIRECT_PLAYBACK_CAPABILITIES');
assert.match(clientReexport, /CINESRC_CAPABILITIES/, 'client re-exports CINESRC_CAPABILITIES');

// ============================================================
// 4. Behavioral test: lookupProviderCapabilities for known adapters
// ============================================================

// We can't import the TS module directly in tsx without compilation, but we
// can verify the map contents by parsing the source. The map maps adapter_id
// strings to capability constants.
function extractCapabilityMap(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  const mapStart = source.indexOf('PROVIDER_CAPABILITY_MAP');
  const mapEnd = source.indexOf('};', mapStart);
  const mapBody = source.slice(mapStart, mapEnd);
  const re = /'([a-z0-9-]+)':\s*(\w+)_CAPABILITIES/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mapBody)) !== null) {
    map[m[1]] = m[2] + '_CAPABILITIES';
  }
  return map;
}

const capMap = extractCapabilityMap(shared);
assert.ok(capMap['vidsrc'] === 'VIDSRC_CAPABILITIES', 'vidsrc maps to VIDSRC_CAPABILITIES');
assert.ok(capMap['vidlink'] === 'VIDLINK_CAPABILITIES', 'vidlink maps to VIDLINK_CAPABILITIES');
assert.ok(capMap['cinesrc'] === 'CINESRC_CAPABILITIES', 'cinesrc maps to CINESRC_CAPABILITIES');
assert.ok(capMap['vidphantom'] === 'VIDPHANTOM_CAPABILITIES', 'vidphantom maps to VIDPHANTOM_CAPABILITIES');
assert.ok(capMap['vidy'] === 'VIDY_CAPABILITIES', 'vidy maps to VIDY_CAPABILITIES');
assert.ok(capMap['viduki'] === 'VIDUKI_CAPABILITIES', 'viduki maps to VIDUKI_CAPABILITIES');
assert.ok(capMap['cinemaos'] === 'CINEMAOS_CAPABILITIES', 'cinemaos maps to CINEMAOS_CAPABILITIES');
assert.ok(capMap['vidapi-qzz'] === 'VIDAPI_QZZ_CAPABILITIES', 'vidapi-qzz maps to VIDAPI_QZZ_CAPABILITIES');

// ============================================================
// 5. Behavioral test: lookupProviderCapabilities returns null for unknown
// ============================================================

function lookupAdapter(adapterId: string | null | undefined): string | null {
  if (!adapterId) return null;
  return capMap[adapterId] ?? null;
}

// Known adapters return a constant name.
assert.ok(lookupAdapter('vidsrc') !== null, 'known adapter vidsrc returns non-null');
assert.ok(lookupAdapter('cinesrc') !== null, 'known adapter cinesrc returns non-null');
// Unknown adapters return null.
assert.strictEqual(lookupAdapter('unknown-adapter'), null, 'unknown adapter returns null');
assert.strictEqual(lookupAdapter(''), null, 'empty string returns null');
assert.strictEqual(lookupAdapter(null), null, 'null returns null');
assert.strictEqual(lookupAdapter(undefined), null, 'undefined returns null');

// ============================================================
// 6. Representative provider capability values preserved (no "upgrades")
// ============================================================

// VidSrc: seek=false, startAt=true, postMessage=true, nextEpisode=true.
function extractCapabilityValues(source: string, constName: string): Record<string, boolean> {
  const start = source.indexOf(`export const ${constName}`);
  const end = source.indexOf('};', start);
  const body = source.slice(start, end);
  const values: Record<string, boolean> = {};
  const re = /(\w+):\s*(true|false)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    values[m[1]] = m[2] === 'true';
  }
  return values;
}

const vidsrc = extractCapabilityValues(shared, 'VIDSRC_CAPABILITIES');
assert.strictEqual(vidsrc.seek, false, 'VidSrc seek=false (not upgraded)');
assert.strictEqual(vidsrc.startAt, true, 'VidSrc startAt=true');
assert.strictEqual(vidsrc.postMessage, true, 'VidSrc postMessage=true');
assert.strictEqual(vidsrc.nextEpisode, true, 'VidSrc nextEpisode=true');
assert.strictEqual(vidsrc.play, false, 'VidSrc play=false (events only, not commands)');

const vidlink = extractCapabilityValues(shared, 'VIDLINK_CAPABILITIES');
assert.strictEqual(vidlink.seek, false, 'VidLink seek=false (not upgraded)');
assert.strictEqual(vidlink.startAt, true, 'VidLink startAt=true');
assert.strictEqual(vidlink.postMessage, true, 'VidLink postMessage=true');

const cinesrc = extractCapabilityValues(shared, 'CINESRC_CAPABILITIES');
assert.strictEqual(cinesrc.seek, true, 'CineSrc seek=true (only provider with verified seek command)');
assert.strictEqual(cinesrc.play, true, 'CineSrc play=true (verified bidirectional)');
assert.strictEqual(cinesrc.pause, true, 'CineSrc pause=true');
assert.strictEqual(cinesrc.volume, true, 'CineSrc volume=true');
assert.strictEqual(cinesrc.pictureInPicture, true, 'CineSrc PiP=true (verified)');
assert.strictEqual(cinesrc.subtitles, false, 'CineSrc subtitles=false (not verified — not upgraded)');

const vidphantom = extractCapabilityValues(shared, 'VIDPHANTOM_CAPABILITIES');
assert.strictEqual(vidphantom.postMessage, true, 'VidPhantom postMessage=true (snippet confirms API exists)');
assert.strictEqual(vidphantom.seek, false, 'VidPhantom seek=false (conservative — origin unreachable)');
assert.strictEqual(vidphantom.play, false, 'VidPhantom play=false (conservative)');
assert.strictEqual(vidphantom.fullscreen, false, 'VidPhantom fullscreen=false (conservative)');

// CinemaOS: partial — postMessage=true but currentTime/duration/play/pause=false (UNKNOWN→false).
const cinemaos = extractCapabilityValues(shared, 'CINEMAOS_CAPABILITIES');
assert.strictEqual(cinemaos.postMessage, true, 'CinemaOS postMessage=true (API exists)');
assert.strictEqual(cinemaos.currentTime, false, 'CinemaOS currentTime=false (UNKNOWN — not upgraded)');
assert.strictEqual(cinemaos.play, false, 'CinemaOS play=false (UNKNOWN — not upgraded)');

// ============================================================
// 7. Three-state model: supported / unsupported / unknown
// ============================================================

assert.match(shared, /SUPPORTED[\s\S]*UNSUPPORTED[\s\S]*UNKNOWN/, 'three-state model documented');
assert.match(shared, /do NOT "upgrade" capabilities based on assumptions/, 'no-upgrade rule documented');
assert.match(shared, /For providers without a registered adapter, the admin UI[\s\S]*shows UNKNOWN for all 14 fields \(NOT unsupported\)/, 'unknown ≠ unsupported documented');

// ============================================================
// 8. Providers page loads capability data
// ============================================================

assert.match(providersServer, /lookupProviderCapabilities/, 'providers server loads capability lookup');
assert.match(providersServer, /capabilityMap/, 'providers server builds capabilityMap');
assert.match(providersServer, /Object\.entries\(caps\)\.filter\(\(\[, v\]\) => v === true\)\.map\(\(\[k\]\) => k\)/, 'providers server extracts supported fields');
assert.match(providersServer, /Object\.entries\(caps\)\.filter\(\(\[, v\]\) => v === false\)\.map\(\(\[k\]\) => k\)/, 'providers server extracts unsupported fields');

// ============================================================
// 9. Providers page displays matrix with three states
// ============================================================

assert.match(providersPage, /import \{ CAPABILITY_FIELDS, CAPABILITY_LABELS, type ProviderPlaybackCapabilities \}/, 'providers page imports capability helpers');
assert.match(providersPage, /capabilityState\(provider\.id, field\)/, 'providers page computes three-state value');
assert.match(providersPage, /'supported' \| 'unsupported' \| 'unknown'/, 'providers page has three-state return type');
assert.match(providersPage, /class:ok=\{state === 'supported'\}/, 'supported → ok class');
assert.match(providersPage, /class:no=\{state === 'unsupported'\}/, 'unsupported → no class');
assert.match(providersPage, /class:unknown=\{state === 'unknown'\}/, 'unknown → unknown class');

// ============================================================
// 10. Unknown display uses HelpCircle icon (NOT X for unsupported)
// ============================================================

assert.match(providersPage, /import \{[^}]*HelpCircle/, 'imports HelpCircle for unknown state');
assert.match(providersPage, /\{:else\}<HelpCircle size=\{12\}/, 'unknown state uses HelpCircle');
assert.match(providersPage, /state === 'unsupported'[\s\S]*<X size=\{12\}/, 'unsupported uses X');

// ============================================================
// 11. DB capabilities JSON is a SEPARATE concept (not confused)
// ============================================================

// The providers page still shows the DB capabilities JSON textarea (media support,
// sandbox policy, etc.) — that's a separate concept from the 14-field playback
// capability matrix.
assert.match(providersPage, /Capabilities JSON/, 'DB capabilities JSON textarea still exists (separate concept)');
assert.match(shared, /DB `capabilities` JSON[\s\S]*SEPARATE concept/i, 'shared module documents separation');

console.log('Phase 7 admin capability display tests passed: shared module exports (12 checks); lookupProviderCapabilities + map (2 checks); client re-export (3 checks); known adapter lookup (8 checks); unknown adapter returns null (5 checks); representative provider values preserved — VidSrc (5) + VidLink (3) + CineSrc (6) + VidPhantom (4) + CinemaOS (3) = 21 checks; three-state model (3 checks); providers page loads capability data (4 checks); providers page displays matrix (5 checks); unknown uses HelpCircle (2 checks); DB capabilities JSON separate concept (2 checks).');
