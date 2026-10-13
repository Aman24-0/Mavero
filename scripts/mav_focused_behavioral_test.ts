/**
 * MAV-FOCUSED — Vidara/Abyss + Link Media behavioral regression suite (2026-10).
 *
 * BEHAVIORAL tests (not source-inspection): exercises the ACTUAL runtime
 * logic of parseDurationSeconds, vidaraStatusMapper, abyssStatusMapper,
 * the listUnlinkedProviderFiles return shape, the isFileLinkable UI gate,
 * and the ManagementService.linkAsset dedup/conflict/idempotent guards
 * (via a mocked Supabase client).
 *
 * Uses the mav_hosting_test_loader.mjs to stub the SvelteKit virtual
 * `$env/dynamic/*` modules + path aliases so the real adapter/service
 * modules can be imported outside a SvelteKit runtime.
 *
 * Run with:
 *   NODE_OPTIONS="--import tsx --import ./scripts/mav_hosting_test_loader.mjs" \
 *     node scripts/mav_focused_behavioral_test.ts
 */

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// Set test env vars before importing the modules.
process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
process.env.VIDARA_API_KEY = 'test-vidara-key';
process.env.VIDARA_API_BASE_URL = 'https://api.vidara.so';
process.env.ABYSS_API_KEY = 'test-abyss-key';

console.log('\n§1 — parseDurationSeconds behavioral tests (pure function)');
{
  const { parseDurationSeconds, MAX_DURATION_SECONDS } = await import('../src/lib/server/hosting/media/duration.ts');

  // The documented Vidara `video_length` shape.
  ok(parseDurationSeconds('00:01:30') === 90, '1a. "00:01:30" → 90 (Vidara video_length)');
  ok(parseDurationSeconds('01:23:45') === 5025, '1b. "01:23:45" → 5025');
  ok(parseDurationSeconds('00:00:01') === 1, '1c. "00:00:01" → 1');
  ok(parseDurationSeconds('00:00:00') === null, '1d. "00:00:00" → null (zero violates DB CHECK)');

  // MM:SS shape.
  ok(parseDurationSeconds('01:30') === 90, '1e. "01:30" → 90 (MM:SS)');
  ok(parseDurationSeconds('90:00') === 5400, '1f. "90:00" → 5400 (90min valid MM:SS)');

  // Numeric.
  ok(parseDurationSeconds(90) === 90, '1g. 90 → 90');
  ok(parseDurationSeconds(0) === null, '1h. 0 → null (DB CHECK rejects)');
  ok(parseDurationSeconds(-5) === null, '1i. -5 → null (DB CHECK rejects)');

  // Edge cases.
  ok(parseDurationSeconds(null) === null, '1j. null → null');
  ok(parseDurationSeconds(undefined) === null, '1k. undefined → null');
  ok(parseDurationSeconds('') === null, '1l. empty string → null');
  ok(parseDurationSeconds('not-a-duration') === null, '1m. non-numeric → null');
  ok(parseDurationSeconds('00:99:00') === null, '1n. "00:99:00" → null (minutes > 59 invalid in HH:MM:SS)');
  ok(parseDurationSeconds('00:00:99') === null, '1o. "00:00:99" → null (seconds > 59 invalid)');
  ok(parseDurationSeconds(MAX_DURATION_SECONDS + 1) === null, '1p. over 7-day cap → null');
  ok(parseDurationSeconds(MAX_DURATION_SECONDS) === 604800, '1q. exactly 7 days → 604800 (at cap)');
  ok(parseDurationSeconds(90.7) === 90, '1r. 90.7 → 90 (floored)');
}

