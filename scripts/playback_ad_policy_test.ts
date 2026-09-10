/**
 * Third-Party Playback Ad Protection tests (provider/source-scoped).
 *
 * Architecture under test:
 *   - The Ad Protection setting is stored per provider AND per source in
 *     their existing capabilities JSONB (`playback_ad_protection: boolean`,
 *     optional `playback_ad_protection_rules`), resolved as:
 *         source override → provider default → system default (OFF).
 *   - The resolver skips the policy ENTIRELY when the effective setting is
 *     OFF for the source being resolved. Every other security layer
 *     (validatePlaybackUrl, expiry, sandbox) stays in force either way.
 *   - Each fallback candidate is evaluated with its OWN effective setting.
 *
 * Matrix:
 *   1.  Provider A, protection ON  → policy executes.
 *   2.  Provider A, protection OFF → policy does not execute.
 *   3.  Provider B, protection OFF → Provider A's rules do not affect it.
 *   4.  Provider B, protection ON  → only B's own scoped rules + global
 *       classification apply; A's scoped rules never leak.
 *   5.  Fallback: protected provider → unprotected provider works.
 *   6.  Fallback: unprotected provider → protected provider works.
 *   7.  Global Mavero application requests are unaffected (default OFF).
 *   8.  Mavero future ad-service URLs are unaffected (separate system).
 *   9.  Sandbox setting remains independent.
 *   10. Unrestricted providers remain unrestricted.
 *   11. Legitimate CDN URLs remain allowed (even when protection is ON).
 *   12. Signed stream URLs remain allowed (even when protection is ON).
 *   13. Peachify-specific protection works when enabled (real config).
 *   14. Peachify behavior is unchanged when disabled (real config).
 *
 * Plus the evaluator-level conservatism matrix (legit allow list, ad-host
 * blocking, subdomain matching, lookalike safety, no keyword matching,
 * provider rule isolation, same-origin bootstrap handling).
 */
import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '../src/lib/server/resolver/core';
import { ResolverError } from '../src/lib/server/resolver/errors';
import { resolveWithBoundedFallback } from '../src/lib/server/resolver/fallback';
import {
  evaluatePlaybackUrl,
  registerProviderPlaybackPolicy,
  unregisterProviderPlaybackPolicy,
  type PlaybackPolicyDecision,
} from '../src/lib/server/resolver/playback-policy';
import {
  defaultPlaybackAdProtection,
  playbackAdProtectionDescription,
  playbackAdProtectionFromCapabilities,
} from '../src/lib/shared/playback-ad-protection';
import { iframeSandboxAttribute, sandboxPolicyFromCapabilities } from '../src/lib/shared/sandbox-policy';
import type { AdapterResult, ProviderAdapter, ResolverRequest, TrustedResolutionConfig } from '../src/lib/server/resolver/types';
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
// Section 0 — capabilities resolution: source override → provider default →
// system default OFF (this IS the scope decision, tested).
// ---------------------------------------------------------------------------
assert.deepEqual(playbackAdProtectionFromCapabilities(undefined), { enabled: false });
assert.deepEqual(playbackAdProtectionFromCapabilities({}), { enabled: false });
assert.deepEqual(playbackAdProtectionFromCapabilities({}, {}), { enabled: false });
assert.equal(defaultPlaybackAdProtection.enabled, false);
// Provider default applies when the source is silent.
assert.equal(playbackAdProtectionFromCapabilities({ playback_ad_protection: true }).enabled, true);
assert.equal(playbackAdProtectionFromCapabilities({ playback_ad_protection: false }, {}).enabled, false);
// Source override wins in BOTH directions.
assert.equal(playbackAdProtectionFromCapabilities({ playback_ad_protection: true }, { playback_ad_protection: false }).enabled, false);
assert.equal(playbackAdProtectionFromCapabilities({ playback_ad_protection: false }, { playback_ad_protection: true }).enabled, true);
// Non-boolean values are never trusted (fall through to the next level).
assert.equal(playbackAdProtectionFromCapabilities({ playback_ad_protection: 'yes' }, {}).enabled, false);
assert.equal(playbackAdProtectionFromCapabilities({ playback_ad_protection: 'yes' }, { playback_ad_protection: true }).enabled, true);
// Scoped rules union (provider + source); malformed rules are ignored.
const rulesMerged = playbackAdProtectionFromCapabilities(
  { playback_ad_protection: true, playback_ad_protection_rules: { blockedHosts: ['ads.peachify-ads.example.test'] } },
  { playback_ad_protection_rules: { blockedPathPrefixes: ['/traffic/'] } },
);
assert.equal(rulesMerged.enabled, true);
assert.deepEqual(rulesMerged.blockedHosts, ['ads.peachify-ads.example.test']);
assert.deepEqual(rulesMerged.blockedPathPrefixes, ['/traffic/']);
assert.deepEqual(playbackAdProtectionFromCapabilities({ playback_ad_protection_rules: 'junk' }, { playback_ad_protection_rules: { blockedHosts: 'not-an-array' } }), { enabled: false });
// Admin-facing copy exists for both states.
ok(playbackAdProtectionDescription(true).includes('only'), 'description must stress provider/source scoping');
ok(playbackAdProtectionDescription(false).includes('OFF by default'), 'description must state the default');
passed += 2;

