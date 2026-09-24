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

// ============================================================
// Phase 2-K — downloader error UX — Phase E final corrective (§6):
// the old "Download unavailable · Retry" inline affordance on the
// DetailPage is GONE. The Download button is now ALWAYS visible for
// movie-like items (decoupled from prefetch). The Loading / Error /
// Retry state lives INSIDE the DownloadSheet component. The
// `downloadProvidersFailed` flag is still tracked, but it is passed
// to the sheet (via `providersFailed` prop) instead of being rendered
// inline on the DetailPage.
// ============================================================

// The downloadProvidersFailed flag is still tracked (for the sheet).
ok(/downloadProvidersFailed/.test(detail), '2K-1a. downloadProvidersFailed state still tracked (passed to sheet via providersFailed prop)');

// Phase E final: showDownloadButton is gated ONLY on isMovieLike (no prefetch gating).
ok(/showDownloadButton = \$derived\(isMovieLike\)/.test(detail), '2K-1b (Phase E final). showDownloadButton is gated ONLY on isMovieLike (decoupled from prefetch completion — no silent button disappearance)');

// retryDownloadProviders function is still defined + wired to the sheet's Retry button.
ok(/function retryDownloadProviders\(\)/.test(detail), '2K-2a. retryDownloadProviders function defined');
ok(/onRetryProviders={retryDownloadProviders}/.test(detail), '2K-2b. retryDownloadProviders is wired to the sheet via onRetryProviders prop (the Retry button is INSIDE the sheet)');

// The retry actually re-attempts the prefetch (not a fake action).
ok(/retryDownloadProviders\(\) \{[\s\S]*?loadDownloadProviders\(\)/.test(detail), '2K-3a. retryDownloadProviders calls loadDownloadProviders (re-attempts the prefetch)');
ok(/void loadDownloadProviders\(\);/.test(detail), '2K-3b. retry is async (void) - does not block the UI thread');

// The DownloadSheet now accepts providersLoading / providersFailed / onRetryProviders props
// so the sheet can render Loading / Error / Retry states internally.
const sheet = read('src/lib/components/DownloadSheet.svelte');
ok(/export let providersLoading = false;/.test(sheet), '2K-4a (Phase E final). DownloadSheet accepts providersLoading prop (renders Loading state internally)');
ok(/export let providersFailed = false;/.test(sheet), '2K-4b (Phase E final). DownloadSheet accepts providersFailed prop (renders Error state internally)');
ok(/export let onRetryProviders/.test(sheet), '2K-4c (Phase E final). DownloadSheet accepts onRetryProviders callback (wires the Retry button)');
ok(/Loading download providers/.test(sheet), '2K-4d (Phase E final). DownloadSheet renders "Loading download providers…" in the Loading branch');
ok(/Downloader temporarily unavailable/.test(sheet), '2K-4e (Phase E final). DownloadSheet renders "Downloader temporarily unavailable" in the Error branch');
ok(/Retry/.test(sheet), '2K-4f (Phase E final). DownloadSheet renders Retry button (calls onRetryProviders)');

// The normal Download button is always shown for movie-like items (no regression).
ok(/onclick=\{openDownloadSheet\}/.test(detail), '2K-5b. normal Download button still opens the sheet (always wired, no prefetch gating)');

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
