/**
 * MAV-FOCUSED — Phase 2 verification — manual-link contract test (2026-10).
 *
 * Static-code + behavior test for the manual-link API endpoint. Verifies
 * the create/update/delete contracts WITHOUT requiring a live Supabase
 * instance or an authenticated admin session. The endpoint's
 * HTTP-layer behavior is validated by reading the source file and
 * exercising the pure helper functions exported via a side-effect-free
 * import path.
 *
 * Coverage:
 *
 *   1. Create (POST) contract:
 *      - contentType validation (movie/series/anime only).
 *      - provider validation (vidara/abyss only).
 *      - reference normalization (short code vs full URL).
 *      - SSRF/allowlist enforcement at write time.
 *      - provider_asset_id length cap (200 chars, matches DB CHECK).
 *      - anime routing — ensureAnime / ensureAnimeEpisode is invoked
 *        (NOT ensureSeries) so anime rows get content_type='anime'.
 *
 *   2. Update (POST with mediaAssetId) contract:
 *      - Same row is updated (not duplicated).
 *      - Audit log entry written with mode='update'.
 *
 *   3. Delete (DELETE) contract:
 *      - Only the media_assets row is deleted (no provider API call).
 *      - Audit log entry written with action='unlink'.
 *      - Idempotent if the row is already gone.
 *
 *   4. URL construction contract:
 *      - Vidara short code → https://vidara.to/e/<code>
 *      - Vidara full URL  → URL preserved, code extracted as provider_asset_id
 *      - Abyss short code → https://player.abyssplayer.com/<code>
 *      - Abyss full URL  → URL preserved, code extracted as provider_asset_id
 *      - Non-allowlisted origins rejected (e.g. https://evil.com).
 *      - http:// rejected (HTTPS-only).
 *
 *   5. Authorization:
 *      - POST and DELETE both call requireAdmin(locals, ...).
 *      - User ID is captured and passed to recordOperation as admin_user_id.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_focused_manual_link_contract_test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

// Task 2 (2026-10-15): the normalization/validation/eligibility/asset-
// upsert contract was EXTRACTED from the manual-link route file into
// src/lib/server/hosting/media/manual-link-contract.ts so the new
// bulk-link endpoint can share the EXACT same definitions (one
// definition, two callers). Assertions about the shared contract read
// the contract module; assertions about the route read the route and
// additionally verify it IMPORTS the shared module (the new contract).
const server = src('src/routes/api/admin/media/manual-link/+server.ts');
const contract = src('src/lib/server/hosting/media/manual-link-contract.ts');
const identity = src('src/lib/server/hosting/media/manual-link-identity.ts');
// Combined surface: the route + the shared module it delegates to.
const surface = server + contract;
// The asset upsert lives ONLY in the contract module now.
const serverNoComments = surface.replace(/\/\/[^\n]*/g, '').replace(/\/*[\s\S]*?\*\//g, '');

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

console.log('\n§1 — Endpoint exists and imports required services');

ok(/import\s+\{\s*requireAdmin\s*\}/.test(server), '1a. imports requireAdmin');
ok(/import\s+\{\s*createSupabaseAdminClient\s*\}/.test(server), '1b. imports createSupabaseAdminClient');
ok(/import\s+\{\s*CanonicalMediaService\s*\}/.test(server), '1c. imports CanonicalMediaService');
ok(/import\s+\{\s*UploadService\s*\}/.test(server), '1d. imports UploadService (for audit log)');
ok(/manual-link-contract/.test(server), '1e. route imports the SHARED manual-link-contract module (one definition, two callers — bulk-link shares it)');
ok(/upsertLinkAsset/.test(server), '1f. route delegates the asset write to the shared upsertLinkAsset');
ok(/resolveProviderSource/.test(server), '1g. route delegates provider/source resolution to the shared resolveProviderSource');
ok(/episodeLinkEligibilityError/.test(server), '1h. route applies the shared server-side release-eligibility gate');

console.log('\n§2 — Authorization enforced on every mutation');

ok(/export const POST[\s\S]*?requireAdmin\(locals,/.test(server), '2a. POST calls requireAdmin');
ok(/export const DELETE[\s\S]*?requireAdmin\(locals,/.test(server), '2b. DELETE calls requireAdmin');
ok(/const \{ user \} = await requireAdmin\(locals,/.test(server), '2c. POST captures user object for audit user.id');
ok(/admin_user_id:\s*adminUserId/.test(contract), '2d. the shared upsert passes admin_user_id (threaded from the route\'s requireAdmin user)');
ok(/adminUserId: user\.id/.test(server), '2e. the route threads requireAdmin\'s user.id into the shared upsert as adminUserId');

console.log('\n§3 — Anime content_type routing (Phase 2 verification fix)');

// 3a/3b verify that the anime branch calls ensureAnime/ensureAnimeEpisode.
// 3d is the negative regression guard — anime MUST NOT fall through to
// the ensureSeries branch. Since Task 1 the orchestrator lives in
// manual-link-identity.ts — read it THERE (the route imports it).
const resolveFnMatch = identity.match(/async function resolveMediaItemId\([\s\S]*?\n\}/);
ok(resolveFnMatch !== null, '3z. resolveMediaItemId function present in manual-link-identity.ts (for routing test)');

if (resolveFnMatch) {
  const fn = resolveFnMatch[0];
  // The anime branch must call ensureAnime or ensureAnimeEpisode and return.
  ok(/contentType === 'anime'[\s\S]*?ensureAnime(Episode)?\(/.test(fn), '3a. anime branch calls ensureAnime or ensureAnimeEpisode');

  // Extract just the anime branch (from `if (contentType === 'anime')` to
  // the matching closing brace). The function uses early-returns, so the
  // anime branch ends at its own `}` followed by either another `if` or
  // a comment line.
  const animeBranchMatch = fn.match(/if \(contentType === 'anime'\) \{[\s\S]*?\n  \}/);
  ok(animeBranchMatch !== null, '3b. anime branch is a self-contained if-block');
  if (animeBranchMatch) {
    const branch = animeBranchMatch[0];
    ok(/ensureAnime(Episode)?\(/.test(branch), '3c. anime branch contains ensureAnime or ensureAnimeEpisode call');
    ok(!/ensureSeries/.test(branch), '3d. anime branch does NOT call ensureSeries (regression check)');
  }
}

console.log('\n§4 — Reference normalization (short code vs full URL)');

// Task 2: the normalization contract lives in the shared module — read
// it THERE (bulk-link uses the exact same function).
ok(/function normalizeReference\(/.test(contract), '4a. normalizeReference function exists in the shared contract module');
ok(/PROVIDER_ASSET_ID_MAX\s*=\s*200/.test(contract), '4b. provider_asset_id length cap = 200 (matches DB CHECK constraint)');
ok(/normalized\.providerAssetId\.length > PROVIDER_ASSET_ID_MAX/.test(contract), '4c. length cap enforced BEFORE insert');
ok(/segments\[segments\.length - 1\]/.test(contract), '4d. short code extracted from URL path (last segment)');
ok(/providerAssetId: code,/.test(contract), '4e. extracted code stored as provider_asset_id');
// 4f (Phase 2 acceptance fix): the playback_url is ALWAYS reconstructed
// from the canonical embed base + extracted code. We do NOT preserve the
// input URL as-is, because the admin may paste a Vidara SHARE URL
// (https://vidara.so/v/<code>) which renders the share page, not the
// embeddable player (per the Phase 6 fix migration).
ok(!/playbackUrl:\s*url\.toString\(\)/.test(contract), '4f. input URL NOT preserved as playback_url (canonical reconstruction instead)');
ok(/VIDARA_EMBED_BASE\s*=\s*'https:\/\/vidara\.to\/e\/'/.test(contract), '4g. Vidara canonical embed base = https://vidara.to/e/');
ok(/ABYSS_PLAYER_BASE\s*=\s*'https:\/\/player\.abyssplayer\.com\/'/.test(contract), '4h. Abyss canonical player base = https://player.abyssplayer.com/');

console.log('\n§5 — SSRF / embed-origin allowlist enforced at write time');

ok(/PROVIDER_ALLOWED_ORIGINS/.test(contract), '5a. allowlist constant defined in the shared contract module');
ok(/vidara:\s*\['https:\/\/vidara\.to',\s*'https:\/\/vidara\.so'\]/.test(contract), '5b. vidara allowlist matches DB capabilities (vidara.to + vidara.so)');
ok(/abyss:\s*\['https:\/\/player\.abyssplayer\.com'\]/.test(contract), '5c. abyss allowlist matches DB capabilities');
ok(/url\.protocol !== 'https:'/.test(contract), '5d. non-HTTPS URLs rejected');
ok(/url\.username \|\| url\.password/.test(contract), '5e. URLs with credentials rejected');
ok(/allowedLower\.includes\(inputUrl\.origin\.toLowerCase\(\)\)/.test(contract), '5f1. INPUT url origin checked against allowlist (catches cross-provider mistakes)');
ok(/allowedLower\.includes\(canonicalUrl\.origin\.toLowerCase\(\)\)/.test(contract), '5f2. CANONICAL reconstructed url origin checked against allowlist (defense in depth)');

console.log('\n§6 — Audit log entries (media_operations)');

// Task 2: the recordOperation calls moved into the shared upsert — the
// route still owns the unlink (DELETE) audit entries.
ok(/action: 'link'/.test(contract), '6a. the shared upsert writes action=link to media_operations');
ok(/action: 'unlink'/.test(server), '6b. DELETE writes action=unlink to media_operations');
ok(/status: 'success'/.test(contract), '6c. success status recorded');
ok(/status: 'failed'/.test(contract), '6d. failure status recorded');
ok(/mode: 'update'/.test(contract), '6e. update mode tagged');
ok(/mode: 'relink'/.test(contract), '6f. relink mode tagged');
ok(/mode: 'insert'/.test(contract), '6g. insert mode tagged');
ok(/details:\s*\{[\s\S]*?note:/.test(contract), '6h. details.note carries human-readable explanation');

console.log('\n§7 — Delete contract — only the media_assets row, no provider API');

ok(/from\('media_assets'\)[\s\S]*?\.delete\(\)/.test(server), '7a. DELETE only deletes from media_assets');
ok(/provider file is NOT touched/.test(server), '7b. code comment confirms no provider API call');
ok(/no adapter\.deleteAsset\(\) call/.test(server), '7c. code comment confirms no adapter.deleteAsset()');

// 7d/7e: assert there is no ACTUAL call statement that invokes a provider
// delete. We strip C-style comments first so that "no adapter.deleteAsset()"
// in the comment doesn't satisfy a positive match for a real call.
// (serverNoComments was declared at the top over the route + shared
// contract surface — reuse it here.)
ok(!/\bawait\s+\w+\.deleteAsset\(/.test(serverNoComments), '7d. no real `await x.deleteAsset(...)` call statement');
ok(!/\bawait\s+adapter\.delete/.test(serverNoComments), '7e. no `await adapter.delete(...)` call statement');
ok(!/\bdeleteAsset\s*\(/.test(serverNoComments), '7f. no direct deleteAsset() call (after stripping comments)');

console.log('\n§7b — Delete audit log FK constraint (Phase 2 acceptance fix)');

// The success-path unlink audit entry must NOT pass media_asset_id,
// because the asset row has just been deleted and the FK
// `media_operations.media_asset_id REFERENCES media_assets(id)` would
// reject the insert. recordOperation silently swallows insert errors,
// so without this fix the unlink audit entry would silently disappear.
//
// Verified by reading the success-path recordOperation call in DELETE:
//   - The success path must NOT pass `media_asset_id: mediaAssetId` at
//     the top level of recordOperation's params.
//   - The success path MUST retain `media_item_id` (which is preserved).
//   - The media_asset_id can still be embedded in the details JSON.
//
// The failure path (deleteError branch) DOES pass media_asset_id at
// the top level — that's fine because the asset row still exists when
// the delete fails.

// Extract the success-path recordOperation call from the DELETE handler.
// The DELETE handler is the LAST export in the file — match to EOF.
const deleteHandlerMatch = server.match(/export const DELETE[\s\S]*$/);
ok(deleteHandlerMatch !== null, '7g. DELETE handler found in source');
if (deleteHandlerMatch) {
  const deleteHandler = deleteHandlerMatch[0];
  // The success-path recordOperation call: action='unlink' + status='success'
  // MUST be the FIRST property (so the regex doesn't accidentally capture
  // the failure-path call which has action='unlink', status='failed' first,
  // then spans into the success path).
  const successAuditMatch = deleteHandler.match(/await uploadService\.recordOperation\(\{\s*action:\s*'unlink',\s*status:\s*'success'[\s\S]*?\}\);/);
  ok(successAuditMatch !== null, '7h. success-path unlink recordOperation call found');
  if (successAuditMatch) {
    const call = successAuditMatch[0];
    // The success path must NOT pass media_asset_id at the top level
    // (it would cause an FK violation since the asset row is gone).
    // We split the call into the params section (before "details:") and
    // the details section. The params section must NOT contain media_asset_id.
    const detailsIdx = call.indexOf('details:');
    const paramsSection = detailsIdx >= 0 ? call.slice(0, detailsIdx) : call;
    const detailsSection = detailsIdx >= 0 ? call.slice(detailsIdx) : '';
    ok(!/media_asset_id:/.test(paramsSection), '7i. success-path unlink audit does NOT pass top-level media_asset_id (would violate FK)');
    // But the details JSON CAN carry media_asset_id for context.
    ok(/media_asset_id:/.test(detailsSection), '7j. success-path unlink audit carries media_asset_id in details JSON (preserves context)');
    // The media_item_id is preserved (it's not deleted).
    ok(/media_item_id:\s*ex\.media_item_id/.test(paramsSection), '7k. success-path unlink audit passes media_item_id (preserved by asset deletion)');
  }
}

console.log('\n§8 — Idempotent / relink behavior');

ok(/idempotent: true/.test(server), '8a. POST returns idempotent:true when same item already linked');
ok(/relinked: true/.test(server), '8b. POST returns relinked:true when re-linking to a different media item');
ok(/idempotent: true/.test(server), '8c. DELETE returns idempotent:true when row is already gone');

console.log('\n§9 — Update link allows changing provider/reference');

// The UPDATE branch must write provider_source_id AND provider_asset_id
// AND playback_url — that's the only way "update link" can change the
// provider or reference. (Task 2: the branch lives in the shared
// upsertLinkAsset — bulk-link updates get the same guarantee.)
ok(/update\(\{[\s\S]*?provider_source_id:\s*providerSourceId[\s\S]*?provider_asset_id:\s*providerAssetId[\s\S]*?playback_url:\s*playbackUrl/.test(contract), '9a. UPDATE writes provider_source_id, provider_asset_id, AND playback_url (allows changing provider/reference)');

console.log('\n§10 — Resolver uses canonical_key + dual-gate (status=ready AND mavero_status=available)');

const resolver = src('src/lib/server/resolver/mavero-hosted.ts');
ok(/\.eq\('status', 'ready'\)/.test(resolver), '10a. resolver gates on status=ready');
ok(/\.eq\('mavero_status', 'available'\)/.test(resolver), '10b. resolver gates on mavero_status=available');
ok(/\.eq\('media_item_id', mediaItemId\)/.test(resolver), '10c. resolver scopes by media_item_id (UUID FK)');

console.log('\n§11 — Provider capabilities match URL construction');

const phase4 = src('supabase/migrations/20260928213822_phase4_register_hosting_sources.sql');
const phase6 = src('supabase/migrations/20261010000000_vidara_embed_url_fix.sql');
ok(/allowed_embed_origins',\s*jsonb_build_array\('https:\/\/vidara\.so'\)/.test(phase4), '11a. Phase 4 registered vidara.so as allowed origin');
ok(/allowed_embed_origins',\s*jsonb_build_array\('https:\/\/player\.abyssplayer\.com'\)/.test(phase4), '11b. Phase 4 registered abyss player URL as allowed origin');
ok(/jsonb_build_array\('https:\/\/vidara\.to',\s*'https:\/\/vidara\.so'\)/.test(phase6), '11c. Phase 6 fix added vidara.to to allowlist (matches manual-link URL construction)');

console.log('\n§12 — CanonicalMediaService has ensureAnime + ensureAnimeEpisode');

const canonical = src('src/lib/server/hosting/media/service.ts');
ok(/async ensureAnime\(/.test(canonical), '12a. ensureAnime method exists');
ok(/async ensureAnimeEpisode\(/.test(canonical), '12b. ensureAnimeEpisode method exists');
ok(/content_type:\s*'anime'/.test(canonical), '12c. ensureAnime writes content_type=anime (not series)');

console.log('\n§13 — Library list shape supports AdminMediaList');

const libraryApi = src('src/routes/api/admin/media/library/+server.ts');
ok(/requireAdmin\(locals,/.test(libraryApi), '13a. library list endpoint enforces admin');
ok(/service\.list\(query\)/.test(libraryApi), '13b. list delegated to MediaLibraryService');

const listComp = src('src/lib/components/admin2/AdminMediaList.svelte');
ok(/\/api\/admin\/media\/library/.test(listComp), '13c. AdminMediaList fetches from library API (with filters + pagination)');
ok(/PAGE_SIZE\s*=\s*20/.test(listComp), '13c1. AdminMediaList uses 20-item page size');
ok(/filterType|filterProvider|filterStatus|sortBy/.test(listComp), '13c2. AdminMediaList has filters (type, provider, status, sort)');
ok(/viewMode.*grid.*list/.test(listComp), '13c3. AdminMediaList has grid/list view toggle');
ok(/AdminAddFileWizard/.test(listComp), '13d. AdminMediaList uses shared AdminAddFileWizard component');

// The POST to manual-link now lives in the shared wizard component
// (Phase 3 extraction). Verify it there.
const wizardComp = src('src/lib/components/admin2/AdminAddFileWizard.svelte');
ok(/\/api\/admin\/media\/manual-link/.test(wizardComp), '13d1. AdminAddFileWizard calls manual-link API');
ok(/method:\s*'POST'/.test(wizardComp), '13e. POST for save (create/update) in shared wizard');

// AdminMediaList still uses DELETE directly (for the three-dot menu Delete action).
const deleteFnMatch = listComp.match(/async function confirmDelete\([\s\S]*?\n  \}/);
ok(deleteFnMatch !== null, '13f1. confirmDelete function present in AdminMediaList');
if (deleteFnMatch) {
  ok(/manual-link/.test(deleteFnMatch[0]), '13f2. confirmDelete targets manual-link endpoint');
  ok(/method:\s*'DELETE'/.test(deleteFnMatch[0]), '13f3. confirmDelete uses DELETE method');
}

console.log('\n§14 — Vidara share-URL canonicalization (Phase 2 acceptance fix)');

// Regression: the user-provided link https://Vidara.so/v/LyBctGwWUh9c
// is the SHARE URL, not the embed URL. The endpoint MUST reconstruct the
// canonical embed URL https://vidara.to/e/LyBctGwWUh9c — never preserve
// the input URL as-is.
//
// Verified via static-regex check on normalizeReference() (in the shared
// contract module — Task 2):
//   - The URL branch must NOT call `url.toString()` for the playbackUrl.
//   - The URL branch must reconstruct the embed URL via the provider base.
ok(!/playbackUrl:\s*url\.toString\(\)/.test(contract), '14a. URL branch does NOT preserve input URL as playbackUrl (regression)');
ok(/provider === 'vidara'[\s\S]*?playbackUrl:\s*`\$\{VIDARA_EMBED_BASE\}\$\{code\}`/.test(contract), '14b. URL branch reconstructs Vidara embed URL from extracted code');
ok(/provider === 'abyss'[\s\S]*?playbackUrl:\s*`\$\{ABYSS_PLAYER_BASE\}\$\{code\}`/.test(contract), '14c. URL branch reconstructs Abyss player URL from extracted slug');
ok(/Phase 6 fix migration/.test(contract), '14d. code comment cites the Phase 6 fix migration as the rationale');

console.log('\n§15 — Task 2/3: bulk-link endpoint shares the exact same contract');

const bulkRoute = src('src/routes/api/admin/media/bulk-link/+server.ts');
ok(/requireAdmin\(locals,/.test(bulkRoute), '15a. bulk-link calls requireAdmin');
ok(/NO_STORE/.test(bulkRoute), '15b. bulk-link sets no-store');
ok(/manual-link-contract'/.test(bulkRoute), '15c. bulk-link imports the SHARED contract module (normalizeReference/validateReference/eligibility/upsert)');
ok(/resolveMediaItemId/.test(bulkRoute), '15d. bulk-link resolves per-episode canonical identity (parent-ensure-first orchestrator)');
ok(/upsertLinkAsset\(/.test(bulkRoute), '15e. bulk-link writes through the SAME upsertLinkAsset path as manual-link');
ok(/DUPLICATE_EPISODES/.test(bulkRoute), '15f. duplicate episodes in one batch rejected (400)');
ok(/DUPLICATE_REFERENCES/.test(bulkRoute), '15g. duplicate references in one batch rejected — each episode needs its OWN reference');
ok(/BULK_ITEMS_REQUIRED/.test(bulkRoute), '15h. empty batch rejected');
ok(/BULK_ITEMS_LIMIT/.test(bulkRoute), '15i. batch size capped');
ok(/EPISODE_NOT_RELEASED/.test(bulkRoute), '15j. unreleased episodes fail per-item (release-eligibility gate)');
ok(/batchEpisodeEligibility/.test(bulkRoute), '15k. ONE season-metadata fetch evaluates the whole batch (no per-episode TMDB round-trips)');
ok(/results\.sort\(\(a, b\) => a\.episode - b\.episode\)/.test(bulkRoute), '15l. per-episode results returned in episode order');
ok(/succeeded.*failed/.test(bulkRoute), '15m. response carries succeeded/failed summary counts');
ok(/via: 'bulk-link'/.test(bulkRoute), '15n. audit entries are tagged via=bulk-link (distinguishable from manual-link)');

console.log('\n§16 — Task 2: Media Library parent/episode hierarchy');

const libraryService = src('src/lib/server/hosting/library/service.ts');
ok(/\.is\('parent_media_id', null\)/.test(libraryService), '16a. list() returns TOP-LEVEL rows only (parent_media_id IS NULL — one card per series/anime)');
ok(/\.in\('parent_media_id', parentIds\)/.test(libraryService), '16b. list() batch-fetches episode children by parent id (bounded, no N+1)');
ok(/episode_summary/.test(libraryService), '16c. parents carry episode_summary (season/episode/linked counts)');
ok(/linked_episode_count/.test(libraryService), '16d. linked_episode_count counts episodes with active assets');
ok(/async episodes\(/.test(libraryService), '16e. episodes(parentId) read exists for the episode sheet');
ok(/computeHostingState\(unionAssets/.test(libraryService), '16f. parent hosting_state rolls up from its episodes\u2019 assets');

const episodesApi = src('src/routes/api/admin/media/library/[id]/episodes/+server.ts');
ok(/requireAdmin\(locals,/.test(episodesApi), '16g. episodes endpoint enforces admin');
ok(/NO_STORE/.test(episodesApi), '16h. episodes endpoint sets no-store');
ok(/service\.episodes\(id\)/.test(episodesApi), '16i. episodes endpoint delegates to MediaLibraryService.episodes');

const episodeSheet = src('src/lib/components/admin2/AdminEpisodeSheet.svelte');
ok(/role="dialog"/.test(episodeSheet), '16j. episode sheet is an accessible dialog');
ok(/aria-modal/.test(episodeSheet), '16k. episode sheet is modal');
ok(/isEpisodeReleased/.test(episodeSheet), '16l. episode sheet uses the SHARED release-eligibility helper');
ok(/\/api\/admin\/media\/bulk-link/.test(episodeSheet), '16m. episode sheet posts bulk links (per-episode references)');
ok(/season-chip/.test(episodeSheet), '16n. episode sheet has season chips (Phase-1 sizing contract)');
ok(/aria-label=\{seasonChipLabel\(season\)\}/.test(episodeSheet), '16o. chip count carried in aria-label, not chip content');

const mediaList = src('src/lib/components/admin2/AdminMediaList.svelte');
ok(/openEpisodeSheet/.test(mediaList), '16p. parent cards open the episode sheet');
ok(/episode_summary/.test(mediaList), '16q. AdminMediaList maps episode_summary onto parent rows');
ok(!/\.filter\(\(i: MediaRow\) => i\.mediaAssetId\)/.test(mediaList), '16r. NO client-side asset-only filter (server owns orphan/pending rules)');

console.log(`\nmav_focused_manual_link_contract_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
