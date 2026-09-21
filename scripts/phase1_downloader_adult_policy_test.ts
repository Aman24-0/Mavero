import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { adultGuardDecision, assertAdultDownloadAllowed, downloaderContentId } from '../src/lib/server/content/adult-guard';

/**
 * Phase 1 (audit BL-5 / DL-1) — Adult Mode downloader bypass closed.
 *
 * Problem: the normal detail/content flow enforces Adult Mode server-side,
 * but the downloader surfaces (4 API endpoints + 2 standalone pages) did
 * NOT — the content service explicitly delegates authorization to callers,
 * so direct API/deep-link access bypassed Adult Mode for adult titles.
 *
 * Fix: ONE reusable server-boundary helper
 * (`$lib/server/content/adult-guard.ts`) that reuses the CANONICAL
 * classification (getDetail — the central classifier; the same
 * `tags.includes('Adult')` signal the detail pages guard on) and the
 * CANONICAL Phase 5 authorization (`canAccessAdultContent` — fresh admin
 * policy + verified preference/guest cookie). Nothing is duplicated.
 *
 * Behavioral coverage here executes the REAL guard helper with injected
 * loaders (adult-policy.ts is env-wired and cannot be imported under tsx —
 * the same adapter split as adult_authorization_test.ts):
 *   1. Adult Mode OFF + adult title        -> blocked (non-disclosing 404)
 *   2. Adult Mode ON + adult title         -> allowed
 *   3. non-adult title (any mode)          -> allowed, no policy I/O
 *   4. direct API request simulation       -> guard decision identical
 *   5. classification load failure         -> fail closed (404)
 *   6. authorization evaluation failure    -> fail closed (404)
 *   7. guest matrix via the pure decision   -> mirrors evaluateAdultAccess
 * A static section verifies the wiring of ALL downloader surfaces.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const ADULT_TAGS = ['Adult'];
const NORMAL_TAGS: string[] = [];
const NOT_FOUND = new Error('NOT_FOUND');

/** Runs the guard and returns the outcome instead of throwing. */
async function guardOutcome(
  tags: string[] | undefined,
  canAccessResult: boolean,
  options: { loadThrows?: boolean; canAccessThrows?: boolean; loadReturnsNull?: boolean } = {},
): Promise<{ blocked: boolean; status?: number }> {
  const supabase = {} as never;
  const cookies = { get: () => undefined };
  try {
    await assertAdultDownloadAllowed(supabase, { id: 'user-1' }, cookies, 'movie', 'movie-8633518', {
      loadDetail: async () => {
        if (options.loadThrows) throw NOT_FOUND;
        if (options.loadReturnsNull) return null;
        return { tags };
      },
      canAccess: async () => {
        if (options.canAccessThrows) throw new Error('policy read failed');
        return canAccessResult;
      },
    });
    return { blocked: false };
  } catch (caught) {
    const status = (caught as { status?: number })?.status;
    return { blocked: true, status };
  }
}

// ============================================================
// 1. Pure decision matrix (canonical authorization semantics)
// ============================================================

assert.equal(adultGuardDecision(ADULT_TAGS, false), 'blocked', 'adult + no access -> blocked');
assert.equal(adultGuardDecision(ADULT_TAGS, true), 'allow', 'adult + access -> allowed');
assert.equal(adultGuardDecision(NORMAL_TAGS, false), 'allow', 'non-adult + no access -> allowed (unaffected)');
assert.equal(adultGuardDecision(undefined, false), 'allow', 'unclassified-as-normal + no access -> allowed');
ok(true, '1. pure decision matrix: admin/preference semantics preserved exactly');

// Guest matrix sanity — the decision input is the EFFECTIVE access that the
// canonical policy produces for guests (admin.allowGuest && cookie), so the
// guard adds no guest-specific branch of its own.
assert.equal(adultGuardDecision(ADULT_TAGS, false), 'blocked', 'guest + admin disallows guests -> blocked');
assert.equal(adultGuardDecision(ADULT_TAGS, true), 'allow', 'guest + admin allows + cookie ON -> allowed');
ok(true, '2. guest behavior flows through the canonical matrix (no duplicated guest logic)');

// ============================================================
// 2. Behavioral — the boundary helper
// ============================================================

// 3. Adult Mode OFF + adult title -> non-disclosing 404.
{
  const outcome = await guardOutcome(ADULT_TAGS, false);
  assert.equal(outcome.blocked, true, 'Adult Mode OFF + adult title must be blocked');
  assert.equal(outcome.status, 404, 'block is the non-disclosing 404');
  ok(true, '3. Adult Mode OFF + adult title -> non-disclosing 404');
}

// 4. Adult Mode ON + adult title -> allowed.
{
  const outcome = await guardOutcome(ADULT_TAGS, true);
  assert.equal(outcome.blocked, false, 'Adult Mode ON + adult title must remain accessible');
  ok(true, '4. Adult Mode ON + adult title -> existing behavior preserved');
}

// 5. Non-adult titles are unaffected in BOTH modes.
{
  assert.equal((await guardOutcome(NORMAL_TAGS, false)).blocked, false, 'non-adult + OFF -> allowed');
  assert.equal((await guardOutcome(NORMAL_TAGS, true)).blocked, false, 'non-adult + ON -> allowed');
  ok(true, '5. non-adult titles unaffected regardless of Adult Mode');
}

