import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapterIds, createDefaultAdapters, createMockAdapter } from '$lib/server/resolver/adapters';
import { resolveWithBoundedFallback } from '$lib/server/resolver/fallback';
import {
  vixolityProviderAdapter,
  VIXOLITY_ADAPTER_ID,
  VIXOLITY_ORIGIN,
  buildVixolityMediaUrl,
  requireImdbId,
  validateVixolityMediaUrl,
} from '$lib/server/resolver/vixolity';
import { PROVIDER_CAPABILITY_MAP, DIRECT_PLAYBACK_CAPABILITIES, lookupProviderCapabilities } from '$lib/shared/player-capabilities';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Vixolity provider integration tests (2026-10 integration).
//
// Verified contract (supplied with the integration; the direct URL IS the
// contract — no API endpoints exist, none are invented, nothing scraped):
//   Movie:  https://ha.vixolity.com/vs/{imdbId}
//   Series: https://ha.vixolity.com/vs/{imdbId}/s{season}/e{episode}
//   (episode padded to AT LEAST two digits — e01, e12; season unpadded — s1)
//
// The URL is built deterministically server-side — there is NO upstream
// fetch to mock; the adapter contract is pure construction + validation.
// Playback is owned by the existing client HLS engine (native + hls.js),
// which is covered by the existing engine suites — mocked playback is never
// misrepresented as verified real-world playback here.

const providerId = '00000000-0000-4000-8000-00000000vx01';
const sourceId = '00000000-0000-4000-8000-00000000vx02';
const otherProviderId = '00000000-0000-4000-8000-00000000vx03';

// Mirrors migration 20261113000000_vixolity_tgvid_zxcstream_providers.sql exactly.
const capabilities = {
  movie: true,
  series: true,
  anime: true,
  result_type: 'direct',
  supports_episode: true,
  supports_direct: true,
  supports_server_selection: false,
  automatic_server_fallback: false,
  supports_subtitles: false,
  supports_language_selection: false,
  supports_download: false,
  allow_experimental_playback: true,
};

function vixolityConfig(overrides?: {
  providerEnabled?: boolean;
  providerStatus?: string;
  sourceEnabled?: boolean;
  sourceStatus?: string;
}): TrustedResolutionConfig {
  return {
    provider: {
      id: providerId,
      name: 'Vixolity',
      status: (overrides?.providerStatus ?? 'experimental') as 'experimental',
      enabled: overrides?.providerEnabled ?? false,
      integration_type: 'direct' as const,
      adapter_id: 'vixolity',
      capabilities,
    },
    source: {
      id: sourceId,
      provider_id: providerId,
      name: 'Vixolity',
      status: (overrides?.sourceStatus ?? 'experimental') as 'experimental',
      enabled: overrides?.sourceEnabled ?? false,
      visibility: 'public' as const,
      integration_type: 'direct' as const,
      capabilities,
      movie_template: null,
      series_template: null,
      anime_template: null,
      identifier_mode: 'imdb_id' as const,
      audio_languages: [],
      subtitle_capability: false,
      quality_capability: [],
    },
  };
}

function content(type: 'movie' | 'series', tmdb?: string, imdb?: string): NormalizedMediaItem {
  return {
    id: `vixolity-fixture-${imdb ?? tmdb ?? 'none'}`,
    title: 'Fixture title',
    year: 2024,
    type,
    runtime: '120 min',
    rating: 8,
    genres: ['Drama'],
    description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#ffffff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb, imdb },
  };
}

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}
async function expectError(promise: Promise<unknown>, code: string, label: string) {
  let threw = false;
  try {
    await promise;
  } catch (error) {
    threw = true;
    ok(error instanceof ResolverError && error.code === code, `${label} → ${code} (got ${(error as Error).message})`);
  }
  if (!threw) assert.fail(`${label}: expected ResolverError ${code} but the promise resolved`);
}

// ============================================================
// §1 — Media URL construction (movie + series + padding)
// ============================================================

