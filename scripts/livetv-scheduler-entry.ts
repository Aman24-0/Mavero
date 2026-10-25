/**
 * MAVERO — Unified Live TV Phase 7 scheduler (Netlify SCHEDULED function
 * entry).
 *
 * This file is the SOURCE for `netlify/functions/livetv-scheduler.mjs`,
 * generated at build time by scripts/build_livetv_scheduler_function.mjs
 * ONLY when `LIVETV_SCHEDULER_CRON` is configured in the build environment.
 * No env ⇒ no emitted function ⇒ NO schedule exists — the scheduled refresh
 * is NEVER silently active (docs/livetv/LIVETV_OPERATIONS.md documents the
 * exact activation steps).
 *
 * The declared Netlify schedule (in-file `config.schedule`, the documented
 * next-generation scheduled-function style) invokes the default handler,
 * which runs the SAME bounded Phase 7 tick orchestration the authenticated
 * endpoint runs — directly in-process (no secret over the wire; the Netlify
 * scheduler itself is the only invocation path; the endpoint keeps its own
 * shared-secret auth for external schedulers).
 *
 * SECURITY MODEL (mirrors scripts/executor-entry.ts):
 *   * The function creates its OWN service-role Supabase client from the
 *     site env (PUBLIC_SUPABASE_URL + PRIVATE_SUPABASE_SERVICE_ROLE_KEY).
 *   * The tick is bounded (8s wall-clock, ≤3 playlist/API + ≤2 EPG sources,
 *     sequential, per-source in-flight guard + history-backed duplicate
 *     window) — one invocation cannot fan out unbounded work.
 *   * Console output carries structured, allowlisted fields ONLY (counts,
 *     durations, slugs) — never configuration, URLs, credentials or secret
 *     material.
 */

export const config = { schedule: process.env['LIVETV_SCHEDULER_CRON'] ?? '@daily' } as const;

import { executeLivetvSchedulerTick } from '$lib/server/livetv/scheduler';

export default async function handler(): Promise<Response> {
        const startedAt = Date.now();

        const supabaseUrl = process.env['PUBLIC_SUPABASE_URL'] ?? '';
        const serviceKey = process.env['PRIVATE_SUPABASE_SERVICE_ROLE_KEY'] ?? '';
        if (supabaseUrl.length === 0 || serviceKey.length === 0) {
                console.error('[livetv-scheduler] unconfigured: missing Supabase env');
                return new Response(JSON.stringify({ ok: false, error: { code: 'SCHEDULER_UNCONFIGURED' } }), {
                        status: 503,
                        headers: { 'content-type': 'application/json' }
                });
        }

        const { createClient } = await import('@supabase/supabase-js');
        const client = createClient(supabaseUrl, serviceKey, {
                auth: { persistSession: false, autoRefreshToken: false }
        });

        try {
                const tick = await executeLivetvSchedulerTick(client);
                // Structured, allowlisted fields only.
                console.info(
                        `[livetv-scheduler] tick finished in ${tick.durationMs}ms: ok=${tick.ok} ` +
                                `planned=${tick.plannedSources}+${tick.plannedEpgSources} deferred=${tick.deferredSources}+${tick.deferredEpgSources} ` +
                                `duplicates=${tick.skippedDuplicates} retention=${tick.retentionDeleted ?? 'n/a'}`
                );
                for (const subject of tick.results) {
                        console.info(`[livetv-scheduler] subject ${subject.kind} ${subject.slug}: ok=${subject.ok} attempts=${subject.attempts} status=${subject.status} category=${subject.errorCategory ?? 'none'}`);
                }
                return new Response(JSON.stringify({ ok: tick.ok }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' }
                });
        } catch (error) {
                console.error(`[livetv-scheduler] tick crashed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
                return new Response(JSON.stringify({ ok: false }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' }
                });
        } finally {
                void startedAt;
        }
}
