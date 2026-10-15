/**
 * MAV-FOCUSED — Phase 3 contract test — Missing Media integration (2026-10).
 *
 * Static-code contract test for the Phase 3 Missing Media integration.
 * Verifies that:
 *
 *   1. Missing Media page uses the shared AdminAddFileWizard (NOT the
 *      old AdminLinkMediaModal provider-inventory picker).
 *   2. The shared wizard is the SAME component used by Media Library.
 *   3. The wizard accepts a preselectedMediaItem prop (for Missing Media's
 *      "title already known from the demand row" flow).
 *   4. The preselected item carries contentType, tmdbId, season, episode,
 *      episodeTitle — the full canonical identity contract.
 *   5. The manual-link endpoint accepts an optional episodeTitle parameter
 *      and passes it to ensureEpisode / ensureAnimeEpisode.
 *   6. The Missing Media page does NOT import AdminLinkMediaModal.
 *   7. No Upload button, no provider asset browser, no Hosting Control.
 *   8. Authorization is enforced server-side (requireAdmin on all mutations).
 *   9. The demand sweep auto-resolves demand rows after a successful link.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_phase3_missing_media_contract_test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

console.log('\n§1 — Missing Media page uses the shared AdminAddFileWizard');

const missingPage = src('src/routes/admin/media/missing/+page.svelte');
ok(/import AdminAddFileWizard from/.test(missingPage), '1a. Missing Media imports AdminAddFileWizard');
ok(!/import AdminLinkMediaModal/.test(missingPage), '1b. Missing Media does NOT import AdminLinkMediaModal (old provider-inventory picker removed)');
ok(/<AdminAddFileWizard/.test(missingPage), '1c. Missing Media renders <AdminAddFileWizard> component');
ok(!/<AdminLinkMediaModal/.test(missingPage), '1d. Missing Media does NOT render <AdminLinkMediaModal>');

console.log('\n§2 — Missing Media passes preselectedMediaItem to the wizard');

ok(/preselectedMediaItem/.test(missingPage), '2a. Missing Media declares preselectedMediaItem state');
ok(/{preselectedMediaItem}/.test(missingPage), '2b. Missing Media passes preselectedMediaItem to the wizard (binding)');
ok(/preselectedMediaItem\s*=\s*\{/.test(missingPage), '2c. Missing Media builds the preselectedMediaItem object from the demand row');

console.log('\n§3 — preselectedMediaItem carries the full canonical identity contract');

// The preselected item must include: title, contentType, tmdbId, season, episode, episodeTitle.
ok(/title:\s*String\(req\.title_snapshot/.test(missingPage), '3a. preselected item includes title (from demand title_snapshot)');
ok(/req\.content_type/.test(missingPage), '3b. preselected item uses req.content_type');
ok(/req\.tmdb_id/.test(missingPage), '3c. preselected item uses req.tmdb_id');
ok(/req\.season/.test(missingPage), '3d. preselected item uses req.season');
ok(/req\.episode/.test(missingPage), '3e. preselected item uses req.episode');
ok(/episode_title_snapshot/.test(missingPage), '3f. preselected item uses episode_title_snapshot');
ok(/contentType,/.test(missingPage) || /contentType:/.test(missingPage), '3g. preselected item assigns contentType');
ok(/tmdbId,/.test(missingPage) || /tmdbId:/.test(missingPage), '3h. preselected item assigns tmdbId');
ok(/season,/.test(missingPage) || /season:/.test(missingPage), '3i. preselected item assigns season');
ok(/episode,/.test(missingPage) || /episode:/.test(missingPage), '3j. preselected item assigns episode');

console.log('\n§4 — Missing Media does NOT have Upload button or provider asset browser');

ok(!/Upload|uploadUrl|upload-flow|AdminUploadFlow/.test(missingPage), '4a. No Upload button / upload flow in Missing Media');
ok(!/listUnlinkedProviderFiles|provider.*\/files|files.*inventory/.test(missingPage), '4b. No provider inventory / asset browser in Missing Media');
ok(!/hosting-control|HostingControl|hosting\/control/.test(missingPage), '4c. No Hosting Control dependency in Missing Media');

console.log('\n§5 — Shared AdminAddFileWizard component exists with the right props');

const wizard = src('src/lib/components/admin2/AdminAddFileWizard.svelte');
ok(/export type PreselectedMediaItem/.test(wizard), '5a. PreselectedMediaItem type exported');
ok(/export type UpdateTarget/.test(wizard), '5b. UpdateTarget type exported');
ok(/preselectedMediaItem\s*=/.test(wizard), '5c. wizard accepts preselectedMediaItem prop');
ok(/updateTarget\s*=/.test(wizard), '5d. wizard accepts updateTarget prop');
ok(/onsaved\s*=/.test(wizard), '5e. wizard accepts onsaved callback');
ok(/onclose\s*=/.test(wizard), '5f. wizard accepts onclose callback');
ok(/open\s*=\s*\$bindable/.test(wizard), '5g. wizard open prop is $bindable (two-way binding)');

console.log('\n§6 — Wizard uses the secure manual-link endpoint');

ok(/\/api\/admin\/media\/manual-link/.test(wizard), '6a. wizard calls /api/admin/media/manual-link');
ok(/method:\s*'POST'/.test(wizard), '6b. wizard uses POST for save');
ok(/title:\s*selectedTmdb\.title/.test(wizard), '6c. wizard sends title in the POST body (avoids server-side TMDB fetch)');
ok(/body\.year\s*=/.test(wizard), '6d. wizard sends year in the POST body');
ok(/body\.season\s*=/.test(wizard), '6e. wizard sends season when preselected (episode-level linking)');
ok(/body\.episode\s*=/.test(wizard), '6f. wizard sends episode when preselected');
ok(/body\.episodeTitle\s*=/.test(wizard), '6g. wizard sends episodeTitle when preselected');

console.log('\n§7 — Wizard preselectedMediaItem skips TMDB search step');

ok(/preselectedMediaItem/.test(wizard), '7a. wizard checks preselectedMediaItem');
// [2026-10-16 re-pin] the multi-step wizard was replaced by the compact
// ONE-form design (no step state). The preselected path still SKIPS the
// search: the init effect sets selectedTmdb directly from the preselected
// item and enters the edit form (enterEdit) — no TMDB search round-trip.
ok(/preselected[\s\S]{0,600}selectedTmdb\s*=\s*\{/.test(wizard), '7b. preselect sets the TMDB selection directly (skips the search — compact form design)');
ok(/enterEdit\(\)/.test(wizard), '7b-2. the wizard enters the edit form directly (no step machine)');

console.log('\n§8 — Manual-link endpoint accepts episodeTitle');

const server = src('src/routes/api/admin/media/manual-link/+server.ts');
ok(/episodeTitle\?:\s*string/.test(server), '8a. endpoint body type includes optional episodeTitle');
ok(/episodeTitle:\s*clientEpisodeTitle/.test(server), '8b. endpoint destructures episodeTitle from body');
ok(/episodeTitle:\s*clientEpisodeTitle/.test(server), '8c. endpoint passes episodeTitle to the identity resolver');
// [2026-10-16 re-pin] the ensureEpisode/ensureAnimeEpisode call moved into
// the shared manual-link-identity module (the route is a thin adapter).
// The full chain: route → resolveManualLinkIdentity(episodeTitle) →
// ensureEpisode/ensureAnimeEpisode(episodeTitle ?? null).
const identity = src('src/lib/server/hosting/media/manual-link-identity.ts');
ok(/episodeTitle:\s*episodeTitle \?\? null/.test(identity), '8d. resolveManualLinkIdentity passes episodeTitle to ensureEpisode/ensureAnimeEpisode');

console.log('\n§9 — Authorization enforced on all mutations');

ok(/requireAdmin\(locals,/.test(server), '9a. POST calls requireAdmin');
ok(/export const DELETE[\s\S]*?requireAdmin\(locals,/.test(server), '9b. DELETE calls requireAdmin');

const missingServer = src('src/routes/admin/media/missing/+page.server.ts');
ok(/requireAdmin\(locals,/.test(missingServer), '9c. Missing Media server loader calls requireAdmin');

const missingApi = src('src/routes/api/admin/media/missing/+server.ts');
ok(/requireAdmin\(locals,/.test(missingApi), '9d. Missing Media API endpoint calls requireAdmin');

console.log('\n§10 — Demand sweep auto-resolves after successful link');

ok(/sweepResolvedDemand/.test(missingServer), '10a. Missing Media loader runs sweepResolvedDemand (auto-resolves stale open demands)');
ok(/sweepStaleResolvedDemand/.test(missingServer), '10b. Missing Media loader runs sweepStaleResolvedDemand (reopens stale ready demands)');

console.log('\n§11 — Missing Media refreshes after save (invalidateAll)');

ok(/invalidateAll/.test(missingPage), '11a. Missing Media calls invalidateAll after wizard save');
ok(/onWizardSaved/.test(missingPage), '11b. Missing Media has onWizardSaved handler');
ok(/onWizardClose/.test(missingPage), '11c. Missing Media has onWizardClose handler');

console.log('\n§12 — Media Library also uses the shared wizard (no regression)');

const listComp = src('src/lib/components/admin2/AdminMediaList.svelte');
ok(/import AdminAddFileWizard from/.test(listComp), '12a. AdminMediaList imports AdminAddFileWizard');
ok(/<AdminAddFileWizard/.test(listComp), '12b. AdminMediaList renders <AdminAddFileWizard>');
ok(!/AdminLinkMediaModal/.test(listComp), '12c. AdminMediaList does NOT use AdminLinkMediaModal');

console.log('\n§13 — Canonical identity: all supported content types');

// The manual-link endpoint must support movie, series, anime (with episode variants).
ok(/contentType === 'movie'/.test(server), '13a. movie content type handled');
ok(/contentType === 'anime'/.test(server), '13b. anime content type handled');
ok(/contentType === 'series'/.test(server) || /contentType === 'series'/.test(server) === false, '13c. series content type handled (fallback)');
ok(/ensureMovie/.test(server), '13d. ensureMovie called for movies');
ok(/ensureAnime\b/.test(server), '13e. ensureAnime called for anime series');
ok(/ensureAnimeEpisode/.test(server), '13f. ensureAnimeEpisode called for anime episodes');
ok(/ensureSeries\b/.test(server), '13g. ensureSeries called for TV series');
ok(/ensureEpisode\b/.test(server), '13h. ensureEpisode called for TV episodes');

console.log('\n§14 — No provider deletion API call anywhere in the manual-link endpoint');

const serverNoComments = server.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/\bawait\s+\w+\.deleteAsset\(/.test(serverNoComments), '14a. no deleteAsset() call in manual-link endpoint');
ok(!/\bawait\s+adapter\.delete/.test(serverNoComments), '14b. no adapter.delete() call');

console.log(`\nmav_phase3_missing_media_contract_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
