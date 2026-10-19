/**
 * MAV-FOCUSED — Phase 7 contract test — resolver + fallback + final handoff.
 *
 * Verifies the resolver's error-isolation contract (Phase 7 §18 fix),
 * ready-only asset eligibility, canonical identity matching, and the
 * complete playback resolution chain.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_phase7_resolver_contract_test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  FAIL - ${label}${extra ? ' ' + extra : ''}`); }
}

console.log('\n§1 — Resolver error-isolation contract (Phase 7 §18 fix)');

const adapter = src('src/lib/server/resolver/mavero-hosted.ts');
const identifiers = src('src/lib/server/resolver/identifiers.ts');

// The fix: ResolverError subclasses are re-thrown, not swallowed.
ok(/if \(error instanceof ResolverError\) throw error/.test(adapter), '1a. ResolverError instances re-thrown (not swallowed)');
ok(/DB \/ network \/ Supabase-client failures return null/.test(adapter), '1b. DB/network errors still return null (fallback continues)');
ok(/import.*ResolverError.*from.*errors/.test(adapter), '1c. ResolverError imported from errors module');

// The old catch-all is gone.
ok(!/catch \{/.test(adapter.replace(/\/\/[^\n]*/g, '')), '1d. no bare catch block (old swallowed-all pattern removed)');

console.log('\n§2 — Ready-only asset eligibility (dual-gate)');

ok(/\.eq\('status', 'ready'\)/.test(adapter), '2a. resolver gates on status=ready');
ok(/\.eq\('mavero_status', 'available'\)/.test(adapter), '2b. resolver gates on mavero_status=available');
ok(/\.eq\('media_item_id', mediaItemId\)/.test(adapter), '2c. resolver scopes by media_item_id (UUID FK)');
ok(/\.eq\('provider_source_id', context\.config\.source\.id\)/.test(adapter), '2d. resolver scopes by provider_source_id');

console.log('\n§3 — Canonical identity matching (no cross-episode collision)');

ok(/movieCanonicalKey/.test(adapter), '3a. uses movieCanonicalKey for movies');
ok(/seriesCanonicalKey/.test(adapter), '3b. uses seriesCanonicalKey for series');
ok(/episodeCanonicalKey/.test(adapter), '3c. uses episodeCanonicalKey for episodes (exact season+episode)');
// Deep-audit Section 3: legacy 'anime' mediaType is normalized to the
// series contract at the parse boundary (parseResolverRequest) and the
// adapter's canonical-key derivation treats series-like requests
// ('series' + fail-safe 'anime') uniformly — the previous hard 'anime →
// null' branch was the second half of the INVALID_REQUEST root cause.
// Unknown media types still fail safe to null.
ok(/unknown — fail safe/.test(adapter) && /return null/.test(adapter), '3d. unknown mediaType → null (fail safe; legacy anime normalized at the parse boundary)');
ok(/=== 'anime' \? 'series'/.test(identifiers), '3d-2. parseResolverRequest normalizes legacy anime mediaType to the series provider contract');

console.log('\n§4 — Embed type (not direct)');

ok(/type:\s*'embed'/.test(adapter), '4a. resolver returns type=embed (NOT direct)');
ok(/validatePlaybackUrl/.test(adapter), '4b. resolver validates URL via validatePlaybackUrl');

console.log('\n§5 — SSRF + allowlist enforcement');

ok(/effectiveEmbedOrigins/.test(adapter), '5a. resolver checks effective embed origins');
ok(/effectiveAllowDynamic/.test(adapter), '5b. resolver checks dynamic-origins flag');

const safeUrl = src('src/lib/server/resolver/safe-url.ts');
ok(/embedProtocols = new Set\(\['https:'\]\)/.test(safeUrl), '5c. embed protocols = HTTPS only');
ok(/url\.username \|\| url\.password/.test(safeUrl), '5d. credentials rejected');
ok(/isPrivateHostname/.test(safeUrl), '5e. private hostname check enforced');

console.log('\n§6 — Fallback pipeline');

