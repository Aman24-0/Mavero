#!/usr/bin/env node
/**
 * MAVERO — bundles the Unified Live TV Phase 7 scheduler Netlify SCHEDULED
 * function (scripts/livetv-scheduler-entry.ts) into
 * netlify/functions/livetv-scheduler.mjs.
 *
 * OWNER-GATED EMISSION (honest scheduling — brief §3): the function is
 * emitted ONLY when `LIVETV_SCHEDULER_CRON` is set in the BUILD environment
 * (a valid Netlify cron expression or Netlify schedule descriptor such as
 * `@hourly`/`@daily`). Without that variable nothing is emitted, nothing is
 * scheduled, and the build output says so explicitly — the Phase 7 scheduler
 * is IMPLEMENTED but NOT ACTIVE until the owner configures it (docs/livetv/
 * LIVETV_OPERATIONS.md carries the exact activation + rollback steps).
 *
 * Invalid cron values FAIL THE BUILD (the owner explicitly asked for a
 * schedule; a silently-missed one would be dishonest).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outFile = path.join(repoRoot, 'netlify', 'functions', 'livetv-scheduler.mjs');

const cron = (process.env['LIVETV_SCHEDULER_CRON'] ?? '').trim();

if (cron.length === 0) {
        // Honest no-op: the scheduler is implemented but NOT scheduled.
        // Remove any stale artifact from a previous configured build.
        if (existsSync(outFile)) {
                writeFileSync(outFile + '.stale-removed', '// livetv-scheduler: LIVETV_SCHEDULER_CRON no longer configured; the schedule was removed by this build.\n');
                console.log('[build_livetv_scheduler_function] LIVETV_SCHEDULER_CRON unset — schedule NOT emitted (stale artifact marked *.stale-removed; delete it in the deploy if present)');
        } else {
                console.log('[build_livetv_scheduler_function] LIVETV_SCHEDULER_CRON unset — scheduler implemented but NOT scheduled (see docs/livetv/LIVETV_OPERATIONS.md)');
        }
        process.exit(0);
}

// Netlify accepts standard 5-field cron expressions plus the @descriptors
// (@hourly, @daily, @weekly, @monthly, @annually, @yearly).
const DESCRIPTORS = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@annually', '@yearly']);
const FIVE_FIELD = /^(\S+\s+){4}\S+$/;
if (!DESCRIPTORS.has(cron) && !FIVE_FIELD.test(cron)) {
        console.error(`[build_livetv_scheduler_function] invalid LIVETV_SCHEDULER_CRON value "${cron.slice(0, 64)}" — use a 5-field cron expression or a Netlify @descriptor (${[...DESCRIPTORS].join(', ')}).`);
        process.exit(1);
}

// esbuild is a transitive dependency (via vite) in pnpm's strict layout —
// resolve it from vite's own module context (the established generator
// pattern; see scripts/build_executor_function.mjs).
const requireFromRepo = createRequire(import.meta.url);
const requireFromVite = createRequire(requireFromRepo.resolve('vite'));
const esbuild = requireFromVite('esbuild');

mkdirSync(path.dirname(outFile), { recursive: true });

await esbuild.build({
        entryPoints: [path.join(repoRoot, 'scripts', 'livetv-scheduler-entry.ts')],
        outfile: outFile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        sourcemap: false,
        minify: false,
        legalComments: 'none',
        define: {
                // The schedule is FROZEN AT BUILD TIME into the emitted
                // function's in-file config (the documented next-generation
                // scheduled-function declaration). The runtime env value is
                // never consulted (a rebuild is the documented rollback path).
                'process.env.LIVETV_SCHEDULER_CRON': JSON.stringify(cron)
        },
        alias: {
                $lib: path.join(repoRoot, 'src', 'lib'),
                '$env/dynamic/private': path.join(repoRoot, 'scripts', 'executor-shims', 'env-dynamic-private.ts')
        },
        packages: 'bundle',
        banner: {
                js: [
                        '// MAVERO livetv-scheduler — GENERATED FILE (scripts/build_livetv_scheduler_function.mjs).',
                        '// Do not edit; regenerate with `pnpm build` (emitted only when LIVETV_SCHEDULER_CRON is set).',
                        "import { createRequire as __createRequire } from 'node:module';",
                        'const require = __createRequire(import.meta.url);'
                ].join('\n')
        }
});

console.log(`[build_livetv_scheduler_function] wrote ${path.relative(repoRoot, outFile)} (schedule: ${cron})`);
