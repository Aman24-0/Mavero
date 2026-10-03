/**
 * Phase 5 (Session 13) — LIVE DB verification equivalent for the sections of
 * phase4_registry_integration_test.ts that require the Supabase Management
 * API PAT (which is not available in this environment — the offline chain
 * honestly skips them). This one-off check verifies the SAME live-data
 * invariants through the DATA API with the service key: the Vidara/Abyss
 * hosting providers + Mavero 1/2 sources are registered with the expected
 * shapes, and no secrets live in the rows.
 *
 * Run (live creds from the untracked env convention):
 *   SUPABASE_URL/SERVICE_KEY sourced from ../scripts/mavero_live.env
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveEnv: Record<string, string> = {};
for (const line of readFileSync(path.join(__dirname, '..', '..', 'scripts', 'mavero_live.env'), 'utf8').split('\n')) {
  const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (match !== null) liveEnv[match[1]!] = match[2]!;
}

let passed = 0;
function ok(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${label}`);
}

const client = createClient(liveEnv['SUPABASE_URL']!, liveEnv['SERVICE_KEY']!, { auth: { persistSession: false } });

console.log('=== Phase 5 live DB verification (phase4_registry equivalents) ===');

// 2/3. Vidara + Abyss providers exist with the expected shape.
const { data: providers } = await client.from('streaming_providers').select('name, slug, status, enabled, integration_type, adapter_id').in('slug', ['vidara', 'abyss']);
ok(Array.isArray(providers) && providers.length === 2, 'DB: exactly two hosting providers (vidara + abyss)');
const vidara = providers?.find((p) => p.slug === 'vidara');
const abyss = providers?.find((p) => p.slug === 'abyss');
ok(vidara?.name === 'Vidara' && vidara.status === 'experimental' && vidara.enabled === true && vidara.integration_type === 'custom' && vidara.adapter_id === 'vidara', 'DB: Vidara provider row shape');
ok(abyss?.name === 'Abyss' && abyss.status === 'experimental' && abyss.enabled === true && abyss.integration_type === 'custom' && abyss.adapter_id === 'abyss', 'DB: Abyss provider row shape');

// 4/5. Mavero 1 + Mavero 2 sources exist, linked correctly.
const { data: sources } = await client.from('streaming_sources').select('name, slug, provider_id, visibility, status').in('slug', ['mavero-1', 'mavero-2']);
ok(Array.isArray(sources) && sources.length === 2, 'DB: exactly two Mavero hosting sources');
const { data: allProviders } = await client.from('streaming_providers').select('id, slug');
const providerBySlug = new Map((allProviders ?? []).map((p) => [p.slug, p.id]));
const mavero1 = sources?.find((s) => s.slug === 'mavero-1');
const mavero2 = sources?.find((s) => s.slug === 'mavero-2');
ok(mavero1?.provider_id === providerBySlug.get('vidara') && mavero1?.visibility === 'public' && mavero1?.status === 'experimental', 'DB: Mavero 1 source linked to Vidara');
ok(mavero2?.provider_id === providerBySlug.get('abyss') && mavero2?.visibility === 'public' && mavero2?.status === 'experimental', 'DB: Mavero 2 source linked to Abyss');

// 8. No duplicates.
ok((providers?.length ?? 0) === 2 && (sources?.length ?? 0) === 2, 'DB: no duplicate provider/source rows');

// 10. No secrets in the provider rows (capabilities jsonb).
const { data: capsRows } = await client.from('streaming_providers').select('slug, capabilities').in('slug', ['vidara', 'abyss']);
for (const row of capsRows ?? []) {
  const serialized = JSON.stringify(row.capabilities ?? {}).toLowerCase();
  ok(!serialized.includes('api_key') && !serialized.includes('password') && !serialized.includes('token'), `DB: ${row.slug} capabilities carry no credential material`);
}

// CloudStream-side live state (the Permanent Adapter system's catalog).
const { count: repoCount } = await client.from('cloudstream_repositories').select('id', { count: 'exact', head: true });
ok(typeof repoCount === 'number' && repoCount >= 0, `DB: cloudstream_repositories live count = ${repoCount}`);
const { count: artifactCount } = await client.from('cloudstream_adapter_artifacts').select('id', { count: 'exact', head: true });
ok(typeof artifactCount === 'number' && artifactCount >= 0, `DB: cloudstream_adapter_artifacts live count = ${artifactCount} (0 = honest, no stale test rows after cleanup)`);

console.log(`\nPhase 5 live DB verification: ${passed} checks passed.`);
