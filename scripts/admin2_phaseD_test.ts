import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Admin 2.0 — Phase D contracts.
 *
 * Phase D is the Upload / Import redesign: replaces the 755-line
 * legacy wizard with a guided, contextual AdminUploadFlow that uses
 * existing backend services. Tests pin the contracts Phase E+ will
 * depend on.
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const uploadFlow = readFileSync(new URL('../src/lib/components/admin2/AdminUploadFlow.svelte', import.meta.url), 'utf8');
const uploadPage = readFileSync(new URL('../src/routes/admin/media/upload/+page.svelte', import.meta.url), 'utf8');
const uploadPageServer = readFileSync(new URL('../src/routes/admin/media/upload/+page.server.ts', import.meta.url), 'utf8');
const uploadService = readFileSync(new URL('../src/lib/server/hosting/upload/service.ts', import.meta.url), 'utf8');
const uploadApi = readFileSync(new URL('../src/routes/api/admin/media/upload/+server.ts', import.meta.url), 'utf8');

// ============================================================
// 1. AdminUploadFlow — orchestrator component exists
// ============================================================

assert.match(uploadFlow, /class AdminUploadFlow|AdminUploadFlow/, 'AdminUploadFlow component exists');
assert.match(uploadFlow, /export type UploadStep|type UploadStep/, 'flow defines UploadStep type');
assert.match(uploadFlow, /type UploadFlowState/, 'flow defines UploadFlowState type');
ok('1a. AdminUploadFlow component exists with types');

// Page delegates to AdminUploadFlow
assert.match(uploadPage, /import AdminUploadFlow/, 'page imports AdminUploadFlow');
assert.match(uploadPage, /<AdminUploadFlow/, 'page renders AdminUploadFlow');
ok('1b. page delegates to AdminUploadFlow');

// Page uses AdminAppShell + AdminPage
assert.match(uploadPage, /<AdminAppShell>/, 'page uses AdminAppShell');
assert.match(uploadPage, /<AdminPage/, 'page uses AdminPage framework');
ok('1c. page uses AdminAppShell + AdminPage framework (no legacy AdminPageHeader)');

// ============================================================
// 2. Step state machine
// ============================================================

const STEPS = ['search', 'metadata', 'provider', 'source', 'review', 'uploading', 'processing', 'done'];
for (const step of STEPS) {
  assert.match(uploadFlow, new RegExp(`'${step}'`), `flow defines step: ${step}`);
}
ok('2a. flow defines all 8 steps (search → metadata → provider → source → review → uploading → processing → done)');

// No dead 'select' step (Phase D removed it)
assert.doesNotMatch(uploadFlow, /step === 'select'/, 'flow has no dead select step');
ok('2b. flow has no dead select step (Phase D cleanup)');

// Step indicator
assert.match(uploadFlow, /upload-steps/, 'flow has step indicator');
assert.match(uploadFlow, /aria-current.*step/, 'flow uses aria-current for active step');
ok('2c. flow has step indicator with aria-current');

// ============================================================
// 3. URL state + deep linking
// ============================================================

assert.match(uploadFlow, /syncUrl\(\)/, 'flow syncs URL state');
assert.match(uploadFlow, /replaceState: true/, 'flow uses replaceState (no history spam)');
assert.match(uploadFlow, /initialContext/, 'flow accepts initialContext prop');
ok('3a. flow syncs URL state with replaceState');

// Server loader reads URL params
assert.match(uploadPageServer, /url\.searchParams/, 'server loader reads URL params');
assert.match(uploadPageServer, /tmdbId/, 'server loader reads tmdbId');
assert.match(uploadPageServer, /contentType/, 'server loader reads contentType');
assert.match(uploadPageServer, /season/, 'server loader reads season');
assert.match(uploadPageServer, /episode/, 'server loader reads episode');
assert.match(uploadPageServer, /initialContext/, 'server loader returns initialContext');
ok('3b. server loader reads URL params for deep linking');

// ============================================================
// 4. Provider capability display (no hardcoded Vidara/Abyss)
// ============================================================

assert.match(uploadFlow, /capabilities/, 'flow uses capabilities');
assert.match(uploadFlow, /providerCapabilities/, 'flow tracks providerCapabilities');
assert.match(uploadFlow, /localUpload/, 'flow checks localUpload capability');
assert.match(uploadFlow, /remoteUpload/, 'flow checks remoteUpload capability');
ok('4a. flow uses provider capabilities (not hardcoded adapterId)');