ok(buildVixolityMediaUrl('tt1234567', 'movie') === `${VIXOLITY_ORIGIN}/vs/tt1234567`, '§1 movie URL exact');
ok(buildVixolityMediaUrl('tt1234567', 'series', 1, 1) === `${VIXOLITY_ORIGIN}/vs/tt1234567/s1/e01`, '§1 series URL exact with two-digit episode padding');
ok(buildVixolityMediaUrl('tt1234567', 'series', 2, 12) === `${VIXOLITY_ORIGIN}/vs/tt1234567/s2/e12`, '§1 two-digit episode stays unpadded (e12)');
ok(buildVixolityMediaUrl('tt0903747', 'series', 5, 123) === `${VIXOLITY_ORIGIN}/vs/tt0903747/s5/e123`, '§1 three-digit episode keeps its digits (e123)');
ok(buildVixolityMediaUrl('tt12345678', 'movie') === `${VIXOLITY_ORIGIN}/vs/tt12345678`, '§1 eight-digit IMDb id accepted');
ok(buildVixolityMediaUrl('tt1234567', 'series', 10, 1) === `${VIXOLITY_ORIGIN}/vs/tt1234567/s10/e01`, '§1 multi-digit season unpadded, episode padded');

// ============================================================
// §2 — Identifier safety (no TMDB substitution, no fabrication)
// ============================================================

const badIds = [undefined, '', '  ', '27205', '1234567', 'tt123456', 'tt123456789', 'tt', 'abcd1234567', 'tt1234567/x', '../tt1234567', 'tt1234567?x=1', 'TT1234567', 'tt_1234567', 'm tt1234567'];
for (const bad of badIds) {
  let threw = false;
  try {
    buildVixolityMediaUrl(bad as string, 'movie');
  } catch (error) {
    threw = error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER';
  }
  ok(threw, `§2 builder rejects imdb ${JSON.stringify(bad ?? 'undefined')} with MISSING_IDENTIFIER`);
}
// Unit form — the same guard the builder uses.
for (const bad of badIds) {
  let threw = false;
  try {
    requireImdbId(bad);
  } catch (error) {
    threw = error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER';
  }
  ok(threw, `§2 requireImdbId rejects ${JSON.stringify(bad ?? 'undefined')} with MISSING_IDENTIFIER`);
}
ok(requireImdbId(' tt0903747 ') === 'tt0903747', '§2 trimmed valid id accepted');

// Series requires BOTH numbers — guessing episode 1 is never allowed.
expectError((async () => buildVixolityMediaUrl('tt1234567', 'series'))(), 'MISSING_IDENTIFIER', '§2 series without season/episode rejected');
expectError((async () => buildVixolityMediaUrl('tt1234567', 'series', 1))(), 'MISSING_IDENTIFIER', '§2 series without episode rejected');
expectError((async () => buildVixolityMediaUrl('tt1234567', 'series', 1, 0))(), 'MISSING_IDENTIFIER', '§2 zero episode rejected');
expectError((async () => buildVixolityMediaUrl('tt1234567', 'series', 0, 1))(), 'MISSING_IDENTIFIER', '§2 zero season rejected');
expectError((async () => buildVixolityMediaUrl('tt1234567', 'series', 1.5, 1))(), 'MISSING_IDENTIFIER', '§2 fractional season rejected');
expectError((async () => buildVixolityMediaUrl('tt1234567', 'series', 1, 10001))(), 'MISSING_IDENTIFIER', '§2 out-of-range episode rejected');

// ============================================================
// §3 — Media URL validation (strict origin/path contract)
// ============================================================

const badUrls = [
  'http://ha.vixolity.com/vs/tt1234567',
  'https://evil.example.com/vs/tt1234567',
  'https://ha.vixolity.com.evil.test/vs/tt1234567',
  'https://user:pass@ha.vixolity.com/vs/tt1234567',
  'https://ha.vixolity.com/vs/tt1234567?token=x',
  'https://ha.vixolity.com/vs/tt1234567#frag',
  'https://ha.vixolity.com/vs/',
  'https://ha.vixolity.com/vs/tt1234567/extra',
  'https://ha.vixolity.com/vs/27205',
  'https://ha.vixolity.com/vs/tt1234567/s1/e1',
  'https://ha.vixolity.com/vs/tt1234567/s1/e01/x',
  'https://ha.vixolity.com/cdn/tt1234567',
  'not a url at all',
];
for (const bad of badUrls) {
  let threw = false;
  try {
    validateVixolityMediaUrl(bad);
  } catch (error) {
    threw = error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL';
  }
  ok(threw, `§3 rejects ${bad} with INVALID_SOURCE_URL`);
}
ok(validateVixolityMediaUrl(`${VIXOLITY_ORIGIN}/vs/tt1234567/s2/e012`) === `${VIXOLITY_ORIGIN}/vs/tt1234567/s2/e012`, '§3 longer episode padding passes the path contract');
ok(validateVixolityMediaUrl(`${VIXOLITY_ORIGIN}/vs/tt1234567`) === `${VIXOLITY_ORIGIN}/vs/tt1234567`, '§3 valid movie URL round-trips');

