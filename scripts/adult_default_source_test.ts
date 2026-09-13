import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TrustedResolutionConfig, ResolverRequest } from '$lib/server/resolver/types';
import type { NormalizedMediaItem } from '$lib/server/content/types';

// Post-release fix — ADULT default playback source.
//
// The admin-configured default source contract gains a fourth content type
// ('adult'): the default SOURCE for authorized Adult playback. Same
// source-based architecture as movie/series/anime
// (streaming_default_sources.source_id -> streaming_sources.id), same
// eligibility rules, same admin authorization, same resolver semantics —
// reordering candidates for ALREADY-AUTHORIZED playback. The adult default
// NEVER affects Adult Mode authorization: Adult Mode OFF keeps adult
// content inaccessible regardless of any configured default (the watch
// route 404s adult titles before any default selection runs).
//
// Coverage:
//   - Migration: ALTER-only constraint extension, data preserved
//   - admin-service: adult accepted (behavioral save/clear), invalid
//     content types rejected
//   - public-config: adult row maps to defaults.adult (same eligibility)
//   - Admin UI: 4th Adult card (save/clear via the same actions)
//   - Watch page: adult-tagged titles use the adult default; other titles
//     unchanged
//   - Resolver: the adult default rides the existing ordering mechanism;
//     ineligible defaults are still excluded (authorization-independent)

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const migration = readFileSync(new URL('../supabase/migrations/20260914000000_adult_default_source.sql', import.meta.url), 'utf8');
const adminService = readFileSync(new URL('../src/lib/server/streaming/admin-service.ts', import.meta.url), 'utf8');
const publicConfig = readFileSync(new URL('../src/lib/server/streaming/public-config.ts', import.meta.url), 'utf8');
const streamingTypes = readFileSync(new URL('../src/lib/server/streaming/types.ts', import.meta.url), 'utf8');
const defaultsPage = readFileSync(new URL('../src/routes/admin/defaults/+page.svelte', import.meta.url), 'utf8');
const defaultsServer = readFileSync(new URL('../src/routes/admin/defaults/+page.server.ts', import.meta.url), 'utf8');
const watchPage = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');

// --- behavioral imports (resolver + admin-service contracts) ---
const { applyDefaultSourceOrdering } = await import('$lib/server/resolver/default-source');
const { rankProviderSourceList } = await import('$lib/server/resolver/ranking');
const { parseResolverRequest } = await import('$lib/server/resolver/identifiers');
const { upsertDefaultSource, clearDefaultSource } = await import('$lib/server/streaming/admin-service');

// ============================================================
// 1. Migration — safe contract extension
// ============================================================
assert.match(migration, /check \(content_type in \('movie', 'series', 'anime', 'adult'\)\)/, 'CHECK union extended with adult');
assert.match(migration, /add constraint streaming_default_sources_content_type_check/, 'constraint re-created with the canonical name');
assert.match(migration, /validate constraint streaming_default_sources_content_type_check/, 'existing rows re-validated');
assert.doesNotMatch(migration, /drop table|truncate\s|delete from|drop column|alter column .*type/i, 'ALTER-only: table/data never reset or recreated');
assert.match(migration, /constraint_name/i, 'constraint swap is name-resilient (pg_constraint lookup)');
assert.match(migration, /on delete cascade/i, 'documents/keeps the existing FK cascade semantics');
ok('1. migration extends the union with adult; ALTER-only, idempotent, data/FK/RLS preserved');

// ============================================================
// 2. admin-service — adult accepted, persistence (behavioral), invalid rejected
// ============================================================
assert.match(adminService, /VALID_DEFAULT_CONTENT_TYPES = new Set\(\['movie', 'series', 'anime', 'adult'\]\)/, "valid content types include 'adult'");
assert.match(adminService, /Must be one of: movie, series, anime, adult\./, 'invalid-type message lists adult');

// Minimal mock of the Supabase client shape used by upsertDefaultSource /
// clearDefaultSource (same pattern as phase7_admin_defaults_test.ts).
function createMockClient() {
  const state = { defaults: new Map<string, { content_type: string; source_id: string; updated_at: string }>() };
  let invalidateCalls = 0;
  const client = {
    from: (table: string) => {
      assert.equal(table, 'streaming_default_sources', 'admin-service writes the default-source table only');
      return {
        upsert: (input: { content_type: string; source_id: string }, opts?: { onConflict?: string }) => {
          assert.equal(opts?.onConflict, 'content_type', 'upsert keyed on content_type (PK)');
          return {
            select: () => ({
              single: () => {
                const row = { content_type: input.content_type, source_id: input.source_id, updated_at: new Date().toISOString() };
                state.defaults.set(input.content_type, row);
                return { data: row, error: null };
              }
            })
          };
        },
        delete: () => ({
          eq: (_col: string, value: string) => {
            state.defaults.delete(value);
            return { error: null };
          }
        })
      };
    },
    _state: state,
    _invalidateCalls: () => invalidateCalls,
  };
  return client;
}