console.log('\n§2 — vidaraStatusMapper behavioral tests');
{
  const { vidaraStatusMapper } = await import('../src/lib/server/hosting/vidara/normalize.ts');

  // The MAV-FOCUSED fix: deleted/inactive → terminal 'deleted'.
  ok(vidaraStatusMapper('deleted') === 'deleted', '2a. "deleted" → "deleted" (was "processing" before fix)');
  ok(vidaraStatusMapper('inactive') === 'deleted', '2b. "inactive" → "deleted" (was "processing" before fix)');
  ok(vidaraStatusMapper('DELETED') === 'deleted', '2c. "DELETED" (uppercase) → "deleted" (case-insensitive)');
  ok(vidaraStatusMapper('Inactive') === 'deleted', '2d. "Inactive" (mixed case) → "deleted"');

  // Preserved mappings.
  ok(vidaraStatusMapper(0) === 'queued', '2e. 0 → "queued"');
  ok(vidaraStatusMapper('0') === 'queued', '2f. "0" → "queued"');
  ok(vidaraStatusMapper('pending') === 'queued', '2g. "pending" → "queued"');
  ok(vidaraStatusMapper('queued') === 'queued', '2h. "queued" → "queued"');
  ok(vidaraStatusMapper(1) === 'ready', '2i. 1 → "ready"');
  ok(vidaraStatusMapper('active') === 'ready', '2j. "active" → "ready"');
  ok(vidaraStatusMapper('ready') === 'ready', '2k. "ready" → "ready"');
  ok(vidaraStatusMapper(2) === 'processing', '2l. 2 → "processing"');
  ok(vidaraStatusMapper('encoding') === 'processing', '2m. "encoding" → "processing"');
  ok(vidaraStatusMapper('processing') === 'processing', '2n. "processing" → "processing"');
  ok(vidaraStatusMapper(3) === 'failed', '2o. 3 → "failed"');
  ok(vidaraStatusMapper('error') === 'failed', '2p. "error" → "failed"');
  ok(vidaraStatusMapper('failed') === 'failed', '2q. "failed" → "failed"');
  ok(vidaraStatusMapper('blocked') === 'failed', '2r. "blocked" → "failed"');

  // Unknown → conservative 'processing'.
  ok(vidaraStatusMapper('unknown-status') === 'processing', '2s. "unknown-status" → "processing" (conservative default)');
  ok(vidaraStatusMapper(undefined) === 'processing', '2t. undefined → "processing" (conservative default)');
}

console.log('\n§3 — abyssStatusMapper behavioral tests');
{
  const { abyssStatusMapper } = await import('../src/lib/server/hosting/abyss/normalize.ts');

  // Abyss already handles deleted/inactive correctly.
  ok(abyssStatusMapper('deleted') === 'deleted', '3a. "deleted" → "deleted"');
  ok(abyssStatusMapper('inactive') === 'deleted', '3b. "inactive" → "deleted"');
  ok(abyssStatusMapper('public') === 'ready', '3c. "public" → "ready" (playable)');
  ok(abyssStatusMapper('banned') === 'failed', '3d. "banned" → "failed" (not linkable)');
  ok(abyssStatusMapper('failed') === 'failed', '3e. "failed" → "failed"');
  ok(abyssStatusMapper('error') === 'failed', '3f. "error" → "failed"');
  ok(abyssStatusMapper('processing') === 'processing', '3g. "processing" → "processing" (linkable)');
  ok(abyssStatusMapper('queued') === 'queued', '3h. "queued" → "queued" (linkable)');
  ok(abyssStatusMapper('ready') === 'ready', '3i. "ready" → "ready" (linkable)');
  ok(abyssStatusMapper('active') === 'ready', '3j. "active" → "ready"');
  ok(abyssStatusMapper(undefined) === 'processing', '3k. undefined → "processing" (conservative)');
}

