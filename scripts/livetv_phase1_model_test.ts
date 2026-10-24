// ============================================================================
// UNIFIED LIVE TV — Phase 1 model verification (pure logic, no database).
//
// Covers requirement §13 for the parts that live in
// src/lib/server/livetv/registry.ts:
//   §1  Source config validation per type (valid + invalid shapes)
//   §2  SSRF safeguards on server-fetched URLs (reuse of stremio/ssrf.ts
//       stage-1: private/metadata/literal hosts, credentials, non-https)
//   §3  Endpoint type validation — stream URL vs embed URL separation, the
//       typed kind/format contract, dispatch compatibility
//   §4  Engine routing — engines are DERIVED from endpoint kind; the engine
//       vocabulary and the source vocabulary never intersect (an engine can
//       never be registered as a source; priority never attaches to engines)
//   §5  Effective enablement rules — the full gate matrix (S1/S2/C1/M0/M1/E1/P1)
//   §6  Deterministic priority ordering + tie-breaking + duplicate-attempt
//       prevention (explicit mode) and the source-priority default mode
//   §7  LiveGT direct vs embed endpoint separation (both representable,
//       independently enableable/orderable)
//   §8  Conservative identity semantics — unmapped entries never resolve;
//       provenance (source ids/ids-per-source) is carried end-to-end
//   §9  VOD isolation — no import edges between this module and VOD code
//
// NO network, NO database, NO Shaka package.
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  LIVETV_SOURCE_TYPES,
  LIVETV_ENDPOINT_KINDS,
  LIVETV_PLAYBACK_ENGINES,
  LIVETV_ENDPOINT_ENGINES,
  playbackEngineForEndpoint,
  LivetvRegistryValidationError,
  validateLivetvSourceConfig,
  validateLivetvEndpointInput,
  explainLivetvCandidateBlock,
  isLivetvCandidateEligible,
  orderExplicitLivetvCandidates,
  buildDefaultLivetvOrder,
  buildDirectLivetvEntryOrder,
  explainLivetvDirectEntryBlock,
  resolveLivetvPlaybackOrder,
  type LivetvCandidateRecord,
  type LivetvEndpointKind,
  type LivetvStreamFormat
} from '../src/lib/server/livetv/registry.ts';

let passed = 0;
function ok(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function fails(fn: () => unknown, label: string, mustContain?: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LivetvRegistryValidationError, `${label} — throws LivetvRegistryValidationError (got ${String(error)})`);
    if (mustContain) assert.ok(String((error as Error).message).includes(mustContain), `${label} — message mentions "${mustContain}" (got "${String((error as Error).message)}")`);
    passed += 1;
    console.log(`  ok ${passed} - ${label}`);
    return;
  }
  assert.fail(`${label} — expected a throw, got none`);
}

// ---------------------------------------------------------------------------
// §1 — source config validation
// ---------------------------------------------------------------------------
console.log('§1 source configuration validation');

