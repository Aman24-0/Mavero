/**
 * Playback Ad / Redirect Policy tests.
 *
 * Covers:
 *   A. Legitimate stream URLs are allowed (media extensions, signed URLs,
 *      token/signature/expires/hash/key params, long random paths, numbers,
 *      provider-specific params, every real Mavero provider template).
 *   B. Clearly classified ad hosts are blocked.
 *   C. Ad SUBDOMAINS are blocked (dot-boundary subdomain matching).
 *   D. Similar-looking legitimate domains are NOT blocked.
 *   E. Legitimate redirect/bootstrap URLs are not blindly blocked
 *      (no keyword matching — 'redirect'/'dl'/'download'/'go' paths pass).
 *   F. Explicit provider-specific blocked hosts / path prefixes work.
 *   G. Provider-specific rules do not affect unrelated providers.
 *   H. Sandbox policy behavior is unchanged (no allow-popups, unrestricted
 *      stays unsandboxed, required keeps the secure attribute).
 *   + Resolver integration: a policy-blocked source fails like any other
 *     unavailable source and the existing bounded fallback resolves the
 *     next candidate; good sources are untouched.
 */
import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '../src/lib/server/resolver/core';
import { ResolverError } from '../src/lib/server/resolver/errors';
import { resolveWithBoundedFallback } from '../src/lib/server/resolver/fallback';
import {
  evaluatePlaybackUrl,
  registerProviderPlaybackPolicy,
  type PlaybackPolicyDecision,
} from '../src/lib/server/resolver/playback-policy';
import { iframeSandboxAttribute, sandboxPolicyFromCapabilities } from '../src/lib/shared/sandbox-policy';
import type { AdapterResult, ProviderAdapter, ResolverDependencies, TrustedResolutionConfig } from '../src/lib/server/resolver/types';
import type { NormalizedMediaItem } from '../src/lib/server/content/types';

let passed = 0;
function ok(value: unknown, message: string) {
  assert.ok(value, message);
  passed += 1;
}
function allowed(url: string, type: 'direct' | 'embed' = 'direct', options?: Parameters<typeof evaluatePlaybackUrl>[2]) {
  const decision: PlaybackPolicyDecision = evaluatePlaybackUrl(url, type, options);
  ok(decision.allowed, `expected ALLOWED: ${url.replace(/(_key|token|signature|Key-Pair-Id)=[^&]+/gi, '$1=<redacted>')} → ${decision.reason}`);
  return decision;
}
function blockedBy(url: string, category: 'ad-domain' | 'redirect' | 'unsafe-navigation' | 'provider-rule', type: 'direct' | 'embed' = 'direct', options?: Parameters<typeof evaluatePlaybackUrl>[2]) {
  const decision = evaluatePlaybackUrl(url, type, options);
  ok(!decision.allowed, `expected BLOCKED (${category}): ${url}`);
  assert.equal(decision.category, category);
  passed += 1;
  return decision;
}

// ---------------------------------------------------------------------------
// A. Legitimate stream URLs are allowed.
// ---------------------------------------------------------------------------
const legitimateDirectUrls = [
  // Media extensions.
  'https://cdn.example.test/hls/778899/master.m3u8',
  'https://cdn.example.test/dash/manifest.mpd',
  'https://media.example.test/v/9f3c2e1a7b/episode.01.1080p.mp4',
  'https://media.example.test/v/9f3c2e1a7b/movie.m4v',
  'https://media.example.test/v/9f3c2e1a7b/clip.webm',
  // Signed CDN URLs with long random paths, numbers, and credential-ish params.
  'https://d1a2b3c4.example.test/v/9f8b2c11de/a1b2c3d4e5f6/stream.m3u8?Expires=1893456000&Signature=QmFkZ2VnQmFkZ2VnQmFkZ2Vn&Key-Pair-Id=APKAI1234567890ABCDEF',
  'https://stream.example.test/4482910/hashes/deadbeefcafebabe/index.m3u8?hd=1&mn=42&clkid=887766',
  'https://media.example.test/get?file=8842109&u=7f3e2d1c&h=a1b2c3d4e5f60718',
  // Token / signature / expires / hash / key params must never trip the policy.
  'https://cdn.example.test/v.m3u8?token=abcdef0123456789',
  'https://cdn.example.test/v.m3u8?signature=0a1b2c3d4e5f60718',
  'https://cdn.example.test/v.m3u8?expires=1893456000',
  'https://cdn.example.test/v.m3u8?hash=b6d81b360a0f7f4cd',
  'https://cdn.example.test/v.m3u8?key=A1B2C3D4E5F6',
  // The word "ads"/"track"/"click"/"banner" inside a legit provider's own
  // subdomain/path must NOT trigger anything (no keyword matching at all).
  'https://media.example.test/stream?src=banner_offset_3',
  'https://track-splitter.example.test/hls/778899/index-v2-a1.m3u8',
];
for (const url of legitimateDirectUrls) allowed(url, 'direct');

