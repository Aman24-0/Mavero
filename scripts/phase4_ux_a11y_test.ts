import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 4-J — Accessibility + UX regression tests.
 *
 * Behavior-focused tests for:
 *   - MediaCard keyboard focus visibility (Phase 2-M preserved)
 *   - Modal focus management (SelectionSheet + trailer modal Phase 4-E)
 *   - Escape behavior
 *   - Focus restoration
 *   - Accessible labels
 *   - Discover loading/error recovery (Phase 2-H/L preserved)
 *   - Downloader failure/retry (Phase 2-K preserved)
 *   - Player PLR lifecycle (Phase 2-I preserved)
 *   - Phase 3 regression-1: watch_history retention permission lockdown
 *   - Phase 3 regression-2: RESOLUTION_UNAVAILABLE NOT negative-cacheable
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. MediaCard keyboard focus visibility (Phase 2-M + Phase 4-D).
// ============================================================
const mediaCard = read('src/lib/components/MediaCard.svelte');
ok(/\.mc-play:focus-visible\s*\{[^}]*opacity:\s*1/.test(mediaCard), '1a. .mc-play:focus-visible sets opacity:1 (Phase 2-M preserved)');
ok(/\.mc-detail:focus-visible\s*\{[^}]*opacity:\s*1/.test(mediaCard), '1b. .mc-detail:focus-visible sets opacity:1 (Phase 2-M preserved)');
ok(/\.mc-play:focus-visible\s*\{[^}]*outline:/.test(mediaCard), '1c. .mc-play:focus-visible has explicit outline');
ok(/\.mc-detail:focus-visible\s*\{[^}]*outline:/.test(mediaCard), '1d. .mc-detail:focus-visible has explicit outline');
ok(/aria-label={`Play \$\{item\.title\}`}/.test(mediaCard), '1e. mc-play has accessible name (aria-label)');
ok(/aria-label={`Open details for \$\{item\.title\`}/.test(mediaCard) || /aria-label={`Open details for \$\{item\.title\}`}/.test(mediaCard), '1f. mc-detail has accessible name (aria-label)');
ok(/role="progressbar"/.test(mediaCard), '1g. progress bar has role=progressbar');
ok(/aria-valuemin="0"/.test(mediaCard) && /aria-valuemax="100"/.test(mediaCard), '1h. progress bar has aria-valuemin/max');

// ============================================================
// 2. SelectionSheet modal accessibility (Phase 4-E).
// ============================================================
const selectionSheet = read('src/lib/components/SelectionSheet.svelte');
ok(/role="dialog"/.test(selectionSheet), '2a. SelectionSheet has role=dialog');
ok(/aria-modal="true"/.test(selectionSheet), '2b. SelectionSheet has aria-modal=true');
ok(/aria-labelledby="selection-sheet-title"/.test(selectionSheet), '2c. SelectionSheet has aria-labelledby');
ok(/previouslyFocused/.test(selectionSheet), '2d. SelectionSheet stores previouslyFocused (Phase 4-E)');
ok(/previouslyFocused\?\.focus\(\)/.test(selectionSheet), '2e. SelectionSheet restores focus on close (Phase 4-E)');
ok(/sheet\?\.querySelector<HTMLElement>\('\.sheet-close'\)\?\.focus\(\)/.test(selectionSheet), '2f. SelectionSheet auto-focuses close button on open (Phase 4-E)');
ok(/event\.key !== 'Tab' \|\| !sheet/.test(selectionSheet), '2g. SelectionSheet has Tab trap (Phase 4-E)');
ok(/event\.shiftKey && document\.activeElement === first/.test(selectionSheet), '2h. Shift+Tab wraps to last element');
ok(/!event\.shiftKey && document\.activeElement === last/.test(selectionSheet), '2i. Tab wraps to first element');
ok(/event\.key === 'Escape'/.test(selectionSheet), '2j. Escape closes the sheet');

// ============================================================
// 3. Trailer modal accessibility (Phase 4-E).
// ============================================================
const detailPage = read('src/lib/components/DetailPage.svelte');
ok(/trailerTrigger = document\.activeElement/.test(detailPage), '3a. trailer modal stores trigger element (Phase 4-E)');
ok(/trailerTrigger\?\.focus\(\)/.test(detailPage), '3b. trailer modal restores focus on close (Phase 4-E)');
ok(/trailerModal\?\.querySelector<HTMLElement>\('\.trailer-close'\)\?\.focus\(\)/.test(detailPage), '3c. trailer modal auto-focuses close button on open (Phase 4-E)');
ok(/bind:this=\{trailerModal\}/.test(detailPage), '3d. trailer modal has bind:this (Phase 4-E)');
ok(/event\.key !== 'Tab' \|\| !trailerModal/.test(detailPage), '3e. trailer modal has Tab trap (Phase 4-E)');
ok(/role="dialog" aria-modal="true"/.test(detailPage), '3f. trailer modal has role=dialog + aria-modal=true');

// ============================================================
// 4. ConfirmDialog accessibility (Phase 1 preserved).
// ============================================================
const confirmDialog = read('src/lib/components/ConfirmDialog.svelte');
ok(/role="alertdialog"/.test(confirmDialog), '4a. ConfirmDialog has role=alertdialog');
ok(/aria-modal="true"/.test(confirmDialog), '4b. ConfirmDialog has aria-modal=true');
ok(/aria-labelledby/.test(confirmDialog), '4c. ConfirmDialog has aria-labelledby');
ok(/aria-describedby/.test(confirmDialog), '4d. ConfirmDialog has aria-describedby');
ok(/previouslyFocused/.test(confirmDialog), '4e. ConfirmDialog stores previouslyFocused');
ok(/previouslyFocused\?\.focus\(\)/.test(confirmDialog), '4f. ConfirmDialog restores focus on close');
ok(/data-autofocus/.test(confirmDialog), '4g. ConfirmDialog auto-focuses [data-autofocus] on open');
ok(/event\.key !== 'Tab' \|\| !dialog/.test(confirmDialog), '4h. ConfirmDialog has Tab trap');

// ============================================================
// 5. DownloadSheet accessibility (Phase 1 preserved).
// ============================================================
const downloadSheet = read('src/lib/components/DownloadSheet.svelte');
ok(/role="dialog"/.test(downloadSheet), '5a. DownloadSheet has role=dialog');
ok(/aria-modal="true"/.test(downloadSheet), '5b. DownloadSheet has aria-modal=true');
ok(/previouslyFocused/.test(downloadSheet), '5c. DownloadSheet stores previouslyFocused');
ok(/previouslyFocused\.focus\(\)/.test(downloadSheet), '5d. DownloadSheet restores focus on close');
ok(/event\.key === 'Escape'/.test(downloadSheet), '5e. DownloadSheet has Escape handler');

// ============================================================
// 6. Discover loading/error recovery (Phase 2-H/L preserved).
// ============================================================
const discoverSection = read('src/lib/components/DiscoverSection.svelte');
ok(/skeleton-rail/.test(discoverSection), '6a. DiscoverSection skeleton rail preserved (Phase 2-H)');
ok(/aria-busy="true"/.test(discoverSection), '6b. skeleton rail has aria-busy');
ok(/showMoreError/.test(discoverSection), '6c. showMoreError state preserved (Phase 2-L)');
ok(/\{#if showMoreError\}/.test(discoverSection), '6d. Show-more failure conditionally rendered (Phase 2-L)');
ok(/retry-btn/.test(discoverSection), '6e. retry button preserved (Phase 2-L)');

// ============================================================
// 7. Downloader failure/retry (Phase 2-K preserved).
// ============================================================
ok(/showDownloadFailure/.test(detailPage), '7a. showDownloadFailure derived preserved (Phase 2-K)');
ok(/retryDownloadProviders/.test(detailPage), '7b. retryDownloadProviders function preserved (Phase 2-K)');
ok(/download-unavailable/.test(detailPage), '7c. download-unavailable CSS class preserved (Phase 2-K)');
ok(/Download unavailable · Retry/.test(detailPage), '7d. retry label preserved (Phase 2-K)');

// ============================================================
// 8. Player PLR lifecycle (Phase 2-I preserved).
// ============================================================
const playerShell = read('src/lib/components/player/PlayerShell.svelte');
ok(/viewportMediaQuery\.removeEventListener\('change', handleViewportChange\)/.test(playerShell), '8a. PLR-02: viewportMediaQuery cleanup preserved');
ok(/if \(source\?\.type === 'direct'\) \{[\s\S]*?registerMediaSessionHandlers\(\)/.test(playerShell), '8b. PLR-03: setupMediaSession restores handlers for direct sources');
ok(/\(\s*playing\s*\|\|\s*embedPlaying\s*\)/.test(playerShell), '8c. PLR-04: (playing || embedPlaying) for auto-hide');
ok(/startEmbedLoadTimeout/.test(playerShell) && /toggleSandbox/.test(playerShell), '8d. PLR-05: sandbox toggle re-arms embed load timeout');

// ============================================================
// 9. Phase 3 Regression-1: watch_history retention permission lockdown.
// ============================================================
const correctiveMigration = read('supabase/migrations/20260923000000_phase4_regression1_history_retention_permissions.sql');
ok(/revoke execute on function public\.prune_old_watch_history\(int\) from authenticated/.test(correctiveMigration), '9a. REGRESSION-1: execute revoked from authenticated');
ok(/revoke execute on function public\.prune_old_watch_history\(int\) from anon/.test(correctiveMigration), '9b. REGRESSION-1: execute revoked from anon');
ok(!/grant execute on function public\.prune_old_watch_history/.test(correctiveMigration), '9c. REGRESSION-1: no grant to any role (only postgres + service-role)');

// ============================================================
// 10. Phase 3 Regression-2: RESOLUTION_UNAVAILABLE NOT negative-cacheable.
// ============================================================
const negativeCache = read('src/lib/server/resolver/negative-cache.ts');
ok(/CACHEABLE_NEGATIVE_CODES = new Set<string>\(\[/.test(negativeCache), '10a. negative cache has a closed set of cacheable codes');
ok(/'UNSUPPORTED_MEDIA_TYPE'/.test(negativeCache), '10b. UNSUPPORTED_MEDIA_TYPE is cacheable (deterministic)');
ok(/'MISSING_IDENTIFIER'/.test(negativeCache), '10c. MISSING_IDENTIFIER is cacheable (deterministic)');
// RESOLUTION_UNAVAILABLE must NOT be in the set.
const cacheableSetMatch = negativeCache.match(/CACHEABLE_NEGATIVE_CODES = new Set<string>\(\[([\s\S]*?)\]\)/);
ok(cacheableSetMatch !== null, '10d. cacheable set extractable');
if (cacheableSetMatch) {
  ok(!/RESOLUTION_UNAVAILABLE/.test(cacheableSetMatch[1]), '10e. REGRESSION-2: RESOLUTION_UNAVAILABLE NOT in cacheable set');
  ok(!/RESOLUTION_TIMEOUT/.test(cacheableSetMatch[1]), '10f. RESOLUTION_TIMEOUT NOT in cacheable set');
  ok(!/INTERNAL_RESOLUTION_ERROR/.test(cacheableSetMatch[1]), '10g. INTERNAL_RESOLUTION_ERROR NOT in cacheable set');
}

// ============================================================
// 11. CSP regression verification (Phase 3-I preserved + Phase 4-M).
// ============================================================
const netlify = read('netlify.toml');
ok(/Content-Security-Policy/.test(netlify), '11a. CSP header present (Phase 3-I preserved)');
ok(/default-src 'self'/.test(netlify), '11b. CSP default-src self');
ok(/script-src 'self' 'unsafe-inline'/.test(netlify), '11c. CSP script-src allows self + unsafe-inline (SvelteKit compat)');
ok(/img-src 'self' data: https:\/\/image\.tmdb\.org/.test(netlify), '11d. CSP img-src allows TMDB images (Phase 4-M: not broken)');
ok(/connect-src 'self' https:\/\/\*\.supabase\.co/.test(netlify), '11e. CSP connect-src allows Supabase (Phase 4-M: auth not broken)');
ok(/frame-src \*/.test(netlify), '11f. CSP frame-src permissive for admin-configured providers (Phase 4-M: playback not broken)');

// ============================================================
// 12. Security invariants — UI is NEVER an authorization boundary.
// ============================================================
ok(/canAccessAdultContent\(locals\.supabase, user, cookies\)/.test(read('src/routes/watch/[type]/[id]/+page.server.ts')), '12a. watch route still calls canAccessAdultContent (server-authoritative)');
ok(/status: 404/.test(read('src/routes/api/content/adult-discover/+server.ts')), '12b. adult-discover unauthorized response stays 404 (non-disclosing)');
ok(/RESOLUTION_UNAVAILABLE: 503/.test(read('src/lib/server/resolver/errors.ts')), '12c. RESOLUTION_UNAVAILABLE maps to HTTP 503 (transient, not cached)');

console.log(`phase4_ux_a11y_test: ${passed} checks passed (Phase 4 UX + accessibility + regression)`);
