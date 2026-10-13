/**
 * MAV-FOCUSED — Vidara/Abyss duration + status mapping regression suite
 * (2026-10). Pure-function + source-inspection tests for the Phase 1
 * fixes. No env deps, no live provider calls.
 *
 * Coverage:
 *   §1 Vidara duration parsing — `parseDurationSeconds` handles
 *      HH:MM:SS / MM:SS / numeric seconds / unknown → null. Never 0
 *      or negative (DB CHECK `duration_seconds > 0` is preserved).
 *   §2 Vidara status mapping — 'deleted' / 'inactive' → terminal
 *      'deleted' (was falling through to 'processing' before the fix).
 *      'failed' / 'blocked' → 'failed'. 'processing' / 'queued' /
 *      'ready' preserved.
 *   §3 Abyss duration parsing — same `parseDurationSeconds` helper
 *      wired into Abyss normalize.
 *   §4 DB CHECK constraint is NOT weakened — verified by source
 *      inspection of the migration.
 *   §5 Sync service writes `durationSeconds` through the typed parser
 *      (no `coerceNumber` on the duration path).
 *   §6 linkAsset writes `durationSeconds` through the typed parser.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import assert from 'node:assert/strict';

// Pure-function import — parseDurationSeconds has NO env deps.
const { parseDurationSeconds, MAX_DURATION_SECONDS } = await import('../src/lib/server/hosting/media/duration.ts');

const root = pathResolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(pathResolve(root, p), 'utf-8');
const readCode = (p: string) => read(p)
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

console.log('\n§1 — Vidara duration parsing (parseDurationSeconds)');
{
  // HH:MM:SS — the documented Vidara `video_length` shape.
  ok(parseDurationSeconds('00:01:30') === 90, '1a. "00:01:30" → 90 seconds (was 0 with parseInt)');
  ok(parseDurationSeconds('01:23:45') === 5025, '1b. "01:23:45" → 5025 seconds');
  ok(parseDurationSeconds('00:00:01') === 1, '1c. "00:00:01" → 1 second');
  ok(parseDurationSeconds('00:00:00') === null, '1d. "00:00:00" → null (zero violates DB CHECK)');
  // MM:SS shape.
  ok(parseDurationSeconds('01:30') === 90, '1e. "01:30" → 90 seconds (MM:SS shape)');
  ok(parseDurationSeconds('90:00') === 5400, '1f. "90:00" → 5400 seconds (90 minutes, valid MM:SS)');
  // Numeric seconds (number).
  ok(parseDurationSeconds(90) === 90, '1g. 90 (number) → 90');
  ok(parseDurationSeconds(0) === null, '1h. 0 (number) → null (DB CHECK rejects 0)');
  ok(parseDurationSeconds(-5) === null, '1i. -5 (number) → null (DB CHECK rejects negative)');
  // Numeric string.
  ok(parseDurationSeconds('90') === 90, '1j. "90" → 90');
  ok(parseDurationSeconds('0') === null, '1k. "0" → null (DB CHECK rejects 0)');
  ok(parseDurationSeconds('-5') === null, '1l. "-5" → null');
  // Unknown / invalid → null.
  ok(parseDurationSeconds(null) === null, '1m. null → null');
  ok(parseDurationSeconds(undefined) === null, '1n. undefined → null');
  ok(parseDurationSeconds('') === null, '1o. empty string → null');
  ok(parseDurationSeconds('   ') === null, '1p. whitespace-only → null');
  ok(parseDurationSeconds('not-a-duration') === null, '1q. non-numeric string → null');
  ok(parseDurationSeconds('1h 23m') === null, '1r. "1h 23m" → null (unsupported shape, do not guess)');
  ok(parseDurationSeconds(NaN) === null, '1s. NaN → null');
  ok(parseDurationSeconds(Infinity) === null, '1t. Infinity → null');
  ok(parseDurationSeconds(true) === null, '1u. boolean → null');
  ok(parseDurationSeconds({}) === null, '1v. object → null');
  // Invalid time shapes.
  ok(parseDurationSeconds('00:99:00') === null, '1w. "00:99:00" → null (minutes > 59 invalid)');
  ok(parseDurationSeconds('00:00:99') === null, '1x. "00:00:99" → null (seconds > 59 invalid)');
  ok(parseDurationSeconds('00:01:3a') === null, '1y. "00:01:3a" → null (non-digit part)');
  // Over the 7-day cap → null (DB CHECK rejects).
  ok(parseDurationSeconds(7 * 86400 + 1) === null, '1z. 7 days + 1 second → null (over DB CHECK cap)');
  ok(parseDurationSeconds(7 * 86400) === 604800, '1za. exactly 7 days → 604800 (at the cap, accepted)');
  // Decimal seconds floored.
  ok(parseDurationSeconds(90.7) === 90, '1zb. 90.7 → 90 (floored to integer)');
  // MAX_DURATION_SECONDS constant.
  ok(MAX_DURATION_SECONDS === 604800, `1zc. MAX_DURATION_SECONDS is 604800 (7 days) — got ${MAX_DURATION_SECONDS}`);
}

console.log('\n§2 — Vidara status mapping (deleted/inactive → terminal deleted)');
{
  // Load the vidaraStatusMapper source via a dynamic import (the module
  // imports $env through the duration helper — but vidaraStatusMapper
  // itself has no env deps; the import chain reaches $env only through
  // parseDurationSeconds which is env-free). The dynamic import will
  // succeed because the vidara/normalize.ts module's only env-touching
  // import is parseDurationSeconds (env-free). Let's verify by source.
  const vidaraSrc = readCode('src/lib/server/hosting/vidara/normalize.ts');

  // The mapper must handle 'deleted' and 'inactive' → 'deleted' (terminal).
  ok(/if\s*\(\s*s\s*===\s*['"]deleted['"]\s*\|\|\s*s\s*===\s*['"]inactive['"]\s*\)\s*return\s*['"]deleted['"]/.test(vidaraSrc), '2a. vidaraStatusMapper maps deleted+inactive → deleted (terminal)');

  // The mapper must preserve the existing mappings.
  ok(/s\s*===\s*0\s*\|\|\s*s\s*===\s*['"]0['"]\s*\|\|\s*s\s*===\s*['"]pending['"]\s*\|\|\s*s\s*===\s*['"]queued['"]/.test(vidaraSrc), '2b. vidaraStatusMapper preserves queued mapping (0/0/pending/queued)');
  ok(/s\s*===\s*1\s*\|\|\s*s\s*===\s*['"]1['"]\s*\|\|\s*s\s*===\s*['"]active['"]\s*\|\|\s*s\s*===\s*['"]ready['"]/.test(vidaraSrc), '2c. vidaraStatusMapper preserves ready mapping (1/1/active/ready)');
  ok(/s\s*===\s*2\s*\|\|\s*s\s*===\s*['"]2['"]\s*\|\|\s*s\s*===\s*['"]encoding['"]\s*\|\|\s*s\s*===\s*['"]processing['"]/.test(vidaraSrc), '2d. vidaraStatusMapper preserves processing mapping (2/2/encoding/processing)');
  ok(/s\s*===\s*3\s*\|\|\s*s\s*===\s*['"]3['"]\s*\|\|\s*s\s*===\s*['"]error['"]\s*\|\|\s*s\s*===\s*['"]failed['"]\s*\|\|\s*s\s*===\s*['"]blocked['"]/.test(vidaraSrc), '2e. vidaraStatusMapper preserves failed mapping (3/3/error/failed/blocked)');

  // The Abyss mapper already handles deleted+inactive (unchanged).
  const abyssSrc = readCode('src/lib/server/hosting/abyss/normalize.ts');
  ok(/s\s*===\s*['"]deleted['"]\s*\|\|\s*s\s*===\s*['"]inactive['"]/.test(abyssSrc), '2f. abyssStatusMapper handles deleted+inactive (unchanged, was already correct)');
}

console.log('\n§3 — Abyss duration parsing (same parseDurationSeconds helper)');
{
  const abyssSrc = readCode('src/lib/server/hosting/abyss/normalize.ts');
  ok(/import\s*\{\s*parseDurationSeconds\s*\}\s*from\s*['"][^'"]*media\/duration['"]/.test(abyssSrc), '3a. Abyss normalize imports parseDurationSeconds');
  ok(/durationSeconds:\s*parseDurationSeconds\(file\.duration\)/.test(abyssSrc), '3b. Abyss normalize uses parseDurationSeconds(file.duration) — NOT coerceNumber');
  ok(!/durationSeconds:\s*coerceNumber\(file\.duration\)/.test(abyssSrc), '3c. Abyss normalize no longer uses coerceNumber for duration');
}

console.log('\n§4 — DB CHECK constraint is NOT weakened');
{
  // Read the migration that creates the media_assets_duration_seconds_check.
  const migration = read('supabase/migrations/20260928200724_phase2_hosting_database_foundation.sql');
  ok(/media_assets_duration_seconds_check\s+CHECK\s*\(\s*duration_seconds\s+IS\s+NULL\s+OR\s*\(\s*duration_seconds\s*>\s*0\s+AND\s+duration_seconds\s*<=\s*86400\s*\*\s*7\s*\)\s*\)/.test(migration), '4a. the DB CHECK constraint is intact (duration_seconds > 0 AND <= 7 days) — NOT weakened');

  // Verify no later migration drops or weakens the constraint. List
  // migration files + grep each one.
  const { readdirSync } = await import('node:fs');
  const migrations = readdirSync(pathResolve(root, 'supabase/migrations'));
  const dropPattern = /DROP\s+CONSTRAINT\s+media_assets_duration_seconds_check/i;
  const weakenPattern = /ALTER\s+CONSTRAINT\s+media_assets_duration_seconds_check/i;
  let violated = false;
  for (const m of migrations) {
    const content = read(`supabase/migrations/${m}`);
    if (dropPattern.test(content) || weakenPattern.test(content)) {
      violated = true;
      console.log(`    ${m} drops or alters the constraint`);
    }
  }
  ok(!violated, '4b. no migration drops or weakens the media_assets_duration_seconds_check constraint');
}

console.log('\n§5 — Sync service writes durationSeconds through the typed parser');
{
  // The sync service writes `duration_seconds: providerAsset.durationSeconds`.
  // `providerAsset` comes from the adapter's normalizeVidaraFile /
  // normalizeAbyssFile — both now use parseDurationSeconds. So the sync
  // path is safe. Verify by source: the sync service does NOT call
  // coerceNumber itself.
  const syncSrc = readCode('src/lib/server/hosting/sync/service.ts');
  ok(/duration_seconds:\s*providerAsset\.durationSeconds/.test(syncSrc), '5a. sync service writes duration_seconds from providerAsset.durationSeconds (already normalized by the adapter)');
  ok(!/coerceNumber/.test(syncSrc), '5b. sync service does NOT call coerceNumber (the parser lives in the adapter, not the service)');
}

console.log('\n§6 — linkAsset writes durationSeconds Through the typed parser');
{
  // linkAsset fetches adapter.getAsset(providerAssetId) which returns a
  // ProviderAssetInfo with durationSeconds already normalized by the
  // adapter. linkAsset INSERTs that value. Verify by source.
  const mgmtSrc = readCode('src/lib/server/hosting/management/service.ts');
  ok(/duration_seconds:\s*assetInfo\.durationSeconds/.test(mgmtSrc), '6a. linkAsset writes duration_seconds from assetInfo.durationSeconds (already normalized by the adapter)');
  ok(!/coerceNumber/.test(mgmtSrc), '6b. management service does NOT call coerceNumber (the parser lives in the adapter)');
}

console.log('\n§7 — Vidara normalize uses parseDurationSeconds for video_length');
{
  const vidaraSrc = readCode('src/lib/server/hosting/vidara/normalize.ts');
  ok(/import\s*\{\s*parseDurationSeconds\s*\}\s*from\s*['"][^'"]*media\/duration['"]/.test(vidaraSrc), '7a. Vidara normalize imports parseDurationSeconds');
  ok(/durationSeconds:\s*parseDurationSeconds\(file\.length\s*\?\?\s*file\.duration\s*\?\?\s*file\.video_length\)/.test(vidaraSrc), '7b. Vidara normalize uses parseDurationSeconds for the length/duration/video_length fields');
  ok(!/durationSeconds:\s*coerceNumber\(/.test(vidaraSrc), '7c. Vidara normalize no longer uses coerceNumber for the duration path');
}

console.log('\n§8 — listUnlinkedProviderFiles excludes terminal deleted/failed (UI contract)');
{
  // The listUnlinkedProviderFiles now returns `lifecycleState` +
  // `linkedToMediaItemId` so the UI can filter / disable rows. The UI
  // (AdminHostingAssets) uses isFileLinkable() to gate the rows.
  const mgmtSrc = readCode('src/lib/server/hosting/management/service.ts');
  ok(/lifecycleState:\s*f\.status/.test(mgmtSrc), '8a. listUnlinkedProviderFiles returns lifecycleState (canonical AssetLifecycleState)');
  ok(/linkedToMediaItemId/.test(mgmtSrc), '8b. listUnlinkedProviderFiles returns linkedToMediaItemId (for the UI duplicate-link guard)');

  const assetsSrc = readCode('src/lib/components/admin2/AdminHostingAssets.svelte');
  ok(/function\s+isFileLinkable/.test(assetsSrc), '8c. AdminHostingAssets defines isFileLinkable()');
  ok(/lifecycleState\s*===\s*['"]deleted['"]\s*\|\|\s*file\.lifecycleState\s*===\s*['"]failed['"]/.test(assetsSrc), '8d. isFileLinkable() excludes terminal deleted/failed files');
  ok(/linkedToMediaItemId\s*&&\s*file\.linkedToMediaItemId\s*!==\s*['"]<deleted>['"]\s*&&\s*file\.linkedToMediaItemId\s*!==\s*linkSelectedMediaItemId/.test(assetsSrc), '8e. isFileLinkable() excludes files linked to a DIFFERENT media_item (preserves idempotent relink to the same item)');
}

console.log(`\nmav_focused_vidara_abyss_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