// Legitimate provider embed URLs — every currently configured Mavero
// provider template (audited from supabase/migrations/*) with realistic
// substituted identifiers. None of these may ever be blocked.
const providerEmbedUrls = [
  'https://vidsrc.wiki/embed/movie/778899/',
  'https://vidsrc.wiki/embed/tv/778899/1/2/',
  'https://vidlink.pro/movie/778899',
  'https://vidlink.pro/tv/778899/1/2',
  'https://vidlink.pro/anime/21/8/sub',
  'https://cinesrc.st/embed/movie/778899',
  'https://cinesrc.st/embed/tv/778899?s=1&e=2',
  'https://vixsrc.to/movie/778899',
  'https://vixsrc.to/tv/778899/1/2',
  'https://vidy.st/movie/778899',
  'https://vidy.st/tv/778899/1/2',
  'https://peachify.top/embed/movie/778899?accent=b1a1ff',
  'https://peachify.top/embed/tv/778899/1/2?accent=b1a1ff',
  'https://vaplayer.ru/embed/movie/778899',
  'https://vaplayer.ru/embed/tv/778899/1/2',
  'https://vidphantom.com/movie/778899',
  'https://vidphantom.com/tv/778899/1/2',
  'https://multiembed.mov/?video_id=778899&tmdb=1',
  'https://multiembed.mov/?video_id=778899&tmdb=1&s=1&e=2',
  'https://nhdapi.com/movie/778899',
  'https://nhdapi.com/tv/778899/1/2',
  'https://nxsha.space/embed/movie/778899',
  'https://nxsha.space/embed/tv/778899/1/2',
  'https://cinemaos.tech/player/778899',
  'https://cinemaos.tech/player/778899/1/2',
  'https://megaplay.buzz/stream/ani/21/8/sub',
  'https://vidapi.qzz.io/movie/778899',
  'https://vidapi.qzz.io/tv/778899/1/2',
  'https://embed.filmu.in/embed/movie/778899',
  'https://embed.filmu.in/embed/tv/778899/1/2',
  'https://mapple.uk/watch/movie/778899',
  'https://mapple.uk/watch/tv/778899-1-2',
  'https://yapgrid.com/embed/movie/778899',
  'https://yapgrid.com/embed/tv/778899/1/2',
  'https://cineverse.modiplay.xyz/embed/imdb/movie?id=tt1234567',
  'https://cineverse.modiplay.xyz/embed/imdb/tv?id=tt1234567&s=1&e=2',
  'https://www.rivestream.app/embed?type=movie&id=778899',
  'https://www.rivestream.app/embed?type=tv&id=778899&season=1&episode=2',
  'https://www.viduki.net/1/movie/778899',
  'https://www.viduki.net/2/tv/778899/1/2',
  'https://slast430did.com/play/tt1234567',
  'https://vidvault.ru/movie/778899',
  'https://vidvault.ru/tv/778899/1/2',
];
for (const url of providerEmbedUrls) {
  allowed(url, 'embed');
}

// Same-origin relative bootstrap embeds (server-side 302 flow) must pass.
allowed('/api/playback/superembed?tmdb_id=778899&imdb_id=tt1234567', 'embed');
allowed('/api/playback/bootstrap?type=tv&id=778899&season=1&episode=2', 'embed');