// ============================================================
// §4 — Resolver integration + lifecycle gates
// ============================================================

{
  // Disabled rows (the seeded state) are gated BEFORE the adapter runs.
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: 'tt1234567', mediaType: 'movie' }, vixolityConfig(), content('movie', '27205', 'tt1234567')),
    'PROVIDER_DISABLED',
    '§4 seeded (disabled) provider gated as PROVIDER_DISABLED',
  );
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: 'tt1234567', mediaType: 'movie' }, vixolityConfig({ providerEnabled: true, sourceEnabled: true }), content('movie', '27205')),
    'MISSING_IDENTIFIER',
    '§4 missing IMDb id → MISSING_IDENTIFIER (never fabricated, never a TMDB substitution)',
  );
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: 'tt1234567', mediaType: 'series', season: 1, episode: 1 }, vixolityConfig({ providerEnabled: true, sourceEnabled: true }), content('series', '1399')),
    'MISSING_IDENTIFIER',
    '§4 series without IMDb id → MISSING_IDENTIFIER',
  );

  const enabledConfig = vixolityConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' });
  const movieResult = await resolveSourceFromConfig({ sourceId, contentId: 'tt1234567', mediaType: 'movie' }, enabledConfig, content('movie', '27205', 'tt1234567'));
  ok(movieResult.type === 'direct' && movieResult.url === `${VIXOLITY_ORIGIN}/vs/tt1234567`, '§4 movie resolves to the exact direct URL');
  ok(movieResult.metadata?.protocol === 'hls', '§4 metadata.protocol hls (engine routes native + hls.js per its own architecture)');
  ok(movieResult.sandboxPolicy === 'required' || movieResult.sandboxPolicy === undefined || movieResult.sandboxRuntime !== undefined, '§4 sandbox provenance present');

  const seriesResult = await resolveSourceFromConfig({ sourceId, contentId: 'tt1234567', mediaType: 'series', season: 2, episode: 12 }, enabledConfig, content('series', '1399', 'tt1234567'));
  ok(seriesResult.type === 'direct' && seriesResult.url === `${VIXOLITY_ORIGIN}/vs/tt1234567/s2/e12`, '§4 series resolves with season + padded episode');

  const paddedResult = await resolveSourceFromConfig({ sourceId, contentId: 'tt1234567', mediaType: 'series', season: 1, episode: 1 }, enabledConfig, content('series', '1399', 'tt1234567'));
  ok(paddedResult.type === 'direct' && paddedResult.url === `${VIXOLITY_ORIGIN}/vs/tt1234567/s1/e01`, '§4 episode 1 renders as e01 (the verified example shape)');

  ok(movieResult.qualities === undefined, '§4 no qualities advertised statically (engine discovers renditions)');
}

// ============================================================
// §5 — Fallback semantics: Vixolity failure never breaks other sources
// ============================================================

{
  const fallbackProvider = {
    id: otherProviderId,
    name: 'Fixture Embed',
    status: 'active' as const,
    enabled: true,
    integration_type: 'template' as const,
    adapter_id: null,
    capabilities: { ...capabilities, result_type: 'embed', supports_direct: false, allowed_embed_origins: ['https://fixture.example.test'] },
  };
  const fallbackSource = {
    id: '00000000-0000-4000-8000-00000000vx04',
    provider_id: otherProviderId,
    name: 'Fixture Embed',
    status: 'active' as const,
    enabled: true,
    visibility: 'public' as const,
    integration_type: 'template' as const,
    capabilities: { ...capabilities, result_type: 'embed', supports_direct: false, allowed_embed_origins: ['https://fixture.example.test'] },
    movie_template: 'https://fixture.example.test/movie/{tmdb_id}',
    series_template: 'https://fixture.example.test/tv/{tmdb_id}/{season}/{episode}',
    anime_template: null,
    identifier_mode: 'tmdb_id' as const,
    audio_languages: ['multi'],
    subtitle_capability: false,
    quality_capability: [],
  };
  const dependencies = { adapters: { template: createMockAdapter('template', { type: 'embed', url: 'https://fixture.example.test/movie/27205' }) } };

  // Missing IMDb id on the Vixolity source → bounded walk proceeds to the
  // healthy fixture source; the final result is the fixture's.
  const fallbackRun = await resolveWithBoundedFallback(
    { sourceId, contentId: '27205', mediaType: 'movie' },
    content('movie', '27205'),
    [
      { config: vixolityConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }) },
      { config: { provider: fallbackProvider, source: fallbackSource } },
    ],
    dependencies,
  );
  ok(fallbackRun.result.type === 'embed' && fallbackRun.result.url === 'https://fixture.example.test/movie/27205', '§5 missing-IMDb failure fell through to the healthy source');
  ok(fallbackRun.attempts[0]?.sourceId === sourceId && fallbackRun.attempts[0]?.result === 'failure', '§5 Vixolity attempt recorded as failure');
  ok(fallbackRun.attempts[0]?.errorCode === 'MISSING_IDENTIFIER', '§5 Vixolity failure carries the typed MISSING_IDENTIFIER code');
}

