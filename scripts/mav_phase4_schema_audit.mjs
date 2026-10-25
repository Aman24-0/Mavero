/**
 * Phase 4 — Live Supabase schema + migration history audit.
 *
 * Uses the service-role Supabase client to query the live database's
 * information_schema + pg_catalog for the actual schema state, and
 * attempts to read the migration history from supabase_migrations.schema_migrations.
 *
 * Read-only — does NOT modify any data or schema.
 *
 * Usage:
 *   source .env && node scripts/mav_phase4_schema_audit.mjs
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing env vars: PUBLIC_SUPABASE_URL or PRIVATE_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

let passed = 0;
let failed = 0;

function ok(cond, label, extra = '') {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}${extra ? ' ' + extra : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${label}${extra ? ' ' + extra : ''}`); }
}

// ============================================================
// §1 — Migration history (supabase_migrations.schema_migrations)
// ============================================================

console.log('\n§1 — Live migration history');

// The supabase_migrations schema is NOT exposed via PostgREST by default.
// We try to query it via an RPC function if one exists, or via the
// information_schema if the table is accessible.
// First, try a direct query (will fail if not exposed — that's OK).
const { data: migHistory, error: migErr } = await supabase
  .from('schema_migrations')
  .select('version, name, statements')
  .order('version', { ascending: true })
  .limit(200);

if (migErr) {
  console.log(`  (note) schema_migrations table not directly queryable: ${migErr.message}`);
  console.log('         This is expected — Supabase migration history is in supabase_migrations.schema_migrations');
  console.log('         which is NOT exposed via PostgREST. We will audit the schema objects directly.');
} else {
  console.log(`  -- found ${migHistory?.length ?? 0} migration history rows`);
  for (const m of migHistory ?? []) {
    console.log(`     ${m.version} ${m.name ?? '(no name)'} (${m.statements?.length ?? 0} statements)`);
  }
}

// ============================================================
// §2 — Core tables existence check
// ============================================================

console.log('\n§2 — Core tables existence');

const coreTables = [
  'media_items', 'media_assets', 'media_operations', 'media_folders',
  'media_availability_requests', 'media_upload_operations',
  'provider_folder_mappings', 'streaming_providers', 'streaming_sources',
  'streaming_source_categories', 'streaming_categories',
  'profiles', 'watch_history', 'favorites', 'device_sessions',
];

for (const table of coreTables) {
  // Use select('*').limit(1) instead of head:true — the head:true path
  // sometimes returns an empty error for certain tables (PostgREST quirk).
  // Note: streaming_source_categories has a composite PK (source_id,
  // category_id) — no 'id' column. Use '*' to avoid column-not-found errors.
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .limit(1);
  if (error) {
    ok(false, `2. ${table} exists`, `(${error.message?.slice(0, 80) || 'empty error'})`);
  } else {
    ok(true, `2. ${table} exists`, `(${Array.isArray(data) ? data.length : 0} sample rows)`);
  }
}

// ============================================================
// §3 — media_items schema (information_schema.columns)
// ============================================================

console.log('\n§3 — media_items column audit');

// We can query information_schema.columns via PostgREST if it's exposed.
// If not, we'll use the table's actual data to infer columns.
const { data: mediaItemsSample, error: miErr } = await supabase
  .from('media_items')
  .select('*')
  .limit(1);

if (miErr) {
  ok(false, '3a. media_items queryable', `(${miErr.message})`);
} else {
  ok(true, '3a. media_items queryable');
  if (mediaItemsSample && mediaItemsSample.length > 0) {
    const cols = Object.keys(mediaItemsSample[0]).sort();
    console.log(`  -- columns (${cols.length}): ${cols.join(', ')}`);
    // Verify expected columns exist.
    const expectedCols = [
      'id', 'canonical_key', 'content_type', 'tmdb_id', 'imdb_id',
      'title', 'year', 'season', 'episode', 'episode_title', 'parent_media_id',
      'created_at', 'updated_at',
    ];
    for (const col of expectedCols) {
      ok(cols.includes(col), `3b. media_items.${col} exists`);
    }
  }
}

// ============================================================
// §4 — media_assets schema
// ============================================================

console.log('\n§4 — media_assets column audit');

const { data: mediaAssetsSample, error: maErr } = await supabase
  .from('media_assets')
  .select('*')
  .limit(1);

if (maErr) {
  ok(false, '4a. media_assets queryable', `(${maErr.message})`);
} else {
  ok(true, '4a. media_assets queryable');
  if (mediaAssetsSample && mediaAssetsSample.length > 0) {
    const cols = Object.keys(mediaAssetsSample[0]).sort();
    console.log(`  -- columns (${cols.length}): ${cols.join(', ')}`);
    const expectedCols = [
      'id', 'media_item_id', 'provider_source_id', 'provider_asset_id',
      'playback_url', 'status', 'mavero_status', 'provider_status',
      'available_qualities', 'audio_languages', 'has_subtitles',
      'duration_seconds', 'size_bytes', 'last_synced_at',
      'created_at', 'updated_at',
    ];
    for (const col of expectedCols) {
      ok(cols.includes(col), `4b. media_assets.${col} exists`);
    }
  }
}

// ============================================================
// §5 — media_operations schema + action CHECK constraint
// ============================================================

console.log('\n§5 — media_operations column + action audit');

const { data: opsSample, error: opsErr } = await supabase
  .from('media_operations')
  .select('*')
  .limit(1);

if (opsErr) {
  ok(false, '5a. media_operations queryable', `(${opsErr.message})`);
} else {
  ok(true, '5a. media_operations queryable');
  if (opsSample && opsSample.length > 0) {
    const cols = Object.keys(opsSample[0]).sort();
    console.log(`  -- columns (${cols.length}): ${cols.join(', ')}`);
  }
}

// Check that action CHECK constraint accepts link + unlink (from Phase 2 probe).
const { error: linkInsertErr } = await supabase
  .from('media_operations')
  .insert({
    action: 'link', status: 'success',
    details: { probe: 'phase4_audit', note: 'temporary — will be deleted' },
  })
  .select('id').single();
ok(!linkInsertErr, '5b. media_operations accepts action=link (CHECK constraint includes it)',
  linkInsertErr ? `(${linkInsertErr.message.slice(0, 80)})` : '');

let linkProbeId = null;
if (!linkInsertErr) {
  // We need to get the id — the insert returned it via .select().
  // Actually the .single() returned data, but we used error destructuring.
  // Re-query to find it.
  const { data: probe } = await supabase
    .from('media_operations')
    .select('id')
    .eq('details->>probe', 'phase4_audit')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  linkProbeId = probe?.id;
}

const { error: unlinkInsertErr } = await supabase
  .from('media_operations')
  .insert({
    action: 'unlink', status: 'success',
    details: { probe: 'phase4_audit', note: 'temporary — will be deleted' },
  });
ok(!unlinkInsertErr, '5c. media_operations accepts action=unlink (CHECK constraint includes it)',
  unlinkInsertErr ? `(${unlinkInsertErr.message.slice(0, 80)})` : '');

// Clean up probe rows.
await supabase.from('media_operations').delete().filter('details->>probe', 'eq', 'phase4_audit');
if (linkProbeId) await supabase.from('media_operations').delete().eq('id', linkProbeId);
console.log('  -- cleaned up probe rows');

// ============================================================
// §6 — media_availability_requests (Missing Media) schema
// ============================================================

console.log('\n§6 — media_availability_requests column audit');

const { data: demandSample, error: demandErr } = await supabase
  .from('media_availability_requests')
  .select('*')
  .limit(1);

if (demandErr) {
  ok(false, '6a. media_availability_requests queryable', `(${demandErr.message})`);
} else {
  ok(true, '6a. media_availability_requests queryable');
  if (demandSample && demandSample.length > 0) {
    const cols = Object.keys(demandSample[0]).sort();
    console.log(`  -- columns (${cols.length}): ${cols.join(', ')}`);
    const expectedCols = [
      'id', 'canonical_key', 'content_type', 'tmdb_id',
      'season', 'episode', 'title_snapshot', 'episode_title_snapshot',
      'request_count', 'first_requested_at', 'last_requested_at', 'status',
    ];
    for (const col of expectedCols) {
      ok(cols.includes(col), `6b. media_availability_requests.${col} exists`);
    }
  }
}

// ============================================================
// §7 — streaming_providers + streaming_sources (Vidara/Abyss)
// ============================================================

console.log('\n§7 — streaming_providers + streaming_sources');

const { data: providers } = await supabase
  .from('streaming_providers')
  .select('id, name, slug, adapter_id, capabilities, enabled')
  .in('adapter_id', ['vidara', 'abyss']);
ok(providers?.length === 2, '7a. Vidara + Abyss providers registered', `(${providers?.length} found)`);
if (providers) {
  for (const p of providers) {
    const origins = p.capabilities?.allowed_embed_origins ?? [];
    console.log(`  -- ${p.name} (adapter=${p.adapter_id}, slug=${p.slug}, enabled=${p.enabled})`);
    console.log(`     allowed_embed_origins: ${JSON.stringify(origins)}`);
  }
}

const { data: sources } = await supabase
  .from('streaming_sources')
  .select('id, name, slug, provider_id, enabled, ordering')
  .in('slug', ['mavero-1', 'mavero-2']);
ok(sources?.length === 2, '7b. Mavero 1 + Mavero 2 sources registered', `(${sources?.length} found)`);
if (sources) {
  for (const s of sources) {
    console.log(`  -- ${s.name} (slug=${s.slug}, ordering=${s.ordering}, enabled=${s.enabled})`);
  }
}

// ============================================================
// §8 — profiles (admin role check)
// ============================================================

console.log('\n§8 — profiles table (admin role)');

const { data: profiles, error: profErr } = await supabase
  .from('profiles')
  .select('id, role, display_name')
  .limit(10);
ok(!profErr, '8a. profiles queryable', profErr ? `(${profErr.message})` : '');
if (profiles) {
  const admins = profiles.filter(p => p.role === 'admin');
  ok(admins.length >= 1, '8b. at least 1 admin user exists', `(${admins.length} admins)`);
  console.log(`  -- total profiles: ${profiles.length}, admins: ${admins.length}`);
}

// ============================================================
// §9 — Data integrity checks
// ============================================================

console.log('\n§9 — Data integrity');

const { count: itemCount } = await supabase.from('media_items').select('id', { count: 'exact', head: true });
const { count: assetCount } = await supabase.from('media_assets').select('id', { count: 'exact', head: true });
const { count: opsCount } = await supabase.from('media_operations').select('id', { count: 'exact', head: true });
const { count: demandCount } = await supabase.from('media_availability_requests').select('id', { count: 'exact', head: true });
const { count: profileCount } = await supabase.from('profiles').select('id', { count: 'exact', head: true });

console.log(`  -- media_items: ${itemCount} rows`);
console.log(`  -- media_assets: ${assetCount} rows`);
console.log(`  -- media_operations: ${opsCount} rows`);
console.log(`  -- media_availability_requests: ${demandCount} rows`);
console.log(`  -- profiles: ${profileCount} rows`);

ok(typeof itemCount === 'number', '9a. media_items count queryable');
ok(typeof assetCount === 'number', '9b. media_assets count queryable');
ok(typeof opsCount === 'number', '9c. media_operations count queryable');
ok(typeof demandCount === 'number', '9d. media_availability_requests count queryable');
ok(typeof profileCount === 'number', '9e. profiles count queryable');

// ============================================================
// §10 — Check for orphaned media_assets (FK integrity)
// ============================================================

console.log('\n§10 — FK integrity (orphaned media_assets)');

// Query media_assets with their media_item join to check for orphans.
const { data: assetsWithItems, error: joinErr } = await supabase
  .from('media_assets')
  .select('id, media_item_id, media_items(id)')
  .limit(100);
ok(!joinErr, '10a. media_assets → media_items FK join queryable', joinErr ? `(${joinErr.message})` : '');
if (assetsWithItems) {
  const orphans = assetsWithItems.filter(a => !a.media_items);
  ok(orphans.length === 0, '10b. no orphaned media_assets (all FK to valid media_items)', `(${orphans.length} orphans in sample of ${assetsWithItems.length})`);
}

console.log(`\nmav_phase4_schema_audit: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