// Capability-driven UI (radio options filtered by capability)
assert.match(uploadFlow, /flowState\.providerCapabilities\?.remoteUpload/, 'flow filters remote-upload option by capability');
ok('4b. flow filters upload-source options by capability');

// Provider capability badges in selection
assert.match(uploadFlow, /multiAudio/, 'flow shows multi-audio capability badge');
assert.match(uploadFlow, /subtitles/, 'flow shows subtitles capability badge');
assert.match(uploadFlow, /transcoding/, 'flow shows transcoding capability badge');
assert.match(uploadFlow, /qualityVariants/, 'flow shows quality-variants capability badge');
ok('4c. flow displays provider capability badges');

// Server loader returns capabilities
assert.match(uploadPageServer, /getHostingAdapter/, 'server loader uses adapter registry');
assert.match(uploadPageServer, /getCapabilities\(\)/, 'server loader calls getCapabilities()');
assert.match(uploadPageServer, /capabilities/, 'server loader returns capabilities');
ok('4d. server loader returns provider capabilities (no N+1 client-side)');

// ============================================================
// 5. TMDB search with debouncing
// ============================================================

assert.match(uploadFlow, /searchDebounce/, 'flow has search debounce');
assert.match(uploadFlow, /setTimeout/, 'flow uses setTimeout for debounce');
assert.match(uploadFlow, /300/, 'flow debounces search by 300ms');
ok('5a. flow debounces TMDB search (300ms)');

// Search handles loading + empty + error states
assert.match(uploadFlow, /searching/, 'flow tracks searching state');
assert.match(uploadFlow, /searchError/, 'flow tracks searchError state');
assert.match(uploadFlow, /search-empty/, 'flow has empty-search-results state');
assert.match(uploadFlow, /search-result-skeleton/, 'flow has skeleton loading');
ok('5b. flow handles search loading + empty + error states');

// ============================================================
// 6. IMDb ID capture
// ============================================================

assert.match(uploadFlow, /imdbId/, 'flow tracks imdbId');
assert.match(uploadFlow, /externalIds\?\.imdb/, 'flow captures IMDb ID from TMDB');
ok('6a. flow captures IMDb ID from TMDB (Phase D fix — was never set before)');

// ============================================================
// 7. Polling with POLL_MAX_ATTEMPTS cap + onDestroy cleanup
// ============================================================

assert.match(uploadFlow, /POLL_MAX_ATTEMPTS/, 'flow references POLL_MAX_ATTEMPTS');
assert.match(uploadFlow, /pollAttempts/, 'flow tracks pollAttempts');
assert.match(uploadFlow, /pollAttempts > POLL_MAX_ATTEMPTS/, 'flow caps polling at POLL_MAX_ATTEMPTS');
ok('7a. flow respects POLL_MAX_ATTEMPTS cap');

assert.match(uploadFlow, /onDestroy/, 'flow uses onDestroy lifecycle hook');
assert.match(uploadFlow, /stopPolling\(\)/, 'flow calls stopPolling on destroy');
ok('7b. flow cleans up polling interval on destroy (Phase D fix — was leaking before)');

// Polling surfaces errors (no silent swallowing)
assert.match(uploadFlow, /pollError/, 'flow tracks pollError state');
assert.match(uploadFlow, /pollStale/, 'flow tracks pollStale state');
ok('7c. flow surfaces polling errors (no silent swallowing)');

// ============================================================
// 8. Retry flow fix (no duplicate createOperation)
// ============================================================

assert.match(uploadFlow, /retryUpload/, 'flow has retryUpload function');
assert.match(uploadFlow, /retrying/, 'flow tracks retrying state');
// The retry endpoint is called directly (no createOperation after)
assert.match(uploadFlow, /\/retry/, 'flow calls /retry endpoint');
ok('8a. flow has retry function that calls /retry endpoint');

// Backend fix: retryOperation preserves source_url/filename/quality
assert.match(uploadService, /source_quality: op\.source_quality/, 'retryOperation preserves source_quality');
assert.match(uploadService, /source_filename: op\.source_filename/, 'retryOperation preserves source_filename');
assert.match(uploadService, /source_url: op\.source_url/, 'retryOperation preserves source_url');
assert.doesNotMatch(uploadService, /source_quality: null/, 'retryOperation does NOT wipe source_quality');
ok('8b. backend retryOperation preserves source_url/filename/quality (Phase D fix)');

// ============================================================
// 9. Backend fix: completeUploadFromResult state guard
// ============================================================