// ---------------------------------------------------------------------------
// B. Clearly classified ad hosts are blocked.
// ---------------------------------------------------------------------------
for (const url of [
  'https://popads.net/pop?zone=12345',
  'https://popcash.net/world/go/test',
  'https://onclickads.net/afu.php?zoneid=12345',
  'https://exoclick.com/iframes/loader.js',
  'https://taboola.com/served?placement=mavero-test',
  'https://doubleclick.net/ddm/adj/test',
  'https://googlesyndication.com/pagead/show_ads.js',
  'https://adnxs.com/tt?id=1',
  'https://mgid.com/unit/1',
  'https://criteo.net/dispatcher/test',
]) {
  blockedBy(url, 'ad-domain', 'direct');
}
blockedBy('https://adf.ly/1aB2cD', 'redirect', 'direct');
blockedBy('https://shorte.st/go/abc', 'redirect', 'direct');

// ---------------------------------------------------------------------------
// C. Ad subdomains are blocked via dot-boundary subdomain matching.
// ---------------------------------------------------------------------------
for (const url of [
  'https://serve.popads.net/pop?z=1',
  'https://cdn.popcash.net/loader.js',
  'https://a.deep.subdomain.mgid.com/unit',
  'https://s.googlesyndication.com/pagead/js/adsbygoogle.js',
  'https://cdn.exosrv.com/player/1',
]) {
  blockedBy(url, 'ad-domain', 'direct');
}

// ---------------------------------------------------------------------------
// D. Similar-looking legitimate domains are NOT blocked.
// ---------------------------------------------------------------------------
for (const url of [
  // Sibling label lookalikes of a blocked apex.
  'https://notpopads.net/v.m3u8',
  'https://popads.net.evil-mirror.test/v.m3u8',
  'https://popads.test/v.m3u8',
  'https://my-popads.net/v.m3u8',
  // The task's canonical example: a blocked host must never widen to the
  // shared parent of unrelated subdomains.
  'https://provider.example.com/stream/778899.m3u8',
  'https://ads.example.com/stream/778899.m3u8',
  // Real Mavero providers must never be collateral damage.
  'https://vidsrc.wiki/embed/movie/778899/',
  'https://vidlink.pro/movie/778899',
  'https://multiembed.mov/?video_id=778899&tmdb=1',
  // Trusted public infrastructure sharing label prefixes with blocked sets.
  'https://www.googletagmanager.com/gtag/js?id=G-TEST', // google-adjacent, not classified
]) {
  allowed(url, 'embed');
}
// Non-blocked real domains that merely sound ad-ish stay allowed.
allowed('https://adserver-none.example.test/v.m3u8', 'direct');

// ---------------------------------------------------------------------------
// E. Legitimate redirect/bootstrap URLs are not blindly blocked (no keyword
//    matching anywhere in this module).
// ---------------------------------------------------------------------------
for (const url of [
  // Real Mavero downloader/bootstrap endpoints whose paths contain
  // 'dl' / 'download' words — purely hostname classification applies.
  'https://nhdapi.com/dl/movie/778899',
  'https://nhdapi.com/dl/tv/778899/1/2',
  'https://02moviedownloader.site/api/download/movie/778899',
  'https://02moviedownloader.site/api/download/tv/778899/1/2',
  'https://nxsha.space/dl/movie/778899',
  'https://vidvault.ru/movie/778899',
  // Generic redirect-looking paths on non-classified hosts must pass.
  'https://media.example.test/redirector?target=https%3A%2F%2Fcdn.example.test%2Fv.m3u8',
  'https://provider.example.com/go/out?u=abc',
  'https://cdn.example.test/click-router/778899/index.m3u8',
  'https://stream.example.test/track/1/file.mpd',
  'https://provider.example.com/banner-check?v=1',
]) {
  allowed(url, 'direct');
}
// Structural hazards are still caught at policy level (defense in depth
// behind validatePlaybackUrl) — as unsafe-navigation, not ad classification.
blockedBy('http://cdn.example.test/v.m3u8', 'unsafe-navigation');
blockedBy('https://user:pass@cdn.example.test/v.m3u8', 'unsafe-navigation');
blockedBy('not a url at all', 'unsafe-navigation');
blockedBy('', 'unsafe-navigation');
// Same-origin bootstrap path is honored, and still respects provider path rules (F below).
allowed('/api/playback/superembed?tmdb_id=1', 'embed');