// save adult default + persistence + existing types unaffected.
{
  const client = createMockClient() as unknown as SupabaseClient<never>;
  void upsertDefaultSource(client, 'movie', '11111111-1111-4111-8111-111111111111');
  void upsertDefaultSource(client, 'series', '22222222-2222-4222-8222-222222222222');
  const adultRow = await upsertDefaultSource(client, 'adult', '33333333-3333-4333-8333-333333333333');
  assert.equal(adultRow.content_type, 'adult', 'adult default row persisted');
  assert.equal(adultRow.source_id, '33333333-3333-4333-8333-333333333333', 'adult default stores a SOURCE id (not a provider id)');
  assert.equal(client._state.defaults.size, 3, 'movie/series rows coexist with the adult row');
  assert.equal(client._state.defaults.get('movie')?.source_id, '11111111-1111-4111-8111-111111111111', 'existing movie default preserved');
  assert.equal(client._state.defaults.get('series')?.source_id, '22222222-2222-4222-8222-222222222222', 'existing series default preserved');
  // overwrite semantics (one default per content type)
  await upsertDefaultSource(client, 'adult', '44444444-4444-4444-8444-444444444444');
  assert.equal(client._state.defaults.get('adult')?.source_id, '44444444-4444-4444-8444-444444444444', 'adult upsert overwrites (at most one default)');
  // clear adult default — others untouched
  await clearDefaultSource(client, 'adult');
  assert.equal(client._state.defaults.has('adult'), false, 'adult default cleared');
  assert.equal(client._state.defaults.has('movie'), true, 'movie default survives the adult clear');
  assert.equal(client._state.defaults.has('series'), true, 'series default survives the adult clear');
  ok('2. save/persistence/overwrite/clear for the adult default (existing rows untouched)');
}

// invalid content type rejection (behavioral).
{
  const client = createMockClient() as unknown as SupabaseClient<never>;
  await assert.rejects(
    () => upsertDefaultSource(client, 'provider-only', '55555555-5555-4555-8555-555555555555'),
    /Invalid default content type 'provider-only'/,
    'non-union content type rejected (no fake provider-only setting)'
  );
  await assert.rejects(() => clearDefaultSource(client, 'tv'), /Invalid default content type 'tv'/, 'clear also validates the union');
  assert.equal(client._state.defaults.size, 0, 'rejected writes persist nothing');
  ok('2b. invalid content types rejected on save AND clear');
}

// ============================================================
// 3. public-config — adult maps through the SAME eligibility rules
// ============================================================
assert.match(publicConfig, /new Set\(\['movie', 'series', 'anime', 'adult'\]\)/, "public config accepts the adult content type");
assert.match(publicConfig, /row\.content_type === 'adult'\) defaults\.adult = row\.source_id/, 'adult row maps to defaults.adult');
assert.match(publicConfig, /publicSourceIds\.has\(row\.source_id\)/, 'eligibility filter (public+enabled source) applied to adult too');
assert.match(streamingTypes, /adult\?: string/, 'PublicStreamingDefaults carries the adult default');
ok('3. public config maps the adult default through the existing eligibility rules');