// ---------------------------------------------------------------------------
// Evaluator-level conservatism matrix (runs whenever invoked; the resolver
// decides WHEN that is).
// ---------------------------------------------------------------------------
const legitimateDirectUrls = [
  'https://cdn.example.test/hls/778899/master.m3u8',
  'https://cdn.example.test/dash/manifest.mpd',
  'https://media.example.test/v/9f3c2e1a7b/episode.01.1080p.mp4',
  'https://media.example.test/v/9f3c2e1a7b/movie.m4v',
  'https://media.example.test/v/9f3c2e1a7b/clip.webm',
  'https://d1a2b3c4.example.test/v/9f8b2c11de/a1b2c3d4e5f6/stream.m3u8?Expires=1893456000&Signature=QmFkZ2VnQmFkZ2VnQmFkZ2Vn&Key-Pair-Id=APKAI1234567890ABCDEF',
  'https://cdn.example.test/v.m3u8?token=abcdef0123456789',
  'https://cdn.example.test/v.m3u8?signature=0a1b2c3d4e5f60718',
  'https://cdn.example.test/v.m3u8?expires=1893456000',
  'https://cdn.example.test/v.m3u8?hash=b6d81b360a0f7f4cd',
  'https://cdn.example.test/v.m3u8?key=A1B2C3D4E5F6',
  'https://track-splitter.example.test/hls/778899/index-v2-a1.m3u8',
];
for (const url of legitimateDirectUrls) allowed(url, 'direct');

// Every currently configured Mavero provider embed template (audited from
// supabase/migrations/*) — none may ever be classified.
const providerEmbedUrls = [
  'https://vidsrc.wiki/embed/movie/778899/',
  'https://vidlink.pro/movie/778899',
  'https://vidlink.pro/anime/21/8/sub',
  'https://cinesrc.st/embed/tv/778899?s=1&e=2',
  'https://vixsrc.to/movie/778899',
  'https://vidy.st/tv/778899/1/2',
  'https://peachify.top/embed/movie/778899?accent=b1a1ff',
  'https://peachify.top/embed/tv/778899/1/2?accent=b1a1ff',
  'https://vaplayer.ru/embed/movie/778899',
  'https://vidphantom.com/movie/778899',
  'https://multiembed.mov/?video_id=778899&tmdb=1&s=1&e=2',
  'https://nhdapi.com/dl/movie/778899',
  'https://nxsha.space/embed/tv/778899/1/2',
  'https://cinemaos.tech/player/778899/1/2',
  'https://megaplay.buzz/stream/ani/21/8/sub',
  'https://vidapi.qzz.io/movie/778899',
  'https://embed.filmu.in/embed/movie/778899',
  'https://mapple.uk/watch/tv/778899-1-2',
  'https://yapgrid.com/embed/movie/778899',
  'https://cineverse.modiplay.xyz/embed/imdb/tv?id=tt1234567&s=1&e=2',
  'https://www.rivestream.app/embed?type=tv&id=778899&season=1&episode=2',
  'https://www.viduki.net/2/tv/778899/1/2',
  'https://slast430did.com/play/tt1234567',
  'https://vidvault.ru/tv/778899/1/2',
  'https://02moviedownloader.site/api/download/tv/778899/1/2',
];
for (const url of providerEmbedUrls) allowed(url, 'embed');
allowed('/api/playback/superembed?tmdb_id=778899&imdb_id=tt1234567', 'embed');
allowed('/api/playback/bootstrap?type=tv&id=778899&season=1&episode=2', 'embed');

