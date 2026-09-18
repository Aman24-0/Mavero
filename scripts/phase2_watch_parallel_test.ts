import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 2-E (audit PERF-005) — Watch page server load parallelization.
 *
 * Problem: the watch page's +page.server.ts fetched detail, then season,
 * then streamingConfig, then maveroPlayerAvailable sequentially. Only
 * detail was a true dependency for the adult gate; the others could run
 * in parallel.
 *
 * Fix: Promise.all on the independent work. Detail is awaited first
 * (the adult gate depends on item.tags), then streamingConfig + season +
 * maveroPlayerAvailable are awaited together.
 *
 * This is a static contract test — it verifies:
 *   1. The load function kicks off multiple promises concurrently.
 *   2. Detail is awaited BEFORE the adult gate (correctness preserved).
 *   3. The adult gate is still server-authoritative + non-disclosing.
 *   4. Streaming config degrades to a safe empty default on failure.
 *   5. maveroPlayerAvailable degrades to false on failure.
 *   6. Episode fetch is still optional (failure is silently absorbed).
 *
 * Runtime measurement (timing) is NOT covered here — the audit explicitly
 * says "Only claim [runtime improvement] if actually measured." This test
 * asserts the static contract; the runtime improvement is a derived
 * consequence of the parallelization.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const watch = read('src/routes/watch/[type]/[id]/+page.server.ts');

// ============================================================
// 1. The load function uses Promise.all to parallelize.
// ============================================================
ok(/Promise\.all\(/.test(watch), '1a. watch load uses Promise.all');
ok(/streamingConfigPromise/.test(watch) && /maveroPlayerAvailablePromise/.test(watch) && /speculativeSeasonPromise/.test(watch), '1b. independent promises are started concurrently before awaiting');

// ============================================================
// 2. Detail is awaited first — the adult gate depends on item.tags.
// ============================================================
ok(/const item = await detailPromise/.test(watch), '2a. detail is awaited first (before the adult gate)');
ok(/detailVerdict\(item\.tags\)/.test(watch), '2b. the adult gate reads item.tags (only available after detail resolves)');

// ============================================================
// 3. The adult gate is preserved — server-authoritative, non-disclosing.
// ============================================================
ok(/canAccessAdultContent\(locals\.supabase,\s*user,\s*cookies\)/.test(watch), '3a. adult gate calls canAccessAdultContent with the verified user + cookies');
ok(/throw error\(404, 'Title not found'\)/.test(watch), '3b. unauthorized adult title returns the non-disclosing 404 (same as missing title)');

// ============================================================
// 4. Streaming config degrades to a safe empty default on failure.
// ============================================================
ok(/EMPTY_STREAMING_CONFIG/.test(watch), '4a. EMPTY_STREAMING_CONFIG fallback defined');
ok(/providers:\s*\[\]/.test(watch) && /sources:\s*\[\]/.test(watch) && /categories:\s*\[\]/.test(watch), '4b. fallback config has empty providers/sources/categories (safe degraded state)');
ok(/getPublicStreamingConfig\(locals\.supabase\)\s*\.catch\(/.test(watch), '4c. streaming config failure is caught (no unhandled rejection)');

// ============================================================
// 5. maveroPlayerAvailable degrades to false on failure.
// ============================================================
ok(/hasStreamEligibleAddons\(createSupabaseAdminClient\(\)\)\s*\.catch\(\(\)\s*=>\s*false\)/.test(watch), '5a. maveroPlayerAvailable failure degrades to false');

// ============================================================
// 6. Episode fetch is still optional (failure is silently absorbed).
// ============================================================
ok(/getSeriesSeason\(params\.id, seasonNumber\)/.test(watch), '6a. season fetch is called when series-like');
ok(/\.catch\(\(\)\s*=>\s*null\)/.test(watch), '6b. season fetch failure returns null (silently absorbed)');

// ============================================================
// 7. Speculative season fetch — series-like-by-params kicks off the
//    season fetch BEFORE detail resolves (no need to wait for item).
// ============================================================
ok(/seriesLikeByParams\s*=\s*params\.type\s*===\s*'series'\s*\|\|\s*params\.type\s*===\s*'anime'/.test(watch), '7a. seriesLikeByParams derived from params.type (no item dependency)');
ok(/speculativeSeasonPromise.*seriesLikeByParams/.test(watch), '7b. speculative season fetch is gated on seriesLikeByParams');

// ============================================================
// 8. The rare movie+anime-series case is handled — lateSeasonPromise.
// ============================================================
ok(/lateSeasonPromise/.test(watch), '8a. lateSeasonPromise handles the rare movie+anime-series case');
ok(/!seriesLikeByParams\s*&&\s*isSeriesLike/.test(watch), '8b. lateSeasonPromise is gated on (not series-by-params) AND (series-like by item)');

// ============================================================
// 9. Episode fallback to item.seasonsData is preserved.
// ============================================================
ok(/item\.seasonsData\?\.flatMap\(/.test(watch), '9a. fallback episodes from item.seasonsData preserved');
ok(/isSeriesLike\s*&&\s*seasonEpisodes\s*&&\s*seasonEpisodes\.length\s*>\s*0/.test(watch), '9b. season episodes used only when series-like AND non-empty');

// ============================================================
// 10. The adult gate uses locals.user (Phase 2-A reuse, not safeGetSession).
// ============================================================
ok(/const user = locals\.user/.test(watch), '10a. adult gate uses locals.user (Phase 2-A: hook-resolved, no second auth roundtrip)');
ok(!/await\s+locals\.safeGetSession\(\)/.test(watch.replace(/\/\/[^\n]*/g, '')), '10b. no redundant safeGetSession call (Phase 2-A preserved)');

// ============================================================
// 11. No duplicate queries — the season fetch runs at most once.
// ============================================================
// Count occurrences of getSeriesSeason as a CALL (not import or comment).
// Should be 2: speculative (line 110) + late (line 137). Both are
// conditional, only one fires per request.
const seasonCallMatches = watch.match(/getSeriesSeason\(params\.id, seasonNumber\)/g) || [];
ok(seasonCallMatches.length === 2, `11a. getSeriesSeason call sites: ${seasonCallMatches.length} (expected 2 — speculative + late; only one fires per request)`);

console.log(`phase2_watch_parallel_test: ${passed} checks passed (Phase 2-E watch page parallelization)`);