// ---------------------------------------------------------------------------
// F. Explicit provider-specific blocked hosts / path prefixes work.
// ---------------------------------------------------------------------------
const POLICY_TEST_PROVIDER = 'policy-test-provider-00000000';
registerProviderPlaybackPolicy(POLICY_TEST_PROVIDER, {
  blockedHosts: ['blocked-partner.example'],
  blockedPathPrefixes: ['/traffic/'],
});
const providerContext = { providerId: POLICY_TEST_PROVIDER, sourceId: 'source-1', providerName: 'Policy Test Provider', sourceName: 'Fixture Source' };
blockedBy('https://blocked-partner.example/stream.m3u8', 'provider-rule', 'direct', providerContext);
blockedBy('https://cdn.blocked-partner.example/stream.m3u8', 'provider-rule', 'direct', providerContext);
blockedBy('https://media.example.test/traffic/redirect?x=1', 'provider-rule', 'direct', providerContext);
blockedBy('/traffic/launch', 'provider-rule', 'embed', providerContext);

// ---------------------------------------------------------------------------
// G. Provider-specific rules do not affect unrelated providers.
// ---------------------------------------------------------------------------
const otherContext = { providerId: 'unrelated-provider-99999999', sourceId: 'source-2', providerName: 'Other Provider', sourceName: 'Other Source' };
allowed('https://blocked-partner.example/stream.m3u8', 'direct', otherContext);
allowed('https://media.example.test/traffic/redirect?x=1', 'direct', otherContext);
allowed('https://blocked-partner.example/stream.m3u8', 'direct', {}); // no providerId → no rules
allowed('https://vidsrc.wiki/embed/movie/778899/', 'embed', providerContext); // real provider still fine under rule-scoped provider
allowed('https://media.example.test/other/path/stream.m3u8', 'direct', providerContext); // prefix rule is path-scoped

// ---------------------------------------------------------------------------
// H. Sandbox policy behavior is unchanged.
// ---------------------------------------------------------------------------
assert.equal(iframeSandboxAttribute('required'), 'allow-forms allow-presentation allow-same-origin allow-scripts');
assert.equal(iframeSandboxAttribute('optional'), 'allow-forms allow-presentation allow-same-origin allow-scripts');
assert.equal(iframeSandboxAttribute('unrestricted'), undefined);
assert.equal(iframeSandboxAttribute(), 'allow-forms allow-presentation allow-same-origin allow-scripts');
ok(!iframeSandboxAttribute('required')!.includes('allow-popups'), 'sandbox must never grant allow-popups');
ok(!iframeSandboxAttribute('required')!.includes('allow-top-navigation'), 'sandbox must never grant top navigation');
passed += 2;
assert.equal(sandboxPolicyFromCapabilities({ sandbox_policy: 'unrestricted' }), 'unrestricted');
assert.equal(sandboxPolicyFromCapabilities({ sandbox_policy: 'required' }), 'required');
assert.equal(sandboxPolicyFromCapabilities({}, { sandbox_policy: 'optional' }), 'optional');
assert.equal(sandboxPolicyFromCapabilities(undefined), 'required');
passed += 4;

// ---------------------------------------------------------------------------
// Resolver integration: policy-blocked source behaves like any unavailable
// source — existing fallback picks the next candidate.
// ---------------------------------------------------------------------------
const providerId = 'a0000000-0000-4000-8000-000000000001';
const sourceIdA = 'b0000000-0000-4000-8000-00000000000a';
const sourceIdB = 'b0000000-0000-4000-8000-00000000000b';
const content: NormalizedMediaItem = {
  id: 'afterlight', title: 'Afterlight', year: 2024, type: 'movie', runtime: '2h 08m', rating: 8.4, genres: ['Drama'], description: 'Fixture', poster: 'https://images.example.test/poster.jpg', backdrop: 'https://images.example.test/backdrop.jpg', accent: '#9b87f5', source: { provider: 'tmdb', externalId: '778899', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '778899', imdb: 'tt1234567' },
};
function config(sourceOverrides: Partial<TrustedResolutionConfig['source']> = {}): TrustedResolutionConfig {
  return {
    provider: { id: providerId, name: 'Fixture Provider', status: 'active', enabled: true, integration_type: 'direct', adapter_id: undefined, capabilities: { movie: true, series: true } },
    source: { id: sourceIdA, provider_id: providerId, name: 'Fixture Source', status: 'active', enabled: true, visibility: 'public', integration_type: 'direct', capabilities: { movie: true }, movie_template: 'https://media.example.test/{tmdb_id}.m3u8', series_template: '', anime_template: '', identifier_mode: 'tmdb_id', audio_languages: ['English'], subtitle_capability: true, quality_capability: ['HD'], ...sourceOverrides },
  };
}
const request = { sourceId: sourceIdA, contentId: 'afterlight', mediaType: 'movie' as const };