// Classified ad hosts + subdomains.
for (const url of ['https://popads.net/pop?zone=12345', 'https://popcash.net/world/go/test', 'https://onclickads.net/afu.php?zoneid=12345', 'https://exoclick.com/iframes/loader.js', 'https://taboola.com/served?placement=mavero-test', 'https://doubleclick.net/ddm/adj/test', 'https://googlesyndication.com/pagead/show_ads.js', 'https://adnxs.com/tt?id=1', 'https://mgid.com/unit/1', 'https://criteo.net/dispatcher/test']) {
  blockedBy(url, 'ad-domain', 'direct');
}
for (const url of ['https://serve.popads.net/pop?z=1', 'https://cdn.popcash.net/loader.js', 'https://a.deep.subdomain.mgid.com/unit', 'https://s.googlesyndication.com/pagead/js/adsbygoogle.js']) {
  blockedBy(url, 'ad-domain', 'direct');
}
blockedBy('https://adf.ly/1aB2cD', 'redirect', 'direct');
blockedBy('https://shorte.st/go/abc', 'redirect', 'direct');

// Lookalike legitimacy.
for (const url of ['https://notpopads.net/v.m3u8', 'https://popads.net.evil-mirror.test/v.m3u8', 'https://popads.test/v.m3u8', 'https://my-popads.net/v.m3u8', 'https://provider.example.com/stream/778899.m3u8', 'https://ads.example.com/stream/778899.m3u8']) {
  allowed(url, 'embed');
}
// No keyword matching anywhere (redirect/download/go/track/banner paths pass).
for (const url of ['https://media.example.test/redirector?target=https%3A%2F%2Fcdn.example.test%2Fv.m3u8', 'https://provider.example.com/go/out?u=abc', 'https://cdn.example.test/click-router/778899/index.m3u8', 'https://stream.example.test/track/1/file.mpd', 'https://provider.example.com/banner-check?v=1']) {
  allowed(url, 'direct');
}
// Structural hazards (defense in depth behind validatePlaybackUrl).
blockedBy('http://cdn.example.test/v.m3u8', 'unsafe-navigation');
blockedBy('https://user:pass@cdn.example.test/v.m3u8', 'unsafe-navigation');
blockedBy('not a url at all', 'unsafe-navigation');
blockedBy('', 'unsafe-navigation');

// Curated registry rules stay scoped to one provider id.
const PROVIDER_A = 'aaaaaaa1-0000-4000-8000-00000000000a';
const PROVIDER_B = 'aaaaaaa2-0000-4000-8000-00000000000b';
registerProviderPlaybackPolicy(PROVIDER_A, { blockedHosts: ['a-partner-ads.example.test'], blockedPathPrefixes: ['/a-traffic/'] });
blockedBy('https://a-partner-ads.example.test/stream.m3u8', 'provider-rule', 'direct', { providerId: PROVIDER_A, policy: { enabled: true } });
blockedBy('https://cdn.a-partner-ads.example.test/stream.m3u8', 'provider-rule', 'direct', { providerId: PROVIDER_A, policy: { enabled: true } });
blockedBy('https://media.example.test/a-traffic/redirect?x=1', 'provider-rule', 'direct', { providerId: PROVIDER_A, policy: { enabled: true } });
blockedBy('/a-traffic/launch', 'provider-rule', 'embed', { providerId: PROVIDER_A, policy: { enabled: true } });
// Runtime-scoped rules (capabilities-derived) merge with registry rules.
blockedBy('https://b-partner-ads.example.test/stream.m3u8', 'provider-rule', 'direct', { providerId: PROVIDER_B, policy: { enabled: true, blockedHosts: ['b-partner-ads.example.test'] } });
// enabled:false short-circuits EVERYTHING (even classified hosts).
const disabledDecision = evaluatePlaybackUrl('https://serve.popads.net/pop?z=1', 'direct', { providerId: PROVIDER_A, policy: { enabled: false } });
ok(disabledDecision.allowed && disabledDecision.reason === 'protection-disabled-for-source', 'evaluator must honor enabled:false for the scoped source');
passed += 1;

