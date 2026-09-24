import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase F §5 — DownloadSheet close→reopen embedded-overlay state reset test.
 *
 * Background (the bug found by the §5 state-machine audit):
 *   DownloadSheet.svelte's open/close lifecycle reactive block previously
 *   only reset `dropdownOpen` on close. The embedded-overlay state
 *   (`embeddedSheetUrl`, `embeddedSheetLoading`, `embeddedSheetError`)
 *   was NOT reset. This caused a stale-state bug:
 *
 *     1. user opens sheet → selects Mavero Downloader
 *     2. clicks "Open download page" on a stream card (sets embeddedSheetUrl
 *        + embeddedSheetLoading=true)
 *     3. iframe errors (embeddedSheetError=true)
 *     4. user closes sheet via X or backdrop (NOT the "Back" button)
 *     5. user reopens sheet
 *     6. {#if embeddedSheetUrl} re-renders the overlay on top of the
 *        freshly-mounted MaveroAddonDownload panel, showing the STALE
 *        error message from the prior session.
 *
 * FIX (Phase F §5):
 *   The open/close reactive block now resets embeddedSheetUrl/Loading/Error
 *   on BOTH open AND close transitions (defense in depth).
 *
 * This test is a source-contract test (not a runtime mount) — it verifies
 * the close-handler explicitly resets the embedded-overlay state. A runtime
 * mount test would require simulating user clicks on stream cards inside
 * the iframe overlay, which requires browser automation (out of scope for
 * a tsx script test). The source-contract test is sufficient because:
 *   - the bug is a MISSING assignment (not a runtime error)
 *   - the fix is an EXPLICIT assignment in a known location
 *   - if the fix is reverted, the source-contract test will fail
 *   - the actual stale-state behavior is verified by the §5 audit's
 *     state-machine trace
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ---------------------------------------------------------------------------
// §5.1 — close handler resets embedded-overlay state
// ---------------------------------------------------------------------------

function section_closeHandlerReset(): void {
  const sheet = read('src/lib/components/DownloadSheet.svelte');

  // The close branch (`!open && lastOpen`) must reset embeddedSheetUrl.
  // We verify by extracting the close branch body and checking for the
  // explicit assignments. The regex captures until the next `}` at the
  // start of a line (which closes the reactive block branch).
  const closeBranchMatch = sheet.match(/else if \(!open && lastOpen\)\s*\{([\s\S]*?)^\s*\}/m);
  ok(closeBranchMatch !== null, '§5.1: close branch (`!open && lastOpen`) exists in DownloadSheet.svelte');
  if (closeBranchMatch) {
    const body = closeBranchMatch[1];
    ok(
      body.includes('embeddedSheetUrl = null'),
      '§5.1: close branch resets embeddedSheetUrl = null (no stale overlay URL on reopen)',
    );
    ok(
      body.includes('embeddedSheetLoading = false'),
      '§5.1: close branch resets embeddedSheetLoading = false (no stale loading spinner on reopen)',
    );
    ok(
      body.includes('embeddedSheetError = false'),
      '§5.1: close branch resets embeddedSheetError = false (no stale error message on reopen)',
    );
    // The close branch should still reset dropdownOpen (the original behavior).
    ok(
      body.includes('dropdownOpen = false'),
      '§5.1: close branch still resets dropdownOpen = false (preserves original behavior)',
    );
    // The close branch should still restore body scroll + focus (original behavior).
    ok(
      body.includes('restoreBodyScroll'),
      '§5.1: close branch still restores body scroll',
    );
    ok(
      body.includes('restoreFocus'),
      '§5.1: close branch still restores focus',
    );
  }
}

// ---------------------------------------------------------------------------
// §5.2 — open handler ALSO resets embedded-overlay state (defense in depth)
// ---------------------------------------------------------------------------

function section_openHandlerReset(): void {
  const sheet = read('src/lib/components/DownloadSheet.svelte');

  // The open branch (`open && !lastOpen`) should ALSO reset embedded state.
  // This is defense in depth: if for some reason the close branch didn't
  // fire (e.g. component was destroyed while open, then remounted), the
  // open branch resets the state too.
  const openBranchMatch = sheet.match(/if \(open && !lastOpen\)\s*\{([\s\S]*?)^\s*\} else/m);
  ok(openBranchMatch !== null, '§5.2: open branch (`open && !lastOpen`) exists in DownloadSheet.svelte');
  if (openBranchMatch) {
    const body = openBranchMatch[1];
    ok(
      body.includes('embeddedSheetUrl = null'),
      '§5.2: open branch resets embeddedSheetUrl = null (defense in depth — fresh state on every open)',
    );
    ok(
      body.includes('embeddedSheetLoading = false'),
      '§5.2: open branch resets embeddedSheetLoading = false',
    );
    ok(
      body.includes('embeddedSheetError = false'),
      '§5.2: open branch resets embeddedSheetError = false',
    );
  }
}

// ---------------------------------------------------------------------------
// §5.3 — the embedded-overlay rendering is conditional on embeddedSheetUrl
// ---------------------------------------------------------------------------

function section_overlayConditional(): void {
  const sheet = read('src/lib/components/DownloadSheet.svelte');

  // Verify the overlay renders only when embeddedSheetUrl is truthy.
  // This is the rendering contract — if embeddedSheetUrl is null, the
  // overlay is NOT rendered. Combined with §5.1 + §5.2 (embeddedSheetUrl
  // is reset to null on close + open), this guarantees the overlay cannot
  // reappear on reopen with stale state.
  ok(
    /\{#if embeddedSheetUrl\}/.test(sheet),
    '§5.3: embedded overlay renders only when embeddedSheetUrl is truthy ({#if embeddedSheetUrl})',
  );
  // The overlay renders inside the dl-sheet body, so it only appears when
  // the sheet itself is open. Combined with §5.1, this means: on close,
  // embeddedSheetUrl is set to null → overlay disappears immediately →
  // on reopen, embeddedSheetUrl is still null (or reset again by §5.2) →
  // overlay does NOT reappear.
  ok(
    /class="dl-embedded-overlay"/.test(sheet),
    '§5.3: embedded overlay uses the dl-embedded-overlay CSS class (scoped styling)',
  );
  // The "Back" button calls closeEmbeddedSheet which also resets the state.
  ok(
    /closeEmbeddedSheet\(\)/.test(sheet) && /embeddedSheetUrl = null/.test(sheet),
    '§5.3: closeEmbeddedSheet handler resets embeddedSheetUrl = null (Back button still works)',
  );
}

// ---------------------------------------------------------------------------
// §5.4 — closeEmbeddedSheet handler is correct (the "Back" button)
// ---------------------------------------------------------------------------

function section_closeEmbeddedSheetHandler(): void {
  const sheet = read('src/lib/components/DownloadSheet.svelte');

  // closeEmbeddedSheet is the "Back" button handler — it must reset all
  // three embedded state vars so the overlay disappears.
  const handlerMatch = sheet.match(/function closeEmbeddedSheet\(\)[^{]*\{([\s\S]*?)^\s*\}/m);
  ok(handlerMatch !== null, '§5.4: closeEmbeddedSheet function exists');
  if (handlerMatch) {
    const body = handlerMatch[1];
    ok(
      body.includes('embeddedSheetUrl = null'),
      '§5.4: closeEmbeddedSheet resets embeddedSheetUrl = null',
    );
    ok(
      body.includes('embeddedSheetLoading = false'),
      '§5.4: closeEmbeddedSheet resets embeddedSheetLoading = false',
    );
    ok(
      body.includes('embeddedSheetError = false'),
      '§5.4: closeEmbeddedSheet resets embeddedSheetError = false',
    );
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

section_closeHandlerReset();
section_openHandlerReset();
section_overlayConditional();
section_closeEmbeddedSheetHandler();

console.log(`stremio_downloader_phaseF_embedded_state_test: ${passed} checks passed (Phase F §5: DownloadSheet close→reopen embedded-overlay state reset — stale overlay URL/loading/error cannot reappear after close)`);
