/**
 * Task 3 regression (2026-10-15) — episode-sheet child dialog stacking.
 *
 * Reported production problem: opening the Add File / update-link wizard
 * or the delete confirmation FROM inside a series' episode sheet rendered
 * the child dialog BEHIND the sheet (z-index), forcing the user to close
 * the sheet first.
 *
 * Fix under test:
 *   - A shared dialog stack (dialog-stack.svelte.ts) gives every admin
 *     overlay a deterministic ownership order: only the TOPMOST dialog
 *     reacts to Escape; closing the child returns focus INTO the
 *     still-open sheet (season + scroll preserved).
 *   - Z-index ladder: sheet 92 < bulk-delete 93 < wizard/delete/filter 94
 *     < portaled menu 1000.
 *   - refreshKey wiring: wizard saves + delete confirmations that happen
 *     above the sheet refresh its linked rows WITHOUT closing it.
 *
 *   §A  dialog-stack unit semantics
 *   §B  z-index ladder (source contract)
 *   §C  Escape/backdrop ownership (only the topmost dialog closes)
 *   §D  child-above-sheet rendering (no clipping / no close-the-sheet-first)
 *   §E  refresh semantics (sheet stays open, linked rows reload)
 *   §F  focus management + a11y preserved
 *   §G  no leaks (listeners, duplicate handlers)
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_dialog_stacking_contract_test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  dialogOpened,
  dialogClosed,
  isTopDialog,
  openDialogCount,
  resetDialogStack,
} from '../src/lib/components/admin2/dialog-stack.svelte';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

const sheet = read('src/lib/components/admin2/AdminEpisodeSheet.svelte');
const wizard = read('src/lib/components/admin2/AdminAddFileWizard.svelte');
const mediaList = read('src/lib/components/admin2/AdminMediaList.svelte');
const stackModule = read('src/lib/components/admin2/dialog-stack.svelte.ts');

// ===========================================================================
console.log('§A — dialog-stack unit semantics');
// ===========================================================================
resetDialogStack();
ok(openDialogCount() === 0, 'A1a. empty stack starts at zero');
ok(!isTopDialog('a'), 'A1b. nothing is topmost on an empty stack');

dialogOpened('episode-sheet');
ok(isTopDialog('episode-sheet'), 'A2a. the only open dialog is topmost');

dialogOpened('wizard');
ok(isTopDialog('wizard'), 'A3a. the LATER-opened dialog owns topmost');
ok(!isTopDialog('episode-sheet'), 'A3b. the sheet below does NOT own Escape while the wizard is open');

dialogClosed('wizard');
ok(isTopDialog('episode-sheet'), 'A4a. closing the child returns ownership to the sheet');

// Repeated close is idempotent (destroy-time race safety).
dialogClosed('wizard');
ok(isTopDialog('episode-sheet'), 'A5a. double-close is a no-op');

// Out-of-order close (a mid-stack dialog closes) keeps the rest ordered.
dialogOpened('bulk-delete');
dialogOpened('wizard');
dialogClosed('bulk-delete');
ok(isTopDialog('wizard'), 'A6a. mid-stack close preserves the top order');
ok(!isTopDialog('episode-sheet'), 'A6b. sheet still not topmost (wizard remains above)');
resetDialogStack();
ok(openDialogCount() === 0, 'A7a. reset clears the stack (test isolation)');

// ===========================================================================
console.log('§B — z-index ladder');
// ===========================================================================
const sheetOverlayCss = sheet.match(/\.episode-sheet-overlay \{[^}]+\}/)?.[0] ?? '';
const bulkDeleteOverlayCss = sheet.match(/\.bulk-delete-overlay \{[^}]+\}/)?.[0] ?? '';
const wizardOverlayCss = wizard.match(/\.wizard-overlay \{[^}]+\}/)?.[0] ?? '';
const mediaListOverlayCss = mediaList.match(/\.wizard-overlay \{[^}]+\}/)?.[0] ?? '';
const menuCss = mediaList.match(/\.menu-dropdown\.floating \{[^}]+\}/)?.[0] ?? '';
ok(/z-index: 92/.test(sheetOverlayCss), 'B1a. episode sheet overlay z-index 92');
ok(/z-index: 93/.test(bulkDeleteOverlayCss), 'B1b. bulk-delete confirm z-index 93 (above the sheet, below the wizard)');
ok(/z-index: 94/.test(wizardOverlayCss), 'B1c. wizard overlay z-index 94 (immediately above the sheet)');
ok(/z-index: 94/.test(mediaListOverlayCss), 'B1d. delete-confirm + filter-sheet overlay z-index 94');
ok(/z-index: 1000/.test(menuCss), 'B1e. portaled action menu stays highest (1000)');
// The ladder is documented in ONE place (the stack module).
ok(/92/.test(stackModule) && /93/.test(stackModule) && /94/.test(stackModule), 'B2a. ladder documented centrally in dialog-stack.svelte');

// ===========================================================================
console.log('§C — Escape/backdrop ownership (topmost only)');
// ===========================================================================
ok(/isTopDialog\(SHEET_DIALOG_ID\)/.test(sheet), 'C1a. sheet Escape checks isTopDialog');
ok(/isTopDialog\(WIZARD_DIALOG_ID\)/.test(wizard), 'C1b. wizard Escape checks isTopDialog');
ok(/isTopDialog\(DELETE_DIALOG_ID\)/.test(mediaList), 'C1c. delete-confirm Escape checks isTopDialog');
ok(/isTopDialog\(FILTER_DIALOG_ID\)/.test(mediaList), 'C1d. filter-sheet Escape checks isTopDialog');
// Sheet routes Escape to the bulk-delete confirm while IT is open.
ok(/if \(bulkDeleteConfirmOpen\) \{\s*onBulkDeleteKeydown\(event\);/.test(sheet), 'C2a. the sheet routes Escape to its open child confirm');
ok(/dialogOpened\(SHEET_DIALOG_ID\)/.test(sheet) && /dialogClosed\(SHEET_DIALOG_ID\)/.test(sheet), 'C3a. sheet registers/deregisters in the stack');
ok(/dialogOpened\(WIZARD_DIALOG_ID\)/.test(wizard) && /dialogClosed\(WIZARD_DIALOG_ID\)/.test(wizard), 'C3b. wizard registers/deregisters in the stack');
ok(/dialogOpened\(BULK_DELETE_DIALOG_ID\)/.test(sheet) && /dialogClosed\(BULK_DELETE_DIALOG_ID\)/.test(sheet), 'C3c. bulk-delete confirm registers/deregisters');
// Backdrop clicks respect the in-flight guard (no closing mid-delete).
ok(/if \(!bulkDeleting\) closeBulkDeleteConfirm\(\)/.test(sheet), 'C4a. bulk-delete backdrop ignores clicks while deleting');
ok(/disabled=\{deleting\}/.test(mediaList), 'C4b. delete-confirm buttons disabled while deleting');

// ===========================================================================
console.log('§D — child dialogs render ABOVE the sheet (no clipping)');
// ===========================================================================
// The wizard + delete confirm are SIBLINGS of the sheet overlay in the
// DOM (fixed position), NOT children of .episode-sheet — so the sheet's
// overflow/stacking context can never clip them.
ok(/<AdminAddFileWizard/.test(mediaList) && /<AdminEpisodeSheet/.test(mediaList), 'D1a. wizard + sheet are sibling component instances');
ok(!/<AdminAddFileWizard/.test(sheet), 'D1b. the sheet does NOT nest the wizard inside its own subtree (type imports are fine)');
ok(!/class="wizard-overlay"/.test(sheet), 'D1c. no wizard overlay rendered inside the sheet component');
// All overlays are position:fixed (viewport-level, immune to ancestor
// overflow/transform clipping).
ok(/position: fixed/.test(wizardOverlayCss), 'D2a. wizard overlay is position:fixed');
ok(/position: fixed/.test(mediaListOverlayCss), 'D2b. delete/filter overlays are position:fixed');

// ===========================================================================
console.log('§E — refresh semantics (sheet stays open, data reloads)');
// ===========================================================================
ok(/refreshKey/.test(sheet) && /refreshKey = 0 as number/.test(sheet), 'E1a. sheet accepts a refreshKey prop');
ok(/\$effect\(\(\) => \{\s*const key = refreshKey;/.test(sheet), 'E1b. sheet reacts to refreshKey changes');
ok(/if \(open && parent\) void loadLinked\(\)/.test(sheet.replace(/\s+/g, ' ')), 'E1c. refresh reloads the linked ground truth only while open (season + scroll preserved)');
ok(/sheetRefreshKey\+\+/.test(mediaList), 'E2a. the parent list bumps the key after a wizard save');
ok(/sheetRefreshKey\+\+;/.test(mediaList.match(/async function confirmDelete\(\)[\s\S]*?\n  \}/)?.[0] ?? ''), 'E2b. the parent list bumps the key after a delete confirmation');
ok(/refreshKey=\{sheetRefreshKey\}/.test(mediaList), 'E3a. refreshKey is wired into the sheet instance');
// The wizard close does NOT close the sheet (open state is independent).
ok(/function closeSheet\(\) \{\s*open = false;/.test(wizard.replace(/\s+/g, ' ')), 'E4a. wizard close only closes the wizard');
ok(!/onsaved[\s\S]{0,200}sheetOpen = false/.test(mediaList), 'E4b. a save never closes the episode sheet');

// ===========================================================================
console.log('§F — focus management + accessibility preserved');
// ===========================================================================
ok(/lastFocused = document\.activeElement/.test(wizard), 'F1a. wizard captures focus on open');
ok(/target\.focus\(\)/.test(wizard) && /isConnected/.test(wizard), 'F1b. wizard restores focus to the opener on close (returns INTO the open sheet)');
ok(/aria-modal="true"/.test(wizard) && /role="dialog"/.test(wizard), 'F2a. wizard keeps role=dialog + aria-modal');
ok(/aria-modal="true"/.test(sheet) && /role="dialog"/.test(sheet), 'F2b. sheet keeps role=dialog + aria-modal');
ok(/aria-modal="true"/.test(sheet) && /aria-labelledby="bulk-delete-title"/.test(sheet), 'F2c. bulk-delete confirm is labelled');
// 2026-10-16 re-pin: the bulk-delete action became a SELECTED-EPISODE flow
// (never "delete the whole season by default") — the accessible label now
// says the admin SELECTS the linked episodes to delete.
ok(/aria-label="Select linked episodes of this season to delete/.test(sheet), 'F2d. bulk-delete button carries its accessible (selection-based) description');

// ===========================================================================
console.log('§G — no leaks (listeners, duplicate handlers)');
// ===========================================================================
// Exactly ONE svelte:window per component (no duplicate keydown handlers).
ok((sheet.match(/<svelte:window/g) ?? []).length === 1, 'G1a. sheet has exactly one window listener');
ok((wizard.match(/<svelte:window/g) ?? []).length === 1, 'G1b. wizard has exactly one window listener');
ok((mediaList.match(/<svelte:window/g) ?? []).length === 1, 'G1c. media list has exactly one window listener');
// Stack registrations use $effect cleanup (no leaked entries on destroy).
ok(/\$effect\(\(\) => \{\s*if \(open && parent\) \{\s*dialogOpened\(SHEET_DIALOG_ID\);\s*return \(\) => dialogClosed\(SHEET_DIALOG_ID\);/.test(sheet.replace(/\r/g, '')), 'G2a. sheet stack registration has destroy cleanup');
ok(/return \(\) => dialogClosed\(WIZARD_DIALOG_ID\);/.test(wizard), 'G2b. wizard stack registration has destroy cleanup');
// The wizard's focus restore uses a captured reference (no re-query races).
ok(/const target = lastFocused;/.test(wizard), 'G3a. focus restore uses the captured opener reference');
// No body scroll-lock was introduced (no counters to leak; overlays are
// fixed-position and the shell owns scrolling).
ok(!/document\.body\.style\.overflow/.test(sheet) && !/document\.body\.style\.overflow/.test(wizard) && !/document\.body\.style\.overflow/.test(mediaList), 'G4a. no body scroll-lock leaks (no locks introduced)');

console.log(`\nmav_dialog_stacking_contract_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