// ---------------------------------------------------------------------------
// Resolver fixtures.
// ---------------------------------------------------------------------------
const providerId = 'a0000000-0000-4000-8000-000000000001';
const sourceIdA = 'b0000000-0000-4000-8000-00000000000a';
const sourceIdB = 'b0000000-0000-4000-8000-00000000000b';
const content: NormalizedMediaItem = {
  id: 'afterlight', title: 'Afterlight', year: 2024, type: 'movie', runtime: '2h 08m', rating: 8.4, genres: ['Drama'], description: 'Fixture', poster: 'https://image.tmdb.org/t/p/w500/afterlight.jpg', backdrop: 'https://image.tmdb.org/t/p/original/afterlight.jpg', accent: '#9b87f5', source: { provider: 'tmdb', externalId: '778899', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '778899', imdb: 'tt1234567' },
};
function config(opts: { sourceId?: string; providerId?: string; providerCapabilities?: Record<string, unknown>; sourceCapabilities?: Record<string, unknown>; movieTemplate?: string; integrationType?: 'direct' | 'embed' } = {}): TrustedResolutionConfig {
  const integration = opts.integrationType ?? 'direct';
  const pid = opts.providerId ?? providerId;
  return {
    provider: { id: pid, name: 'Fixture Provider', status: 'active', enabled: true, integration_type: integration, adapter_id: undefined, capabilities: { movie: true, series: true, ...(opts.providerCapabilities ?? {}) } },
    source: { id: opts.sourceId ?? sourceIdA, provider_id: pid, name: 'Fixture Source', status: 'active', enabled: true, visibility: 'public', integration_type: integration, capabilities: { movie: true, ...(opts.sourceCapabilities ?? {}) }, movie_template: opts.movieTemplate ?? 'https://media.example.test/{tmdb_id}.m3u8', series_template: '', anime_template: '', identifier_mode: 'tmdb_id', audio_languages: ['English'], subtitle_capability: true, quality_capability: ['HD'] },
  };
}
const request: ResolverRequest = { sourceId: sourceIdA, contentId: 'afterlight', mediaType: 'movie' };
function staticAdapter(result: AdapterResult | null): ProviderAdapter {
  return { integrationType: 'direct', resolve: async () => result };
}
const popadsResult: AdapterResult = { type: 'direct', url: 'https://serve.popads.net/fake-stream.m3u8?token=x' };

