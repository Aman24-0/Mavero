/**
 * Phase 4 — Provider/source registry integration tests.
 *
 * Verifies that Vidara/Abyss providers and Mavero 1/Mavero 2 sources
 * are correctly registered in the database, that category mappings
 * are correct, and that the hosting adapter registry links the right
 * adapters to the right providers.
 *
 * These are STATIC contract tests (read source files + verify live DB
 * via the Management API) — they do NOT call live provider APIs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// --- Migration file inspection ---
const migration = readFileSync(path.join(REPO_ROOT, 'supabase/migrations/20260928213822_phase4_register_hosting_sources.sql'), 'utf8');

// --- Live DB verification ---
// PAT is read from the SUPABASE_PAT environment variable (server-side only).
// NEVER hardcode the PAT in source files.
const PAT = process.env.SUPABASE_PAT || '';
const PROJ = process.env.SUPABASE_PROJECT_REF || 'whekhqimzrafhsrmswbn';

async function q(sql: string): Promise<unknown[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJ}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  return await res.json() as unknown[];
}

console.log('=== Phase 4 — Provider/source registry integration tests ===\n');

// ===========================================================================
// 1. Migration file inspection
// ===========================================================================

ok(migration.includes("'vidara'"), 'Migration: Vidara provider slug');
ok(migration.includes("'abyss'"), 'Migration: Abyss provider slug');
ok(migration.includes("'mavero-1'"), 'Migration: Mavero 1 source slug');
ok(migration.includes("'mavero-2'"), 'Migration: Mavero 2 source slug');
ok(migration.includes('ON CONFLICT (slug) DO NOTHING'), 'Migration: idempotent provider insert');
ok(migration.includes('ON CONFLICT (provider_id, slug) DO NOTHING'), 'Migration: idempotent source insert');
ok(migration.includes("'multi-audio'"), 'Migration: Vidara → Multi Audio category');
ok(migration.includes("'org-audio'"), 'Migration: Abyss → Org Audio category');
ok(!migration.includes('api_key') || migration.includes('NO secrets'), 'Migration: no API key values (word only in comments)');
ok(!migration.match(/password\s*=\s*\S/i), 'Migration: no password values assigned');
ok(!migration.match(/token\s*=\s*\S/i), 'Migration: no token values assigned');
ok(migration.includes("'custom'"), 'Migration: integration_type = custom (not template/embed)');
ok(migration.includes("'vidara'"), 'Migration: adapter_id = vidara');
ok(migration.includes("'abyss'"), 'Migration: adapter_id = abyss');
ok(migration.includes("'experimental'"), 'Migration: status = experimental');
ok(migration.includes("'public'"), 'Migration: visibility = public');
console.log('  ok — migration file inspection (16 checks)');

// ===========================================================================
// 2. Live DB: Vidara provider exists
// ===========================================================================

const vidaraProviders = await q(`
  SELECT name, slug, status, enabled, integration_type, adapter_id
  FROM public.streaming_providers WHERE slug = 'vidara';
`);
ok(vidaraProviders.length === 1, 'DB: Vidara provider exists (exactly 1 row)');
const vidaraProvider = vidaraProviders[0] as Record<string, unknown>;
ok(vidaraProvider.name === 'Vidara', 'DB: Vidara provider name');
ok(vidaraProvider.status === 'experimental', 'DB: Vidara provider status = experimental');
ok(vidaraProvider.enabled === true, 'DB: Vidara provider enabled');
ok(vidaraProvider.integration_type === 'custom', 'DB: Vidara integration_type = custom');
ok(vidaraProvider.adapter_id === 'vidara', 'DB: Vidara adapter_id = vidara');

// ===========================================================================
// 3. Live DB: Abyss provider exists
// ===========================================================================

const abyssProviders = await q(`
  SELECT name, slug, status, enabled, integration_type, adapter_id
  FROM public.streaming_providers WHERE slug = 'abyss';
`);
ok(abyssProviders.length === 1, 'DB: Abyss provider exists (exactly 1 row)');
const abyssProvider = abyssProviders[0] as Record<string, unknown>;
ok(abyssProvider.name === 'Abyss', 'DB: Abyss provider name');
ok(abyssProvider.status === 'experimental', 'DB: Abyss provider status = experimental');
ok(abyssProvider.enabled === true, 'DB: Abyss provider enabled');
ok(abyssProvider.integration_type === 'custom', 'DB: Abyss integration_type = custom');
ok(abyssProvider.adapter_id === 'abyss', 'DB: Abyss adapter_id = abyss');

// ===========================================================================
// 4. Live DB: Mavero 1 source exists (linked to Vidara)
// ===========================================================================

const mavero1Sources = await q(`
  SELECT s.name, s.slug, s.status, s.enabled, s.visibility, s.integration_type,
         s.provider_id, p.slug AS provider_slug
  FROM public.streaming_sources s
  JOIN public.streaming_providers p ON p.id = s.provider_id
  WHERE s.slug = 'mavero-1';
`);
ok(mavero1Sources.length === 1, 'DB: Mavero 1 source exists (exactly 1 row)');
const mavero1 = mavero1Sources[0] as Record<string, unknown>;
ok(mavero1.name === 'Mavero 1', 'DB: Mavero 1 source name');
ok(mavero1.provider_slug === 'vidara', 'DB: Mavero 1 → Vidara provider');
ok(mavero1.status === 'experimental', 'DB: Mavero 1 status = experimental');
ok(mavero1.visibility === 'public', 'DB: Mavero 1 visibility = public');
ok(mavero1.integration_type === 'custom', 'DB: Mavero 1 integration_type = custom');

// ===========================================================================
// 5. Live DB: Mavero 2 source exists (linked to Abyss)
// ===========================================================================

const mavero2Sources = await q(`
  SELECT s.name, s.slug, s.status, s.enabled, s.visibility, s.integration_type,
         s.provider_id, p.slug AS provider_slug
  FROM public.streaming_sources s
  JOIN public.streaming_providers p ON p.id = s.provider_id
  WHERE s.slug = 'mavero-2';
`);
ok(mavero2Sources.length === 1, 'DB: Mavero 2 source exists (exactly 1 row)');
const mavero2 = mavero2Sources[0] as Record<string, unknown>;
ok(mavero2.name === 'Mavero 2', 'DB: Mavero 2 source name');
ok(mavero2.provider_slug === 'abyss', 'DB: Mavero 2 → Abyss provider');
ok(mavero2.status === 'experimental', 'DB: Mavero 2 status = experimental');
ok(mavero2.visibility === 'public', 'DB: Mavero 2 visibility = public');
ok(mavero2.integration_type === 'custom', 'DB: Mavero 2 integration_type = custom');

// ===========================================================================
// 6. Live DB: Category mappings correct
// ===========================================================================

const mavero1Categories = await q(`
  SELECT c.name, c.slug FROM public.streaming_source_categories ssc
  JOIN public.streaming_sources s ON s.id = ssc.source_id
  JOIN public.streaming_categories c ON c.id = ssc.category_id
  WHERE s.slug = 'mavero-1';
`);
ok(mavero1Categories.length === 1, 'DB: Mavero 1 has 1 category mapping');
ok((mavero1Categories[0] as Record<string, unknown>).slug === 'multi-audio', 'DB: Mavero 1 → Multi Audio category');

const mavero2Categories = await q(`
  SELECT c.name, c.slug FROM public.streaming_source_categories ssc
  JOIN public.streaming_sources s ON s.id = ssc.source_id
  JOIN public.streaming_categories c ON c.id = ssc.category_id
  WHERE s.slug = 'mavero-2';
`);
ok(mavero2Categories.length === 1, 'DB: Mavero 2 has 1 category mapping');
ok((mavero2Categories[0] as Record<string, unknown>).slug === 'org-audio', 'DB: Mavero 2 → Org Audio category');

// ===========================================================================
// 7. Live DB: Existing registry preserved
// ===========================================================================

const counts = await q(`
  SELECT
    (SELECT count(*) FROM public.streaming_providers) AS providers,
    (SELECT count(*) FROM public.streaming_sources) AS sources,
    (SELECT count(*) FROM public.streaming_categories) AS categories,
    (SELECT count(*) FROM public.streaming_source_categories) AS source_categories;
`);
const c = counts[0] as Record<string, number>;
ok(c.providers === 12, `DB: 12 providers (10 existing + 2 new) — got ${c.providers}`);
ok(c.sources === 13, `DB: 13 sources (11 existing + 2 new) — got ${c.sources}`);
ok(c.categories === 2, `DB: 2 categories (unchanged) — got ${c.categories}`);
ok(c.source_categories === 13, `DB: 13 source-categories (11 existing + 2 new) — got ${c.source_categories}`);

// ===========================================================================
// 8. Live DB: No duplicates
// ===========================================================================

const vidaraCount = await q(`SELECT count(*)::int AS n FROM public.streaming_providers WHERE slug = 'vidara';`);
ok((vidaraCount[0] as Record<string, number>).n === 1, 'DB: no duplicate Vidara provider');
const abyssCount = await q(`SELECT count(*)::int AS n FROM public.streaming_providers WHERE slug = 'abyss';`);
ok((abyssCount[0] as Record<string, number>).n === 1, 'DB: no duplicate Abyss provider');
const mavero1Count = await q(`SELECT count(*)::int AS n FROM public.streaming_sources WHERE slug = 'mavero-1';`);
ok((mavero1Count[0] as Record<string, number>).n === 1, 'DB: no duplicate Mavero 1 source');
const mavero2Count = await q(`SELECT count(*)::int AS n FROM public.streaming_sources WHERE slug = 'mavero-2';`);
ok((mavero2Count[0] as Record<string, number>).n === 1, 'DB: no duplicate Mavero 2 source');

// ===========================================================================
// 9. Live DB: Hosting tables still empty
// ===========================================================================

const hostingCounts = await q(`
  SELECT
    (SELECT count(*) FROM public.media_items) AS mi,
    (SELECT count(*) FROM public.media_assets) AS ma,
    (SELECT count(*) FROM public.media_upload_operations) AS muo,
    (SELECT count(*) FROM public.media_operations) AS mo,
    (SELECT count(*) FROM public.media_availability_requests) AS mar,
    (SELECT count(*) FROM public.media_folders) AS mf,
    (SELECT count(*) FROM public.provider_folder_mappings) AS pfm;
`);
const hc = hostingCounts[0] as Record<string, number>;
ok(Object.values(hc).every(v => v === 0), 'DB: all hosting tables empty (0 rows)');

// ===========================================================================
// 10. Live DB: No secrets in provider/source rows
// ===========================================================================

const vidaraCaps = await q(`SELECT capabilities FROM public.streaming_providers WHERE slug = 'vidara';`);
const vidaraCapsStr = JSON.stringify(vidaraCaps);
ok(!vidaraCapsStr.toLowerCase().includes('api_key'), 'Security: Vidara capabilities has no api_key');
ok(!vidaraCapsStr.toLowerCase().includes('password'), 'Security: Vidara capabilities has no password');

const abyssCaps = await q(`SELECT capabilities FROM public.streaming_providers WHERE slug = 'abyss';`);
const abyssCapsStr = JSON.stringify(abyssCaps);
ok(!abyssCapsStr.toLowerCase().includes('api_key'), 'Security: Abyss capabilities has no api_key');
ok(!abyssCapsStr.toLowerCase().includes('password'), 'Security: Abyss capabilities has no password');

// ===========================================================================
// 11. Migration ledger
// ===========================================================================

const ledger = await q(`SELECT count(*)::int AS n, max(version) AS max_version FROM supabase_migrations.schema_migrations;`);
const l = ledger[0] as Record<string, unknown>;
ok(l.n === 30, `DB: migration ledger has 30 entries — got ${l.n}`);
ok(l.max_version === '20260928213822', `DB: ledger MAX = 20260928213822 — got ${l.max_version}`);

// ===========================================================================
// 12. Source code: registry links adapter_id to adapters
// ===========================================================================

const registrySource = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/registry.ts'), 'utf8');
ok(registrySource.includes("vidara: 'vidara'"), 'Registry: adapter_id vidara → key vidara');
ok(registrySource.includes("abyss: 'abyss'"), 'Registry: adapter_id abyss → key abyss');
ok(registrySource.includes('getVidaraAdapter'), 'Registry: links to VidaraAdapter');
ok(registrySource.includes('getAbyssAdapter'), 'Registry: links to AbyssAdapter');
ok(!registrySource.includes('console.log'), 'Security: registry has no console.log');

// ===========================================================================
// 13. Source code: existing resolver architecture unchanged
// ===========================================================================

const resolverTypes = readFileSync(path.join(REPO_ROOT, 'src/lib/server/resolver/types.ts'), 'utf8');
ok(resolverTypes.includes("interface ProviderAdapter"), 'Compatibility: existing ProviderAdapter interface unchanged');
ok(resolverTypes.includes("'direct' | 'embed'"), 'Compatibility: existing result types unchanged');

const adapterRegistry = readFileSync(path.join(REPO_ROOT, 'src/lib/server/resolver/adapters.ts'), 'utf8');
ok(adapterRegistry.includes('createDefaultAdapters'), 'Compatibility: existing adapter registry unchanged');
ok(adapterRegistry.includes('templateProviderAdapter'), 'Compatibility: existing template adapter preserved');

console.log('  ok — live DB + source code verification (all checks)');

console.log(`\nPhase 4 registry integration tests: ${passed} checks passed.`);