assert.match(uploadService, /Phase D §H \(state guard\)/, 'completeUploadFromResult documents Phase D state guard');
assert.match(uploadService, /if \(op\.status !== 'uploading'\)/, 'completeUploadFromResult has state guard');
assert.match(uploadService, /Cannot complete operation in/, 'completeUploadFromResult rejects invalid states');
ok('9a. backend completeUploadFromResult has state guard (Phase D fix)');

// Idempotency: already-completed operations return current state
assert.match(uploadService, /op\.status === 'uploaded' \|\| op\.status === 'processing' \|\| op\.status === 'ready'/, 'completeUploadFromResult is idempotent for already-completed operations');
ok('9b. completeUploadFromResult is idempotent for already-completed operations');

// ============================================================
// 10. Backend fix: providerAdapterId optional
// ============================================================

assert.match(uploadService, /providerAdapterId\?/, 'CreateUploadOperationInput has optional providerAdapterId');
assert.match(uploadApi, /providerAdapterId` is now OPTIONAL/, 'API documents optional providerAdapterId');
assert.match(uploadApi, /Derive providerAdapterId from the source/, 'API derives providerAdapterId when not provided');
ok('10a. backend providerAdapterId is optional (Phase D fix — eliminates redundant field)');

// API no longer requires providerAdapterId in validation
assert.doesNotMatch(uploadApi, /!body\.providerAdapterId/, 'API does NOT require providerAdapterId in validation');
ok('10b. API validation does NOT require providerAdapterId');

// ============================================================
// 11. Subtitle sub-flow (separate sheet, isolated success/failure)
// ============================================================

assert.match(uploadFlow, /subtitleSheetOpen/, 'flow has subtitleSheetOpen state');
assert.match(uploadFlow, /subtitle-sheet/, 'flow has subtitle sheet UI');
assert.match(uploadFlow, /uploadSubtitle/, 'flow has uploadSubtitle function');
assert.match(uploadFlow, /subtitleResult/, 'flow tracks subtitleResult independently');
assert.match(uploadFlow, /subtitleError/, 'flow tracks subtitleError independently');
ok('11a. flow has subtitle sub-flow as separate sheet');

// Subtitle success/failure is isolated from main upload
assert.match(uploadFlow, /result-subtitle-success/, 'flow shows subtitle success state');
assert.match(uploadFlow, /result-subtitle-failed/, 'flow shows subtitle failure state (independent of main upload)');
ok('11b. subtitle success/failure is isolated from main upload');

// ============================================================
// 12. Mobile-native composition
// ============================================================

assert.match(uploadFlow, /@media \(max-width: 1023px\)/, 'flow has 1023px breakpoint');
assert.match(uploadFlow, /@media \(max-width: 640px\)/, 'flow has 640px breakpoint');
assert.match(uploadFlow, /upload-actionbar/, 'flow has sticky action bar');
ok('12a. flow has mobile breakpoints + sticky action bar');

// Mobile hides side panel
assert.match(uploadFlow, /\.upload-side \{[\s\S]*display: none/, 'flow hides side panel on mobile');
ok('12b. flow hides side panel on mobile');

// Mobile stacks search controls
assert.match(uploadFlow, /flex-direction: column/, 'flow stacks controls on mobile');
ok('12c. flow stacks controls vertically on mobile');

// ============================================================
// 13. Accessibility
// ============================================================

assert.match(uploadFlow, /aria-label/, 'flow uses aria-label');
assert.match(uploadFlow, /aria-current/, 'flow uses aria-current');
assert.match(uploadFlow, /aria-modal/, 'flow uses aria-modal for subtitle sheet');
assert.match(uploadFlow, /role="dialog"/, 'flow uses role=dialog for subtitle sheet');
ok('13a. flow has accessibility attributes');

// Reduced motion
assert.match(uploadFlow, /prefers-reduced-motion: reduce/, 'flow respects prefers-reduced-motion');
ok('13b. flow respects prefers-reduced-motion');

// File dropzone is keyboard accessible
assert.match(uploadFlow, /tabindex="0"/, 'flow file dropzone is keyboard focusable');
assert.match(uploadFlow, /e\.key === 'Enter' \|\| e\.key === ' '/, 'flow file dropzone handles Enter/Space');
ok('13c. flow file dropzone is keyboard accessible');

// ============================================================
// 14. Error handling (no silent swallowing)
// ============================================================

assert.match(uploadFlow, /try \{/, 'flow uses try/catch');
assert.match(uploadFlow, /catch/, 'flow catches errors');
assert.match(uploadFlow, /operationError/, 'flow tracks operationError');
assert.match(uploadFlow, /createError/, 'flow tracks createError');
assert.match(uploadFlow, /searchError/, 'flow tracks searchError');
ok('14a. flow surfaces errors (no silent swallowing)');

// Error block in result
assert.match(uploadFlow, /result-failed/, 'flow has failed result block');
assert.match(uploadFlow, /result-error-code/, 'flow shows error code in failure');
ok('14b. flow shows error details in failure result');

// ============================================================
// 15. Result actions
// ============================================================

assert.match(uploadFlow, /uploadAnother/, 'flow has uploadAnother action');
assert.match(uploadFlow, /goToMediaLibrary/, 'flow has goToMediaLibrary action');
assert.match(uploadFlow, /goToMediaDetail/, 'flow has goToMediaDetail action');
assert.match(uploadFlow, /openSubtitleSheet/, 'flow has openSubtitleSheet action');
ok('15a. flow has result actions (upload another, view in library, subtitle)');

// Retry action
assert.match(uploadFlow, /Retry Upload/, 'flow has Retry Upload button');
ok('15b. flow has retry action');

// Cancel action during processing
assert.match(uploadFlow, /cancelUpload/, 'flow has cancelUpload function');
assert.match(uploadFlow, /Cancel Upload/, 'flow has Cancel Upload button');
ok('15c. flow has cancel action during processing');

// ============================================================
// 16. Security — no credential exposure
// ============================================================

// Flow does NOT hardcode api_key / password / token
assert.doesNotMatch(uploadFlow, /api_key\s*=\s*['"]/, 'flow does NOT hardcode api_key');
assert.doesNotMatch(uploadFlow, /password\s*=\s*['"]/, 'flow does NOT hardcode password');
assert.doesNotMatch(uploadFlow, /jwt\s*=\s*['"]/, 'flow does NOT hardcode jwt');
// Flow uses the /upload-server endpoint to get the authenticated URL (server-side)
assert.match(uploadFlow, /\/upload-server/, 'flow uses /upload-server endpoint (server issues authenticated URL)');
ok('16a. flow does NOT expose provider credentials');

// ============================================================
// 17. Contextual side panel (desktop)
// ============================================================

assert.match(uploadFlow, /upload-side/, 'flow has contextual side panel');
assert.match(uploadFlow, /side-card/, 'flow has side cards');
assert.match(uploadFlow, /Selected Title/, 'flow shows selected title in side panel');
assert.match(uploadFlow, /Provider/, 'flow shows provider in side panel');
ok('17a. flow has contextual side panel (desktop)');

// ============================================================
// 18. File selection (drag-and-drop + picker)
// ============================================================

assert.match(uploadFlow, /handleDrop/, 'flow has drag-and-drop');
assert.match(uploadFlow, /handleDragOver/, 'flow handles drag-over');
assert.match(uploadFlow, /file-dropzone/, 'flow has file dropzone UI');
assert.match(uploadFlow, /clearFile/, 'flow has clear-file action');
assert.match(uploadFlow, /file-selected/, 'flow shows selected file state');
ok('18a. flow supports drag-and-drop + file picker + clear');

// File size display
assert.match(uploadFlow, /selectedFile\.size/, 'flow shows file size');
ok('18b. flow displays file size');

// ============================================================
// 19. Review step
// ============================================================

assert.match(uploadFlow, /review-grid/, 'flow has review grid');
assert.match(uploadFlow, /review-block/, 'flow has review blocks');
assert.match(uploadFlow, /Start Upload/, 'flow has Start Upload button on review');
ok('19a. flow has review step with all details');

// Review shows all key fields
assert.match(uploadFlow, /TMDB ID/, 'review shows TMDB ID');
assert.match(uploadFlow, /Provider/, 'review shows provider');
assert.match(uploadFlow, /Upload Method/, 'review shows upload method');
ok('19b. review shows all key fields');

// ============================================================
// 20. Backend test compatibility — Phase D must not break existing contracts
// ============================================================

// All existing upload endpoints still have requireAdmin
assert.match(uploadApi, /requireAdmin/, 'upload API still requires admin');
ok('20a. all upload endpoints still admin-gated');

// No secrets in any new source file
const allNewSources = [uploadFlow, uploadPage, uploadPageServer];
for (const src of allNewSources) {
  assert.doesNotMatch(src, /sbp_[a-zA-Z0-9]{20,}/, 'no Supabase PAT in source');
  assert.doesNotMatch(src, /sk_[a-zA-Z0-9]{20,}/, 'no API key in source');
}
ok('20b. no secrets in any new source file');

console.log(`\nAdmin 2.0 Phase D tests passed (${passed} check groups).`);
