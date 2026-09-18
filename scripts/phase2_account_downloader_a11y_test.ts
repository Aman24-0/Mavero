import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 2-J + 2-K + 2-M — Account settings audit, downloader error UX,
 * and small accessibility fixes.
 *
 * Phase 2-J (audit UIX-1): the three "Playback & interface" toggles
 * (autoplay / autoResume / reducedMotion) were dead — persisted to
 * localStorage('mavero.settings') but never read by runtime code. The
 * audit requires dead controls to be wired or removed; we removed them
 * (wiring would require new player-shell behavior, out of Phase 2 scope).
 *
 * Phase 2-K (audit UIX-2): the downloader-config fetch failure silently
 * hid every Download entry point with no retry surface. We now render an
 * inline "Download temporarily unavailable · Retry" affordance on failure.
 *
 * Phase 2-M (audit A11Y-1): MediaCard Play/Details controls are opacity:0
 * and keyboard focus on the controls themselves (not the parent card link)
 * did not reveal them. We added :focus-visible reveal rules.
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
// Phase 2-J — dead Account settings removed.
// ============================================================
const account = read('src/routes/account/+page.svelte');

// The settings state, persistence helpers, and localStorage load must be gone.
ok(!/let settings = \$state\(\{ autoplay:/.test(account), '2J-1a. settings state (autoplay/autoResume/reducedMotion) removed');
ok(!/function persistSettings\(\)/.test(account), '2J-1b. persistSettings function removed');
ok(!/function persistSettingsAndHaptic\(\)/.test(account), '2J-1c. persistSettingsAndHaptic function removed');
ok(!/localStorage.getItem\('mavero.settings'\)/.test(account.replace(/\/\/[^\n]*/g, '')), '2J-1d. localStorage.getItem("mavero.settings") removed from runtime (comment references stripped)');
ok(!/localStorage.setItem\('mavero.settings'/.test(account.replace(/\/\/[^\n]*/g, '')), '2J-1e. localStorage.setItem("mavero.settings", ...) removed from runtime');

// The "Playback & interface" section must be removed from the template.
ok(!/id="experience-title"/.test(account), '2J-2a. "experience-title" section removed');
ok(!/Autoplay next episode/.test(account), '2J-2b. "Autoplay next episode" toggle removed');
ok(!/Resume where you left off/.test(account), '2J-2c. "Resume where you left off" toggle removed');
ok(!/Reduce motion/.test(account), '2J-2d. "Reduce motion" toggle removed');

// The audit-removal comment is present (for traceability).
ok(/Phase 2-J \(audit UIX-1\)/.test(account), '2J-3a. removal annotated with Phase 2-J (audit UIX-1) comment');

// Adult Mode section (server-authoritative, NOT dead) is preserved.
ok(/Adult Mode/.test(account), '2J-4a. Adult Mode section preserved (server-authoritative, functional)');
ok(/adultAvailable/.test(account), '2J-4b. adultAvailable state preserved');
ok(/loadAdultMode/.test(account), '2J-4c. loadAdultMode function preserved');
ok(/\/api\/settings\/adult-mode/.test(account), '2J-4d. /api/settings/adult-mode API call preserved');

// ============================================================
// Phase 2-K — downloader error UX (retry surface).
// ============================================================
const detail = read('src/lib/components/DetailPage.svelte');

// The downloadProvidersFailed flag is now rendered (not just set silently).
ok(/downloadProvidersFailed/.test(detail), '2K-1a. downloadProvidersFailed state still tracked');
ok(/showDownloadFailure/.test(detail), '2K-1b. showDownloadFailure derived state added (renders the failure)');
ok(/showDownloadFailure = isMovieLike && downloadProvidersFailed && !downloadProvidersLoading && !downloadProvidersLoaded/.test(detail), '2K-1c. showDownloadFailure condition: failed + not loading + not loaded');

// The failure affordance is rendered in the actions row.
ok(/download-unavailable/.test(detail), '2K-2a. download-unavailable CSS class added (failure affordance)');
ok(/Download unavailable · Retry/.test(detail), '2K-2b. "Download unavailable · Retry" label rendered on failure');
ok(/onclick={retryDownloadProviders}/.test(detail), '2K-2c. Retry button calls retryDownloadProviders (real retry action)');
ok(/function retryDownloadProviders\(\)/.test(detail), '2K-2d. retryDownloadProviders function defined');

// The retry actually re-attempts the prefetch (not a fake action).
ok(/retryDownloadProviders\(\) \{[\s\S]*?loadDownloadProviders\(\)/.test(detail), '2K-3a. retryDownloadProviders calls loadDownloadProviders (re-attempts the prefetch)');
ok(/void loadDownloadProviders\(\);/.test(detail), '2K-3b. retry is async (void) - does not block the UI thread');

// The loading state is reflected in the retry button.
ok(/downloadProvidersLoading \? 'Retrying…' : 'Download unavailable · Retry'/.test(detail), '2K-4a. retry button reflects loading state (Retrying… while re-fetching)');
ok(/disabled={downloadProvidersLoading}/.test(detail), '2K-4b. retry button disabled while loading (prevents double-fire)');

// The normal Download button is still shown on success (no regression).
ok(/showDownloadButton = isMovieLike && downloadProvidersLoaded && visibleDownloadProviders.length > 0/.test(detail), '2K-5a. showDownloadButton preserved (success path intact)');
ok(/onclick={openDownloadSheet}/.test(detail), '2K-5b. normal Download button still opens the sheet on success');

// The audit fix is annotated.
ok(/Phase 2-K \(audit UIX-2\)/.test(detail), '2K-6a. fix annotated with Phase 2-K (audit UIX-2) comment');

// No leaking of server errors (the label is generic, not the raw error message).
ok(!/\{errorMessage\}.*Download/.test(detail) && !/error\.message.*Download/.test(detail), '2K-7a. no server error message leaked in the download affordance (generic label)');

// ============================================================
// Phase 2-M — MediaCard focus visibility (A11Y-1).
// ============================================================
const mediaCard = read('src/lib/components/MediaCard.svelte');

// The :focus-visible reveal rules for .mc-play and .mc-detail must exist.
ok(/\.mc-play:focus-visible/.test(mediaCard), '2M-1a. .mc-play:focus-visible rule added (Play reveals on keyboard focus)');
ok(/\.mc-detail:focus-visible/.test(mediaCard), '2M-1b. .mc-detail:focus-visible rule added (Details reveals on keyboard focus)');

// The reveal must set opacity to 1 (the original opacity:0 is overridden).
ok(/\.mc-play:focus-visible\s*\{[^}]*opacity:\s*1/.test(mediaCard), '2M-2a. .mc-play:focus-visible sets opacity:1 (overrides the default opacity:0)');
ok(/\.mc-detail:focus-visible\s*\{[^}]*opacity:\s*1/.test(mediaCard), '2M-2b. .mc-detail:focus-visible sets opacity:1');

// Focus ring is also explicit (not relying on opacity alone).
ok(/\.mc-play:focus-visible\s*\{[^}]*outline:/.test(mediaCard), '2M-3a. .mc-play:focus-visible has explicit outline (focus ring visible)');
ok(/\.mc-detail:focus-visible\s*\{[^}]*outline:/.test(mediaCard), '2M-3b. .mc-detail:focus-visible has explicit outline');

// The audit fix is annotated.
ok(/Phase 2-M \(A11Y-1\)/.test(mediaCard), '2M-4a. fix annotated with Phase 2-M (A11Y-1) comment');

// The existing :hover reveal rules are preserved (no regression).
ok(/\.mc-wrap:has\(\.mc-card-link:hover\)\s*\.mc-poster/.test(mediaCard), '2M-5a. existing hover reveal on mc-poster preserved');
ok(/\.mc-wrap:hover\s*\.mc-detail/.test(mediaCard), '2M-5b. existing hover reveal on mc-detail preserved');

console.log(`phase2_account_downloader_a11y_test: ${passed} checks passed (Phase 2-J dead settings + 2-K downloader UX + 2-M a11y)`);
