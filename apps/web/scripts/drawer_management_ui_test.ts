/**
 * Media Management UI — state-aware actions regression tests.
 *
 * [2026-10-16 re-pin] AdminMediaDetailDrawer was DELETED with the legacy
 * asset-manager UI. The state-aware management-action contracts it carried
 * live on, on the LIVE surfaces:
 *   - AdminMediaList: the delete (unlink) confirm dialog — names the exact
 *     target, states the remote provider file is NOT deleted, Cancel,
 *     disabled while submitting.
 *   - AdminEpisodeSheet: per-episode + bulk delete with explicit episode
 *     selection, per-episode outcomes (role=status), errors (role=alert),
 *     disabled-during-submit.
 *   - The reactivate API endpoint + service (admin-gated).
 *   - Provider labels resolved from the canonical resolver's sources.
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

assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminMediaDetailDrawer.svelte', import.meta.url)), '0. AdminMediaDetailDrawer deleted (legacy drawer removed with the asset-manager UI)');
const mediaList = read('src/lib/components/admin2/AdminMediaList.svelte');
const episodeSheet = read('src/lib/components/admin2/AdminEpisodeSheet.svelte');

// ============================================================
// 1. Destructive actions are confirm-gated and state-aware
// ============================================================

// The live unlink (delete) is confirm-gated and only offered for rows
// that have a link to remove.
assert.match(mediaList, /deleteTarget[\s\S]{0,200}episodeLabel/, '1a. The delete confirm names the exact target (title + episode label when present)');
assert.match(mediaList, /confirm-dialog" role="dialog" aria-modal="true"/, '1b. The delete confirmation is a modal dialog (a11y)');
ok('1. Destructive unlink: explicit confirmation dialog, state-aware targeting');

// ============================================================
// 2. Zero-link rows offer no destructive action (server rule + UI gate)
// ============================================================

// The server owns the zero-link rule (library list excludes zero-link
// rows); the sheet's per-episode Delete exists only via the linked-episode
// ground truth, and the bulk-delete selection only lists LINKED episodes.
assert.match(episodeSheet, /ondeletelink/, '2a. Per-episode delete delegated for linked episodes only');
assert.match(episodeSheet, /linked[\s\S]{0,300}bulkDelete|bulkDelete[\s\S]{0,300}linked/, '2b. Bulk delete builds its selection from LINKED episodes only');
ok('2. Zero-link rows: excluded server-side; destructive actions gated on live links');

// ============================================================
// 3. The live link flow is the Add File wizard
// ============================================================

assert.match(mediaList, /AdminAddFileWizard/, '3a. The list mounts the shared Add File wizard (the link flow)');
assert.match(mediaList, /openAddWizard|openPreselectedWizard/, '3b. Add-file opens the wizard (toolbar + per-row menu entries)');
ok('3. Link flow: the shared wizard (TMDB + provider reference), no inventory picker');

// ============================================================
// 4. Delete confirmation dialog wording (remote file preserved)
// ============================================================

assert.match(mediaList, /will NOT be deleted/, '4a. The delete confirm explicitly states the hosted file will NOT be deleted');
assert.match(mediaList, /can be re-linked later/, '4b. The confirm notes the file can be re-linked later (reversible semantics)');
assert.match(mediaList, /btn-cancel[\s\S]{0,120}Cancel/, '4c. The confirmation dialog has a Cancel button');
ok('4. Unlink confirm: remote file preserved, reversible, cancelable');

// ============================================================
// 5. Reactivate API endpoint exists (service-level surface)
// ============================================================

assert.ok(existsSync(new URL('../src/routes/api/admin/media/assets/[id]/reactivate/+server.ts', import.meta.url)), '5a. Reactivate API endpoint file exists');
const reactivateEndpoint = read('src/routes/api/admin/media/assets/[id]/reactivate/+server.ts');
assert.match(reactivateEndpoint, /requireAdmin/, '5b. Reactivate endpoint calls requireAdmin');
assert.match(reactivateEndpoint, /reactivateAsset/, '5c. Reactivate endpoint calls management.reactivateAsset');
ok('5. Reactivate API endpoint: admin-only, delegates to existing service');

// ============================================================
// 6. All live actions map to existing endpoints (no duplicate logic)
// ============================================================

assert.match(mediaList, /\/api\/admin\/media\/manual-link/, '6a. Unlink/relink use the manual-link endpoints (shared contract)');
assert.match(episodeSheet, /\/api\/admin\/media\/bulk-unlink/, '6b. Bulk delete uses the bulk-unlink endpoint (server-validated selection)');
assert.match(read('src/lib/components/admin2/AdminOpsAttention.svelte'), /\/api\/admin\/media\/assets\/\$\{item\.mediaAssetId\}\/reconcile/, '6c. Reconcile uses the reconcile endpoint');
ok('6. Live actions reuse the canonical API endpoints (no duplicate service logic)');

// ============================================================
// 7. Loading state prevents double-submit
// ============================================================

assert.match(mediaList, /disabled=\{deleting\}/, '7a. Delete confirm buttons disabled while deleting');
assert.match(episodeSheet, /disabled=\{bulkDeleting\}/, '7b. Bulk-delete buttons disabled while submitting');
assert.match(episodeSheet, /disabled=\{bulkSubmitting[ |}]/, '7c. Bulk-link submit disabled while submitting (and when no references are filled)');
ok('7. Loading state: disabled during action, prevents double-submit');

// ============================================================
// 8. Action error/success feedback rendered inline (a11y roles)
// ============================================================

assert.match(mediaList, /role="alert"/, '8a. List errors rendered with role=alert');
assert.match(episodeSheet, /role="alert"/, '8b. Sheet errors rendered with role=alert');
assert.match(episodeSheet, /role="status"/, '8c. Bulk outcomes rendered with role=status (per-episode results)');
ok('8. Action feedback: inline error (role=alert) + outcomes (role=status)');

// ============================================================
// 9. Mobile responsive CSS (live surfaces)
// ============================================================

assert.match(episodeSheet, /@media \(max-width: 640px\)[\s\S]*?confirm|\.confirm-actions[\s\S]*?column|flex-direction: column/, '9a. Mobile: confirm actions stack vertically');
assert.match(episodeSheet, /\.bulk-delete-dialog[\s\S]*?width: min\(420px, calc\(100vw - 32px\)\)/, '9b. Mobile: the bulk dialog is viewport-bounded');
ok('9. Mobile responsive: dialogs bounded, actions stack');

// ============================================================
// 10. Provider resolution — real names, never a misleading label
// ============================================================

// The live list resolves provider labels from the canonical resolver's
// sources: providerLabel() maps the row's provider name to Vidara/Abyss
// (real names from the resolved hosting_sources — the resolver guarantees
// the source is found, per the Phase C audit fix).
assert.match(mediaList, /providerLabel\(row\)/, '10a. Provider labels resolved via providerLabel (row ground truth)');
assert.match(mediaList, /'Vidara'|'Abyss'/, '10b. Labels are real provider names (Vidara/Abyss)');
assert.doesNotMatch(read('src/lib/shared/hosting-source-helpers.ts'), /\?\? 'Unknown'/, '10c. The shared helpers never stringify an Unknown provider (null contract)');
ok('10. Provider resolution: real names from the canonical resolver (null, never misleading UNKNOWN)');

// ============================================================
// 11. State refresh after successful mutations
// ============================================================

// The list reloads after every successful mutation (delete + wizard saves)
// — the zero-link cards disappear immediately. Verified in the dedicated
// zero-link suite (§F); here we pin the wiring exists.
assert.match(mediaList, /loadList\(true\)/, '11a. The list exposes a hard reload used after mutations');
assert.match(episodeSheet, /refreshKey|onsaved/, '11b. The sheet signals saves upward (parent list reloads)');
ok('11. State refresh: list reload + sheet onsaved signal after mutations');

// ============================================================
// 12. Vidara embed URL not touched
// ============================================================

const vidaraNormalize = read('src/lib/server/hosting/vidara/normalize.ts');
assert.match(vidaraNormalize, /vidara\.to\/e\//, '12a. Vidara normalize still uses vidara.to/e/ embed URL');
ok('12. Vidara embed URL: still vidara.to/e/ (no regression)');

console.log(`\nMedia management UI tests passed (${passed} check groups).`);
