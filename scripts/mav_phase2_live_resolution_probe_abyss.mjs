/**
 * MAV-FOCUSED — Phase 2 verification — live playback resolution probe (Abyss).
 *
 * Mirror of mav_phase2_live_resolution_probe.mjs but for Abyss.
 * Inserts a TEMPORARY manually-linked asset (series:tmdb:1396 → Abyss
 * slug "MAVTESTABYSSSLUG") and exercises the resolver's lookup query.
 * Cleans up all inserted rows at the end.
 *
 * Usage:
 *   PRIVATE_SUPABASE_SERVICE_ROLE_KEY=... \
 *   PUBLIC_SUPABASE_URL=... \
 *   node scripts/mav_phase2_live_resolution_probe_abyss.mjs
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

console.log('\n§1 — Locate the Abyss provider_source_id');

const { data: abyssProvider } = await supabase
  .from('streaming_providers')
  .select('id, capabilities')
  .eq('adapter_id', 'abyss')
  .maybeSingle();

ok(abyssProvider != null, '1a. Abyss provider found');
const origins = abyssProvider?.capabilities?.allowed_embed_origins ?? [];
ok(Array.isArray(origins) && origins.includes('https://player.abyssplayer.com'),
  '1b. Abyss capabilities include https://player.abyssplayer.com',
  `(got: ${JSON.stringify(origins)})`);

const { data: abyssSource } = await supabase
  .from('streaming_sources')
  .select('id, name, slug')
  .eq('provider_id', abyssProvider?.id ?? '')
  .maybeSingle();

ok(abyssSource != null, '1c. Abyss source found', abyssSource ? `(${abyssSource.name} / ${abyssSource.slug})` : '');
if (!abyssSource) {
  console.log('Cannot proceed without Abyss source. Aborting.');
  process.exit(1);
}
const abyssSourceId = abyssSource.id;

console.log('\n§2 — Insert test media_items row (canonical_key=series:tmdb:1396)');

// TMDB 1396 = Breaking Bad. canonical_key matches CanonicalMediaService.ensureSeries.
const { data: item, error: itemErr } = await supabase
  .from('media_items')
  .upsert({
    canonical_key: 'series:tmdb:1396',
    content_type: 'series',
    tmdb_id: '1396',
    title: 'MAV Phase 2 Test Series (temporary)',
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

if (!item) { await cleanup(); process.exit(1); }
insertedItemIds.push(item.id);

console.log('\n§3 — Insert test media_assets row with Abyss playback_url');

const testSlug = 'MAVTESTABYSSSLUG';
const testPlaybackUrl = `https://player.abyssplayer.com/${testSlug}`;

const { data: existingAsset } = await supabase
  .from('media_assets')
  .select('id')
  .eq('provider_source_id', abyssSourceId)
  .eq('provider_asset_id', testSlug)
  .maybeSingle();

if (existingAsset) {
  console.log('  -- found leftover test row from previous run, deleting first');
  await supabase.from('media_assets').delete().eq('id', existingAsset.id);
}

const { data: asset, error: assetErr } = await supabase
  .from('media_assets')
  .insert({
    media_item_id: item.id,
    provider_source_id: abyssSourceId,
    provider_asset_id: testSlug,
    provider_video_id: testSlug,
    playback_url: testPlaybackUrl,
    filename: 'test.mp4',
    title: 'MAV Phase 2 Test Asset (Abyss)',
    status: 'ready',
    provider_status: 'active',
    mavero_status: 'available',
    available_qualities: [],
    audio_languages: [],
    has_subtitles: false,
    last_synced_at: new Date().toISOString(),
  })
  .select('id, playback_url, status, mavero_status, provider_asset_id')
  .single();

ok(!assetErr, '3a. media_assets insert succeeded', assetErr ? `(${assetErr.message})` : '');
ok(!!asset?.id, '3b. media_assets row returned id', `= ${asset?.id?.slice(0, 8)}…`);
ok(asset?.playback_url === testPlaybackUrl, '3c. playback_url stored correctly',
  `(got: ${asset?.playback_url})`);

if (asset) insertedAssetIds.push(asset.id);
if (!asset) { await cleanup(); process.exit(1); }

console.log('\n§4 — Exercise the resolver\'s lookup query');

const { data: itemLookup, error: itemLookupErr } = await supabase
  .from('media_items')
  .select('id')
  .eq('canonical_key', 'series:tmdb:1396')
  .limit(1)
  .maybeSingle();

ok(!itemLookupErr, '4a. resolver step 3a — media_items lookup by canonical_key succeeded',
  itemLookupErr ? `(${itemLookupErr.message})` : '');
ok(!!itemLookup?.id, '4b. resolver step 3a — found media_item by canonical_key',
  `= ${itemLookup?.id?.slice(0, 8)}…`);

const { data: assetLookup, error: assetLookupErr } = await supabase
  .from('media_assets')
  .select('playback_url')
  .eq('media_item_id', itemLookup?.id ?? '')
  .eq('provider_source_id', abyssSourceId)
  .eq('status', 'ready')
  .eq('mavero_status', 'available')
  .order('updated_at', { ascending: false })
  .limit(1)
  .maybeSingle();

ok(!assetLookupErr, '4c. resolver step 3b — media_assets lookup succeeded',
  assetLookupErr ? `(${assetLookupErr.message})` : '');
ok(!!assetLookup?.playback_url, '4d. resolver step 3b — found ready+available asset');
ok(assetLookup?.playback_url === testPlaybackUrl, '4e. resolver step 3b — playback_url matches',
  `(got: ${assetLookup?.playback_url})`);

console.log('\n§5 — Verify the playback URL passes the Abyss allowlist');

const abyssAllowedOrigins = ['https://player.abyssplayer.com'];
let urlObj;
try { urlObj = new URL(assetLookup?.playback_url ?? ''); } catch { urlObj = null; }

ok(urlObj != null, '5a. playback_url is parseable');
if (urlObj) {
  ok(urlObj.protocol === 'https:', '5b. URL protocol is HTTPS');
  ok(!urlObj.username && !urlObj.password, '5c. URL has no credentials');
  ok(abyssAllowedOrigins.includes(urlObj.origin),
    '5d. URL origin is in Abyss allowed_embed_origins',
    `(origin=${urlObj.origin}, allowed=${JSON.stringify(abyssAllowedOrigins)})`);
}

console.log('\n§6 — Verify mavero_status + status gates');

await supabase.from('media_assets').update({ mavero_status: 'missing' }).eq('id', asset.id);
const { data: gated1 } = await supabase
  .from('media_assets')
  .select('playback_url')
  .eq('media_item_id', item.id)
  .eq('provider_source_id', abyssSourceId)
  .eq('status', 'ready')
  .eq('mavero_status', 'available')
  .limit(1)
  .maybeSingle();
ok(!gated1, '6a. mavero_status=missing → resolver returns null', gated1 ? '(unexpectedly found)' : '(correctly empty)');

await supabase.from('media_assets').update({ mavero_status: 'available', status: 'failed' }).eq('id', asset.id);
const { data: gated2 } = await supabase
  .from('media_assets')
  .select('playback_url')
  .eq('media_item_id', item.id)
  .eq('provider_source_id', abyssSourceId)
  .eq('status', 'ready')
  .eq('mavero_status', 'available')
  .limit(1)
  .maybeSingle();
ok(!gated2, '6b. status=failed → resolver returns null', gated2 ? '(unexpectedly found)' : '(correctly empty)');

await cleanup();

console.log('\n§7 — Verify cleanup');

const { data: postAsset } = await supabase
  .from('media_assets')
  .select('id')
  .eq('provider_source_id', abyssSourceId)
  .eq('provider_asset_id', testSlug)
  .maybeSingle();
ok(!postAsset, '7a. test media_assets row deleted');

const { data: postItem } = await supabase
  .from('media_items')
  .select('id, title')
  .eq('canonical_key', 'series:tmdb:1396')
  .maybeSingle();
ok(!postItem || postItem.title?.startsWith('MAV Phase 2 Test') === false,
  '7b. no leftover test media_items row with our test title',
  postItem ? `(found title: ${postItem.title})` : '(no row)');

console.log(`\nmav_phase2_live_resolution_probe_abyss: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