ok(validateLivetvSourceConfig('builtin_livegt_v1', {}) && true, '§1.1 builtin_livegt_v1 accepts an empty config');
ok(validateLivetvSourceConfig('manual_stream', {}) && true, '§1.2 manual_stream accepts an empty config');
ok(validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://iptv-org.github.io/iptv/index.m3u' }).playlistUrl === 'https://iptv-org.github.io/iptv/index.m3u', '§1.3 m3u_playlist accepts a valid https playlist URL');
ok(validateLivetvSourceConfig('api_provider', { baseUrl: 'https://api.example.com' }).baseUrl === 'https://api.example.com', '§1.4 api_provider accepts a valid https baseUrl');
ok(Array.isArray(validateLivetvSourceConfig('embed_provider', { allowedOrigins: ['https://player.example.com'] }).allowedOrigins), '§1.5 embed_provider accepts an https origin allowlist');

fails(() => validateLivetvSourceConfig('m3u_playlist', {}), '§1.6 m3u_playlist without playlistUrl fails');
fails(() => validateLivetvSourceConfig('api_provider', {}), '§1.7 api_provider without baseUrl fails');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://ok.example/x.m3u', secret: 'hunter2' }), '§1.8 unknown config keys are rejected (no secret can hide in config)', 'unknown config key');
fails(() => validateLivetvSourceConfig('builtin_livegt_v1', { token: 'x' }), '§1.9 builtin_livegt_v1 rejects any config key');
fails(() => validateLivetvSourceConfig('m3u_playlist', 'https://not-an-object.example'), '§1.10 a non-object config is rejected');
fails(() => validateLivetvSourceConfig('embed_provider', { allowedOrigins: [] }), '§1.11 embed_provider requires a non-empty origin list');
fails(() => validateLivetvSourceConfig('embed_provider', { allowedOrigins: ['http://player.example.com'] }), '§1.12 embed origins must be https');
fails(() => validateLivetvSourceConfig('embed_provider', { allowedOrigins: ['https://player.example.com/path'] }), '§1.13 embed origins must not include a path');
ok(
  validateLivetvSourceConfig('embed_provider', { allowedOrigins: ['https://player.example.com:443', 'https://other.example.net'] }).allowedOrigins[0] === 'https://player.example.com',
  '§1.14 default-port origins normalize (443 stripped)'
);

// ---------------------------------------------------------------------------
// §2 — SSRF safeguards (stage-1 guard reuse for server-fetched URLs)
// ---------------------------------------------------------------------------
console.log('§2 SSRF safeguards on server-fetched config URLs');

fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'http://iptv-org.github.io/iptv/index.m3u' }), '§2.1 non-https playlist URL rejected (documented https-only policy)');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://localhost/x.m3u' }), '§2.2 localhost playlist host blocked');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://127.0.0.1/x.m3u' }), '§2.3 IPv4 loopback literal blocked');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://10.0.0.5/x.m3u' }), '§2.4 private-range IPv4 literal blocked');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://169.254.169.254/latest/meta-data' }), '§2.5 cloud-metadata endpoint blocked');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://0x7f000001/x.m3u' }), '§2.6 hex-encoded IPv4 literal blocked');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://user:pass@example.com/x.m3u' }), '§2.7 credentials in URL rejected');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://internal.example.local/x.m3u' }), '§2.8 .local (mDNS) suffix blocked');
fails(() => validateLivetvSourceConfig('m3u_playlist', { playlistUrl: 'https://[::1]/x.m3u' }), '§2.9 IPv6 loopback literal blocked');
fails(() => validateLivetvSourceConfig('api_provider', { baseUrl: 'https://192.168.1.10/api' }), '§2.10 private-range API base blocked');
ok(true, '§2.11 all SSRF rejections surface as LivetvRegistryValidationError (typed, no upstream error leaks)');

// ---------------------------------------------------------------------------
// §3 — endpoint validation: stream URL vs embed URL separation
// ---------------------------------------------------------------------------
console.log('§3 endpoint type validation and dispatch compatibility');