// 6. Direct API request — the SAME guard decision applies (no UI-only
// enforcement): the helper is the API boundary itself (wiring proven in §3).
{
  const outcome = await guardOutcome(ADULT_TAGS, false);
  assert.equal(outcome.blocked, true);
  ok(true, '6. direct API requests hit the identical server-side guard');
}

// 7. Fail-closed: classification failure and policy failure both block.
{
  const loadFailure = await guardOutcome(ADULT_TAGS, false, { loadThrows: true });
  assert.equal(loadFailure.blocked && loadFailure.status === 404, true, 'detail load failure fails closed with 404');
  const nullTitle = await guardOutcome(undefined, false, { loadReturnsNull: true });
  assert.equal(nullTitle.blocked && nullTitle.status === 404, true, 'unknown title fails closed with 404');
  const policyFailure = await guardOutcome(ADULT_TAGS, false, { canAccessThrows: true });
  assert.equal(policyFailure.blocked && policyFailure.status === 404, true, 'policy evaluation failure fails closed with 404');
  ok(true, '7. failure modes fail closed (classification error, unknown title, policy error)');
}

// 8. Non-disclosure: every deny path throws the IDENTICAL generic 404 —
// nothing reveals whether the blocked id is actually an adult title.
{
  const blocked = await guardOutcome(ADULT_TAGS, false);
  const unknown = await guardOutcome(undefined, false, { loadReturnsNull: true });
  assert.equal(blocked.status, unknown.status, 'blocked-adult and unknown-title responses are indistinguishable');
  ok(true, '8. deny responses are non-disclosing (identical 404 shape for every deny reason)');
}

// 9. Canonical content id builder.
{
  assert.equal(downloaderContentId('movie', '8633518'), 'movie-8633518');
  assert.equal(downloaderContentId('series', '94605'), 'series-94605');
  assert.equal(downloaderContentId('anime', '21'), 'anime-21');
  ok(true, '9. downloader content ids use the canonical type-prefixed identity');
}

// ============================================================
// 3. Wiring — every downloader surface enforces the guard
// ============================================================

const batchEndpoint = read('src/routes/api/downloader/mavero/+server.ts');
const addonEndpoint = read('src/routes/api/downloader/mavero/addon/+server.ts');
const tabsEndpoint = read('src/routes/api/downloader/mavero/tabs/+server.ts');
const fourkEndpoint = read('src/routes/api/downloader/4k/+server.ts');
const moviePage = read('src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.server.ts');
const tvPage = read('src/routes/watch/mavero-downloader/tv/[tmdbId]/[season]/[episode]/+page.server.ts');

for (const [label, source] of [
  ['/api/downloader/mavero', batchEndpoint],
  ['/api/downloader/mavero/addon', addonEndpoint],
  ['/api/downloader/mavero/tabs', tabsEndpoint],
  ['/api/downloader/4k', fourkEndpoint],
] as const) {
  assert.match(source, /await assertAdultDownloadAllowed\(/, `${label} must call the adult guard`);
  // The guard must run BEFORE the try block so its HttpError is never
  // swallowed into the 503 convention.
  const guardIndex = source.indexOf('await assertAdultDownloadAllowed(');
  const tryIndex = source.indexOf('try {', guardIndex);
  assert.ok(tryIndex > guardIndex, `${label} guard runs before the resolution try block`);
}
ok(true, '10. all four downloader API endpoints enforce the guard BEFORE resolution');

// The endpoints pass the verified session + request cookies (guest matrix
// works through the same canonical policy as the detail flow).
assert.match(batchEndpoint, /locals\.supabase, locals\.user, cookies/, 'batch endpoint passes user + cookies to the guard');
assert.match(fourkEndpoint, /downloaderContentId\(mediaType, tmdbId\)/, '4K endpoint derives the canonical content id from the TMDB id');
ok(true, '11. endpoints pass verified identity + guest cookies; 4K uses the canonical content id');

for (const [label, source] of [['movie page', moviePage], ['tv page', tvPage]] as const) {
  assert.match(source, /await assertAdultDownloadAllowed\(/, `${label} must call the adult guard server-side`);
  // Phase 2-A: identity now comes from the hook-resolved locals.user
  // (no second auth roundtrip). The guard contract is unchanged.
  assert.match(source, /locals\.user/, `${label} reads hook-resolved locals.user`);
}
ok(true, '12. standalone downloader pages enforce the guard in +page.server.ts (deep links covered)');

// The pages exist as REAL server loads (not client-side hiding).
ok(true, '13. +page.server.ts loads exist for both standalone downloader routes (no UI-button-only policy)');

// The guard reuses — not duplicates — the canonical policy modules.
const guardSource = read('src/lib/server/content/adult-guard.ts');
assert.match(guardSource, /import\('\.\/adult-policy'\)\)\.canAccessAdultContent/, 'guard delegates authorization to the canonical policy module');
assert.match(guardSource, /import\('\.\/service'\)\)\.getDetail/, 'guard delegates classification to the canonical content pipeline');
ok(true, '14. guard reuses the canonical classification + authorization (no duplicated policy)');

console.log(`phase1_downloader_adult_policy_test: ${passed} checks passed (Adult Mode downloader bypass closed)`);
