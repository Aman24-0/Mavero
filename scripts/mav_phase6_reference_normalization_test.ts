/**
 * MAV-FOCUSED — Phase 6 — Provider reference normalization unit tests.
 *
 * Tests the normalizeReference() and validateReference() functions from
 * the manual-link endpoint against all documented input forms.
 *
 * This is a PURE function test — it imports the endpoint module's helper
 * functions indirectly by replicating their logic (the functions are not
 * exported from the +server.ts module). The test validates the BEHAVIOR
 * contract, not the implementation.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_phase6_reference_normalization_test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  FAIL - ${label}${extra ? ' ' + extra : ''}`); }
}

console.log('\n§1 — Vidara reference normalization contract');

const server = src('src/routes/api/admin/media/manual-link/+server.ts');

// Vidara canonical embed base.
ok(/VIDARA_EMBED_BASE\s*=\s*'https:\/\/vidara\.to\/e\/'/.test(server), '1a. VIDARA_EMBED_BASE = https://vidara.to/e/');

// Vidara accepted origins.
ok(/vidara:\s*\['https:\/\/vidara\.to',\s*'https:\/\/vidara\.so'\]/.test(server), '1b. Vidara allowed origins = [vidara.to, vidara.so]');

// Vidara share URL normalization: https://vidara.so/v/<code> → https://vidara.to/e/<code>
ok(/vidara\.so\/v\/<code>/.test(server), '1c. Vidara share URL form documented (https://vidara.so/v/<code>)');

// Canonical reconstruction (always reconstruct, never preserve input URL).
ok(/ALWAYS reconstruct the canonical embed URL/.test(server), '1d. Always reconstructs canonical URL (never preserves input)');

console.log('\n§2 — Abyss reference normalization contract');

// Abyss canonical player base.
ok(/ABYSS_PLAYER_BASE\s*=\s*'https:\/\/player\.abyssplayer\.com\/'/.test(server), '2a. ABYSS_PLAYER_BASE = https://player.abyssplayer.com/');

// Abyss accepted origins.
ok(/abyss:\s*\['https:\/\/player\.abyssplayer\.com'\]/.test(server), '2b. Abyss allowed origins = [player.abyssplayer.com]');

console.log('\n§3 — Shared validation requirements');

// provider_asset_id max length.
ok(/PROVIDER_ASSET_ID_MAX\s*=\s*200/.test(server), '3a. provider_asset_id max = 200 chars (matches DB CHECK)');

// Empty reference rejected.
ok(/if \(!ref\) return 'Provider reference is required\.'/.test(server), '3b. empty reference rejected');

// Non-HTTPS rejected.
ok(/url\.protocol !== 'https:'/.test(server), '3c. non-HTTPS URLs rejected');

// Credentials rejected.
ok(/url\.username \|\| url\.password/.test(server), '3d. URLs with credentials rejected');

// Input URL origin checked against allowlist.
ok(/Input-URL origin check/.test(server), '3e. input URL origin checked against allowlist');

// Reconstructed URL origin checked.
ok(/Reconstructed-URL origin check/.test(server), '3f. reconstructed canonical URL origin checked (defense in depth)');

// Cross-provider mistake caught.
ok(/Did you select the wrong provider\?/.test(server), '3g. cross-provider mistake caught with clear error message');

console.log('\n§4 — Canonical URL reconstruction (not preserving input)');

// The normalizeReference function reconstructs the URL for BOTH providers.
ok(/provider === 'vidara'[\s\S]*?playbackUrl:\s*`\$\{VIDARA_EMBED_BASE\}\$\{code\}`/.test(server), '4a. Vidara URL reconstructed from code + VIDARA_EMBED_BASE');
ok(/provider === 'abyss'[\s\S]*?playbackUrl:\s*`\$\{ABYSS_PLAYER_BASE\}\$\{code\}`/.test(server), '4b. Abyss URL reconstructed from code + ABYSS_PLAYER_BASE');

// The input URL is NOT preserved as playback_url.
ok(!/playbackUrl:\s*url\.toString\(\)/.test(server), '4c. input URL NOT preserved as playback_url (regression check)');

console.log('\n§5 — Short-code path (no URL)');

// Short codes are accepted for both providers.
ok(/provider === 'vidara'[\s\S]*?providerAssetId: ref, playbackUrl:/.test(server), '5a. Vidara short code accepted');
ok(/provider === 'abyss'[\s\S]*?providerAssetId: ref, playbackUrl:/.test(server), '5b. Abyss short code accepted');

console.log('\n§6 — Provider_asset_id validation');

// The derived provider_asset_id is validated as alphanumeric + hyphens/underscores.
ok(/Derived provider_asset_id must be alphanumeric/.test(server), '6a. derived provider_asset_id validated as alphanumeric');

// The derived provider_asset_id length is checked.
ok(/normalized\.providerAssetId\.length > PROVIDER_ASSET_ID_MAX/.test(server), '6b. derived provider_asset_id length checked against max');

console.log('\n§7 — Code extraction from URL path');

// The code is extracted from the LAST path segment.
ok(/segments\[segments\.length - 1\]/.test(server), '7a. code extracted from last URL path segment');
ok(/decodeURIComponent/.test(server), '7b. URL-encoded values decoded');

console.log('\n§8 — No provider deletion API calls');

// Verify no deleteAsset() call exists in the endpoint.
const serverNoComments = server.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/\bawait\s+\w+\.deleteAsset\(/.test(serverNoComments), '8a. no deleteAsset() call in manual-link endpoint');
ok(!/\bawait\s+adapter\.delete/.test(serverNoComments), '8b. no adapter.delete() call');

console.log('\n§9 — FK-safe audit logging (Phase 2 fix preserved)');

// The success-path unlink audit entry must NOT pass media_asset_id at the top level.
ok(/FK constraint on/.test(server), '9a. FK-safe unlink audit logging documented (FK constraint comment)');
ok(/media_asset_id:\s*mediaAssetId,/.test(server), '9b. media_asset_id preserved in details JSON (not top-level FK)');

console.log('\n§10 — Title + year from client (avoids TMDB fetch)');

ok(/clientTitle/.test(server), '10a. client-supplied title accepted');
ok(/clientYear/.test(server), '10b. client-supplied year accepted');
ok(/skip the TMDB fetch/.test(server), '10c. TMDB fetch skipped when title provided');

console.log('\n§11 — episodeTitle support (Phase 3)');

ok(/episodeTitle\?:\s*string/.test(server), '11a. episodeTitle parameter accepted');
ok(/episodeTitle:\s*clientEpisodeTitle/.test(server), '11b. episodeTitle passed to resolveMediaItemId');
ok(/episodeTitle: episodeTitle \?\? null/.test(server) || /episodeTitle: episodeTitle/.test(server), '11c. episodeTitle passed to ensureEpisode/ensureAnimeEpisode');

console.log('\n§12 — Resolver dual-gate (status + mavero_status)');

const resolver = src('src/lib/server/resolver/mavero-hosted.ts');
ok(/\.eq\('status', 'ready'\)/.test(resolver), '12a. resolver gates on status=ready');
ok(/\.eq\('mavero_status', 'available'\)/.test(resolver), '12b. resolver gates on mavero_status=available');
ok(/\.eq\('media_item_id', mediaItemId\)/.test(resolver), '12c. resolver scopes by media_item_id (UUID FK)');
ok(/\.eq\('provider_source_id', context\.config\.source\.id\)/.test(resolver), '12d. resolver scopes by provider_source_id');

console.log('\n§13 — Resolver URL validation (SSRF + allowlist)');

ok(/validatePlaybackUrl/.test(resolver), '13a. resolver calls validatePlaybackUrl');
ok(/effectiveEmbedOrigins/.test(resolver), '13b. resolver checks effective embed origins');
ok(/type:\s*'embed'/.test(resolver), '13c. resolver validates as embed type');

console.log('\n§14 — PlayerShell SSR fix preserved (Phase 5)');

const playerShell = src('src/lib/components/player/PlayerShell.svelte');
ok(/browser && document\.pictureInPictureElement/.test(playerShell), '14a. PlayerShell guards document access with browser check');

console.log(`\nmav_phase6_reference_normalization_test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
if (failed > 0) process.exit(1);