const service = src('src/lib/server/resolver/service.ts');
ok(/DEFAULT_FALLBACK_MAX_ATTEMPTS/.test(service), '6a. fallback has max-attempts limit');
ok(/loadTrustedFallbackCandidates/.test(service), '6b. fallback loads trusted candidates');
ok(/rankProviderSourceList/.test(service), '6c. fallback ranks candidates');
ok(/alreadyAttemptedSourceIds/.test(service), '6d. fallback tracks already-attempted sources (no re-attempt)');
ok(/deadline\.guard/.test(service), '6e. fallback guarded by deadline (prevents indefinite attempts)');
ok(/deadline\.dispose\(\)/.test(service), '6f. deadline disposed in finally block');

console.log('\n§7 — Eligibility gates (ranking.ts)');

const ranking = src('src/lib/server/resolver/ranking.ts');
ok(/config\.provider\.enabled/.test(ranking), '7a. provider.enabled gate');
ok(/config\.source\.enabled/.test(ranking), '7b. source.enabled gate');
ok(/visibility !== .public./.test(ranking) || /visibility === .public./.test(ranking), '7c. source.visibility=public gate');
ok(/lifecycleAllows/.test(ranking), '7d. lifecycleAllows gate (active or experimental+allow_experimental_playback)');
ok(/supportsMediaType/.test(ranking), '7e. supportsMediaType gate');

console.log('\n§8 — PlaybackManager stale-response guards');

const pm = src('src/lib/client/player/PlaybackManager.ts');
ok(/sessionId/.test(pm), '8a. sessionId guard exists');
ok(/abortController/.test(pm), '8b. abortController exists');
ok(/sessionId !== this\.sessionId/.test(pm), '8c. stale session check after await');
ok(/timedOut/.test(pm), '8d. timeout distinction (timedOut flag)');

console.log('\n§9 — Watch page source selection');

const watchPage = src('src/routes/watch/[type]/[id]/+page.svelte');
ok(/selectedSourceId/.test(watchPage), '9a. selectedSourceId derived');
ok(/prepareSource/.test(watchPage), '9b. prepareSource function exists');
ok(/handleSourceChange/.test(watchPage), '9c. handleSourceChange exists (manual switch)');
ok(/allowFallback/.test(watchPage), '9d. allowFallback parameter used');

console.log('\n§10 — PlayerShell SSR fix preserved (Phase 5)');

const playerShell = src('src/lib/components/player/PlayerShell.svelte');
ok(/browser && document\.pictureInPictureElement/.test(playerShell), '10a. PlayerShell guards document access with browser check');

console.log('\n§11 — Manual-link workflow preserved');

const manualLink = src('src/routes/api/admin/media/manual-link/+server.ts');
ok(/requireAdmin/.test(manualLink), '11a. requireAdmin enforced on POST');
ok(/provider !== 'vidara' && provider !== 'abyss'/.test(manualLink), '11b. provider validated (vidara/abyss only)');
ok(/normalizeReference/.test(manualLink), '11c. reference normalized before persistence');
ok(/PROVIDER_ASSET_ID_MAX\s*=\s*200/.test(src('src/lib/server/hosting/media/manual-link-contract.ts')), '11d. provider_asset_id max=200 (matches DB CHECK; constant lives in the shared manual-link contract since faa0079)');

// No provider deletion.
const noComments = manualLink.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/\bawait\s+\w+\.deleteAsset\(/.test(noComments), '11e. no deleteAsset() call (Mavero-side only)');
ok(!/\bawait\s+adapter\.delete/.test(noComments), '11f. no adapter.delete() call');

console.log('\n§12 — FK-safe audit logging preserved');

ok(/FK constraint on/.test(manualLink), '12a. FK-safe unlink audit documented');

console.log('\n§13 — Public routes preserved (Phase 5)');

ok(existsSync(resolve(root, 'src/routes/tv-show/[id]/+page.server.ts')), '13a. /tv-show/[id] route exists');
ok(existsSync(resolve(root, 'src/routes/anime-series/[id]/+page.server.ts')), '13b. /anime-series/[id] route exists');
ok(existsSync(resolve(root, 'src/routes/anime-movie/[id]/+page.server.ts')), '13c. /anime-movie/[id] route exists');

const routes = src('src/lib/shared/routes.ts');
ok(/detailHref/.test(routes), '13d. shared route helper detailHref exists');
ok(/watchHref/.test(routes), '13e. shared route helper watchHref exists');

console.log(`\nmav_phase7_resolver_contract_test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
if (failed > 0) process.exit(1);

function existsSync(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}