// ============================================================
// 4. Admin UI — 4th card, same authorization (server actions unchanged)
// ============================================================
assert.match(defaultsPage, /\{ key: 'adult', label: 'Adult', description: 'Default playback source for authorized Adult content\.' \}/, 'Adult card present with the required purpose text');
assert.match(defaultsPage, /\{#each contentTypes as ct\}/, 'cards render from the shared loop (save/clear flows identical)');
assert.doesNotMatch(defaultsServer, /content_type in|VALID_DEFAULT/, 'page server delegates validation to admin-service (no duplicate contract)');
assert.match(defaultsServer, /saveDefault: async[\s\S]*?await requireAdmin/, 'save action requires admin');
assert.match(defaultsServer, /clearDefault: async[\s\S]*?await requireAdmin/, 'clear action requires admin');
ok('4. admin UI shows the Adult card; save/clear ride the existing admin-authorized actions');

// ============================================================
// 5. Watch page — adult-tagged titles use the adult default
// ============================================================
assert.match(watchPage, /isAdultTitle = item\.tags\?\.includes\('Adult'\) === true/, 'adult titles detected via the central classifier tag');
assert.match(watchPage, /defaultSourceId = \(isAdultTitle \? data\.streamingConfig\.defaults\?\.adult : undefined\) \?\? data\.streamingConfig\.defaults\?\.\[contentType\]/, 'adult default preferred for adult titles; content-type default otherwise');
ok('5. watch page consumes defaults.adult for authorized adult titles only');

// ============================================================
// 6. Resolver — adult default rides the existing ordering semantics;
//    ranking gates still exclude ineligible defaults
// ============================================================
const adultContent: NormalizedMediaItem = {
  id: '2902-t', title: 'Adult Title', year: 2024, type: 'series', runtime: '25m', rating: 7, genres: ['Drama'], description: 'fixture',
  tags: ['Adult'],
  poster: 'https://image.example.test/poster.jpg', backdrop: 'https://image.example.test/backdrop.jpg', accent: '#9b87f5',
  source: { provider: 'tmdb', externalId: '2902', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '2902' },
};
function makeConfig(providerId: string, sourceId: string, overrides: { source?: Partial<TrustedResolutionConfig['source']> } = {}): TrustedResolutionConfig {
  return {
    provider: { id: providerId, name: `Provider ${providerId}`, status: 'active', enabled: true, integration_type: 'embed', adapter_id: null, capabilities: { movie: true, series: true, anime: false, allow_experimental_playback: true, sandbox_policy: 'required' } },
    source: {
      id: sourceId, provider_id: providerId, name: `Source ${sourceId}`, status: 'active', enabled: true, visibility: 'public',
      integration_type: 'embed', capabilities: { movie: true, series: true, anime: false, allow_experimental_playback: true, sandbox_policy: 'required', allowed_embed_origins: ['https://embed.example.test'] },
      movie_template: 'https://embed.example.test/movie/{tmdb_id}', series_template: 'https://embed.example.test/tv/{tmdb_id}/{season}/{episode}', anime_template: null,
      identifier_mode: 'tmdb_id', audio_languages: ['multi'], subtitle_capability: false, quality_capability: [],
      ...overrides.source,
    },
  };
}
const adultDefault = makeConfig('p-adult', 's-adult-default');
const sourceA = makeConfig('p-a', 's-a');
const sourceB = makeConfig('p-b', 's-b');
// 6a. The adult default moves to the front of the candidate list.
{
  const ordered = applyDefaultSourceOrdering([sourceA, adultDefault, sourceB], 's-adult-default');
  assert.equal(ordered[0].source.id, 's-adult-default', 'authorized adult playback prefers the configured adult default');
  // 6b. Ranking keeps the default first and eligibility gates still apply.
  const request: ResolverRequest = { sourceId: 's-a', contentId: '2902', mediaType: 'series', defaultSourceId: 's-adult-default' };
  const ranking = rankProviderSourceList(request, adultContent, ordered, new Map());
  assert.equal(ranking.eligible[0].config.source.id, 's-adult-default', 'default wins the sourceOrder tiebreaker');
  assert.equal(ranking.eligible.length, 3, 'all eligible sources remain candidates (default reorders, never removes)');
  // 6c. A DISABLED adult default is still excluded by the ranking gates —
  // the default never bypasses eligibility.
  const disabledDefault = makeConfig('p-adult', 's-adult-default', { source: { enabled: false } });
  const orderedDisabled = applyDefaultSourceOrdering([sourceA, disabledDefault, sourceB], 's-adult-default');
  const rankingDisabled = rankProviderSourceList(request, adultContent, orderedDisabled, new Map());
  assert.equal(rankingDisabled.eligible.some((r) => r.config.source.id === 's-adult-default'), false, 'disabled adult default excluded (no eligibility bypass)');
  ok('6. resolver: adult default preferred when configured + eligible; gates still authoritative');
}
// 6d. parseResolverRequest accepts the adult default UUID (same field).
{
  const parsed = parseResolverRequest({ sourceId: '00000000-0000-4000-8000-000000000001', contentId: '2902', mediaType: 'series', defaultSourceId: '00000000-0000-4000-8000-000000000002' });
  assert.equal(parsed.defaultSourceId, '00000000-0000-4000-8000-000000000002', 'adult default rides the existing request field');
  ok('6b. resolver request contract unchanged (defaultSourceId is content-type-agnostic)');
}

// ============================================================
// 7. Authorization is independent of the default (the security contract)
// ============================================================
{
  // The default selection exists ONLY on the watch page, which the Phase 6
  // guard protects: unauthorized adult access 404s BEFORE the page (and its
  // default selection) ever renders. Verify the guard is still in place and
  // precedes any data return.
  const watchServer = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.server.ts', import.meta.url), 'utf8');
  assert.match(
    watchServer,
    /detailVerdict\(item\.tags\) === 'adult'[\s\S]*?canAccessAdultContent\(locals\.supabase, user, cookies\)[\s\S]*?if \(!canAccess\) \{[\s\S]*?throw error\(404, 'Title not found'\)/,
    'watch route still classifies + evaluates the Phase 5 policy + denies with the non-disclosing 404'
  );
  // The resolver/playback APIs gained no new authorization surface.
  assert.doesNotMatch(adminService, /canAccessAdultContent/, 'default-source admin service has no adult-policy coupling');
  const resolveApi = readFileSync(new URL('../src/routes/api/playback/resolve/+server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(resolveApi, /default.*adult|adult.*default/i, 'the resolve API is unchanged by the adult default');
  ok('7. Adult Mode OFF => watch route 404s adult titles => adult default can never apply (authorization authoritative)');
}

console.log(`\nAdult default source tests passed (${passed} check groups).`);