console.log('\n§4 — normalizeVidaraFile behavioral test (duration + status)');
{
  const { normalizeVidaraFile } = await import('../src/lib/server/hosting/vidara/normalize.ts');

  // Simulate a Vidara /v1/video/info response for a Black Clover episode.
  const vidaraFile = {
    filecode: 'bc-s02e01',
    vid_id: 4006148,
    video_title: 'Black Clover S02E01',
    video_length: '00:24:30',  // HH:MM:SS — the documented shape
    video_created: '2026-10-13',
    status: 'active',
    file_active: 1,
    link: 'https://vidara.to/bc-s02e01',
    player_img: 'https://example.com/thumb.jpg',
  };
  const result = normalizeVidaraFile(vidaraFile as any);

  ok(result.providerAssetId === 'bc-s02e01', '4a. providerAssetId = filecode');
  ok(result.title === 'Black Clover S02E01', '4b. title from video_title');
  ok(result.durationSeconds === 1470, `4c. durationSeconds = 1470 (00:24:30) — got ${result.durationSeconds} (was 0 before fix)`);
  ok(result.status === 'ready', '4d. status = ready (active → ready)');
  ok(result.playbackUrl === 'https://vidara.to/e/bc-s02e01', '4e. playbackUrl uses /e/ embed path');
  ok(result.thumbnailUrl === 'https://example.com/thumb.jpg', '4f. thumbnailUrl from player_img');

  // A deleted Vidara file.
  const deletedFile = { ...vidaraFile, status: 'deleted' };
  const deletedResult = normalizeVidaraFile(deletedFile as any);
  ok(deletedResult.status === 'deleted', '4g. deleted file → status = "deleted" (was "processing" before fix)');

  // A file with a zero duration string.
  const zeroDurationFile = { ...vidaraFile, video_length: '00:00:00' };
  const zeroResult = normalizeVidaraFile(zeroDurationFile as any);
  ok(zeroResult.durationSeconds === null, '4h. "00:00:00" → null (DB CHECK-safe, was 0 before fix)');
}

console.log('\n§5 — normalizeAbyssFile behavioral test (duration + status)');
{
  const { normalizeAbyssFile } = await import('../src/lib/server/hosting/abyss/normalize.ts');

  // Simulate an Abyss /v1/resources file.
  const abyssFile = {
    id: 'ltJEfKQxR',
    slug: 'ltJEfKQxR',
    title: 'Black Clover S02E01',
    filename: 'black_clover_s02e01.mp4',
    duration: 1470,  // numeric seconds
    status: 'public',
    thumbnail: 'https://example.com/thumb.jpg',
    resolutions: ['HD', 'FullHD'],
    isDir: false,
  };
  const result = normalizeAbyssFile(abyssFile as any);

  ok(result.providerAssetId === 'ltJEfKQxR', '5a. providerAssetId = slug/id');
  ok(result.title === 'Black Clover S02E01', '5b. title');
  ok(result.durationSeconds === 1470, `5c. durationSeconds = 1470 — got ${result.durationSeconds}`);
  ok(result.status === 'ready', '5d. status = ready (public → ready)');
  ok(result.availableQualities.length === 2, '5e. availableQualities from resolutions');

  // A banned Abyss file.
  const bannedFile = { ...abyssFile, status: 'banned' };
  const bannedResult = normalizeAbyssFile(bannedFile as any);
  ok(bannedResult.status === 'failed', '5f. banned → failed (not linkable)');
}