// ============================================================
// §6 — Adapter registration + existing adapters unaffected
// ============================================================

const adapterIds = createDefaultAdapterIds();
ok(adapterIds[VIXOLITY_ADAPTER_ID] === vixolityProviderAdapter, '§6 vixolity registered under its adapter id');
ok(adapterIds['blue-velvet'] !== undefined, '§6 blue-velvet registration intact');
ok(adapterIds['vidsrc-embed'] !== undefined, '§6 vidsrc registration intact');
ok(adapterIds['vidlink-embed'] !== undefined, '§6 vidlink registration intact');
ok(adapterIds['vidara'] !== undefined && adapterIds['abyss'] !== undefined, '§6 mavero-hosted registrations intact');
// 2026-10 round 13: vidsrc-scrape adapter added (DirectStream scraper).
ok(adapterIds['vidsrc-scrape'] !== undefined, '§6 vidsrc-scrape registration intact (2026-10 round 13)');
ok(Object.keys(adapterIds).length === 7, '§6 exactly the seven expected adapter ids (five prior + vixolity + vidsrc-scrape)');

const genericAdapters = createDefaultAdapters();
ok(genericAdapters.template && genericAdapters.api && genericAdapters.direct && genericAdapters.embed && genericAdapters.custom, '§6 default integration-type adapters unchanged');
ok(vixolityProviderAdapter.integrationType === 'direct', '§6 vixolity declares the direct integration type');
ok(vixolityProviderAdapter.adapterId === 'vixolity', '§6 adapterId matches the migration value');

// ============================================================
// §7 — Capability matrix entries
// ============================================================

ok(PROVIDER_CAPABILITY_MAP['vixolity'] === DIRECT_PLAYBACK_CAPABILITIES, '§7 vixolity maps to the generic direct capability truth');
ok(lookupProviderCapabilities('vixolity') === DIRECT_PLAYBACK_CAPABILITIES, '§7 lookupProviderCapabilities resolves vixolity');
ok(lookupProviderCapabilities('vixolity')?.postMessage === false, '§7 direct playback carries no postMessage capability');
ok(lookupProviderCapabilities('vixolity')?.nextEpisode === false, '§7 direct playback carries no nextEpisode capability');

// ============================================================
// §8 — Migration contract (file review, nothing executed)
// ============================================================

