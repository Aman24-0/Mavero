/**
 * UNIFIED LIVE TV — Phase 7 health & diagnostics contracts (deterministic).
 *
 * Covers (Phase 7 brief §6 + required regression areas #10/#11/#18/#22):
 *   §1  public /api/health is UNTOUCHED (no livetv imports, no flag leaks;
 *       the three documented modes keep their exact shapes)
 *   §2  the admin ops status endpoint contract: requireAdmin FIRST,
 *       no-store, bounded queries, bounded response (≤25 sources, ≤10 EPG),
 *       no config/URL/message/credential material, flag as boolean ONLY
 *   §3  scheduler-secret presence is a BOOLEAN (the secret itself never
 *       reflected)
 *   §4  EPG freshness surfaces data PRESENCE (guide window end) — never a
 *       playability claim
 *   §5  EPG freshness/stale-data honesty helpers (the Phase 6 progress
 *       boundary helpers stay green under the new modules)
 *
 * Source-contract checks use the repo's established source-inspection
 * conventions (exact import-edge + line-level pins).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { programmeProgressPercent, formatProgrammeRemaining } from '../src/lib/client/live-tv/epg';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
        assert.ok(condition, hint ? `${label} (${hint})` : label);
        passed += 1;
        console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

async function main() {
        // ------------------------------------------------------------------
        console.log('§1 — public /api/health is UNTOUCHED by Phase 7');
        // ------------------------------------------------------------------
        {
                const healthSource = read('src/routes/api/health/+server.ts');
                ok(!healthSource.includes('livetv'), '§1.1 the health endpoint imports NO livetv module');
                ok(!healthSource.includes('unified'), '§1.2 the health endpoint never exposes the unified flag');
                ok(!healthSource.includes('refresh_history') && !healthSource.includes('scheduler'), '§1.3 the health endpoint reads NO history/scheduler state');
                ok(healthSource.includes("url.searchParams.get('deep') === '1'") && healthSource.includes("url.searchParams.get('stats') === '1'"), '§1.4 the three documented modes (liveness/deep/stats) are unchanged');
                ok(healthSource.includes("'cache-control': 'no-store'") && healthSource.includes("'cache-control': 'public, max-age=5'"), '§1.5 the caching contract is unchanged (liveness/deep no-store; stats 5s public)');
                ok(healthSource.includes('READINESS_TIMEOUT_MS = 2_000'), '§1.6 the 2s readiness probe budget is unchanged');
        }

        // ------------------------------------------------------------------
        console.log('§2 — admin ops status endpoint contract');
        // ------------------------------------------------------------------
        {
                const opsSource = read('src/routes/api/admin/livetv/ops/status/+server.ts');
                // Auth FIRST: the requireAdmin call precedes any client creation
                // or data read (line-order pin).
                const requireAdminIdx = opsSource.indexOf('await requireAdmin(locals');
                const clientIdx = opsSource.indexOf('createSupabaseAdminClient()');
                ok(requireAdminIdx !== -1 && clientIdx !== -1 && requireAdminIdx < clientIdx, '§2.1 requireAdmin runs BEFORE any data access');
                ok(opsSource.includes("'cache-control': 'no-store'"), '§2.2 the response is no-store');
                ok(opsSource.includes('MAX_SOURCE_ROWS = 25') && opsSource.includes('MAX_EPG_ROWS = 10'), '§2.3 the per-subject bounds are explicit (≤25 sources, ≤10 EPG)');
                ok(opsSource.includes('HISTORY_PAGE = 300') && opsSource.includes('DB_PROBE_TIMEOUT_MS = 2_000'), '§2.4 every read is bounded (history page + probe timeout)');
                const getResult = opsSource.split('export const GET')[1] ?? '';
                // Response discipline: NO config/URL/message/credential fields.
                ok(!/\bconfig\s*:|'config'|"config"|\bconfig\b,\s*$/m.test(getResult), '§2.5 the response body carries NO source configuration key');
                ok(!getResult.includes('error_message'), '§2.6 the response carries NO error message bodies (categories only)');
                ok(!getResult.includes('source_url') && !getResult.includes('playlistUrl') && !getResult.includes('baseUrl'), '§2.7 the response carries NO upstream URLs');
                ok(getResult.includes('unified: { enabled: unifiedEnabled }'), '§2.8 the unified flag is reported as a BOOLEAN only');
                ok(opsSource.includes('lastErrorCategory') && !opsSource.includes('lastErrorMessage'), '§2.9 failures surface as sanitized CATEGORIES, not messages');
                ok(opsSource.includes('isUnifiedLivetvEnabled'), '§2.10 the flag read reuses the Phase 5 resolver gate (single flag ownership)');
                ok(getResult.includes('guideWindowEndAt'), '§2.11 the EPG freshness surface (guide window end) exists');
                ok(!getResult.includes('playable') && !getResult.includes('isPlaying'), '§2.12 NOTHING in the response claims playability (ingestion health ≠ playback health)');
        }

        // ------------------------------------------------------------------
        console.log('§3 — scheduler-secret presence is a boolean');
        // ------------------------------------------------------------------
        {
                const schedulerSource = read('src/lib/server/livetv/scheduler.ts');
                ok(schedulerSource.includes("process.env['LIVETV_SCHEDULER_SECRET']"), '§3.1 the secret is read ONLY from server-side env');
                ok(schedulerSource.includes('timingSafeEqual'), '§3.2 the comparison is timing-safe');
                ok(schedulerSource.includes('createHash'), '§3.3 the comparison hashes to fixed-length digests (length-safe)');
                const tickSource = read('src/routes/api/livetv/scheduler/tick/+server.ts');
                ok(tickSource.indexOf('checkRateLimit') < tickSource.indexOf('isLivetvSchedulerConfigured') && tickSource.indexOf('isLivetvSchedulerConfigured') < tickSource.indexOf('verifyLivetvSchedulerSecret'), '§3.4 rate limit → configuration check → auth (all before any work)');
                const execIdx = tickSource.indexOf('executeLivetvSchedulerTick(client)');
                ok(execIdx > tickSource.indexOf('verifyLivetvSchedulerSecret(provided)'), '§3.5 the tick executes ONLY after authentication');
                ok(!tickSource.includes('LIVETV_SCHEDULER_SECRET') || !/['"]LIVETV_SCHEDULER_SECRET['"]\s*[,)}]/.test(tickSource.replace("process.env['LIVETV_SCHEDULER_SECRET']", '')), '§3.6 the endpoint itself never embeds or reflects the secret value');
        }

        // ------------------------------------------------------------------
        console.log('§4 — in-flight counts are instance-local honesty');
        // ------------------------------------------------------------------
        {
                const refreshSource = read('src/lib/server/livetv/refresh-service.ts');
                const epgSource = read('src/lib/server/livetv/epg/guide-service.ts');
                ok(refreshSource.includes('getLivetvRefreshInFlightCount') && epgSource.includes('getLivetvEpgInFlightCount'), '§4.1 both services expose their instance-local in-flight count');
                ok(read('src/routes/api/admin/livetv/ops/status/+server.ts').includes('inFlight: { sources: getLivetvRefreshInFlightCount(), epgSources: getLivetvEpgInFlightCount() }'), '§4.2 the ops response labels in-flight counts as instance-local surface');
        }

        // ------------------------------------------------------------------
        console.log('§5 — EPG freshness/staleness honesty helpers (regression)');
        // ------------------------------------------------------------------
        {
                // The Phase 6 honest progress/remaining helpers keep their exact
                // boundary semantics under the Phase 7 modules (drill #3/#18
                // companion pins).
                // The helpers take a PROGRAMME object (startSeconds/stopSeconds
                // in Unix SECONDS) + a now (seconds) — exact Phase 6 contract.
                const now = 1_000_000;
                const prog = (start: number, stop: number) => ({ startSeconds: start, stopSeconds: stop }) as never;
                ok(programmeProgressPercent(prog(now - 1_000, now + 1_000), now) === 50, '§5.1 mid-window progress = 50%');
                ok(programmeProgressPercent(prog(now - 2_000, now), now) === null, '§5.2 a just-ended programme reports NO progress (honest staleness)');
                ok(programmeProgressPercent(prog(now + 1_000, now + 2_000), now) === null, '§5.3 an upcoming programme reports NO progress');
                ok(programmeProgressPercent(prog(now - 1_000, now - 500), now) === null, '§5.4 a degenerate window reports NO progress');
                ok(formatProgrammeRemaining(prog(now, now + 90), now) === '1m left', '§5.5 the remaining-time format is unchanged');
                ok(formatProgrammeRemaining(prog(now - 90, now), now) === null, '§5.6 a past programme reports NO remaining time');
        }

        console.log(`\n=== livetv Phase 7 health/verification: ${passed} checks PASSED ===`);
}

main().catch((error) => {
        console.error(error);
        process.exit(1);
});
