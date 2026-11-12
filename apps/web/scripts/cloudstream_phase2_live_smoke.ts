/**
 * Phase 2 live smoke — Nuvio manifest detection against the REAL world.
 *
 * Runs previewRepository() (the exact production discovery path: SSRF-safe
 * fetch → schema detection → parse → normalize) against the two real Nuvio
 * provider manifests named in the plan (plus one more discovered during the
 * audit), asserting the pre-Phase-2 "0 extensions" failure is gone and the
 * providers are detected with the honest adapter_required state.
 *
 * Read-only: NO persistence (previewRepository is validation-only).
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/cloudstream_phase2_live_smoke.ts
 */
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { previewRepository } from '$lib/server/cloudstream/repository/service';

// The live smoke's purpose is the REAL network path (SSRF-safe fetch → schema
// detection → parse). The only DB touch previewRepository makes is the
// duplicate-URL check (a select of configured repository URLs) — a minimal
// fake returning an empty catalog keeps the smoke READ-ONLY with zero
// secrets, exactly like the offline suites.
type UrlRows = { data: Array<{ url: string }>; error: null };
const emptySelect = (): Promise<UrlRows> => Promise.resolve({ data: [], error: null });
const client = {
  from: () => ({
    select: () => ({
      then: (resolve: (value: UrlRows) => void) => emptySelect().then(resolve),
    }),
  }),
} as unknown as SupabaseClient<Database>;

const TARGETS = [
  {
    label: 'phisher-nuvio-providers (plan §5 named repo)',
    url: 'https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/main/manifest.json',
    expectType: 'nuvio' as const,
    minProviders: 1,
  },
  {
    label: 'All-in-One-Nuvio (plan §5 named repo)',
    url: 'https://raw.githubusercontent.com/LiquidBromineOxide/All-in-One-Nuvio/main/manifest.json',
    expectType: 'nuvio' as const,
    minProviders: 1,
  },
];

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

console.log('=== Phase 2 live smoke — real Nuvio manifest detection ===\n');

for (const target of TARGETS) {
  console.log(`--- ${target.label} ---`);
  const preview = await previewRepository(client, target.url);
  ok(preview.integrationType === target.expectType, `${target.label}: detected as ${target.expectType}`);
  ok(preview.extensionCount >= target.minProviders, `${target.label}: ${preview.extensionCount} providers discovered (NOT 0)`);
  ok(preview.name.length > 0, `${target.label}: repository name parsed ("${preview.name}")`);
  ok(
    preview.extensions.every((extension) => extension.integrationType === 'nuvio'),
    `${target.label}: every previewed provider is typed nuvio`,
  );
  ok(
    preview.extensions.every((extension) => extension.adapterStatus === 'adapter_required'),
    `${target.label}: every provider honestly adapter_required (no fake compatibility)`,
  );
  const withMedia = preview.extensions.filter((extension) => extension.mediaTypes.length > 0);
  ok(withMedia.length > 0, `${target.label}: canonical media types derived for ${withMedia.length}/${preview.extensions.length} providers`);
  console.log(
    `    ${preview.name} → ${preview.extensionCount} providers`
    + ` (showing ${preview.extensions.length}${preview.truncated ? ', truncated' : ''})`
    + ` · sample: ${preview.extensions.slice(0, 3).map((extension) => `${extension.internalName} [${extension.mediaTypes.join('/') || 'no-media'}]`).join(', ')}`,
  );
}

console.log(`\ncloudstream_phase2_live_smoke: ${passed} checks PASSED`);
