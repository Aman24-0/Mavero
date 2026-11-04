/**
 * Admin 2.0 — Phase 3 — Final Consistency / Deferred Issue Fixes
 *
 * Substantive coverage of all Phase 3 changes:
 *   A. (RETIRED, Phase 6) Analytics mobile card lists — dashboard deleted
 *      with the Umami Cloud migration
 *   B. (RETIRED, Phase 6) Legacy /admin/users/* migration — routes deleted
 *      with the Umami Cloud migration
 *   C. Media Library mobile hierarchy (trigger button + bottom sheet reusing AdminMediaTree)
 *   D. Admin Overview caching (deferral documented — no code changes)
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const libraryPage = read('src/routes/admin/media/library/+page.svelte');

// Phase 6 (Umami Cloud migration): the analytics dashboard page and the
// legacy /admin/users/* routes were DELETED — sections A (analytics
// mobile card lists) and B (legacy users migration) are retired. Umami
// Cloud serves the analytics surfaces now.
// ============================================================
// C. Media Library mobile experience — [final remediation] the Phase 3
// content-hierarchy tree UI (mobile hierarchy sheet) was SUPERSEDED by the
// asset-centric file-manager consolidation: the Media Library now renders
// AdminHostingAssets with the Mavero-native AdminFilterSheet on mobile.
// ============================================================

// C1. The single file manager is the library page's content.
assert.match(libraryPage, /AdminHostingAssets/, 'C1a. library page renders AdminHostingAssets (single file manager)');
assert.doesNotMatch(libraryPage, /library-hierarchy-mobile-btn/, 'C1b. hierarchy tree button removed with the tree UI');
ok('C1. Media Library renders the asset-centric file manager');

// C2. Mobile filter sheet — AdminFilterSheet (chip-based, dialog semantics).
const adminFilterSheet = read('src/lib/components/admin2/AdminFilterSheet.svelte');
assert.match(adminFilterSheet, /role="dialog"[\s\S]*aria-modal="true"/, 'C2a. filter sheet has dialog ARIA semantics');
assert.match(adminFilterSheet, /aria-labelledby="a2-fs-title"/, 'C2b. filter sheet has accessible title');
ok('C2. Mobile filter sheet has dialog ARIA semantics (AdminFilterSheet)');

// C3. Sheet structure (overlay + chips + Apply/Clear).
assert.match(adminFilterSheet, /a2-fs-backdrop/, 'C3a. sheet overlay rendered');
assert.match(adminFilterSheet, /class="a2-fs-chip"/, 'C3b. chip options rendered');
assert.match(adminFilterSheet, /a2-fs-apply/, 'C3c. Apply button rendered');
assert.match(adminFilterSheet, /a2-fs-clear/, 'C3d. Clear button rendered');
ok('C3. Filter sheet structure (overlay + chips + Apply/Clear)');

// C4. Sheet CSS — fixed overlay, touch targets, safe area, reduced motion.
assert.match(adminFilterSheet, /a2-fs-layer \{[\s\S]*?position: fixed[\s\S]*?inset: 0/, 'C4a. sheet overlay is fixed full-screen');
assert.match(adminFilterSheet, /a2-fs-close \{[\s\S]*?width: 34px/, 'C4b. sheet close button touch target');
assert.match(adminFilterSheet, /safe-area-inset-bottom/, 'C4c. sheet has safe-area-inset-bottom');
assert.match(adminFilterSheet, /prefers-reduced-motion: reduce/, 'C4d. sheet respects reduced-motion');
ok('C4. Filter sheet CSS (fixed overlay, touch targets, safe-area, reduced motion)');

// C5. The old tree components remain archived (not rendered by the library).
assert.doesNotMatch(libraryPage, /<AdminMediaTree/, 'C5a. AdminMediaTree no longer rendered by the library page');
ok('C5. Tree UI not rendered by the canonical library');

// ============================================================
// D. Admin Overview caching — deferral documented
// ============================================================

// D1. Overview server unchanged (no caching added)
const overviewRouteServer = read('src/routes/admin/+page.server.ts');
assert.match(overviewRouteServer, /getAdminOverview/, 'D1a. Overview server still calls getAdminOverview (no cache layer added)');
assert.match(overviewRouteServer, /getDownloadersAdminOverview/, 'D1b. Overview server still calls getDownloadersAdminOverview');
assert.match(overviewRouteServer, /getAddonsAdminOverview/, 'D1c. Overview server still calls getAddonsAdminOverview');
assert.doesNotMatch(overviewRouteServer, /getOrSet|cache\./, 'D1d. Overview server does NOT use cache (Phase 3 audit deferred caching)');
ok('D1. Admin Overview caching deferred (no cache layer added — Phase 3 audit determined it is unsafe due to addon registry lacking invalidation signal)');

// D2. content/cache.ts unchanged (still unused by admin)
const cacheModule = read('src/lib/server/content/cache.ts');
assert.match(cacheModule, /export async function getOrSet/, 'D2a. cache.ts still exports getOrSet');
assert.match(cacheModule, /export function invalidate/, 'D2b. cache.ts still exports invalidate');
ok('D2. content/cache.ts unchanged (existing infrastructure preserved for future use)');

console.log(`\nAdmin 2.0 Phase 3 tests passed (${passed} check groups).`);