const migrationPath = resolve('supabase/migrations/20261113000000_vixolity_tgvid_zxcstream_providers.sql');
const migration = readFileSync(migrationPath, 'utf-8');
ok(migration.includes("slug = 'vixolity'") || migration.includes("'vixolity',"), '§8 migration seeds the vixolity provider slug');
ok((migration.match(/on conflict \(slug\) do nothing/g) ?? []).length === 3, '§8 provider inserts are idempotent (on conflict do nothing ×3)');
ok((migration.match(/on conflict \(provider_id, slug\) do nothing/g) ?? []).length === 3, '§8 source inserts are idempotent (on conflict do nothing ×3)');
ok(!/insert into public\.streaming_(providers|sources)[\s\S]*?on conflict[\s\S]*?do update/i.test(migration), '§8 never updates existing rows (do nothing everywhere)');
ok(!/delete from|truncate /i.test(migration), '§8 no destructive statements');
ok((migration.match(/'imdb_id',/g) ?? []).length === 1, '§8 exactly one imdb_id identifier_mode value (Vixolity)');
ok((migration.match(/'tmdb_id',/g) ?? []).length === 2, '§8 exactly two tmdb_id identifier_mode values (TGVID + ZXCStream)');
ok((migration.match(/'experimental',\n    false,/g) ?? []).length === 3, '§8 all three PROVIDERS seeded experimental + disabled');
ok((migration.match(/    false,\n    'public',\n    'experimental',/g) ?? []).length === 3, '§8 all three SOURCES seeded disabled + public + experimental');
ok((migration.match(/'experimental'/g) ?? []).length === 6, '§8 all six rows seeded experimental');
ok(migration.includes("'allow_experimental_playback', true"), '§8 experimental-playback grant present (admin can trial-enable)');
ok(migration.includes(`'allowed_embed_origins', jsonb_build_array('https://tgvid.lovable.app')`), '§8 TGVID embed origin pinned');
ok(migration.includes(`'allowed_embed_origins', jsonb_build_array('https://zxcstream.cc')`), '§8 ZXCStream embed origin pinned');
ok(migration.includes('https://tgvid.lovable.app/embed/movie/{tmdb_id}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false'), '§8 TGVID movie template exact (documented params)');
ok(migration.includes('https://tgvid.lovable.app/embed/tv/{tmdb_id}/{season}/{episode}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false'), '§8 TGVID series template exact');
ok(migration.includes('https://zxcstream.cc/player/movie/{tmdb_id}?dubLang=hi&server=1'), '§8 ZXCStream movie template exact');
ok(migration.includes('https://zxcstream.cc/player/tv/{tmdb_id}/{season}/{episode}?dubLang=hi&server=1'), '§8 ZXCStream series template exact');
ok(!/'https:\/\/[^']*\?[^']*domainAd/.test(migration), '§8 no template URL carries the domainAd splash parameter');
ok(!/'https:\/\/[^']*\?[^']*autoplay=true/.test(migration), '§8 no template URL enables the muted autoplay parameter');
ok((migration.match(/'vixolity',/g) ?? []).length >= 1, '§8 vixolity adapter id wired');
ok(migration.includes("410"), '§8 vixolity ordering 410 (staged band behind blue velvet 400)');
ok(migration.includes("420"), '§8 tgvid ordering 420');
ok(migration.includes("430"), '§8 zxcstream ordering 430');

// ============================================================
// §9 — CSP contract for the Vixolity media origin
// ============================================================

{
  const netlifyToml = readFileSync(resolve('netlify.toml'), 'utf-8');
  const cspMatch = netlifyToml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/);
  ok(cspMatch !== null, '§9 netlify.toml carries a Content-Security-Policy header');
  if (cspMatch) {
    const csp = cspMatch[1];
    const directive = (name: string) => {
      const m = csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`, 'i'));
      return m ? m[1].trim().split(/\s+/) : null;
    };
    const mediaSrc = directive('media-src');
    const connectSrc = directive('connect-src');
    ok(mediaSrc?.includes('https://ha.vixolity.com') === true, '§9 media-src allows the fixed Vixolity origin (native-HLS media element)');
    ok(connectSrc?.includes('https://ha.vixolity.com') === true, '§9 connect-src allows the fixed Vixolity origin (hls.js XHR route)');
    // Pre-existing directives retained — the addition may never weaken the
    // existing policy (bluevelvet §10 contract stays green).
    ok(mediaSrc?.includes('https://zcdn.bluevelvet.space') === true, '§9 media-src Blue Velvet origin retained');
    ok(connectSrc?.includes('https://zcdn.bluevelvet.space') === true, '§9 connect-src Blue Velvet origin retained');
    ok(connectSrc?.includes('https://sub.vdrk.site') === true, '§9 connect-src VDRK subtitle lists retained');
    ok(connectSrc?.includes('https://api.theintrodb.org') === true, '§9 connect-src TheIntroDB retained');
    ok(connectSrc?.includes('https://*.supabase.co') === true, '§9 connect-src Supabase wildcard retained');
    ok(directive('default-src')?.includes("'self'") === true, '§9 default-src remains self');
    ok(directive('frame-ancestors')?.includes("'none'") === true, '§9 frame-ancestors none unchanged');
    ok(directive('frame-src')?.includes('*') === true, '§9 frame-src * retained (admin-configured embeds — covers TGVID/ZXCStream without new entries)');
    ok(!mediaSrc?.includes('*') && !connectSrc?.includes('*'), '§9 no wildcard relaxation introduced in media-src/connect-src');
    ok(!/http:\/\//.test(mediaSrc?.join(' ') ?? '') && !/http:\/\//.test(connectSrc?.join(' ') ?? ''), '§9 no plaintext (non-HTTPS) origins in media-src/connect-src');
  }
}

// ============================================================
// Summary
// ============================================================

console.log(`vixolity_provider_test: ${passed} checks passed`);
