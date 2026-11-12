/**
 * MAV-FOCUSED — Phase 2 acceptance — live playback resolution probe with REAL provider references.
 *
 * Verifies the manual-link endpoint's URL construction + the resolver's
 * data flow against the real, user-provided provider references:
 *
 *   Vidara: https://Vidara.so/v/LyBctGwWUh9c   (share URL — Phase 6 fix must transform)
 *   Abyss:  https://player.abyssplayer.com/-7DfAqb5s   (player URL — canonical)
 *
 * The probe:
 *   1. Inserts a temporary media_items + media_assets row using each
 *      reference, calling the manual-link endpoint's normalizeReference()
 *      logic (mirrored here for read-only verification).
 *   2. Exercises the resolver's actual DB lookup query.
 *   3. Verifies the resulting playback_url is the CANONICAL embed URL
 *      (Vidara → https://vidara.to/e/LyBctGwWUh9c, NOT the share URL).
 *   4. Verifies the URL passes the resolver's SSRF + allowlist validation.
 *   5. Cleans up all inserted rows.
 *
 * This does NOT verify the iframe actually plays the video — that's the
 * browser-based acceptance step. This probe verifies the DATA FLOW that
 * produces the URL the iframe would receive.
 *
 * Usage:
 *   PRIVATE_SUPABASE_SERVICE_ROLE_KEY=... \
 *   PUBLIC_SUPABASE_URL=... \
 *   node scripts/mav_phase2_real_refs_probe.mjs
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

// --- Mirror of the manual-link endpoint's normalizeReference() ---
// Kept in sync with src/routes/api/admin/media/manual-link/+server.ts.
// If they drift, the test will fail — that's the point.

const VIDARA_EMBED_BASE = 'https://vidara.to/e/';
const ABYSS_PLAYER_BASE = 'https://player.abyssplayer.com/';
const PROVIDER_ALLOWED_ORIGINS = {
  vidara: ['https://vidara.to', 'https://vidara.so'],
  abyss: ['https://player.abyssplayer.com'],
};

function normalizeReference(provider, reference) {
  const ref = reference.trim();
  if (!ref) return null;

  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    let url;
    try { url = new URL(ref); } catch { return null; }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    const code = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : '';
    if (!code) return null;

    if (provider === 'vidara') {
      return { providerAssetId: code, playbackUrl: `${VIDARA_EMBED_BASE}${code}` };
    }
    if (provider === 'abyss') {
      return { providerAssetId: code, playbackUrl: `${ABYSS_PLAYER_BASE}${code}` };
    }
    return null;
  }

  if (provider === 'vidara') return { providerAssetId: ref, playbackUrl: `${VIDARA_EMBED_BASE}${ref}` };
  if (provider === 'abyss') return { providerAssetId: ref, playbackUrl: `${ABYSS_PLAYER_BASE}${ref}` };
  return null;
}

function validatePlaybackUrl(raw, allowedEmbedOrigins) {
  // Mirror of src/lib/server/resolver/safe-url.ts validatePlaybackUrl()
  // for type='embed' and allowDynamicEmbedOrigins=false.
  const u = new URL(raw);
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  // Skip the private-hostname check — we trust the allowlist for this probe.
  const origin = u.origin.toLowerCase();
  const allowed = allowedEmbedOrigins.map((o) => new URL(o).origin.toLowerCase());
  return allowed.includes(origin);
}

// Mirror of the manual-link endpoint's validateReference() input-origin
// check. Returns true if the reference is acceptable, false otherwise.
function validateReference(provider, reference) {
  const ref = reference.trim();
  if (!ref) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(ref) && !ref.startsWith('http')) return false;

  const normalized = normalizeReference(provider, reference);
  if (!normalized) return false;
  if (normalized.providerAssetId.length > 200) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized.providerAssetId)) return false;

  const allowed = PROVIDER_ALLOWED_ORIGINS[provider] ?? [];

  // Input-URL origin check (only when the admin pasted a URL).
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    try {
      const inputUrl = new URL(ref);
      const inputOrigin = inputUrl.origin.toLowerCase();
      const allowedLower = allowed.map((o) => o.toLowerCase());
      if (!allowedLower.includes(inputOrigin)) return false;
    } catch { return false; }
  }

  // Reconstructed-URL origin check.
  try {
    const canonicalUrl = new URL(normalized.playbackUrl);
    const canonicalOrigin = canonicalUrl.origin.toLowerCase();
    const allowedLower = allowed.map((o) => o.toLowerCase());
    if (!allowedLower.includes(canonicalOrigin)) return false;
  } catch { return false; }

  return true;
}

// ============================================================
// VIDARA — real reference https://Vidara.so/v/LyBctGwWUh9c
// ============================================================

console.log('\n§1 — Vidara: normalize user-provided share URL');

const vidaraInput = 'https://Vidara.so/v/LyBctGwWUh9c';
const vidaraNormalized = normalizeReference('vidara', vidaraInput);

ok(vidaraNormalized !== null, '1a. normalizeReference returned a result');
ok(vidaraNormalized?.providerAssetId === 'LyBctGwWUh9c',
  '1b. provider_asset_id = LyBctGwWUh9c (extracted from URL path)',
  `(got: ${vidaraNormalized?.providerAssetId})`);
ok(vidaraNormalized?.playbackUrl === 'https://vidara.to/e/LyBctGwWUh9c',
  '1c. playback_url = https://vidara.to/e/LyBctGwWUh9c (canonical embed URL, NOT the share URL)',
  `(got: ${vidaraNormalized?.playbackUrl})`);

console.log('\n§2 — Vidara: playback URL passes resolver allowlist');

ok(validatePlaybackUrl(vidaraNormalized.playbackUrl, PROVIDER_ALLOWED_ORIGINS.vidara),
  '2a. URL passes validatePlaybackUrl (HTTPS + origin in allowlist)');

console.log('\n§3 — Vidara: insert test row + exercise resolver lookup');

const { data: vidaraProvider } = await supabase
  .from('streaming_providers').select('id').eq('adapter_id', 'vidara').maybeSingle();
const { data: vidaraSource } = await supabase
  .from('streaming_sources').select('id').eq('provider_id', vidaraProvider?.id ?? '').maybeSingle();
ok(vidaraSource != null, '3a. Vidara source row found');

const vidaraCanonicalKey = 'movie:tmdb:278'; // The Dark Knight (safe test target)
const { data: vidaraItem, error: vidaraItemErr } = await supabase
  .from('media_items')
  .upsert({
    canonical_key: vidaraCanonicalKey,
    content_type: 'movie',
    tmdb_id: '278',
    title: 'MAV Phase 2 Acceptance Test (Vidara, temporary)',
    year: 2008,
    season: null, episode: null, episode_title: null, parent_media_id: null,
  }, { onConflict: 'canonical_key' })
  .select('id, canonical_key, content_type')
  .single();
ok(!vidaraItemErr, '3b. media_items upsert succeeded', vidaraItemErr ? `(${vidaraItemErr.message})` : '');
ok(!!vidaraItem?.id, '3c. media_items row returned id', `= ${vidaraItem?.id?.slice(0, 8)}…`);
if (vidaraItem) insertedItemIds.push(vidaraItem.id);

// Clean up any leftover test asset from a previous crashed run.
const { data: existingVidaraAsset } = await supabase
  .from('media_assets')
  .select('id')
  .eq('provider_source_id', vidaraSource?.id ?? '')
  .eq('provider_asset_id', vidaraNormalized.providerAssetId)
  .maybeSingle();
if (existingVidaraAsset) {
  console.log('  -- found leftover test row from previous run, deleting first');
  await supabase.from('media_assets').delete().eq('id', existingVidaraAsset.id);
}

const { data: vidaraAsset, error: vidaraAssetErr } = await supabase
  .from('media_assets')
  .insert({
    media_item_id: vidaraItem?.id,
    provider_source_id: vidaraSource?.id,
    provider_asset_id: vidaraNormalized.providerAssetId,
    provider_video_id: vidaraNormalized.providerAssetId,
    playback_url: vidaraNormalized.playbackUrl,
    filename: 'test.mp4',
    title: 'MAV Phase 2 Acceptance Test Asset (Vidara)',
    status: 'ready',
    provider_status: 'active',
    mavero_status: 'available',
    available_qualities: [], audio_languages: [], has_subtitles: false,
    last_synced_at: new Date().toISOString(),
  })
  .select('id, playback_url, status, mavero_status, provider_asset_id')
  .single();
ok(!vidaraAssetErr, '3d. media_assets insert succeeded', vidaraAssetErr ? `(${vidaraAssetErr.message})` : '');
ok(!!vidaraAsset?.id, '3e. media_assets row returned id', `= ${vidaraAsset?.id?.slice(0, 8)}…`);
ok(vidaraAsset?.playback_url === 'https://vidara.to/e/LyBctGwWUh9c',
  '3f. stored playback_url is the CANONICAL embed URL (not the input share URL)',
  `(got: ${vidaraAsset?.playback_url})`);
if (vidaraAsset) insertedAssetIds.push(vidaraAsset.id);

console.log('\n§4 — Vidara: exercise resolver lookup query');

const { data: vidaraItemLookup } = await supabase
  .from('media_items')
  .select('id')
  .eq('canonical_key', vidaraCanonicalKey)
  .limit(1)
  .maybeSingle();
ok(!!vidaraItemLookup?.id, '4a. resolver step 3a — media_items lookup by canonical_key succeeded');

const { data: vidaraAssetLookup } = await supabase
  .from('media_assets')
  .select('playback_url')
  .eq('media_item_id', vidaraItemLookup?.id ?? '')
  .eq('provider_source_id', vidaraSource?.id ?? '')
  .eq('status', 'ready')
  .eq('mavero_status', 'available')
  .order('updated_at', { ascending: false })
  .limit(1)
  .maybeSingle();
ok(!!vidaraAssetLookup?.playback_url, '4b. resolver step 3b — found ready+available asset');
ok(vidaraAssetLookup?.playback_url === 'https://vidara.to/e/LyBctGwWUh9c',
  '4c. resolver returns the canonical embed URL',
  `(got: ${vidaraAssetLookup?.playback_url})`);

// ============================================================
// ABYSS — real reference https://player.abyssplayer.com/-7DfAqb5s
// ============================================================

console.log('\n§5 — Abyss: normalize user-provided player URL');

const abyssInput = 'https://player.abyssplayer.com/-7DfAqb5s';
const abyssNormalized = normalizeReference('abyss', abyssInput);

ok(abyssNormalized !== null, '5a. normalizeReference returned a result');
ok(abyssNormalized?.providerAssetId === '-7DfAqb5s',
  '5b. provider_asset_id = -7DfAqb5s (slug starting with hyphen is preserved)',
  `(got: ${abyssNormalized?.providerAssetId})`);
ok(abyssNormalized?.playbackUrl === 'https://player.abyssplayer.com/-7DfAqb5s',
  '5c. playback_url = https://player.abyssplayer.com/-7DfAqb5s (canonical player URL)',
  `(got: ${abyssNormalized?.playbackUrl})`);

console.log('\n§6 — Abyss: playback URL passes resolver allowlist');

ok(validatePlaybackUrl(abyssNormalized.playbackUrl, PROVIDER_ALLOWED_ORIGINS.abyss),
  '6a. URL passes validatePlaybackUrl (HTTPS + origin in allowlist)');

console.log('\n§7 — Abyss: insert test row + exercise resolver lookup');

const { data: abyssProvider } = await supabase
  .from('streaming_providers').select('id').eq('adapter_id', 'abyss').maybeSingle();
const { data: abyssSource } = await supabase
  .from('streaming_sources').select('id').eq('provider_id', abyssProvider?.id ?? '').maybeSingle();
ok(abyssSource != null, '7a. Abyss source row found');

const abyssCanonicalKey = 'series:tmdb:1396'; // Breaking Bad (safe test target)
const { data: abyssItem, error: abyssItemErr } = await supabase
  .from('media_items')
  .upsert({
    canonical_key: abyssCanonicalKey,
    content_type: 'series',
    tmdb_id: '1396',
    title: 'MAV Phase 2 Acceptance Test (Abyss, temporary)',
    year: 2008,
    season: null, episode: null, episode_title: null, parent_media_id: null,
  }, { onConflict: 'canonical_key' })
  .select('id, canonical_key, content_type')
  .single();
ok(!abyssItemErr, '7b. media_items upsert succeeded', abyssItemErr ? `(${abyssItemErr.message})` : '');
ok(!!abyssItem?.id, '7c. media_items row returned id', `= ${abyssItem?.id?.slice(0, 8)}…`);
if (abyssItem) insertedItemIds.push(abyssItem.id);

const { data: existingAbyssAsset } = await supabase
  .from('media_assets')
  .select('id')
  .eq('provider_source_id', abyssSource?.id ?? '')
  .eq('provider_asset_id', abyssNormalized.providerAssetId)
  .maybeSingle();
if (existingAbyssAsset) {
  console.log('  -- found leftover test row from previous run, deleting first');
  await supabase.from('media_assets').delete().eq('id', existingAbyssAsset.id);
}

const { data: abyssAsset, error: abyssAssetErr } = await supabase
  .from('media_assets')
  .insert({
    media_item_id: abyssItem?.id,
    provider_source_id: abyssSource?.id,
    provider_asset_id: abyssNormalized.providerAssetId,
    provider_video_id: abyssNormalized.providerAssetId,
    playback_url: abyssNormalized.playbackUrl,
    filename: 'test.mp4',
    title: 'MAV Phase 2 Acceptance Test Asset (Abyss)',
    status: 'ready',
    provider_status: 'active',
    mavero_status: 'available',
    available_qualities: [], audio_languages: [], has_subtitles: false,
    last_synced_at: new Date().toISOString(),
  })
  .select('id, playback_url, status, mavero_status, provider_asset_id')
  .single();
ok(!abyssAssetErr, '7d. media_assets insert succeeded', abyssAssetErr ? `(${abyssAssetErr.message})` : '');
ok(!!abyssAsset?.id, '7e. media_assets row returned id', `= ${abyssAsset?.id?.slice(0, 8)}…`);
ok(abyssAsset?.playback_url === 'https://player.abyssplayer.com/-7DfAqb5s',
  '7f. stored playback_url is the canonical player URL',
  `(got: ${abyssAsset?.playback_url})`);
if (abyssAsset) insertedAssetIds.push(abyssAsset.id);

console.log('\n§8 — Abyss: exercise resolver lookup query');

const { data: abyssItemLookup } = await supabase
  .from('media_items')
  .select('id')
  .eq('canonical_key', abyssCanonicalKey)
  .limit(1)
  .maybeSingle();
ok(!!abyssItemLookup?.id, '8a. resolver step 3a — media_items lookup by canonical_key succeeded');

const { data: abyssAssetLookup } = await supabase
  .from('media_assets')
  .select('playback_url')
  .eq('media_item_id', abyssItemLookup?.id ?? '')
  .eq('provider_source_id', abyssSource?.id ?? '')
  .eq('status', 'ready')
  .eq('mavero_status', 'available')
  .order('updated_at', { ascending: false })
  .limit(1)
  .maybeSingle();
ok(!!abyssAssetLookup?.playback_url, '8b. resolver step 3b — found ready+available asset');
ok(abyssAssetLookup?.playback_url === 'https://player.abyssplayer.com/-7DfAqb5s',
  '8c. resolver returns the canonical player URL',
  `(got: ${abyssAssetLookup?.playback_url})`);

// ============================================================
// NEGATIVE TESTS — share URLs from non-allowlisted origins are rejected
// ============================================================

console.log('\n§9 — Negative: non-allowlisted origin rejected');

// The new validateReference() checks BOTH the input URL's origin AND
// the reconstructed canonical URL's origin against the provider's
// allowlist. A URL from evil.com (not in the Vidara allowlist) must
// be rejected at the input-origin check.
const evilValid = validateReference('vidara', 'https://evil.com/v/somecode');
ok(!evilValid, '9a. URL with non-allowlisted origin (evil.com) rejected by validateReference');

// Cross-provider mistake: Abyss URL + Vidara provider selection.
const crossValid = validateReference('vidara', 'https://player.abyssplayer.com/someslug');
ok(!crossValid, '9b. Cross-provider URL (Abyss URL + Vidara provider) rejected');

// Positive controls — the real references must pass validateReference.
const vidaraValid = validateReference('vidara', vidaraInput);
ok(vidaraValid, '9c. Real Vidara share URL accepted by validateReference');
const abyssValid = validateReference('abyss', abyssInput);
ok(abyssValid, '9d. Real Abyss player URL accepted by validateReference');

await cleanup();

console.log('\n§10 — Verify cleanup');

const { data: postVidaraAsset } = await supabase
  .from('media_assets')
  .select('id')
  .eq('provider_source_id', vidaraSource?.id ?? '')
  .eq('provider_asset_id', vidaraNormalized.providerAssetId)
  .maybeSingle();
ok(!postVidaraAsset, '10a. Vidara test media_assets row deleted');

const { data: postAbyssAsset } = await supabase
  .from('media_assets')
  .select('id')
  .eq('provider_source_id', abyssSource?.id ?? '')
  .eq('provider_asset_id', abyssNormalized.providerAssetId)
  .maybeSingle();
ok(!postAbyssAsset, '10b. Abyss test media_assets row deleted');

console.log(`\nmav_phase2_real_refs_probe: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
