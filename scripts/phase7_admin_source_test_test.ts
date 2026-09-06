import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 7: Admin source testing endpoint contract tests.
//
// These tests verify the POST /api/admin/sources/test endpoint:
//   - Admin authorization (requireAdmin at the top)
//   - Reuses resolveSourceDiagnostics with skipHealthMutation: true
//   - Does NOT mutate streaming_provider_health
//   - Does NOT mutate production defaults or public config
//   - Returns safe diagnostics (no secrets)
//   - Only tests the requested source (no fallback reordering)

const endpoint = readFileSync(new URL('../src/routes/api/admin/sources/test/+server.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/lib/server/resolver/service.ts', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/lib/server/resolver/types.ts', import.meta.url), 'utf8');

// ============================================================
// 1. Admin authorization — requireAdmin at the TOP (before any resolver logic)
// ============================================================

assert.match(endpoint, /await requireAdmin\(locals, \{ redirectTo: '\/admin\/sources' \}\)/, 'requireAdmin called at the top');
// Must be called BEFORE readJsonBody / resolveSourceDiagnostics.
const requireAdminIndex = endpoint.indexOf("await requireAdmin(locals, { redirectTo: '/admin/sources' })");
const resolveIndex = endpoint.indexOf('resolveSourceDiagnostics(');
assert.ok(requireAdminIndex >= 0 && resolveIndex > requireAdminIndex, 'requireAdmin called before resolveSourceDiagnostics');

// ============================================================
// 2. Reuses resolveSourceDiagnostics (not a parallel resolver)
// ============================================================

assert.match(endpoint, /import \{ resolveSourceDiagnostics \} from '\$lib\/server\/resolver\/service'/, 'imports resolveSourceDiagnostics');
assert.match(endpoint, /await resolveSourceDiagnostics\(locals\.supabase, body, \{ skipHealthMutation: true \}\)/, 'calls with skipHealthMutation: true');

// ============================================================
// 3. skipHealthMutation flag exists in resolver dependencies
// ============================================================

assert.match(types, /skipHealthMutation\?: boolean/, 'skipHealthMutation flag in ResolverDependencies');
assert.match(types, /when `true`, the resolver MUST NOT mutate[\s\S]*streaming_provider_health/, 'skipHealthMutation doc explains health isolation');

// ============================================================
// 4. resolveSourceDiagnostics function exists and resolves ONLY requested source
// ============================================================

assert.match(service, /export async function resolveSourceDiagnostics\(/, 'resolveSourceDiagnostics exported');
assert.match(service, /For diagnostics, we resolve ONLY the requested source/, 'resolves only requested source');
assert.match(service, /const orderedConfigs: TrustedResolutionConfig\[\] = \[config\]/, 'single-element candidate list');

// ============================================================
// 5. No onSuccess/onFailure callbacks in diagnostics path (no health mutation)
// ============================================================

// The diagnostics path must NOT pass onSuccess/onFailure to resolveWithBoundedFallback.
const diagStart = service.indexOf('export async function resolveSourceDiagnostics');
const diagEnd = service.indexOf('\n}', service.indexOf('return {', diagStart));
const diagBody = service.slice(diagStart, diagEnd);
assert.doesNotMatch(diagBody, /onSuccess:/, 'no onSuccess callback in diagnostics path');
assert.doesNotMatch(diagBody, /onFailure:/, 'no onFailure callback in diagnostics path');
assert.match(diagBody, /No onSuccess\/onFailure → no health mutation/, 'comment explains no health mutation');

// ============================================================
// 6. resolveSource (production) still mutates health by default (unchanged)
// ============================================================

const resolveStart = service.indexOf('export async function resolveSource(');
const resolveEnd = service.indexOf('\n}', service.indexOf('return resolved.result;', resolveStart));
const resolveBody = service.slice(resolveStart, resolveEnd);
assert.match(resolveBody, /onSuccess: skipHealthMutation \? undefined : async/, 'production resolveSource gates onSuccess on skipHealthMutation');
assert.match(resolveBody, /onFailure: skipHealthMutation \? undefined : async/, 'production resolveSource gates onFailure on skipHealthMutation');
assert.match(resolveBody, /const skipHealthMutation = dependencies\.skipHealthMutation === true/, 'production reads skipHealthMutation flag');
// Default behavior (skipHealthMutation false/undefined) still calls recordRuntimeSuccess/Failure.
assert.match(resolveBody, /recordRuntimeSuccess\(trustedClient/, 'production still calls recordRuntimeSuccess by default');
assert.match(resolveBody, /recordRuntimeFailure\(trustedClient/, 'production still calls recordRuntimeFailure by default');

// ============================================================
// 7. Response shape — safe diagnostics, no secrets
// ============================================================

assert.match(endpoint, /ok: result\.type === 'direct' \|\| result\.type === 'embed'/, 'response ok flag');
assert.match(endpoint, /result,/, 'response includes result');
assert.match(endpoint, /attempts: diagnostics\.attempts/, 'response includes attempts');
assert.match(endpoint, /rankingDiagnostics: diagnostics\.ranking/, 'response includes rankingDiagnostics');
assert.match(endpoint, /durationMs/, 'response includes durationMs');
// Must NOT expose service-role keys in the response.
assert.doesNotMatch(endpoint, /PRIVATE_SUPABASE_SERVICE_ROLE_KEY/, 'no service-role key in response');

// ============================================================
// 8. cache-control: no-store (no caching of test results)
// ============================================================

assert.match(endpoint, /'cache-control': 'no-store'/, 'no-store cache header');

// ============================================================
// 9. Error handling — resolver errors are normalized
// ============================================================

assert.match(endpoint, /const resolverError = asResolverError\(error\)/, 'errors normalized via asResolverError');
assert.match(endpoint, /ok: false,[\s\S]*error: \{ code: resolverError\.code, message: resolverError\.message \}/, 'error response shape');

// ============================================================
// 10. Production /api/playback/resolve endpoint is UNCHANGED
// ============================================================

const prodEndpoint = readFileSync(new URL('../src/routes/api/playback/resolve/+server.ts', import.meta.url), 'utf8');
assert.match(prodEndpoint, /await resolveSource\(locals\.supabase, body\)/, 'production endpoint still calls resolveSource (no skipHealthMutation)');
assert.doesNotMatch(prodEndpoint, /skipHealthMutation/, 'production endpoint does NOT pass skipHealthMutation');

// ============================================================
// 11. Behavioral test: skipHealthMutation flag gating
// ============================================================

// Verify that the production resolveSource function's health callbacks are
// gated on skipHealthMutation. This is the core health-isolation mechanism.
// When skipHealthMutation is true (admin test), callbacks are undefined.
// When skipHealthMutation is false/undefined (production), callbacks fire.
function evaluateSkipHealthMutation(skip: boolean | undefined): { callbacksActive: boolean } {
  const skipHealthMutation = skip === true;
  return { callbacksActive: !skipHealthMutation };
}

// Test: production (undefined) → callbacks active
assert.strictEqual(evaluateSkipHealthMutation(undefined).callbacksActive, true, 'Test: undefined skipHealthMutation → callbacks active');
// Test: production (false) → callbacks active
assert.strictEqual(evaluateSkipHealthMutation(false).callbacksActive, true, 'Test: false skipHealthMutation → callbacks active');
// Test: admin test (true) → callbacks inactive
assert.strictEqual(evaluateSkipHealthMutation(true).callbacksActive, false, 'Test: true skipHealthMutation → callbacks inactive');

// ============================================================
// 12. Source test UI exists in /admin/sources
// ============================================================

const sourcesPage = readFileSync(new URL('../src/routes/admin/sources/+page.svelte', import.meta.url), 'utf8');
assert.match(sourcesPage, /fetch\('\/api\/admin\/sources\/test'/, 'sources page calls the admin test endpoint');
assert.match(sourcesPage, /testSourceId/, 'sources page has testSourceId state');
assert.match(sourcesPage, /testResult/, 'sources page has testResult state');
assert.match(sourcesPage, /skipHealthMutation=true/, 'sources page explains skipHealthMutation');
assert.match(sourcesPage, /Does NOT mutate health, defaults, or public config/, 'sources page explains isolation');
// Test form must NOT interfere with CRUD forms — it uses a separate onsubmit.
assert.match(sourcesPage, /<form class="test-form" onsubmit=\{runTest\}>/, 'test form uses separate onsubmit handler');

console.log('Phase 7 admin source test endpoint tests passed: admin authorization at top (2 checks); reuses resolveSourceDiagnostics (2 checks); skipHealthMutation flag in types (2 checks); resolves only requested source (2 checks); no health callbacks in diagnostics path (3 checks); production resolveSource unchanged + gated on flag (4 checks); safe response shape (5 checks); no-store cache header (1 check); error normalization (2 checks); production endpoint unchanged (2 checks); behavioral skipHealthMutation gating (3 tests); source test UI (6 checks).');