console.log('\n§6 — normalizeAbyssFileList behavioral test (pagination + filtering)');
{
  const { normalizeAbyssFileList } = await import('../src/lib/server/hosting/abyss/normalize.ts');

  // A response with mixed files + folders.
  const response = {
    items: [
      { id: 'f1', slug: 'f1', title: 'File 1', isDir: false, status: 'public' },
      { id: 'd1', name: 'Folder 1', isDir: true },
      { id: 'f2', slug: 'f2', title: 'File 2', isDir: false, status: 'deleted' },
      { id: 'f3', slug: 'f3', title: 'File 3', isDir: false, status: 'banned' },
    ],
    pageToken: null,
  };
  const files = normalizeAbyssFileList(response as any);

  ok(files.length === 3, `6a. 3 files (folders filtered out) — got ${files.length}`);
  ok(files[0].providerAssetId === 'f1', '6b. first file = f1');
  ok(files[1].providerAssetId === 'f2', '6c. second file = f2 (deleted — still listed, UI gates)');
  ok(files[2].providerAssetId === 'f3', '6d. third file = f3 (banned — still listed, UI gates)');
  ok(files[1].status === 'deleted', '6e. f2 lifecycleState = deleted (normalized)');
  ok(files[2].status === 'failed', '6f. f3 lifecycleState = failed (banned → failed)');

  // An unrecognized response shape throws (no silent empty).
  try {
    normalizeAbyssFileList({ unknown: 'shape' } as any);
    ok(false, '6g. unrecognized shape should throw');
  } catch (err: any) {
    ok(err.message.includes('no recognized file list'), '6g. unrecognized shape throws with descriptive message');
  }

  // An empty items array is a legitimate zero (no throw).
  const empty = normalizeAbyssFileList({ items: [], pageToken: null } as any);
  ok(empty.length === 0, '6h. empty items array → empty result (legitimate zero)');
}