// ---------------------------------------------------------------------------
// 1. Provider A, protection ON → policy executes.
// ---------------------------------------------------------------------------
await assert.rejects(
  () => resolveSourceFromConfig(request, config({ providerCapabilities: { playback_ad_protection: true } }), content, { adapters: { direct: staticAdapter(popadsResult) } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
passed += 1;

// ---------------------------------------------------------------------------
// 2. Provider A, protection OFF → policy does NOT execute (ad URL resolves).
// ---------------------------------------------------------------------------
const offResult = await resolveSourceFromConfig(request, config(), content, { adapters: { direct: staticAdapter(popadsResult) } });
assert.equal(offResult.url, 'https://serve.popads.net/fake-stream.m3u8?token=x');
assert.equal(offResult.sandboxPolicy, 'required'); // security layers untouched
passed += 2;
// Explicit false behaves identically.
const explicitOff = await resolveSourceFromConfig(request, config({ providerCapabilities: { playback_ad_protection: false } }), content, { adapters: { direct: staticAdapter(popadsResult) } });
assert.equal(explicitOff.url, 'https://serve.popads.net/fake-stream.m3u8?token=x');
passed += 1;

// ---------------------------------------------------------------------------
// 3. Provider B, protection OFF → Provider A's scoped rules never affect it.
// ---------------------------------------------------------------------------
const providerBConfig = config({ sourceId: sourceIdB, providerId: PROVIDER_B });
const bOffResult = await resolveSourceFromConfig(request, providerBConfig, content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://a-partner-ads.example.test/stream.m3u8' }) } });
assert.equal(bOffResult.url, 'https://a-partner-ads.example.test/stream.m3u8');
passed += 1;

// ---------------------------------------------------------------------------
// 4. Provider B, protection ON → only B's own scoped rules + global
//    classification apply; A's scoped rules do not leak onto B.
// ---------------------------------------------------------------------------
const providerBOn = config({ sourceId: sourceIdB, providerId: PROVIDER_B, providerCapabilities: { playback_ad_protection: true } });
// A's scoped host stays allowed for B…
const bScopedLeak = await resolveSourceFromConfig(request, providerBOn, content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://a-partner-ads.example.test/stream.m3u8' }) } });
assert.equal(bScopedLeak.url, 'https://a-partner-ads.example.test/stream.m3u8');
passed += 1;
// …but the global classification still applies to B when ON.
await assert.rejects(
  () => resolveSourceFromConfig(request, providerBOn, content, { adapters: { direct: staticAdapter(popadsResult) } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
passed += 1;
// And B's own scoped rule (runtime config) blocks for B only.
const bScoped = await assert.rejects(
  () => resolveSourceFromConfig(request, { ...providerBOn, provider: { ...providerBOn.provider, capabilities: { movie: true, playback_ad_protection: true, playback_ad_protection_rules: { blockedHosts: ['b-partner-ads.example.test'] } } } }, content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://cdn.b-partner-ads.example.test/v.m3u8' }) } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
void bScoped;
passed += 1;

// ---------------------------------------------------------------------------
// 5. Fallback: protected provider (blocked) → unprotected provider plays.
// ---------------------------------------------------------------------------
const protectedA = config({ sourceId: sourceIdA, providerCapabilities: { playback_ad_protection: true } });
const unprotectedB = config({ sourceId: sourceIdB, providerId: PROVIDER_B });
const run5 = await resolveWithBoundedFallback(
  request,
  content,
  [ { config: protectedA, eligible: true }, { config: unprotectedB, eligible: true } ],
  { adapters: { direct: { integrationType: 'direct', resolve: async (context) => (context.config.source.id === sourceIdA ? popadsResult : { type: 'direct' as const, url: 'https://backup-b.example.test/778899.m3u8?token=abc&expires=1893456000' }) } } },
  { allowFallback: true, maxAttempts: 2, avoidDuplicateProviders: false },
);
assert.equal(run5.result.url, 'https://backup-b.example.test/778899.m3u8?token=abc&expires=1893456000');
assert.equal(run5.attempts[0].result, 'failure');
assert.equal(run5.attempts[0].errorCode, 'PLAYBACK_POLICY_BLOCKED');
assert.equal(run5.attempts[1].result, 'success');
passed += 3;

// ---------------------------------------------------------------------------
// 6. Fallback: unprotected provider (unavailable) → protected provider is
//    evaluated with ITS OWN setting (blocked here, recorded in attempts).
// ---------------------------------------------------------------------------
const run6 = await resolveWithBoundedFallback(
  request,
  content,
  [ { config: unprotectedB, eligible: true }, { config: protectedA, eligible: true } ],
  { adapters: { direct: { integrationType: 'direct', resolve: async (context) => (context.config.source.id === sourceIdB ? null : popadsResult) } } },
  { allowFallback: true, maxAttempts: 2, avoidDuplicateProviders: false },
).then(
  () => { throw new Error('expected rejection'); },
  (error: unknown) => error,
);
assert.ok(run6 instanceof ResolverError && run6.code === 'PLAYBACK_POLICY_BLOCKED');
passed += 1;

// ---------------------------------------------------------------------------
// 7. Global Mavero application requests are unaffected: with the default
//    (OFF) nothing anywhere is filtered, and TMDB/content hosts are never
//    classified even when some OTHER provider has protection ON.
// ---------------------------------------------------------------------------
ok(!evaluatePlaybackUrl('https://image.tmdb.org/t/p/w500/afterlight.jpg', 'direct').allowed === false, 'TMDB image host is never classified');
ok(evaluatePlaybackUrl('https://image.tmdb.org/t/p/w500/afterlight.jpg', 'direct').allowed, 'TMDB image host allowed');
ok(evaluatePlaybackUrl('https://api.themoviedb.org/3/movie/778899', 'direct').allowed, 'TMDB API host allowed');
passed += 2;

// ---------------------------------------------------------------------------
// 8. Mavero future ad-service URLs are unaffected — a first-party MaveroAds
//    host is not third-party playback ad infrastructure and stays allowed.
// ---------------------------------------------------------------------------
ok(evaluatePlaybackUrl('https://ads.mavero-ads.example.test/serve?slot=preroll', 'direct').allowed, 'first-party ad-service host must remain unaffected');
ok(evaluatePlaybackUrl('https://ads.mavero-ads.example.test/serve?slot=preroll', 'direct', { providerId: PROVIDER_A, policy: { enabled: true } }).allowed, 'first-party ad-service host unaffected even when protection is ON for a provider');
passed += 2;

// ---------------------------------------------------------------------------
// 9. Sandbox setting remains independent of Ad Protection.
// ---------------------------------------------------------------------------
assert.equal(iframeSandboxAttribute('required'), 'allow-forms allow-presentation allow-same-origin allow-scripts');
assert.equal(iframeSandboxAttribute('optional'), 'allow-forms allow-presentation allow-same-origin allow-scripts');
ok(!iframeSandboxAttribute('required')!.includes('allow-popups'), 'sandbox never grants allow-popups');
ok(!iframeSandboxAttribute('required')!.includes('allow-top-navigation'), 'sandbox never grants top navigation');
assert.equal(sandboxPolicyFromCapabilities({ sandbox_policy: 'required' }), 'required');
// Protection ON + sandbox required → sandbox unchanged on the result.
const sandboxWithProtection = await resolveSourceFromConfig(request, config({ providerCapabilities: { playback_ad_protection: true }, sourceCapabilities: { sandbox_policy: 'optional' } }), content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://media.example.test/778899.m3u8' }) } });
assert.equal(sandboxWithProtection.sandboxPolicy, 'optional');
passed += 6;

// ---------------------------------------------------------------------------
// 10. Unrestricted providers remain unrestricted (protection never forces
//     the sandbox back on), and protection still applies to them.
// ---------------------------------------------------------------------------
const unrestricted = await resolveSourceFromConfig(request, config({ providerCapabilities: { sandbox_policy: 'unrestricted' } }), content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://media.example.test/778899.m3u8' }) } });
assert.equal(unrestricted.sandboxPolicy, 'unrestricted');
assert.equal(iframeSandboxAttribute('unrestricted'), undefined);
const unrestrictedProtected = await resolveSourceFromConfig(request, config({ providerCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: true } }), content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://media.example.test/778899.m3u8' }) } });
assert.equal(unrestrictedProtected.sandboxPolicy, 'unrestricted');
await assert.rejects(
  () => resolveSourceFromConfig(request, config({ providerCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: true } }), content, { adapters: { direct: staticAdapter(popadsResult) } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
passed += 4;

// ---------------------------------------------------------------------------
// 11 + 12. Legitimate CDN and signed stream URLs remain allowed when the
//          provider has protection ON.
// ---------------------------------------------------------------------------
const protectedOn = config({ providerCapabilities: { playback_ad_protection: true } });
const cdnResult = await resolveSourceFromConfig(request, protectedOn, content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://d1a2b3c4.example.test/v/9f8b2c11de/a1b2c3d4e5f6/master.m3u8' }) } });
assert.equal(cdnResult.type, 'direct');
const signedResult = await resolveSourceFromConfig(request, protectedOn, content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://d1a2b3c4.example.test/v/a1b2c3d4/stream.m3u8?Expires=1893456000&Signature=QmFkZ2Vn&Key-Pair-Id=APKAI1234567890ABCDEF' }) } });
ok(signedResult.url!.includes('Signature=QmFkZ2Vn'), 'signed URL query must remain untouched when protection is ON');
passed += 1;

// ---------------------------------------------------------------------------
// 13. Peachify-specific protection works when enabled (REAL Peachify config
//     from supabase/migrations/20260821040000: embed, sandbox required,
//     allowed_embed_origins https://peachify.top, accent param template).
// ---------------------------------------------------------------------------
registerProviderPlaybackPolicy('peachify-test-provider', { blockedHosts: ['redirect.peachify-ads.example.test'] });
const peachifyOn = config({
  integrationType: 'embed',
  providerCapabilities: { result_type: 'embed', sandbox_policy: 'required', allowed_embed_origins: ['https://peachify.top'], playback_ad_protection: true },
  sourceCapabilities: { allowed_embed_origins: ['https://peachify.top'] },
  movieTemplate: 'https://peachify.top/embed/movie/{tmdb_id}?accent=b1a1ff',
});
// The real Peachify embed URL is legitimate and must play with protection ON.
const peachifyPlayback = await resolveSourceFromConfig(request, peachifyOn, content, {});
assert.equal(peachifyPlayback.type, 'embed');
assert.equal(peachifyPlayback.url, 'https://peachify.top/embed/movie/778899?accent=b1a1ff');
assert.equal(peachifyPlayback.sandboxPolicy, 'required');
passed += 2;
// A Peachify-SCOPED classified host is blocked only when Peachify's
// protection is ON — demonstrating per-provider rule application. (Direct
// fixture: for embeds the origin allowlist is an independent security layer
// that already rejects unknown origins before the policy runs.)
const peachifyDirectOn = config({ providerId: 'peachify-test-provider', providerCapabilities: { playback_ad_protection: true } });
await assert.rejects(
  () => resolveSourceFromConfig(request, peachifyDirectOn, content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://redirect.peachify-ads.example.test/landing' }) } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
passed += 1;
// The embed origin allowlist still runs BEFORE the policy even when a
// provider has protection ON — existing security is never weakened.
await assert.rejects(
  () => resolveSourceFromConfig(request, peachifyOn, content, { adapters: { embed: staticAdapter({ type: 'embed', url: 'https://redirect.peachify-ads.example.test/landing' }) } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);
passed += 1;

// ---------------------------------------------------------------------------
// 14. Peachify behavior unchanged when disabled — the same real config with
//     the toggle OFF resolves identically, and Peachify's scoped rule does
//     not exist for other providers (no inheritance).
// ---------------------------------------------------------------------------
const peachifyOff = { ...peachifyOn, provider: { ...peachifyOn.provider, capabilities: { result_type: 'embed', sandbox_policy: 'required', allowed_embed_origins: ['https://peachify.top'], playback_ad_protection: false } } };
const peachifyOffPlayback = await resolveSourceFromConfig(request, peachifyOff, content, {});
assert.equal(peachifyOffPlayback.url, 'https://peachify.top/embed/movie/778899?accent=b1a1ff');
const peachifyOffDirect = config({ providerId: 'peachify-test-provider', providerCapabilities: { playback_ad_protection: false } });
const offScopedResult = await resolveSourceFromConfig(request, peachifyOffDirect, content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://redirect.peachify-ads.example.test/landing' }) } });
assert.equal(offScopedResult.url, 'https://redirect.peachify-ads.example.test/landing');
passed += 2;
// Another provider with protection ON never inherits Peachify's rule.
const otherOn = config({ sourceId: sourceIdB, providerId: PROVIDER_B, providerCapabilities: { playback_ad_protection: true } });
const otherResult = await resolveSourceFromConfig(request, otherOn, content, { adapters: { direct: staticAdapter({ type: 'direct', url: 'https://redirect.peachify-ads.example.test/landing' }) } });
assert.equal(otherResult.url, 'https://redirect.peachify-ads.example.test/landing');
passed += 1;
// Source-level override respected end-to-end: provider ON, source OFF → OFF.
const sourceOverrideOff = config({ providerCapabilities: { playback_ad_protection: true }, sourceCapabilities: { playback_ad_protection: false } });
const overrideResult = await resolveSourceFromConfig(request, sourceOverrideOff, content, { adapters: { direct: staticAdapter(popadsResult) } });
assert.equal(overrideResult.url, 'https://serve.popads.net/fake-stream.m3u8?token=x');
passed += 1;
// And the inverse: provider OFF, source ON → ON.
const sourceOverrideOn = config({ providerCapabilities: { playback_ad_protection: false }, sourceCapabilities: { playback_ad_protection: true } });
await assert.rejects(
  () => resolveSourceFromConfig(request, sourceOverrideOn, content, { adapters: { direct: staticAdapter(popadsResult) } }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED',
);
passed += 1;

// Cleanup the curated fixture rule so unrelated tests are untouched.
ok(unregisterProviderPlaybackPolicy('peachify-test-provider'), 'fixture cleanup');
ok(unregisterProviderPlaybackPolicy(PROVIDER_A), 'fixture cleanup');
passed += 2;

console.log(`Third-Party Playback Ad Protection tests passed: ${passed} checks — provider/source-scoped resolution (source override → provider default → OFF), per-attempt evaluation, both fallback directions, sandbox/unrestricted independence, first-party ad-service separation, legit CDN/signed URL safety, real Peachify config ON/OFF, evaluator conservatism matrix, and scoped rule isolation.`);
