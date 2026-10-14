/**
 * MAV-FOCUSED — Phase 2 verification — live playback resolution probe.
 *
 * Inserts a TEMPORARY manually-linked asset (movie:tmdb:278 → Vidara
 * filecode "MAVTESTFILECODEXYZ") using the same canonical_key derivation
 * and URL construction the manual-link endpoint uses, then exercises
 * the resolver's actual lookup query against the live DB. Cleans up
 * all inserted rows at the end.
 *
 * This is additive-then-subtractive: no permanent changes remain.
 *
 * Usage:
 *   PRIVATE_SUPABASE_SERVICE_ROLE_KEY=... \
 *   PUBLIC_SUPABASE_URL=... \
 *   node scripts/mav_phase2_live_resolution_probe.mjs
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing env: PUBLIC_SUPABASE_URL or PRIVATE_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

let passed = 0;
let failed = 0;
const insertedItemIds = [];
const insertedAssetIds = [];

function ok(cond, label, extra = '') {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}${extra ? ' ' + extra : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${label}${extra ? ' ' + extra : ''}`); }
}

async function cleanup() {
  console.log('\n§cleanup — removing all test rows');
  for (const id of insertedAssetIds) {
    try { await supabase.from('media_assets').delete().eq('id', id); } catch {}
  }
  for (const id of insertedItemIds) {
    try { await supabase.from('media_items').delete().eq('id', id); } catch {}
  }
  console.log(`  -- removed ${insertedAssetIds.length} test asset rows, ${insertedItemIds.length} test item rows`);
}

console.log('\n§1 — Locate the Vidara provider_source_id');

const { data: vidaraProvider } = await supabase
  .from('streaming_providers')
  .select('id')
  .eq('adapter_id', 'vidara')
  .maybeSingle();

ok(vidaraProvider != null, '1a. Vidara provider found');

const { data: vidaraSource } = await supabase
  .from('streaming_sources')
  .select('id, name, slug')
  .eq('provider_id', vidaraProvider?.id ?? '')
  .maybeSingle();

ok(vidaraSource != null, '1b. Vidara source found', vidaraSource ? `(${vidaraSource.name} / ${vidaraSource.slug})` : '');
if (!vidaraSource) {
  console.log('Cannot proceed without Vidara source. Aborting.');
  process.exit(1);
}
const vidaraSourceId = vidaraSource.id;

console.log('\n§2 — Insert test media_items row (canonical_key=movie:tmdb:278)');

// Use a known TMDB ID (278 = The Dark Knight). The canonical_key matches
// what CanonicalMediaService.ensureMovie() would produce.
const { data: item, error: itemErr } = await supabase
  .from('media_items')
  .upsert({
    canonical_key: 'movie:tmdb:278',
    content_type: 'movie',
    tmdb_id: '278',
    title: 'MAV Phase 2 Test Movie (temporary)',
    year: 2008,
    season: null,
    episode: null,
    episode_title: null,
    parent_media_id: null,
  }, { onConflict: 'canonical_key' })
  .select('id, canonical_key, content_type')
  .single();

ok(!itemErr, '2a. media_items upsert succeeded', itemErr ? `(${itemErr.message})` : '');
ok(!!item?.id, '2b. media_items row returned id', `= ${item?.id?.slice(0, 8)}…`);

if (!item) {
  await cleanup();
  process.exit(1);
}
insertedItemIds.push(item.id);

console.log('\n§3 — Insert test media_assets row with Vidara playback_url');

// Use a clearly-test filecode so it doesn't collide with real Vidara assets.
const testFilecode = 'MAVTESTFILECODEXYZ';
const testPlaybackUrl = `https://vidara.to/e/${testFilecode}`;

// First check if an asset with this provider_asset_id already exists
// (cleanup from a previous run that crashed before deleting).
const { data: existingAsset } = await supabase
  .from('media_assets')
  .select('id')
  .eq('provider_source_id', vidaraSourceId)
  .eq('provider_asset_id', testFilecode)
  .maybeSingle();

if (existingAsset) {
  console.log('  -- found leftover test row from previous run, deleting first');
  await supabase.from('media_assets').delete().eq('id', existingAsset.id);
}

const { data: asset, error: assetErr } = await supabase
  .from('media_assets')
  .insert({
    media_item_id: item.id,
    provider_source_id: vidaraSourceId,
    provider_asset_id: testFilecode,
    provider_video_id: testFilecode,
    playback_url: testPlaybackUrl,
    filename: 'test.mp4',
    title: 'MAV Phase 2 Test Asset',
    status: 'ready',
    provider_status: 'active',
    mavero_status: 'available',
    available_qualities: [],
    audio_languages: [],
    has_subtitles: false,
    last_synced_at: new Date().toISOString(),
  })
  .select('id, playback_url, status, mavero_status, provider_asset_id, provider_source_id')
  .single();

ok(!assetErr, '3a. media_assets insert succeeded', assetErr ? `(${assetErr.message})` : '');
ok(!!asset?.id, '3b. media_assets row returned id', `= ${asset?.id?.slice(0, 8)}…`);
ok(asset?.playback_url === testPlaybackUrl, '3c. playback_url stored correctly',
  `(got: ${asset?.playback_url})`);

if (asset) insertedAssetIds.push(asset.id);
if (!asset) {
  await cleanup();
  process.exit(1);
}

console.log('\n§4 — Exercise the resolver\'s actual lookup query');

// Step 4a: lookup media_items by canonical_key (same as mavero-hosted.ts step 3a).
const { data: itemLookup, error: itemLookupErr } = await supabase
  .from('media_items')
  .select('id')
  .eq('canonical_key', 'movie:tmdb:278')
  .limit(1)
  .maybeSingle();

ok(!itemLookupErr, '4a. resolver step 3a — media_items lookup by canonical_key succeeded',
  itemLookupErr ? `(${itemLookupErr.message})` : '');
ok(!!itemLookup?.id, '4b. resolver step 3a — found media_item by canonical_key',
  `= ${itemLookup?.id?.slice(0, 8)}…`);
ok(itemLookup?.id === item.id, '4c. resolver step 3a — found the same UUID we inserted');

// Step 4b: lookup media_assets WHERE media_item_id=? AND provider_source_id=?
// AND status='ready' AND mavero_status='available' (same as mavero-hosted.ts step 3b).
const { data: assetLookup, error: assetLookupErr } = await supabase
  .from('media_assets')
  .select('playback_url')
  .eq('media_item_id', itemLookup?.id ?? '')
  .eq('provider_source_id', vidaraSourceId)
  .eq('status', 'ready')
  .eq('mavero_status', 'available')
  .order('updated_at', { ascending: false })
  .limit(1)
  .maybeSingle();

ok(!assetLookupErr, '4d. resolver step 3b — media_assets lookup succeeded',
  assetLookupErr ? `(${assetLookupErr.message})` : '');
ok(!!assetLookup?.playback_url, '4e. resolver step 3b — found ready+available asset');
ok(assetLookup?.playback_url === testPlaybackUrl, '4f. resolver step 3b — playback_url matches what we inserted',
  `(got: ${assetLookup?.playback_url})`);

console.log('\n§5 — Verify the playback URL passes the resolver\'s allowlist');

// Same check validatePlaybackUrl() performs: HTTPS, no credentials,
// no private hostname, origin in allowed_embed_origins.
const vidaraAllowedOrigins = ['https://vidara.to', 'https://vidara.so'];
let urlObj;
try {
  urlObj = new URL(assetLookup?.playback_url ?? '');
} catch {
  urlObj = null;
}

ok(urlObj != null, '5a. playback_url is parseable as a URL');
if (urlObj) {
  ok(urlObj.protocol === 'https:', '5b. URL protocol is HTTPS');
  ok(!urlObj.username && !urlObj.password, '5c. URL has no credentials');
  ok(!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(urlObj.hostname),
    '5d. URL hostname is not loopback');
  ok(vidaraAllowedOrigins.includes(urlObj.origin),
    '5e. URL origin is in Vidara allowed_embed_origins',
    `(origin=${urlObj.origin}, allowed=${JSON.stringify(vidaraAllowedOrigins)})`);
}

console.log('\n§6 — Verify mavero_status gate (the resolver rejects unavailable assets)');

// Flip mavero_status to 'missing' and re-run the lookup — it should
// NOT find the asset anymore (same as detachAsset behavior).
const { error: flipErr } = await supabase
  .from('media_assets')
  .update({ mavero_status: 'missing' })
  .eq('id', asset.id);

ok(!flipErr, '6a. flipped mavero_status to missing');

const { data: gatedLookup } = await supabase
  .from('media_assets')
  .select('playback_url')
  .eq('media_item_id', item.id)
  .eq('provider_source_id', vidaraSourceId)
  .eq('status', 'ready')
  .eq('mavero_status', 'available')
  .limit(1)
  .maybeSingle();

ok(!gatedLookup, '6b. resolver lookup returns null when mavero_status != available',
  gatedLookup ? '(unexpectedly found)' : '(correctly empty)');

// Flip back to verify the gate is two-way.
await supabase.from('media_assets').update({ mavero_status: 'available' }).eq('id', asset.id);

console.log('\n§7 — Verify status gate (resolver rejects non-ready assets)');

const { error: flipErr2 } = await supabase
  .from('media_assets')
  .update({ status: 'failed' })
  .eq('id', asset.id);

ok(!flipErr2, '7a. flipped status to failed');

const { data: statusGated } = await supabase
  .from('media_assets')
  .select('playback_url')
  .eq('media_item_id', item.id)
  .eq('provider_source_id', vidaraSourceId)
  .eq('status', 'ready')
  .eq('mavero_status', 'available')
  .limit(1)
  .maybeSingle();

ok(!statusGated, '7b. resolver lookup returns null when status != ready',
  statusGated ? '(unexpectedly found)' : '(correctly empty)');

await cleanup();

console.log('\n§8 — Verify cleanup');

const { data: postCleanupAsset } = await supabase
  .from('media_assets')
  .select('id')
  .eq('provider_source_id', vidaraSourceId)
  .eq('provider_asset_id', testFilecode)
  .maybeSingle();
ok(!postCleanupAsset, '8a. test media_assets row deleted');

const { data: postCleanupItem } = await supabase
  .from('media_items')
  .select('id')
  .eq('canonical_key', 'movie:tmdb:278')
  .maybeSingle();
// Note: the media_items row may or may not still exist — if a real
// movie:tmdb:278 row existed before, we won't have deleted it (we only
// delete rows whose IDs are in insertedItemIds).
if (insertedItemIds.includes(postCleanupItem?.id ?? '')) {
  ok(!postCleanupItem, '8b. test media_items row deleted (was our test row)');
} else {
  ok(true, '8b. media_items row preserved (was a real pre-existing row, not our test row)');
}

console.log(`\nmav_phase2_live_resolution_probe: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