function staticAdapter(result: AdapterResult | null): ProviderAdapter {
  return { integrationType: 'direct', resolve: async () => result };
}

// 1) A source whose adapter returns a classified ad URL is rejected with the
//    dedicated code — it never becomes a successful SourceResult.
const adAdapter = staticAdapter({ type: 'direct', url: 'https://serve.popads.net/fake-stream.m3u8?token=x' });
await assert.rejects(
  () => resolveSourceFromConfig(request, config(), content, { adapters: { direct: adAdapter } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
passed += 1;

// 2) Full fallback chain: candidate A blocked by policy → candidate B good.
//    The result must be B's stream; attempts record the policy failure code.
const goodConfig = config({ id: sourceIdB, name: 'Backup Source', movie_template: 'https://backup.example.test/{tmdb_id}.m3u8' });
const blockedConfig = config();
const adapterBySourceId = new Map<string, ProviderAdapter>([
  [sourceIdA, adAdapter],
  [sourceIdB, staticAdapter({ type: 'direct', url: 'https://backup.example.test/778899.m3u8?token=abc&expires=1893456000' })],
]);
const fallbackRun = await resolveWithBoundedFallback(
  request,
  content,
  [ { config: blockedConfig, eligible: true }, { config: goodConfig, eligible: true } ],
  { adapters: { direct: { integrationType: 'direct', resolve: async (context) => adapterBySourceId.get(context.config.source.id)!.resolve(context) } } },
  { allowFallback: true, maxAttempts: 2, avoidDuplicateProviders: false },
);
assert.equal(fallbackRun.result.url, 'https://backup.example.test/778899.m3u8?token=abc&expires=1893456000');
assert.equal(fallbackRun.attempts[0].result, 'failure');
assert.equal(fallbackRun.attempts[0].errorCode, 'PLAYBACK_POLICY_BLOCKED');
assert.equal(fallbackRun.attempts[1].result, 'success');
passed += 3;

// 3) Signed, token-bearing CDN URLs from a legitimate host resolve untouched.
const signedResult = await resolveSourceFromConfig(request, config(), content, {
  adapters: { direct: staticAdapter({ type: 'direct', url: 'https://d1a2b3c4.example.test/v/a1b2c3d4/stream.m3u8?Expires=1893456000&Signature=QmFkZ2Vn&Key-Pair-Id=APKAI1234567890ABCDEF' }) },
});
assert.equal(signedResult.type, 'direct');
ok(signedResult.url!.includes('Signature=QmFkZ2Vn'), 'signed URL query must remain untouched');
passed += 1;

// 4) Blocked direct URL and blocked embed URL both propagate the dedicated
//    code through resolveSourceFromConfig's error boundary unchanged.
const adEmbedConfig = config({ integration_type: 'embed', capabilities: { movie: true, allowed_embed_origins: ['https://ads.popads.net'] }, movie_template: 'https://ads.popads.net/{tmdb_id}' });
await assert.rejects(
  () => resolveSourceFromConfig(request, adEmbedConfig, content, { adapters: { embed: staticAdapter({ type: 'embed', url: 'https://ads.popads.net/778899' }) } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
passed += 1;

// 5) allowFallback=false still surfaces the policy error (no silent success).
await assert.rejects(
  () => resolveWithBoundedFallback(
    { ...request, allowFallback: false },
    content,
    [{ config: blockedConfig, eligible: true }],
    { adapters: { direct: adAdapter } },
    { allowFallback: false },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
passed += 1;

const resolverDependencies: ResolverDependencies = {};
void resolverDependencies;

console.log(`Playback ad/redirect policy tests passed: ${passed} checks across legitimate-URL allow matrix (media extensions, signed/token URLs, all configured provider embeds, same-origin bootstrap), ad-host + subdomain blocking, lookalike-domain safety, keyword-matching absence, provider-specific rules + isolation, sandbox policy stability, resolver fallback integration, and signed-URL preservation.`);