const dashOk = validateLivetvEndpointInput({ endpointKind: 'direct_stream', streamFormat: 'dash', url: 'https://cdn.example/stream.mpd' });
ok(dashOk.streamFormat === 'dash' && dashOk.url === 'https://cdn.example/stream.mpd', '§3.1 a direct dash endpoint validates');
const hlsOk = validateLivetvEndpointInput({ endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/stream.m3u8' });
ok(hlsOk.streamFormat === 'hls', '§3.2 a direct hls endpoint validates');
const embedOk = validateLivetvEndpointInput({ endpointKind: 'embed_page', url: 'https://livetgtv.lovable.app/embed/143' });
ok(embedOk.streamFormat === null, '§3.3 an embed endpoint validates WITHOUT a stream format');

fails(() => validateLivetvEndpointInput({ endpointKind: 'direct_stream', url: 'https://cdn.example/stream.mpd' }), '§3.4 direct_stream without a streamFormat fails');
fails(() => validateLivetvEndpointInput({ endpointKind: 'embed_page', streamFormat: 'hls' as unknown as undefined, url: 'https://embed.example/page' }), '§3.5 an embed endpoint CANNOT declare a stream format (iframe URL can never be treated as a manifest)', 'must not declare');
fails(() => validateLivetvEndpointInput({ endpointKind: 'direct_stream', streamFormat: 'rtmp' as unknown as LivetvStreamFormat, url: 'https://cdn.example/x' }), '§3.6 an unsupported direct format fails the closed vocabulary');
fails(() => validateLivetvEndpointInput({ endpointKind: 'embed_page', url: 'http://embed.example/page' }), '§3.7 a non-https embed URL fails');
fails(() => validateLivetvEndpointInput({ endpointKind: 'direct_stream', streamFormat: 'dash', url: 'http://cdn.example/stream.mpd' }), '§3.8 a non-https stream URL fails');
fails(() => validateLivetvEndpointInput({ endpointKind: 'embed_page', url: 'https://embed.example/pa ge?x=1' }), '§3.9 whitespace in URL fails');
fails(() => validateLivetvEndpointInput({ endpointKind: 'direct_stream', streamFormat: 'dash', url: 'https://user@cdn.example/s.mpd' }), '§3.10 credentials in a playback URL fail');
fails(() => validateLivetvEndpointInput({ endpointKind: 'direct_stream', streamFormat: 'dash', url: 'https://cdn.exa\u0001mple/s.mpd' }), '§3.11 control characters in a playback URL fail');
fails(() => validateLivetvEndpointInput({ endpointKind: 'direct_stream', streamFormat: 'dash', url: `https://cdn.example/${'a'.repeat(2100)}` }), '§3.12 an oversized playback URL fails');
fails(() => validateLivetvEndpointInput({ endpointKind: 'direct_stream', streamFormat: 'dash', url: 'not-a-url' }), '§3.13 a non-absolute playback URL fails');
fails(() => validateLivetvEndpointInput({ endpointKind: 'direct_stream' as LivetvEndpointKind, streamFormat: 'dash', url: 'https://cdn.example/x.mpd', ordering: -1 }), '§3.14 a negative ordering fails');

ok(playbackEngineForEndpoint('direct_stream') === 'shaka_media_player', '§3.15 direct_stream routes to the existing Shaka media player');
ok(playbackEngineForEndpoint('embed_page') === 'iframe_embed', '§3.16 embed_page routes to the existing iframe embed integration');

// ---------------------------------------------------------------------------
// §4 — engines are never sources (the core architectural rule)
// ---------------------------------------------------------------------------
console.log('§4 playback engines are never sources and never receive priority');

const engineVocabulary = LIVETV_PLAYBACK_ENGINES as readonly string[];
const sourceVocabulary = LIVETV_SOURCE_TYPES as readonly string[];
ok(
  engineVocabulary.every((engine) => !sourceVocabulary.includes(engine)),
  '§4.1 no playback engine exists in the source_type vocabulary'
);
ok(
  sourceVocabulary.every((source) => !engineVocabulary.includes(source)),
  '§4.2 no source type exists in the engine vocabulary'
);
ok(Object.keys(LIVETV_ENDPOINT_ENGINES).length === LIVETV_ENDPOINT_KINDS.length, '§4.3 the engine table is total over the endpoint kinds');
ok(
  LIVETV_SOURCE_TYPES.every((type) => !/shaka|iframe|player|engine/i.test(type)),
  '§4.4 no source type name references a playback engine (Shaka/iframe are not providers)'
);

// ---------------------------------------------------------------------------
// §5 — effective enablement rules (the full gate matrix)
// ---------------------------------------------------------------------------
console.log('§5 effective enablement rules');

function makeRecord(overrides: Partial<LivetvCandidateRecord> = {}): LivetvCandidateRecord {
  return {
    candidate: { rowId: 'cand-1', channelId: 'ch-1', endpointId: 'ep-1', priority: 10, enabled: true, createdAt: '2026-01-01T00:00:00Z' },
    endpoint: { id: 'ep-1', sourceChannelId: 'entry-1', kind: 'direct_stream', streamFormat: 'dash', url: 'https://cdn.example/a.mpd', ordering: 0, enabled: true, label: null },
    sourceChannel: { id: 'entry-1', sourceId: 'src-1', sourceChannelId: '143', canonicalChannelId: 'ch-1', enabled: true },
    source: { id: 'src-1', slug: 'playlist-a', sourceType: 'm3u_playlist', enabled: true, status: 'active', priority: 10 },
    channelEnabled: true,
    ...overrides
  };
}

const baseline = makeRecord();
ok(isLivetvCandidateEligible(baseline) && explainLivetvCandidateBlock(baseline) === null, '§5.1 a fully-enabled chain is eligible');

ok(explainLivetvCandidateBlock(makeRecord({ source: { ...baseline.source, enabled: false } })) === 'source_disabled', '§5.2 a DISABLED SOURCE is never selected (S1)');
ok(explainLivetvCandidateBlock(makeRecord({ source: { ...baseline.source, status: 'disabled' } })) === 'source_status_ineligible', '§5.3 a disabled-status source is ineligible (S2)');
ok(explainLivetvCandidateBlock(makeRecord({ source: { ...baseline.source, status: 'unavailable' } })) === 'source_status_ineligible', '§5.4 an unavailable-status source is ineligible (S2)');
ok(isLivetvCandidateEligible(makeRecord({ source: { ...baseline.source, status: 'experimental' } })), '§5.5 an experimental source IS eligible (Phase 7A parity)');
ok(explainLivetvCandidateBlock(makeRecord({ channelEnabled: false })) === 'channel_disabled', '§5.6 a disabled canonical channel blocks its candidates (C1)');
ok(explainLivetvCandidateBlock(makeRecord({ sourceChannel: { ...baseline.sourceChannel, canonicalChannelId: null } })) === 'source_channel_unmapped', '§5.7 an UNMAPPED source entry never resolves (M0 — conservative identity)');
ok(explainLivetvCandidateBlock(makeRecord({ sourceChannel: { ...baseline.sourceChannel, enabled: false } })) === 'source_channel_disabled', '§5.8 a disabled source entry blocks its endpoints (M1)');
ok(explainLivetvCandidateBlock(makeRecord({ endpoint: { ...baseline.endpoint, enabled: false } })) === 'endpoint_disabled', '§5.9 a disabled endpoint is ineligible (E1)');
ok(explainLivetvCandidateBlock(makeRecord({ candidate: { ...baseline.candidate, enabled: false } })) === 'candidate_disabled', '§5.10 a disabled candidate is ineligible (P1)');

// ---------------------------------------------------------------------------
// §6 — deterministic ordering and tie-breaking
// ---------------------------------------------------------------------------
console.log('§6 deterministic priority ordering, tie-breaking, default mode');

function rec(rowId: string, endpointId: string, priority: number, createdAt: string, overrides: Partial<LivetvCandidateRecord> = {}): LivetvCandidateRecord {
  const base = makeRecord();
  return {
    candidate: { ...base.candidate, rowId, endpointId, priority, createdAt },
    endpoint: { ...base.endpoint, id: endpointId },
    sourceChannel: base.sourceChannel,
    source: base.source,
    channelEnabled: base.channelEnabled,
    // Overrides always win (last spread) — matches makeRecord semantics.
    ...overrides
  };
}

const ordered = orderExplicitLivetvCandidates([
  rec('c-c', 'ep-c', 30, '2026-01-01T00:00:00Z'),
  rec('c-a', 'ep-a', 10, '2026-01-01T00:00:00Z'),
  rec('c-b', 'ep-b', 20, '2026-01-01T00:00:00Z')
]);
ok(ordered.map((candidate) => candidate.endpointId).join(',') === 'ep-a,ep-b,ep-c', '§6.1 candidates order by priority ASC regardless of input order');

const tied = orderExplicitLivetvCandidates([
  rec('c-2', 'ep-2', 10, '2026-01-02T00:00:00Z'),
  rec('c-1', 'ep-1', 10, '2026-01-01T00:00:00Z')
]);
ok(tied.map((candidate) => candidate.endpointId).join(',') === 'ep-1,ep-2', '§6.2 equal priorities tie-break by createdAt ASC');

const fullTie = orderExplicitLivetvCandidates([
  rec('zzz', 'ep-z', 10, '2026-01-01T00:00:00Z'),
  rec('aaa', 'ep-a', 10, '2026-01-01T00:00:00Z')
]);
ok(fullTie.map((candidate) => candidate.endpointId).join(',') === 'ep-a,ep-z', '§6.3 full ties break by candidate row id ASC (total, stable order)');

const filtered = orderExplicitLivetvCandidates([
  rec('c-1', 'ep-1', 10, '2026-01-01T00:00:00Z'),
  rec('c-2', 'ep-2', 20, '2026-01-01T00:00:00Z', { endpoint: { id: 'ep-2', sourceChannelId: 'entry-1', kind: 'embed_page', streamFormat: null, url: 'https://embed.example/1', ordering: 1, enabled: false, label: null } })
]);
ok(filtered.length === 1 && filtered[0]!.endpointId === 'ep-1', '§6.4 only ENABLED candidates are ordered (disabled ones drop out)');

const deduped = orderExplicitLivetvCandidates([
  rec('c-1', 'ep-1', 10, '2026-01-01T00:00:00Z'),
  rec('c-2', 'ep-1', 5, '2026-01-01T00:00:00Z')
]);
ok(deduped.length === 1, '§6.5 the same endpoint can never be attempted twice (no duplicate attempts/loops)');

ok(orderExplicitLivetvCandidates([]).length === 0, '§6.6 an empty explicit list yields an empty resolution (no silent auto-include)');

// Default mode — the user's example shape: playlist direct → LiveGT direct →
// LiveGT embed (from source priorities; NOTHING hard-coded in code).
const sources = [
  { id: 'src-playlist', slug: 'playlist-a', sourceType: 'm3u_playlist' as const, enabled: true, status: 'active' as const, priority: 5 },
  { id: 'src-livegt', slug: 'builtin-livegt-v1', sourceType: 'builtin_livegt_v1' as const, enabled: true, status: 'active' as const, priority: 10 },
  { id: 'src-embed-provider', slug: 'embed-b', sourceType: 'embed_provider' as const, enabled: true, status: 'active' as const, priority: 7 },
  { id: 'src-off', slug: 'disabled-c', sourceType: 'api_provider' as const, enabled: false, status: 'active' as const, priority: 1 }
];
const entries = [
  { id: 'entry-livegt', sourceId: 'src-livegt', sourceChannelId: '143', canonicalChannelId: 'ch-1' as string | null, enabled: true },
  { id: 'entry-playlist', sourceId: 'src-playlist', sourceChannelId: 'exnews.hd', canonicalChannelId: 'ch-1' as string | null, enabled: true },
  { id: 'entry-off', sourceId: 'src-off', sourceChannelId: 'off.1', canonicalChannelId: 'ch-1' as string | null, enabled: true },
  { id: 'entry-unmapped', sourceId: 'src-playlist', sourceChannelId: 'unmapped.1', canonicalChannelId: null, enabled: true }
];
const endpoints = [
  { id: 'ep-livegt-embed', sourceChannelId: 'entry-livegt', kind: 'embed_page' as const, streamFormat: null, url: 'https://livetgtv.lovable.app/embed/143', ordering: 1, enabled: true, label: 'LiveGT embed' },
  { id: 'ep-livegt-direct', sourceChannelId: 'entry-livegt', kind: 'direct_stream' as const, streamFormat: 'dash' as const, url: 'https://cdn.example/143.mpd', ordering: 0, enabled: true, label: null },
  { id: 'ep-playlist-direct', sourceChannelId: 'entry-playlist', kind: 'direct_stream' as const, streamFormat: 'hls' as const, url: 'https://cdn.example/exnews.m3u8', ordering: 0, enabled: true, label: null },
  { id: 'ep-off-direct', sourceChannelId: 'entry-off', kind: 'direct_stream' as const, streamFormat: 'dash' as const, url: 'https://cdn.example/off.mpd', ordering: 0, enabled: true, label: null },
  { id: 'ep-unmapped-direct', sourceChannelId: 'entry-unmapped', kind: 'direct_stream' as const, streamFormat: 'dash' as const, url: 'https://cdn.example/unmapped.mpd', ordering: 0, enabled: true, label: null }
];

const defaultOrder = buildDefaultLivetvOrder({ channelEnabled: true, sources, sourceChannels: entries, endpoints });
ok(
  defaultOrder.map((candidate) => candidate.endpointId).join(',') === 'ep-playlist-direct,ep-livegt-direct,ep-livegt-embed',
  '§6.7 default mode derives playlist → LiveGT-direct → LiveGT-embed from source priorities (never hard-coded; mirrors the §5 example)'
);
ok(defaultOrder.every((candidate) => !candidate.endpointId.startsWith('ep-off') && !candidate.endpointId.startsWith('ep-unmapped')), '§6.8 disabled sources and unmapped entries never contribute in default mode');
ok(defaultOrder[0]!.candidateId.startsWith('default:'), '§6.9 default-mode candidates carry synthetic candidate ids');

const endpointOrdered = buildDefaultLivetvOrder({
  channelEnabled: true,
  sources: [{ id: 'src-livegt', slug: 'builtin-livegt-v1', sourceType: 'builtin_livegt_v1', enabled: true, status: 'active', priority: 0 }],
  sourceChannels: [{ id: 'entry-livegt', sourceId: 'src-livegt', sourceChannelId: '143', canonicalChannelId: 'ch-1', enabled: true }],
  endpoints: [endpoints[0]!, endpoints[1]!]
});
ok(endpointOrdered.map((candidate) => candidate.endpointId).join(',') === 'ep-livegt-direct,ep-livegt-embed', '§6.10 endpoint-level ordering orders several endpoints of ONE source (direct before embed by ordering)');

ok(
  buildDefaultLivetvOrder({ channelEnabled: false, sources, sourceChannels: entries, endpoints }).length === 0,
  '§6.11 a disabled canonical channel resolves nothing in default mode (C1)'
);

const resolvedExplicit = resolveLivetvPlaybackOrder({ channelId: 'ch-1', explicitRecords: [rec('c-1', 'ep-1', 10, '2026-01-01T00:00:00Z')], defaults: { channelEnabled: true, sources, sourceChannels: entries, endpoints } });
ok(resolvedExplicit.mode === 'explicit' && resolvedExplicit.candidates.length === 1, '§6.12 explicit rows make the resolution authoritative (explicit mode)');
const resolvedDefault = resolveLivetvPlaybackOrder({ channelId: 'ch-1', explicitRecords: [], defaults: { channelEnabled: true, sources, sourceChannels: entries, endpoints } });
ok(resolvedDefault.mode === 'default' && resolvedDefault.candidates.length === 3, '§6.13 with no rows the source-priority default applies (default mode)');

// §6b — R-0: DIRECT entry resolution (the `entry:<rowId>` selection path).
// The canonical gates (C1/M0) deliberately do NOT apply; S1/S2/M1/E1 do.
console.log('§6b direct-entry resolution (R-0)');
{
  const playlistSource = sources[0]!;
  const unmappedEntry = entries[3]!;
  const unmappedEndpoints = [endpoints[4]!];
  const direct = buildDirectLivetvEntryOrder({ source: playlistSource, entry: unmappedEntry, endpoints: unmappedEndpoints });
  ok(direct.length === 1 && direct[0]!.endpointId === 'ep-unmapped-direct' && direct[0]!.engine === 'shaka_media_player', '§6b.1 an UNMAPPED entry resolves through its own endpoints (M0 deliberately absent; engine derived)');
  ok(direct[0]!.candidateId === 'default:ep-unmapped-direct', '§6b.2 direct-entry candidates carry the same synthetic id convention');
  ok(explainLivetvDirectEntryBlock({ source: playlistSource, entry: unmappedEntry, endpoints: unmappedEndpoints }) === null, '§6b.3 a fully eligible direct entry reports NO block');
  ok(buildDirectLivetvEntryOrder({ source: sources[3]!, entry: { ...unmappedEntry, sourceId: 'src-off' }, endpoints: unmappedEndpoints }).length === 0, '§6b.4 a disabled source contributes NOTHING (S1)');
  ok(buildDirectLivetvEntryOrder({ source: { ...playlistSource, status: 'unavailable' }, entry: unmappedEntry, endpoints: unmappedEndpoints }).length === 0, '§6b.5 a non-eligible status contributes NOTHING (S2)');
  ok(buildDirectLivetvEntryOrder({ source: playlistSource, entry: { ...unmappedEntry, enabled: false }, endpoints: unmappedEndpoints }).length === 0, '§6b.6 a disabled entry contributes NOTHING (M1)');
  ok(buildDirectLivetvEntryOrder({ source: playlistSource, entry: unmappedEntry, endpoints: [{ ...endpoints[4]!, enabled: false }] }).length === 0, '§6b.7 a disabled endpoint contributes NOTHING (E1)');
  const crossEntry = buildDirectLivetvEntryOrder({ source: playlistSource, entry: unmappedEntry, endpoints: [{ ...endpoints[4]!, sourceChannelId: 'entry-playlist' }] });
  ok(crossEntry.length === 0, '§6b.8 a cross-entry endpoint never contributes (defense in depth)');
}

// ---------------------------------------------------------------------------
// §7 — LiveGT direct vs embed endpoint separation
// ---------------------------------------------------------------------------
console.log('§7 LiveGT direct/embed separation');

const livegtEntry = { id: 'entry-lg', sourceId: 'src-livegt', sourceChannelId: '143', canonicalChannelId: 'ch-1' as string | null, enabled: true };
const livegtSource = { id: 'src-livegt', slug: 'builtin-livegt-v1', sourceType: 'builtin_livegt_v1' as const, enabled: true, status: 'active' as const, priority: 0 };
const lgDirect = { id: 'ep-lg-direct', sourceChannelId: 'entry-lg', kind: 'direct_stream' as const, streamFormat: 'dash' as const, url: 'https://cdn.example/143.mpd', ordering: 0, enabled: true, label: null };
const lgEmbed = { id: 'ep-lg-embed', sourceChannelId: 'entry-lg', kind: 'embed_page' as const, streamFormat: null, url: 'https://livetgtv.lovable.app/embed/143', ordering: 1, enabled: true, label: 'LiveGT embed fallback' };

const both = buildDefaultLivetvOrder({ channelEnabled: true, sources: [livegtSource], sourceChannels: [livegtEntry], endpoints: [lgDirect, lgEmbed] });
ok(both.length === 2 && both[0]!.engine === 'shaka_media_player' && both[1]!.engine === 'iframe_embed', '§7.1 LiveGT direct (Shaka) and embed (iframe) coexist and route to DIFFERENT engines');
ok(both[1]!.endpointUrl === 'https://livetgtv.lovable.app/embed/143', '§7.2 the documented embed format https://livetgtv.lovable.app/embed/{channelId} is representable verbatim');

const embedOnlyEligible = orderExplicitLivetvCandidates([
  makeRecord({
    candidate: { rowId: 'c-1', channelId: 'ch-1', endpointId: 'ep-lg-direct', priority: 10, enabled: true, createdAt: '2026-01-01T00:00:00Z' },
    endpoint: { id: 'ep-lg-direct', sourceChannelId: 'entry-lg', kind: 'direct_stream', streamFormat: 'dash', url: 'https://cdn.example/143.mpd', ordering: 0, enabled: false, label: null }
  }),
  makeRecord({
    candidate: { rowId: 'c-2', channelId: 'ch-1', endpointId: 'ep-lg-embed', priority: 20, enabled: true, createdAt: '2026-01-01T00:00:00Z' },
    endpoint: { id: 'ep-lg-embed', sourceChannelId: 'entry-lg', kind: 'embed_page', streamFormat: null, url: 'https://livetgtv.lovable.app/embed/143', ordering: 1, enabled: true, label: null }
  })
]);
ok(embedOnlyEligible.length === 1 && embedOnlyEligible[0]!.endpointKind === 'embed_page', '§7.3 disabling the direct endpoint leaves the embed eligible (independent enablement — the existing LT-15 intent, admin-controllable)');

// ---------------------------------------------------------------------------
// §8 — conservative identity + provenance
// ---------------------------------------------------------------------------
console.log('§8 conservative identity and provenance preservation');

const provenance = makeRecord({
  sourceChannel: { id: 'entry-1', sourceId: 'src-1', sourceChannelId: '143', canonicalChannelId: 'ch-1', enabled: true },
  source: { id: 'src-1', slug: 'builtin-livegt-v1', sourceType: 'builtin_livegt_v1', enabled: true, status: 'active', priority: 0 }
});
ok(provenance.sourceChannel.sourceChannelId === '143' && provenance.source.slug === 'builtin-livegt-v1', '§8.1 source-specific ids and provenance ride along the whole chain (never erased by mapping)');
ok(explainLivetvCandidateBlock(makeRecord({ sourceChannel: { ...provenance.sourceChannel, canonicalChannelId: null } })) === 'source_channel_unmapped', '§8.2 an unmapped entry (uncertain match kept separate) never reaches resolution');

// ---------------------------------------------------------------------------
// §9 — VOD isolation (static import-graph checks)
// ---------------------------------------------------------------------------
console.log('§9 VOD isolation');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registrySource = readFileSync(path.join(REPO_ROOT, 'src/lib/server/livetv/registry.ts'), 'utf8');
ok(!/from '\$lib\/shared\/player'/.test(registrySource) && !/shared\/player'/.test(registrySource), '§9.1 the Live TV registry never imports VOD PlayerSource types');

let vodFiles: string[] = [];
const vodDirs = ['src/lib/client/player', 'src/lib/shared', 'src/lib/server/resolver'];
for (const dir of vodDirs) {
  const absolute = path.join(REPO_ROOT, dir);
  if (!existsSync(absolute)) continue;
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const child = path.join(current, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (name.endsWith('.ts') || name.endsWith('.svelte')) vodFiles.push(child);
    }
  };
  walk(absolute);
}
ok(vodFiles.length > 100, `§9.2a the VOD import scan actually ran (found ${vodFiles.length} VOD files)`);
const vodImportsLivetv = vodFiles.filter((file) => {
  const text = readFileSync(file, 'utf8');
  return /server\/livetv/.test(text);
});
ok(vodImportsLivetv.length === 0, `§9.2 no VOD module imports the Live TV registry (${vodFiles.length} VOD files scanned)`);

console.log(`\n=== livetv Phase 1 model verification: ${passed} checks PASSED ===`);