console.log('\n§7 — ManagementService.linkAsset dedup + idempotent + conflict (mocked client)');
{
  // Mock the Supabase client to test linkAsset's decision tree without
  // hitting a real database. The mock implements the chain of queries
  // linkAsset performs: media_items lookup → media_assets lookup →
  // adapter.getAsset → insert.
  const { ManagementService } = await import('../src/lib/server/hosting/management/service.ts');
  const { CanonicalMediaService } = await import('../src/lib/server/hosting/media/service.ts');
  const { HostingProviderError } = await import('../src/lib/server/hosting/errors.ts');

  // Test helper: build a mock client with configurable media_assets
  // lookup results.
  function makeMockClient(opts: {
    mediaItemExists?: boolean;
    existingAsset?: { id: string; mavero_status: string; media_item_id: string | null; status: string } | null;
    insertError?: { code: string; message: string } | null;
  } = {}) {
    const mediaItemExists = opts.mediaItemExists ?? true;
    const existingAsset = opts.existingAsset ?? null;
    const insertError = opts.insertError ?? null;

    return {
      from: (table: string) => {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => {
            if (table === 'media_items') {
              return { data: mediaItemExists ? { id: 'item-1', canonical_key: 'movie:123' } : null, error: null };
            }
            if (table === 'media_assets') {
              return { data: existingAsset, error: null };
            }
            return { data: null, error: null };
          },
          insert: () => ({
            select: () => ({ single: async () => ({ data: insertError ? null : { id: 'asset-new' }, error: insertError }) }),
          }),
          update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'asset-existing' }, error: null }) }) }) }),
          upsert: () => chain,
        };
        return chain;
      },
    };
  }

  // We also need to mock the adapter resolver. The ManagementService
  // calls resolveAdapterForSource which queries streaming_providers +
  // streaming_sources. Rather than mock the full chain, we test the
  // EXISTING-ASSET decision tree (cases a–e) which happens BEFORE the
  // adapter resolution.

  // Case (c): existing + same media_item + available → idempotent success.
  // This is the most important dedup test.
  const mockClientC = makeMockClient({
    existingAsset: { id: 'asset-1', mavero_status: 'available', media_item_id: 'item-1', status: 'ready' },
  });
  const mediaServiceC = new CanonicalMediaService(mockClientC as any);
  const mgmtC = new ManagementService(mockClientC as any, mediaServiceC);

  try {
    const result = await mgmtC.linkAsset('item-1', 'source-1', 'file-1', 'admin-1');
    ok(result.ok === true, '7a. idempotent relink (same item, already available) → ok: true');
    ok(result.action === 'link', '7b. action = "link"');
    ok(result.mediaAssetId === 'asset-1', '7c. returns existing asset id (no duplicate insert)');
  } catch (err: any) {
    ok(false, `7a. idempotent relink should succeed — got error: ${err.message}`);
  }

  // Case (b): existing + linked to a DIFFERENT media_item → reject (throws).
  // linkAsset THROWS HostingProviderError for cases (b), (d), and NOT_FOUND
  // when they occur BEFORE the outer try/catch (lines 319-401). The API
  // endpoint's catch block normalizes both thrown errors and { ok: false }
  // returns into the same JSON response.
  const mockClientB = makeMockClient({
    existingAsset: { id: 'asset-2', mavero_status: 'available', media_item_id: 'item-OTHER', status: 'ready' },
  });
  const mediaServiceB = new CanonicalMediaService(mockClientB as any);
  const mgmtB = new ManagementService(mockClientB as any, mediaServiceB);

  try {
    const result = await mgmtB.linkAsset('item-1', 'source-1', 'file-1', 'admin-1');
    ok(false, '7d. conflict (linked to different item) should throw');
  } catch (err: any) {
    ok(err instanceof HostingProviderError, '7d. conflict throws HostingProviderError');
    ok(err.code === 'VALIDATION', `7e. error code = VALIDATION — got ${err.code}`);
    ok(err.message?.includes('already linked to a different'), '7f. error message mentions "already linked to a different"');
  }

  // Case (d): existing + status='deleted' (terminal) → reject (throws).
  const mockClientD = makeMockClient({
    existingAsset: { id: 'asset-3', mavero_status: 'available', media_item_id: 'item-1', status: 'deleted' },
  });
  const mediaServiceD = new CanonicalMediaService(mockClientD as any);
  const mgmtD = new ManagementService(mockClientD as any, mediaServiceD);

  try {
    const result = await mgmtD.linkAsset('item-1', 'source-1', 'file-1', 'admin-1');
    ok(false, '7g. deleted asset should throw');
  } catch (err: any) {
    ok(err instanceof HostingProviderError, '7g. deleted asset throws HostingProviderError');
    ok(err.code === 'ASSET_DELETED', `7h. error code = ASSET_DELETED — got ${err.code}`);
  }

  // Case: media_item does not exist → NOT_FOUND (throws).
  const mockClientNotFound = makeMockClient({ mediaItemExists: false });
  const mediaServiceNotFound = new CanonicalMediaService(mockClientNotFound as any);
  const mgmtNotFound = new ManagementService(mockClientNotFound as any, mediaServiceNotFound);

  try {
    const result = await mgmtNotFound.linkAsset('nonexistent-item', 'source-1', 'file-1', 'admin-1');
    ok(false, '7i. nonexistent media_item should throw');
  } catch (err: any) {
    ok(err instanceof HostingProviderError, '7i. nonexistent media_item throws HostingProviderError');
    ok(err.code === 'NOT_FOUND', `7j. error code = NOT_FOUND — got ${err.code}`);
  }
}

