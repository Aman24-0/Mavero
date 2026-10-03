/**
 * MAVERO — Adapter Build Executor (Netlify BACKGROUND function entry).
 *
 * This file is the SOURCE for `netlify/functions/adapter-build-executor.mjs`
 * (generated at build time by scripts/build_executor_function.mjs — the
 * bundling step is required because Netlify's function bundler cannot
 * resolve SvelteKit's `$lib` aliases; esbuild resolves them here).
 *
 * WHY A BACKGROUND FUNCTION: Netlify synchronous functions are hard-capped
 * at 10s (default) / 26s (max) — far below the adapter-build pipeline's
 * real duration (Render cold start ~32s + Builder budget up to 150s +
 * independent representative test). A background function is invoked with
 * a plain HTTP POST that returns 202 IMMEDIATELY, then runs detached for
 * up to 15 minutes — the platform-native durable execution mechanism
 * (no queue service introduced).
 *
 * SECURITY MODEL (unchanged):
 *   * Authorized with the SAME server-side shared secret as the Builder
 *     (PRIVATE_ADAPTER_BUILDER_SECRET — never exposed to any client; the
 *     queue action sends it in the Authorization header, which no browser
 *     can observe).
 *   * The executor creates its OWN service-role Supabase client from the
 *     site's env (PUBLIC_SUPABASE_URL + PRIVATE_SUPABASE_SERVICE_ROLE_KEY)
 *     — the exact credentials the SvelteKit app itself uses.
 *   * Executes only DURABLE, pre-validated jobs: the claim CAS
 *     (queued→building) makes duplicate/late invocations no-ops, and every
 *     pipeline write is job-pointer-guarded (a late worker can never write
 *     a row a newer job owns).
 *   * NEVER callable by Downloader 2 / any runtime path — only the build
 *     lifecycle dispatches it.
 */

export const config = { type: 'background' } as const;

// The durable build lifecycle (resolved via the $lib alias by the
// esbuild bundling step — see scripts/build_executor_function.mjs).
import { executeAdapterBuildJob } from '$lib/server/extensions/builder/build-lifecycle';

interface ExecutorRequestBody {
  jobId?: unknown;
}

export default async function handler(request: Request): Promise<Response> {
  const startedAt = Date.now();

  // Auth: the shared Builder secret (server-to-server only).
  const secret = process.env['PRIVATE_ADAPTER_BUILDER_SECRET'] ?? '';
  const authorization = request.headers.get('authorization') ?? '';
  if (secret.length === 0 || authorization !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ ok: false, error: { code: 'EXECUTOR_UNAUTHORIZED', message: 'Unauthorized.' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Body: one durable job id.
  let body: ExecutorRequestBody;
  try {
    body = (await request.json()) as ExecutorRequestBody;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: { code: 'EXECUTOR_INVALID_REQUEST', message: 'Invalid body.' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const jobId = body.jobId;
  if (typeof jobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return new Response(JSON.stringify({ ok: false, error: { code: 'EXECUTOR_INVALID_REQUEST', message: 'A valid jobId is required.' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // The executor's own service-role client (the site's env).
  const supabaseUrl = process.env['PUBLIC_SUPABASE_URL'] ?? '';
  const serviceKey = process.env['PRIVATE_SUPABASE_SERVICE_ROLE_KEY'] ?? '';
  if (supabaseUrl.length === 0 || serviceKey.length === 0) {
    console.error('[adapter-build-executor] missing Supabase env (PUBLIC_SUPABASE_URL / PRIVATE_SUPABASE_SERVICE_ROLE_KEY)');
    return new Response(JSON.stringify({ ok: false, error: { code: 'EXECUTOR_UNCONFIGURED', message: 'The executor is not configured.' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { createClient } = await import('@supabase/supabase-js');
  // Types are erased at runtime here (the bundled build-lifecycle carries
  // its own typed client); the shape is identical.
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const outcome = await executeAdapterBuildJob(client, jobId);
    console.info(
      `[adapter-build-executor] job ${jobId} finished in ${Date.now() - startedAt}ms: ` +
      (outcome.ok ? `ok (adapter v${outcome.adapterVersion})` : `${outcome.code}: ${outcome.message}`),
    );
    return new Response(JSON.stringify({ ok: outcome.ok }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    // The durable job row + the reconciler own recovery — the function
    // NEVER needs to retry on its own.
    console.error(`[adapter-build-executor] job ${jobId} crashed:`, error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({ ok: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}
