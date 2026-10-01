/**
 * Media Detail Drawer — Management UI Regression Tests
 *
 * Verifies the state-aware provider asset management actions:
 *   1. Linked + available assets show Reconcile + Detach buttons
 *   2. Detached (mavero_status='missing') assets show Reactivate button
 *   3. Not-linked providers show Link existing file button
 *   4. Detach confirmation dialog exists and states remote file NOT deleted
 *   5. Reactivate API endpoint exists
 *   6. All actions use existing endpoints (no duplicate service logic)
 *   7. Loading state prevents double-submit (disabled during action)
 *   8. Action error/success feedback rendered inline
 *   9. Mobile responsive CSS for action buttons
 *   10. Provider still resolved as VIDARA/ABYSS (no UNKNOWN)
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const drawer = read('src/lib/components/admin2/AdminMediaDetailDrawer.svelte');

// ============================================================
// 1. Linked + available assets show Reconcile + Detach
// ============================================================

assert.match(drawer, /mavero_status.*===.*'available'.*Reconcile|Reconcile[\s\S]*Detach/, '1a. Linked available assets show Reconcile + Detach buttons');
assert.match(drawer, /onclick=\{\(\) => reconcileAsset\(asset\.id\)\}/, '1b. Reconcile button calls reconcileAsset(asset.id)');
assert.match(drawer, /confirmDialog = \{ assetId: asset\.id, action: 'detach' \}/, '1c. Detach button opens confirmation dialog (not immediate action)');
ok('1. Linked + available: Reconcile + Detach buttons present');

// ============================================================
// 2. Detached assets show Reactivate
// ============================================================

assert.match(drawer, /mavero_status.*===.*'missing'[\s\S]*Reactivate/, '2a. Detached (mavero_status=missing) assets show Reactivate button');
assert.match(drawer, /onclick=\{\(\) => reactivateAsset\(asset\.id\)\}/, '2b. Reactivate button calls reactivateAsset(asset.id)');
ok('2. Detached: Reactivate button present');

// ============================================================
// 3. Not-linked providers show Link existing file
// ============================================================

assert.match(drawer, /Link existing file/, '3a. Not-linked providers show "Link existing file" button');
assert.match(drawer, /openLinkSheet\(block\.adapterId, block\.sourceId, block\.label\)/, '3b. Link button calls openLinkSheet with correct params');
ok('3. Not-linked: Link existing file button present');

// ============================================================
// 4. Detach confirmation dialog
// ============================================================

assert.match(drawer, /Detach provider asset\?/, '4a. Confirmation dialog has "Detach provider asset?" title');
assert.match(drawer, /remote provider file will NOT be deleted/i, '4b. Confirmation dialog explicitly states remote file NOT deleted');
assert.match(drawer, /a2-confirm-dialog/, '4c. Confirmation dialog has its own CSS class');
assert.match(drawer, /Cancel/, '4d. Confirmation dialog has Cancel button');
ok('4. Detach confirmation: explicit, states remote file preserved, has Cancel');

// ============================================================
// 5. Reactivate API endpoint exists
// ============================================================

assert.ok(existsSync(new URL('../src/routes/api/admin/media/assets/[id]/reactivate/+server.ts', import.meta.url)), '5a. Reactivate API endpoint file exists');
const reactivateEndpoint = read('src/routes/api/admin/media/assets/[id]/reactivate/+server.ts');
assert.match(reactivateEndpoint, /requireAdmin/, '5b. Reactivate endpoint calls requireAdmin');
assert.match(reactivateEndpoint, /reactivateAsset/, '5c. Reactivate endpoint calls management.reactivateAsset');
ok('5. Reactivate API endpoint: admin-only, delegates to existing service');

// ============================================================
// 6. All actions use existing endpoints (no duplicate service logic)
// ============================================================

assert.match(drawer, /\/api\/admin\/media\/assets\/\$\{assetId\}\/detach/, '6a. Detach calls existing /api/admin/media/assets/:id/detach endpoint');
assert.match(drawer, /\/api\/admin\/media\/assets\/\$\{assetId\}\/reactivate/, '6b. Reactivate calls existing /api/admin/media/assets/:id/reactivate endpoint');
assert.match(drawer, /\/api\/admin\/media\/assets\/\$\{assetId\}\/reconcile/, '6c. Reconcile calls existing /api/admin/media/assets/:id/reconcile endpoint');
assert.match(drawer, /\/api\/admin\/media\/assets\/link/, '6d. Link existing file calls existing /api/admin/media/assets/link endpoint');
ok('6. All actions reuse existing API endpoints (no duplicate service logic in component)');

// ============================================================
// 7. Loading state prevents double-submit
// ============================================================

assert.match(drawer, /disabled=\{actionLoading !== null\}/, '7a. Action buttons disabled while any action is loading');
assert.match(drawer, /isActionLoading\(asset\.id/, '7b. Per-asset per-action loading state tracked');
ok('7. Loading state: disabled during action, prevents double-submit');

// ============================================================
// 8. Action error/success feedback rendered inline
// ============================================================

assert.match(drawer, /actionError[\s\S]*role="alert"/, '8a. Action errors rendered with role=alert');
assert.match(drawer, /actionSuccess[\s\S]*role="status"/, '8b. Action success rendered with role=status');
assert.match(drawer, /a2-drawer-action-error/, '8c. Action error has CSS class');
assert.match(drawer, /a2-drawer-action-success-msg/, '8d. Action success has CSS class');
ok('8. Action feedback: inline error (role=alert) + success (role=status) rendered');

// ============================================================
// 9. Mobile responsive CSS
// ============================================================

assert.match(drawer, /@media \(max-width: 640px\)[\s\S]*provider-asset-actions.*flex-direction: column/, '9a. Mobile: provider action buttons stack vertically');
assert.match(drawer, /@media \(max-width: 640px\)[\s\S]*a2-confirm-actions.*flex-direction: column-reverse/, '9b. Mobile: confirmation dialog actions stack vertically');
assert.match(drawer, /@media \(max-width: 640px\)[\s\S]*a2-confirm-dialog.*max-width: 100%/, '9c. Mobile: confirmation dialog full width');
ok('9. Mobile responsive: action buttons stack, confirmation dialog full width');

// ============================================================
// 10. Provider resolution — no UNKNOWN for valid relationships
// ============================================================

// Phase C audit fix: the drawer now uses resolveAdapter() (shared helper)
// and resolves labels from the resolved adapter ID. The old pattern used
// adapterIdForSource directly; the new pattern uses resolveAdapter which
// wraps the shared adapterIdForSource helper.
assert.match(drawer, /resolved === 'vidara' \? 'Vidara'[\s\S]*?resolved === 'abyss' \? 'Abyss'/, '10a. Provider labels resolved from resolved adapterId (not from source name fallback)');
assert.match(drawer, /import.*adapterIdForSource, sourceNameForId.*from '\$lib\/shared\/hosting-source-helpers'/, '10b. Drawer imports shared helpers (no duplicated logic)');
// Note: provider-block-name CSS has text-transform:uppercase which renders
// "Vidara" as "VIDARA" and "Abyss" as "ABYSS" — this is the intended display
// format. The "UNKNOWN" issue only occurred when adapterIdForSource returned
// null (source not in hostingSources). With the canonical resolver + no
// enabled filter, the source is always found, so the label is always
// "Vidara" or "Abyss". When the source genuinely can't be resolved, the
// drawer now shows "Unresolved" with an error notice instead of "UNKNOWN".
assert.match(drawer, /unresolved/, '10c. Drawer surfaces Unresolved state for genuinely unresolvable sources (not misleading UNKNOWN)');
ok('10. Provider resolution: labels from resolved adapterId (Vidara/Abyss), Unresolved for unknown sources — never misleading UNKNOWN');

// ============================================================
// 11. State refresh after action (invalidateAll)
// ============================================================

assert.match(drawer, /await invalidateAll\(\)/, '11a. All actions call invalidateAll() after success to refresh state');
ok('11. State refresh: invalidateAll() called after each successful action');

// ============================================================
// 12. Vidara embed URL not touched
// ============================================================

const vidaraNormalize = read('src/lib/server/hosting/vidara/normalize.ts');
assert.match(vidaraNormalize, /vidara\.to\/e\//, '12a. Vidara normalize still uses vidara.to/e/ embed URL');
ok('12. Vidara embed URL: still vidara.to/e/ (no regression)');

console.log(`\nMedia detail drawer management UI tests passed (${passed} check groups).`);
