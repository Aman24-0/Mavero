/**
 * 2026-10-16 final round — upload-workflow REMOVAL completion regression.
 *
 * Reported defect: the upload subsystem and its API routes were removed,
 * but AdminOpsJobs.svelte still rendered Retry/Cancel buttons that
 * POSTed to the deleted endpoints
 * (/api/admin/media/upload/{id}/retry | /cancel) — dead buttons invoking
 * nonexistent routes. The same class of defect existed in
 * AdminOpsAttention.svelte (Retry) and the dead upload/legacy UI
 * components survived as unreachable code.
 *
 * Contract under test:
 *   §A  no ACTIVE code invokes a removed upload endpoint (fetch calls)
 *   §B  the retired upload/legacy UI components are GONE (dead code
 *       deleted, not allowlisted)
 *   §C  every remaining Operations action maps to a LIVE route
 *   §D  the dead Retry/Cancel handlers + canRetry capability are gone
 *   §E  no upload navigation / route files survive unintentionally
 *   §F  the manual-link / bulk-link / bulk-unlink / missing-media
 *       workflows remain INTACT (removal did not eat valid functionality)
 *   §G  documentation matches the implemented architecture
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_upload_removal_completion_test.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.resolve(root, rel), 'utf8');
const exists = (rel: string) => existsSync(path.resolve(root, rel));

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

// Walk src/ collecting .ts/.svelte files (for the active-call scan).
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|svelte)$/.test(entry)) yield full;
  }
}

console.log('\n2026-10-16 — upload-workflow removal completion\n');

// ===========================================================================
console.log('§A — no ACTIVE code invokes a removed upload endpoint');
// ===========================================================================
{
  const offenders: string[] = [];
  for (const file of walk(path.join(root, 'src'))) {
    const src = readFileSync(file, 'utf8');
    // Any FETCH to the removed upload routes is a dead button invoking a
    // nonexistent endpoint. (Comments that DOCUMENT the removal are fine —
    // they contain no fetch call.)
    if (/fetch\(\s*[`'"]\/api\/admin\/media\/upload/.test(src)) offenders.push(path.relative(root, file));
    // Links to the removed upload PAGE are equally dead.
    if (/href=["'`]\/admin\/media\/upload/.test(src)) offenders.push(path.relative(root, file) + ' (href)');
  }
  ok(offenders.length === 0, `A1. zero fetch/href references to removed upload routes in src/ (got ${offenders.join(', ')})`);
}

// ===========================================================================
console.log('§B — the retired upload/legacy UI components are GONE');
// ===========================================================================
{
  const gone = [
    'src/lib/components/admin2/AdminUploadFlow.svelte',
    'src/lib/components/admin2/AdminMediaDetailDrawer.svelte',
    'src/lib/components/admin2/AdminHostingAssets.svelte',
    'src/lib/components/admin2/AdminMediaTable.svelte',
    'src/lib/components/admin2/AdminLinkMediaModal.svelte',
  ];
  for (const rel of gone) {
    ok(!exists(rel), `B1. ${path.basename(rel)} deleted (retired upload / provider-inventory-picker / legacy asset-manager UI)`);
  }
  // No import statement resurrects them.
  const importers: string[] = [];
  for (const file of walk(path.join(root, 'src'))) {
    const src = readFileSync(file, 'utf8');
    if (/import\s+[^'"]*['"][^'"]*Admin(UploadFlow|MediaDetailDrawer|HostingAssets|MediaTable|LinkMediaModal)/.test(src)) {
      importers.push(path.relative(root, file));
    }
  }
  ok(importers.length === 0, `B2. zero importers of the deleted components (got ${importers.join(', ')})`);
}

// ===========================================================================
console.log('§C — every remaining Operations action maps to a LIVE route');
// ===========================================================================
{
  const jobs = read('src/lib/components/admin2/AdminOpsJobs.svelte');
  const attention = read('src/lib/components/admin2/AdminOpsAttention.svelte');
  // The only action fetch in Ops Jobs/Attention: Reconcile.
  // Backtick fetch calls in the components: the Jobs/Attention list reads
  // (/api/admin/operations/*) + the reconcile action. Every MUTATING action
  // maps to a live route; nothing points at a removed upload route.
  const jobFetches = [...jobs.matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
  ok(jobFetches.every((u) => u.startsWith('/api/admin/operations/jobs') || u.startsWith('/api/admin/media/assets/')), `C1. Jobs fetches = list read + reconcile only (got ${jobFetches.join(', ')})`);
  const attentionFetches = [...attention.matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
  ok(attentionFetches.every((u) => u.startsWith('/api/admin/operations/attention') || u.startsWith('/api/admin/media/assets/')), `C2. Attention fetches = list read + reconcile only (got ${attentionFetches.join(', ')})`);
  // The reconcile route handler actually exists.
  ok(exists('src/routes/api/admin/media/assets/[id]/reconcile/+server.ts'), 'C3. /api/admin/media/assets/[id]/reconcile route exists (action backed)');
  ok(/export const POST/.test(read('src/routes/api/admin/media/assets/[id]/reconcile/+server.ts')), 'C4. the reconcile route is a POST handler');
  // Navigation links in the drawer/attention rows.
  ok(/\/admin\/media\/library\?mediaItem=/.test(jobs), 'C5. Open media links to the live library page');
  ok(!/href=["'`][^"'`]*\/admin\/media\/upload/.test(jobs) && !/href=["'`][^"'`]*\/admin\/media\/upload/.test(attention), 'C6. no dead upload-page links remain');
}

// ===========================================================================
console.log('§D — the dead Retry/Cancel handlers + canRetry capability are gone');
// ===========================================================================
{
  const jobs = read('src/lib/components/admin2/AdminOpsJobs.svelte');
  const attention = read('src/lib/components/admin2/AdminOpsAttention.svelte');
  ok(!/retryJob/.test(jobs) && !/cancelJob/.test(jobs), 'D1. AdminOpsJobs holds no retryJob/cancelJob handlers');
  ok(!/function retryItem/.test(attention), 'D2. AdminOpsAttention holds no retryItem handler');
  // D3/D4 pin the ACTION wiring, not the word "Retry" (the list-load
  // retry buttons and the historical type filter legitimately keep the
  // label — they never touch a removed endpoint).
  ok(!/onclick=\{\(\) => retryJob\(/.test(jobs) && !/onclick=\{\(\) => cancelJob\(/.test(jobs), 'D3. Jobs drawer wires no retryJob/cancelJob actions');
  ok(!/onclick=\{\(\) => retryItem\(/.test(attention) && !/\{#if item\.canRetry\}/.test(attention), 'D4. Attention items wire no retryItem action and no canRetry branch');
  // The server no longer advertises the dead capability.
  const types = read('src/lib/shared/operations-types.ts');
  ok(!/canRetry: boolean;/.test(types), 'D5. AttentionItem.canRetry removed from the shared type');
  const opsService = read('src/lib/server/hosting/operations/service.ts');
  ok(!/canRetry:/.test(opsService), 'D6. OperationsService no longer maps canRetry');
  // Historical upload rows still render as records (the table is kept for
  // production data — documented, not a live workflow).
  ok(/media_upload_operations/.test(opsService), 'D7. the unified Jobs stream still READS the historical upload rows');
  ok(/upload pipeline is retired/.test(jobs), 'D8. upload-origin rows are labeled historical records');
}

// ===========================================================================
console.log('§E — no upload navigation or live upload route survives');
// ===========================================================================
{
  const shell = read('src/lib/components/admin2/AdminAppShell.svelte');
  ok(!/\/admin\/media\/upload/.test(shell), 'E1. the admin nav carries no upload destination');
  ok(!exists('src/routes/admin/media/upload'), 'E2. /admin/media/upload page route is gone');
  ok(!exists('src/routes/api/admin/media/upload'), 'E3. /api/admin/media/upload/* routes are gone');
  ok(!exists('src/lib/server/hosting/upload'), 'E4. the UploadService module is gone');
  // Intentionally RETAINED (documented, valid, not upload workflow):
  ok(exists('src/routes/api/admin/media/missing/link/+server.ts'), 'E5. RETAINED: /api/admin/media/missing/link (valid canonical link endpoint)');
  ok(exists('src/routes/api/admin/hosting/providers/[adapterId]/files/+server.ts'), 'E6. RETAINED: provider inventory read (valid adapter files listing)');
  ok(exists('src/routes/api/admin/media/assets/link/+server.ts'), 'E7. RETAINED: direct-UUID link endpoint (valid)');
}

// ===========================================================================
console.log('§F — the manual linking workflows remain INTACT');
// ===========================================================================
{
  ok(exists('src/lib/components/admin2/AdminAddFileWizard.svelte'), 'F1. the shared Add File wizard exists');
  ok(exists('src/lib/components/admin2/AdminMediaList.svelte'), 'F2. AdminMediaList exists');
  ok(exists('src/lib/components/admin2/AdminEpisodeSheet.svelte'), 'F3. AdminEpisodeSheet exists');
  ok(/export const POST/.test(read('src/routes/api/admin/media/manual-link/+server.ts')), 'F4. manual-link POST (create/update) intact');
  ok(/export const DELETE/.test(read('src/routes/api/admin/media/manual-link/+server.ts')), 'F5. manual-link DELETE (unlink) intact');
  ok(/export const POST/.test(read('src/routes/api/admin/media/bulk-link/+server.ts')), 'F6. bulk-link POST intact');
  ok(/export const POST/.test(read('src/routes/api/admin/media/bulk-unlink/+server.ts')), 'F7. bulk-unlink POST intact (selected episodes)');
  ok(/requireAdmin/.test(read('src/routes/api/admin/media/bulk-unlink/+server.ts')), 'F8. bulk-unlink keeps the admin authorization gate');
  const missing = read('src/routes/admin/media/missing/+page.svelte');
  ok(/AdminAddFileWizard/.test(missing), 'F9. Missing Media uses the shared wizard');
  ok(!/AdminLinkMediaModal/.test(missing.replace(/AdminLinkMediaModal \(which was[^)]*\)/g, '')), 'F10. Missing Media imports no inventory-picker modal');
  // Reference normalization contracts survive.
  const contract = read('src/lib/server/hosting/media/manual-link-contract.ts');
  ok(/vidara\.to\/e\//.test(contract) || /normalize/.test(contract), 'F11. provider reference normalization contract intact');
  ok(/recordMediaOperation/.test(contract), 'F12. link operations keep the audit writer');
}

// ===========================================================================
console.log('§G — documentation matches the implemented architecture');
// ===========================================================================
{
  const plan = read('PLAN.md');
  ok(/upload workflow REMOVED/.test(plan), 'G1. PLAN.md title states the upload removal');
  ok(/no media upload\/import workflow/.test(plan), 'G2. PLAN.md describes the manual-reference-only architecture');
  ok(!/\/admin\/media\/upload` — Upload\/Import wizard/.test(plan), 'G3. PLAN.md no longer lists the upload page as a live route');
  ok(/Retained INTENTIONALLY/.test(plan), 'G4. PLAN.md documents what was intentionally retained (tables, valid endpoints)');
  ok(/zero-link/.test(plan) || /Zero/.test(plan) || /ZERO-LINK/.test(plan), 'G5. PLAN.md mentions the zero-link library rule');
  const worklog = read('WORKLOG.md');
  ok(/2026-10-16/.test(worklog), 'G6. WORKLOG.md records this round');
}

console.log(`\nmav_upload_removal_completion_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