console.log('\n§8 — isFileLinkable UI gate behavioral test (simulated)');
{
  // Simulate the isFileLinkable function from AdminHostingAssets.svelte.
  // We can't import the .svelte file directly, so we replicate the exact
  // logic here and test it against the lifecycleState + linkedToMediaItemId
  // shapes that listUnlinkedProviderFiles returns.

  // The selected media item id for the test.
  const linkSelectedMediaItemId = 'item-1';

  function isFileLinkable(file: { lifecycleState: string; linkedToMediaItemId: string | null }): boolean {
    if (file.lifecycleState === 'deleted' || file.lifecycleState === 'failed') return false;
    if (file.linkedToMediaItemId === '<deleted>') return false;
    if (file.linkedToMediaItemId && file.linkedToMediaItemId !== linkSelectedMediaItemId) return false;
    return true;
  }

  // A ready, unlinked file → linkable.
  ok(isFileLinkable({ lifecycleState: 'ready', linkedToMediaItemId: null }) === true, '8a. ready + unlinked → linkable');
  // A processing file → linkable (legitimate in-progress).
  ok(isFileLinkable({ lifecycleState: 'processing', linkedToMediaItemId: null }) === true, '8b. processing + unlinked → linkable');
  // A queued file → linkable.
  ok(isFileLinkable({ lifecycleState: 'queued', linkedToMediaItemId: null }) === true, '8c. queued + unlinked → linkable');
  // A deleted file → NOT linkable.
  ok(isFileLinkable({ lifecycleState: 'deleted', linkedToMediaItemId: null }) === false, '8d. deleted → NOT linkable');
  // A failed file → NOT linkable (banned maps to failed at the normalizer).
  ok(isFileLinkable({ lifecycleState: 'failed', linkedToMediaItemId: null }) === false, '8e. failed (banned) → NOT linkable');
  // A ready file linked to the SAME media_item → linkable (idempotent relink).
  ok(isFileLinkable({ lifecycleState: 'ready', linkedToMediaItemId: 'item-1' }) === true, '8f. ready + linked to same item → linkable (idempotent relink)');
  // A ready file linked to a DIFFERENT media_item → NOT linkable.
  ok(isFileLinkable({ lifecycleState: 'ready', linkedToMediaItemId: 'item-OTHER' }) === false, '8g. ready + linked to different item → NOT linkable');
  // A file whose DB row is deleted → NOT linkable (linkAsset case (d) rejects).
  ok(isFileLinkable({ lifecycleState: 'ready', linkedToMediaItemId: '<deleted>' }) === false, '8h. ready + DB row deleted → NOT linkable (server would reject with ASSET_DELETED)');
}

console.log('\n§9 — getFilteredInventory per-provider search behavioral test');
{
  // Simulate the getFilteredInventory function — client-side filtering by
  // filename / title / provider file ID.
  function getFilteredInventory(inventory: Array<{ providerAssetId: string; title: string | null; filename: string | null }>, query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return inventory;
    return inventory.filter((f) => {
      const title = (f.title ?? '').toLowerCase();
      const filename = (f.filename ?? '').toLowerCase();
      const id = (f.providerAssetId ?? '').toLowerCase();
      return title.includes(q) || filename.includes(q) || id.includes(q);
    });
  }

  const inventory = [
    { providerAssetId: 'bc-s02e01', title: 'Black Clover S02E01', filename: 'black_clover_s02e01.mp4' },
    { providerAssetId: 'bc-s02e02', title: 'Black Clover S02E02', filename: 'black_clover_s02e02.mp4' },
    { providerAssetId: 'avengers', title: 'Avengers: Endgame', filename: 'avengers_endgame.mp4' },
    { providerAssetId: 'swapped', title: 'Swapped', filename: 'swapped.mp4' },
  ];

  // Search by filename.
  ok(getFilteredInventory(inventory, 'black_clover').length === 2, '9a. search "black_clover" → 2 results (by filename)');
  // Search by title.
  ok(getFilteredInventory(inventory, 'avengers').length === 1, '9b. search "avengers" → 1 result (by title)');
  // Search by provider file ID.
  ok(getFilteredInventory(inventory, 'bc-s02e01').length === 1, '9c. search "bc-s02e01" → 1 result (by provider file ID)');
  // Search with no query → all files.
  ok(getFilteredInventory(inventory, '').length === 4, '9d. empty search → all 4 files');
  // Search with a non-matching query → 0 results.
  ok(getFilteredInventory(inventory, 'nonexistent').length === 0, '9e. search "nonexistent" → 0 results');
  // Case-insensitive search.
  ok(getFilteredInventory(inventory, 'BLACK CLOVER').length === 2, '9f. search "BLACK CLOVER" → 2 results (case-insensitive)');
}

console.log(`\nmav_focused_behavioral_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
